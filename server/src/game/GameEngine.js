const { PLAYER, SONAR, PROJECTILE, GAME } = require('../../../shared/constants');
const { MODES, arenaForPlayers } = require('../../../shared/modes');

// Zone toxique (border map) : rectangle central qui rétrécit avec le temps.
// Hors zone, on encaisse des dégâts ; à pleine vie on meurt en GAS.KILL_MS.
const GAS = {
  START: 0.2,    // fraction de la partie avant le début du rétrécissement
  END: 0.85,     // fraction à laquelle la zone atteint sa taille minimale
  MIN: 0.18,     // taille finale = 18% des dimensions de l'arène
  KILL_MS: 5000, // temps pour vider une barre de vie pleine dans le gaz
};

class GameEngine {
  constructor(roomId, mode = MODES.classic) {
    this.roomId = roomId;
    this.mode = mode;
    this.teamCount = mode.teamCount;
    this.teamSize = mode.teamSize;
    this.totalPlayers = mode.totalPlayers;
    this.friendlyFire = !!mode.friendlyFire;
    this.sharedVision = !!mode.sharedVision;
    this.suddenDeathEnabled = !!mode.suddenDeath;
    this.maxHp = mode.maxHp || PLAYER.MAX_HP;
    this.durationMs = mode.durationMs || GAME.MAX_DURATION_MS;
    this.borderMapEnabled = !!mode.borderMap;

    // Arène dimensionnée selon le nombre de joueurs (source partagée).
    this.arena = arenaForPlayers(this.totalPlayers);

    this.players = [];
    this.projectiles = [];
    this.sonarWaves = [];
    this.walls = [];
    this.zone = null;       // rectangle sûr courant (border map), sinon null
    this.startTime = null;
    this.endTime = null;
    this.over = false;
    this.winnerTeam = null; // fixé quand la partie se termine
    this.stats = Array.from({ length: this.totalPlayers }, () => ({ pings: 0, shots: 0, hits: 0 }));
    this._projIdSeq = 0;
    this._waveIdSeq = 0;
    this._events = [];
    this.suddenDeath = false;

    this._teamSpawns = this._pickTeamSpawns(); // [team][slot] = [col,row]
    this._teamFill = new Array(this.teamCount).fill(0);
    this._generateMap();
  }

  // Une zone de spawn par équipe (bandes horizontales : 1re équipe à gauche,
  // dernière à droite), avec teamSize emplacements répartis verticalement. Les
  // coéquipiers démarrent groupés, loin de l'équipe adverse.
  _pickTeamSpawns() {
    const cols = this.arena.COLS, rows = this.arena.ROWS;
    const margin = 2;
    const spawns = [];
    for (let t = 0; t < this.teamCount; t++) {
      const frac = this.teamCount === 1 ? 0.5 : t / (this.teamCount - 1);
      const baseCol = Math.round(margin + frac * (cols - 1 - margin * 2));
      const cells = [];
      for (let i = 0; i < this.teamSize; i++) {
        const rowFrac = (i + 1) / (this.teamSize + 1);
        const row = Math.max(1, Math.min(rows - 2, Math.round(rowFrac * (rows - 1)) + (Math.random() < 0.5 ? 0 : 1)));
        const col = Math.max(1, Math.min(cols - 2, baseCol + (Math.random() < 0.5 ? 0 : (t === 0 ? 1 : -1))));
        cells.push([col, row]);
      }
      spawns.push(cells);
    }
    return spawns;
  }

  _generateMap() {
    const walls = [];
    const cols = this.arena.COLS;
    const rows = this.arena.ROWS;
    const S = this.arena.CELL_SIZE;
    const safeZones = new Set();
    // Protéger une zone 3×3 autour de CHAQUE cellule de spawn (toutes équipes
    // confondues) pour qu'aucun joueur ne démarre dans (ou collé à) un mur.
    this._teamSpawns.flat().forEach(([sc, sr]) => {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          safeZones.add(`${sc + dc},${sr + dr}`);
        }
      }
    });
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (!safeZones.has(`${c},${r}`) && Math.random() < 0.22) {
          walls.push({ x: c * S, y: r * S });
        }
      }
    }
    this.walls = walls;
    this._wallSet = new Set(walls.map(w => `${Math.floor(w.x / S)},${Math.floor(w.y / S)}`));
  }

  addPlayer(userId, pseudo, elo, socketId, team = this.players.length) {
    const S = this.arena.CELL_SIZE;
    const slot = this._teamFill[team] ?? 0;
    this._teamFill[team] = slot + 1;
    const cell = (this._teamSpawns[team] && this._teamSpawns[team][slot]) || this._teamSpawns[team][0] || [1, 1];
    const x = cell[0] * S + S / 2;
    const y = cell[1] * S + S / 2;
    this.players.push({
      userId,
      pseudo,
      elo,
      socketId,
      team,
      x,
      y,
      vx: 0,
      vy: 0,
      angle: Math.atan2(this.arena.HEIGHT / 2 - y, this.arena.WIDTH / 2 - x), // face au centre
      hp: this.maxHp,
      invincibleUntil: 0,
      lastPingTime: 0,
      lastShotTime: 0,
      inputs: { up: false, down: false, left: false, right: false },
      exposed: false,
      exposedUntil: 0,
      gasAccum: 0,
    });
  }

  start() {
    this.startTime = Date.now();
    this.endTime = this.startTime + this.durationMs;
    if (this.borderMapEnabled) this._updateZone(this.startTime);
  }

  handleInput(playerIndex, inputs) {
    const p = this.players[playerIndex];
    if (!p) return;
    p.inputs = { ...p.inputs, ...inputs };
    if (inputs.angle !== undefined) p.angle = inputs.angle;
  }

  handlePing(playerIndex) {
    if (this.suddenDeath) return null; // sonar désactivé en mort subite
    const p = this.players[playerIndex];
    if (!p || p.hp <= 0) return null; // un joueur mort ne peut plus pinger
    const now = Date.now();
    if (now - p.lastPingTime < SONAR.COOLDOWN_MS) return null;
    p.lastPingTime = now;
    this.stats[playerIndex].pings++;
    const wave = {
      id: this._waveIdSeq++,
      x: p.x,
      y: p.y,
      startTime: now,
      playerIndex,
    };
    this.sonarWaves.push(wave);
    // Pinger = s'exposer : la position du pingeur est révélée aux adversaires.
    p.exposed = true;
    p.exposedUntil = now + SONAR.EXPOSE_DURATION_MS;
    return wave;
  }

  handleShoot(playerIndex) {
    const p = this.players[playerIndex];
    if (!p || p.hp <= 0) return null; // un joueur mort ne peut plus tirer
    const now = Date.now();
    const myProjectiles = this.projectiles.filter(pr => pr.playerIndex === playerIndex);
    if (now - p.lastShotTime < PROJECTILE.COOLDOWN_MS) return null;
    if (myProjectiles.length >= PROJECTILE.MAX_ACTIVE) return null;
    p.lastShotTime = now;
    this.stats[playerIndex].shots++;
    const proj = {
      id: this._projIdSeq++,
      x: p.x + Math.cos(p.angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2),
      y: p.y + Math.sin(p.angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2),
      vx: Math.cos(p.angle) * PROJECTILE.SPEED,
      vy: Math.sin(p.angle) * PROJECTILE.SPEED,
      playerIndex,
    };
    this.projectiles.push(proj);
    return proj;
  }

  tick(dtMs) {
    if (this.over) return null;
    const dt = dtMs / 1000;
    const now = Date.now();

    // Fin du temps : départage par PV d'équipe (cf. _resolveTimer).
    if (!this.suddenDeath && now >= this.endTime) {
      return this._resolveTimer();
    }

    this._updatePlayers(dt, now);
    this._updateProjectiles(dt, now);
    if (this.borderMapEnabled && !this.suddenDeath) {
      this._updateZone(now);
      this._applyGas(dt, now);
    }
    if (!this.suddenDeath) {
      this._updateSonarWaves(now);
      this._updateExposure(now);
    }

    return null;
  }

  _enterSuddenDeath() {
    this.suddenDeath = true;
    this.walls = [];
    this._wallSet = new Set();
    this.sonarWaves = [];
    this.zone = null;
    this.players.forEach(p => { p.exposed = false; });
  }

  // Rectangle sûr centré qui rétrécit de l'arène entière vers GAS.MIN.
  _updateZone(now) {
    const A = this.arena;
    const progress = Math.max(0, Math.min(1, (now - this.startTime) / this.durationMs));
    const t = Math.max(0, Math.min(1, (progress - GAS.START) / (GAS.END - GAS.START)));
    const ease = t * t * (3 - 2 * t);
    const k = 1 - (1 - GAS.MIN) * ease;     // 1 → GAS.MIN
    const halfW = (A.WIDTH / 2) * k;
    const halfH = (A.HEIGHT / 2) * k;
    this.zone = { x: A.WIDTH / 2 - halfW, y: A.HEIGHT / 2 - halfH, w: halfW * 2, h: halfH * 2 };
  }

  // Dégâts du gaz : hors zone, on accumule le temps d'exposition ; chaque palier
  // retire 1 PV. À pleine vie, mort en GAS.KILL_MS (ré-entrer remet le compteur à zéro).
  _applyGas(dt, now) {
    if (!this.zone) return;
    const z = this.zone;
    const perHpMs = GAS.KILL_MS / this.maxHp;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p || p.hp <= 0) continue;
      const inside = p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
      if (inside) { p.gasAccum = 0; continue; }
      p.gasAccum += dt * 1000;
      if (p.gasAccum >= perHpMs) {
        p.gasAccum -= perHpMs;
        p.hp--;
        this._events.push({ type: 'hit', victim: i, by: -1 }); // by:-1 = gaz
        if (p.hp <= 0) { this._maybeEndByElimination(); if (this.over) return; }
      }
    }
  }

  _updatePlayers(dt, now) {
    const A = this.arena;
    this.players.forEach((p, i) => {
      if (p.hp <= 0) return;
      let dx = 0, dy = 0;
      if (p.inputs.up) dy -= 1;
      if (p.inputs.down) dy += 1;
      if (p.inputs.left) dx -= 1;
      if (p.inputs.right) dx += 1;
      if (dx !== 0 && dy !== 0) {
        const norm = Math.SQRT2;
        dx /= norm;
        dy /= norm;
      }
      if (dx !== 0 || dy !== 0) {
        p.angle = Math.atan2(dy, dx);
      }
      const newX = p.x + dx * PLAYER.SPEED * dt;
      const newY = p.y + dy * PLAYER.SPEED * dt;
      const clampedX = Math.max(PLAYER.RADIUS, Math.min(A.WIDTH - PLAYER.RADIUS, newX));
      const clampedY = Math.max(PLAYER.RADIUS, Math.min(A.HEIGHT - PLAYER.RADIUS, newY));
      // collision murs + collision avec un autre joueur (pas de chevauchement)
      if (!this._collidesWithWall(clampedX, p.y, PLAYER.RADIUS) && !this._collidesWithPlayer(i, clampedX, p.y)) p.x = clampedX;
      if (!this._collidesWithWall(p.x, clampedY, PLAYER.RADIUS) && !this._collidesWithPlayer(i, p.x, clampedY)) p.y = clampedY;
    });
  }

  _collidesWithPlayer(selfIdx, x, y) {
    const minDist = PLAYER.RADIUS * 2;
    for (let i = 0; i < this.players.length; i++) {
      if (i === selfIdx) continue;
      const o = this.players[i];
      if (!o || o.hp <= 0) continue;
      if (Math.hypot(x - o.x, y - o.y) < minDist) return true;
    }
    return false;
  }

  _collidesWithWall(x, y, radius) {
    const S = this.arena.CELL_SIZE;
    const minC = Math.floor((x - radius) / S);
    const maxC = Math.floor((x + radius) / S);
    const minR = Math.floor((y - radius) / S);
    const maxR = Math.floor((y + radius) / S);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (this._wallSet.has(`${c},${r}`)) {
          const wx = c * S, wy = r * S;
          const nearX = Math.max(wx, Math.min(wx + S, x));
          const nearY = Math.max(wy, Math.min(wy + S, y));
          const dist = Math.hypot(x - nearX, y - nearY);
          if (dist < radius) return true;
        }
      }
    }
    return false;
  }

  _updateProjectiles(dt, now) {
    const A = this.arena;
    const toRemove = new Set();
    for (const proj of this.projectiles) {
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      if (proj.x < 0 || proj.x > A.WIDTH || proj.y < 0 || proj.y > A.HEIGHT) {
        toRemove.add(proj.id);
        continue;
      }
      if (this._collidesWithWall(proj.x, proj.y, PROJECTILE.RADIUS)) {
        toRemove.add(proj.id);
        continue;
      }
      const shooterTeam = this.players[proj.playerIndex]?.team;
      // Cible : n'importe quel joueur d'une autre équipe (sauf friendly fire).
      for (let ti = 0; ti < this.players.length; ti++) {
        if (ti === proj.playerIndex) continue;
        const target = this.players[ti];
        if (!target || target.hp <= 0) continue;
        if (!this.friendlyFire && target.team === shooterTeam) continue;
        if (now <= target.invincibleUntil) continue;
        const dist = Math.hypot(proj.x - target.x, proj.y - target.y);
        if (dist < PLAYER.RADIUS + PROJECTILE.RADIUS) {
          target.hp--;
          target.invincibleUntil = now + PLAYER.INVINCIBILITY_MS;
          this.stats[proj.playerIndex].hits++;
          this._events.push({ type: 'hit', victim: ti, by: proj.playerIndex });
          toRemove.add(proj.id);
          // Fin de partie : mort subite (1er coup) ou une seule équipe survivante.
          if (this.suddenDeath) {
            this._setOver(shooterTeam);
          } else if (target.hp <= 0) {
            this._maybeEndByElimination();
          }
          break; // un projectile ne touche qu'une cible
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !toRemove.has(p.id));
  }

  // Partie terminée s'il ne reste qu'une équipe (ou zéro) avec des joueurs en vie.
  _maybeEndByElimination() {
    const alive = new Set(this.players.filter(p => p.hp > 0).map(p => p.team));
    if (alive.size <= 1) this._setOver(alive.size === 1 ? [...alive][0] : -1);
  }

  _isTeamEliminated(team) {
    return this.players.filter(p => p.team === team).every(p => p.hp <= 0);
  }

  _teamHpSums() {
    const sums = new Array(this.teamCount).fill(0);
    for (const p of this.players) sums[p.team] += Math.max(0, p.hp);
    return sums;
  }

  _setOver(winnerTeam) {
    this.over = true;
    this.winnerTeam = winnerTeam ?? null;
  }

  // Récupère et vide les events accumulés depuis le dernier tick (hits, etc.)
  consumeEvents() {
    const e = this._events;
    this._events = [];
    return e;
  }

  _updateSonarWaves(now) {
    this.sonarWaves = this.sonarWaves.filter(w => now - w.startTime < SONAR.LIFETIME_MS);
  }

  _updateExposure(now) {
    for (const p of this.players) {
      if (p.exposed && now >= p.exposedUntil) p.exposed = false;
    }
  }

  _resolveTimer() {
    const sums = this._teamHpSums();
    let best = -Infinity, bestTeam = -1, tie = false;
    sums.forEach((s, t) => {
      if (s > best) { best = s; bestTeam = t; tie = false; }
      else if (s === best) { tie = true; }
    });
    if (!tie) {
      this._setOver(bestTeam);
      return { winnerTeam: bestTeam, reason: 'timer' };
    }
    // Égalité de PV : mort subite si le mode l'autorise, sinon match nul.
    if (this.suddenDeathEnabled) {
      this._enterSuddenDeath();
      return null;
    }
    this._setOver(-1);
    return { winnerTeam: -1, reason: 'timer' };
  }

  getWinnerTeam() {
    if (this.winnerTeam !== null) return this.winnerTeam;
    const aliveTeams = new Set(this.players.filter(p => p.hp > 0).map(p => p.team));
    if (aliveTeams.size === 1) return [...aliveTeams][0];
    return -1;
  }

  computeVisibility() {
    const A = this.arena;
    const S = A.CELL_SIZE;
    const total = A.COLS * A.ROWS;
    const n = this.players.length;
    // Mort subite : toute la carte est claire pour tout le monde.
    if (this.suddenDeath) {
      return this.players.map(() => new Array(total).fill(true));
    }
    const vis = this.players.map(() => new Array(total).fill(false));
    const now = Date.now();

    // Vrai sonar : seule la BANDE au front de l'onde révèle, dans la limite de
    // portée → blip fugace, pas de révélation instantanée de toute la zone.
    const lingerDist = SONAR.SPEED * (SONAR.REVEAL_LINGER_MS / 1000);
    for (const wave of this.sonarWaves) {
      if (!vis[wave.playerIndex]) continue;
      const elapsed = now - wave.startTime;
      const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
      const innerEdge = front - lingerDist;
      for (let r = 0; r < A.ROWS; r++) {
        for (let c = 0; c < A.COLS; c++) {
          const cx = c * S + S / 2;
          const cy = r * S + S / 2;
          const dist = Math.hypot(cx - wave.x, cy - wave.y);
          if (dist <= SONAR.MAX_RADIUS && dist <= front && dist >= innerEdge) {
            vis[wave.playerIndex][r * A.COLS + c] = true;
          }
        }
      }
    }

    for (let pi = 0; pi < n; pi++) {
      const p = this.players[pi];
      if (!p) continue;
      const pc = Math.floor(p.x / S);
      const pr = Math.floor(p.y / S);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = pr + dr, c = pc + dc;
          if (r >= 0 && r < A.ROWS && c >= 0 && c < A.COLS) {
            vis[pi][r * A.COLS + c] = true;
          }
        }
      }
    }

    // Vision partagée : union de la vision au sein de chaque équipe.
    if (this.sharedVision) {
      const teamMask = new Map();
      for (let pi = 0; pi < n; pi++) {
        const t = this.players[pi].team;
        let m = teamMask.get(t);
        if (!m) { m = new Array(total).fill(false); teamMask.set(t, m); }
        const v = vis[pi];
        for (let k = 0; k < total; k++) if (v[k]) m[k] = true;
      }
      for (let pi = 0; pi < n; pi++) vis[pi] = teamMask.get(this.players[pi].team);
    }

    return vis;
  }

  getState() {
    const now = Date.now();
    const visibility = this.computeVisibility();
    return {
      players: this.players.map(p => ({
        x: p.x, y: p.y, angle: p.angle, hp: p.hp, team: p.team,
        exposed: p.exposed,
        lastPingTime: p.lastPingTime,
        invincible: Date.now() < p.invincibleUntil,
      })),
      projectiles: this.projectiles.map(p => ({
        id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, playerIndex: p.playerIndex,
      })),
      sonarWaves: this.sonarWaves.map(w => ({
        id: w.id, x: w.x, y: w.y, startTime: w.startTime, playerIndex: w.playerIndex,
      })),
      visibility,
      zone: this.zone,
      timeLeft: Math.max(0, this.endTime - now),
      suddenDeath: this.suddenDeath,
    };
  }

  getFullState() {
    return { ...this.getState(), walls: this.walls, arena: this.arena };
  }

  getDurationSeconds() {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

module.exports = GameEngine;
