const { ARENA, PLAYER, SONAR, PROJECTILE, GAME } = require('../../../shared/constants');

class GameEngine {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.projectiles = [];
    this.sonarWaves = [];
    this.walls = [];
    this.startTime = null;
    this.endTime = null;
    this.over = false;
    this.stats = [
      { pings: 0, shots: 0, hits: 0 },
      { pings: 0, shots: 0, hits: 0 },
    ];
    this._projIdSeq = 0;
    this._waveIdSeq = 0;
    this._events = [];
    this.suddenDeath = false;
    this._spawnCells = this._pickSpawns();
    this._generateMap();
  }

  // Deux spawns aléatoires (hors bordure) avec une distance minimum pour
  // l'équité : aucun joueur ne démarre collé à l'autre.
  _pickSpawns() {
    const cols = ARENA.COLS, rows = ARENA.ROWS;
    const minDist = Math.round(Math.min(cols, rows) * 0.75); // ~11 cellules
    const rndCell = () => [
      1 + Math.floor(Math.random() * (cols - 2)),
      1 + Math.floor(Math.random() * (rows - 2)),
    ];
    for (let tries = 0; tries < 200; tries++) {
      const a = rndCell();
      const b = rndCell();
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= minDist) return [a, b];
    }
    // garde-fou : coins opposés
    return [[1, 1], [cols - 2, rows - 2]];
  }

  _generateMap() {
    const walls = [];
    const cols = ARENA.COLS;
    const rows = ARENA.ROWS;
    const S = ARENA.CELL_SIZE;
    const safeZones = new Set();
    // Protéger une zone 3×3 autour de CHAQUE cellule de spawn pour qu'aucun
    // joueur ne démarre dans (ou collé à) un mur.
    this._spawnCells.forEach(([sc, sr]) => {
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
    this._wallSet = new Set(walls.map(w => `${Math.floor(w.x/S)},${Math.floor(w.y/S)}`));
  }

  addPlayer(userId, pseudo, elo, socketId) {
    const idx = this.players.length;
    const S = ARENA.CELL_SIZE;
    const startPositions = this._spawnCells.map(([c, r]) => ({
      x: c * S + S / 2,
      y: r * S + S / 2,
    }));
    this.players.push({
      userId,
      pseudo,
      elo,
      socketId,
      x: startPositions[idx].x,
      y: startPositions[idx].y,
      vx: 0,
      vy: 0,
      angle: idx === 0 ? 0 : Math.PI,
      hp: PLAYER.MAX_HP,
      invincibleUntil: 0,
      lastPingTime: 0,
      lastShotTime: 0,
      inputs: { up: false, down: false, left: false, right: false },
      exposed: false,
      exposedUntil: 0,
    });
  }

  start() {
    this.startTime = Date.now();
    this.endTime = this.startTime + GAME.MAX_DURATION_MS;
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
    if (!p) return null;
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
    // Pinger = s'exposer : c'est le PINGEUR dont la position est révélée à
    // l'adversaire. Le pingeur, lui, ne voit l'autre que si son onde l'atteint.
    p.exposed = true;
    p.exposedUntil = now + SONAR.EXPOSE_DURATION_MS;
    return wave;
  }

  handleShoot(playerIndex) {
    const p = this.players[playerIndex];
    if (!p) return null;
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

    // Fin du temps : si égalité de vies → mort subite, sinon fin normale.
    if (!this.suddenDeath && now >= this.endTime) {
      return this._resolveTimer();
    }

    this._updatePlayers(dt, now);
    this._updateProjectiles(dt, now);
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
    this.players.forEach(p => { p.exposed = false; });
  }

  _updatePlayers(dt, now) {
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
      const clampedX = Math.max(PLAYER.RADIUS, Math.min(ARENA.WIDTH - PLAYER.RADIUS, newX));
      const clampedY = Math.max(PLAYER.RADIUS, Math.min(ARENA.HEIGHT - PLAYER.RADIUS, newY));
      // collision murs + collision avec l'autre joueur (pas de chevauchement)
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
    const S = ARENA.CELL_SIZE;
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
    const toRemove = new Set();
    for (const proj of this.projectiles) {
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      if (proj.x < 0 || proj.x > ARENA.WIDTH || proj.y < 0 || proj.y > ARENA.HEIGHT) {
        toRemove.add(proj.id);
        continue;
      }
      if (this._collidesWithWall(proj.x, proj.y, PROJECTILE.RADIUS)) {
        toRemove.add(proj.id);
        continue;
      }
      const targetIdx = 1 - proj.playerIndex;
      const target = this.players[targetIdx];
      if (target && target.hp > 0 && now > target.invincibleUntil) {
        const dist = Math.hypot(proj.x - target.x, proj.y - target.y);
        if (dist < PLAYER.RADIUS + PROJECTILE.RADIUS) {
          target.hp--;
          target.invincibleUntil = now + PLAYER.INVINCIBILITY_MS;
          this.stats[proj.playerIndex].hits++;
          this._events.push({ type: 'hit', victim: targetIdx, by: proj.playerIndex });
          toRemove.add(proj.id);
          // Mort subite : le premier coup au but met fin à la partie.
          if (target.hp <= 0 || this.suddenDeath) {
            this.over = true;
          }
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !toRemove.has(p.id));
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
    const [p0, p1] = this.players;
    if (p0.hp === p1.hp) {
      // Égalité de vies → on bascule en mort subite au lieu de finir.
      this._enterSuddenDeath();
      return null;
    }
    this.over = true;
    return { winnerIndex: p0.hp > p1.hp ? 0 : 1, reason: 'timer' };
  }

  getWinnerIndex() {
    if (!this.over) return null;
    const [p0, p1] = this.players;
    if (p0.hp <= 0 && p1.hp > 0) return 1;
    if (p1.hp <= 0 && p0.hp > 0) return 0;
    if (p0.hp > p1.hp) return 0;
    if (p1.hp > p0.hp) return 1;
    return -1;
  }

  computeVisibility() {
    const S = ARENA.CELL_SIZE;
    const total = ARENA.COLS * ARENA.ROWS;
    // Mort subite : toute la carte est claire pour les deux joueurs.
    if (this.suddenDeath) {
      return [new Array(total).fill(true), new Array(total).fill(true)];
    }
    const vis = [new Array(total).fill(false), new Array(total).fill(false)];
    const now = Date.now();

    // Vrai sonar : seule la BANDE au front de l'onde révèle, dans la limite
    // de portée. Une cellule n'est éclairée que si le front vient de la
    // balayer (dans la fenêtre de linger) → blip fugace, pas de révélation
    // instantanée de toute la zone.
    const lingerDist = SONAR.SPEED * (SONAR.REVEAL_LINGER_MS / 1000);
    for (const wave of this.sonarWaves) {
      const elapsed = now - wave.startTime;
      const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
      const innerEdge = front - lingerDist;
      for (let r = 0; r < ARENA.ROWS; r++) {
        for (let c = 0; c < ARENA.COLS; c++) {
          const cx = c * S + S / 2;
          const cy = r * S + S / 2;
          const dist = Math.hypot(cx - wave.x, cy - wave.y);
          // dans la portée, derrière le front, mais pas plus vieux que le linger
          if (dist <= SONAR.MAX_RADIUS && dist <= front && dist >= innerEdge) {
            vis[wave.playerIndex][r * ARENA.COLS + c] = true;
          }
        }
      }
    }

    for (let pi = 0; pi < 2; pi++) {
      const p = this.players[pi];
      if (!p) continue;
      const pc = Math.floor(p.x / S);
      const pr = Math.floor(p.y / S);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = pr + dr, c = pc + dc;
          if (r >= 0 && r < ARENA.ROWS && c >= 0 && c < ARENA.COLS) {
            vis[pi][r * ARENA.COLS + c] = true;
          }
        }
      }
    }
    return vis;
  }

  getState() {
    const now = Date.now();
    const visibility = this.computeVisibility();
    return {
      players: this.players.map(p => ({
        x: p.x, y: p.y, angle: p.angle, hp: p.hp,
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
      timeLeft: Math.max(0, this.endTime - now),
      suddenDeath: this.suddenDeath,
    };
  }

  getFullState() {
    return { ...this.getState(), walls: this.walls };
  }

  getDurationSeconds() {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

module.exports = GameEngine;
