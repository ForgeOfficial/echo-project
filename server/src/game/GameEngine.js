const { PLAYER, SONAR, PROJECTILE, WALL, BONUS, VISION, GAME } = require('../../../shared/constants');
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
    // Mode Frags : on réapparaît après un délai et la victoire se joue au nombre
    // de kills (équipe la 1re à killTarget) plutôt qu'à l'élimination.
    this.deathmatch = mode.objective === 'deathmatch';
    this.killTarget = mode.killTarget || 0;
    this.respawnMs = mode.respawnMs || 3000;
    // Bonus ramassables : config issue du mode. Désactivés si aucun type retenu.
    this.bonusCfg = mode.bonus || { enabled: false, types: [], intervalMs: BONUS.SPAWN_INTERVAL_MS, maxOnMap: BONUS.MAX_ON_MAP };
    this.bonusEnabled = !!this.bonusCfg.enabled && (this.bonusCfg.types || []).length > 0;
    this.bonuses = [];
    this._bonusIdSeq = 0;
    this._nextBonusAt = 0;

    // Arène dimensionnée selon le nombre de joueurs (source partagée), avec un
    // multiplicateur de taille optionnel (parties custom).
    this.arena = arenaForPlayers(this.totalPlayers, mode.mapScale || 1);

    this.players = [];
    this.projectiles = [];
    this.sonarWaves = [];
    this.walls = [];
    this.zone = null;       // rectangle sûr courant (border map), sinon null
    this.startTime = null;
    this.endTime = null;
    this.over = false;
    this.winnerTeam = null; // fixé quand la partie se termine
    this.stats = Array.from({ length: this.totalPlayers }, () => ({ pings: 0, shots: 0, hits: 0, kills: 0, deaths: 0 }));
    this._projIdSeq = 0;
    this._waveIdSeq = 0;
    this._events = [];
    this.suddenDeath = false;
    // Grâce de sortie de l'interest management : _lastSeen[observer][enemy] = ts
    // de la dernière fois où l'observateur a réellement vu cet ennemi.
    this._lastSeen = [];

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
    // Densité de murs : plus dense qu'avant (labyrinthe plus marqué), un peu
    // plus clairsemée sur les grandes arènes pour ne pas isoler des joueurs.
    const density = cols > 40 ? 0.23 : 0.29;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (!safeZones.has(`${c},${r}`) && Math.random() < density) {
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
      respawnAt: 0,   // mode Frags : timestamp de réapparition quand hp<=0
      // Effets de bonus actifs (timestamps de fin ; 0 = inactif).
      fx: { speedUntil: 0, burstUntil: 0, rapidUntil: 0, shieldUntil: 0 },
    });
  }

  start() {
    this.startTime = Date.now();
    this.endTime = this.startTime + this.durationMs;
    if (this.borderMapEnabled) this._updateZone(this.startTime);
    // Premier bonus un peu plus tôt que l'intervalle plein.
    if (this.bonusEnabled) this._nextBonusAt = this.startTime + Math.round(this.bonusCfg.intervalMs * 0.5);
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
    // Bonus actifs : cadence (cooldown réduit) et rafale (3 projectiles en éventail).
    const rapid = now < p.fx.rapidUntil;
    const burst = now < p.fx.burstUntil;
    const cd = rapid ? PROJECTILE.COOLDOWN_MS * BONUS.TYPES.rapid.mult : PROJECTILE.COOLDOWN_MS;
    if (now - p.lastShotTime < cd) return null;
    const myProjectiles = this.projectiles.filter(pr => pr.playerIndex === playerIndex);
    const maxActive = PROJECTILE.MAX_ACTIVE + (burst ? 3 : 0);
    if (myProjectiles.length >= maxActive) return null;
    p.lastShotTime = now;
    this.stats[playerIndex].shots++;
    const spread = burst ? [0, -0.22, 0.22] : [0];
    // Les 3 balles partent du MÊME point (le bout du canon, dans l'axe du joueur)
    // et ne diffèrent que par leur direction → éventail propre depuis la proue.
    const muzzleX = p.x + Math.cos(p.angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2);
    const muzzleY = p.y + Math.sin(p.angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2);
    let first = null;
    for (const da of spread) {
      const ang = p.angle + da;
      const proj = {
        id: this._projIdSeq++,
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(ang) * PROJECTILE.SPEED,
        vy: Math.sin(ang) * PROJECTILE.SPEED,
        playerIndex,
      };
      this.projectiles.push(proj);
      if (!first) first = proj;
    }
    return first;
  }

  tick(dtMs) {
    if (this.over) return null;
    const dt = dtMs / 1000;
    const now = Date.now();

    // Fin du temps : départage par PV d'équipe (cf. _resolveTimer).
    if (!this.suddenDeath && now >= this.endTime) {
      return this._resolveTimer();
    }

    if (this.deathmatch) this._updateRespawns(now);
    if (this.bonusEnabled && !this.suddenDeath) this._updateBonuses(now);
    this._updatePlayers(dt, now);
    this._updateProjectiles(dt, now);
    if (this.over) return null; // un ramassage (nuke) peut terminer la partie
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
    this.bonuses = []; // pas de bonus pendant la mort subite (1 coup = victoire)
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
      const speed = PLAYER.SPEED * (now < p.fx.speedUntil ? BONUS.TYPES.speed.mult : 1);
      const newX = p.x + dx * speed * dt;
      const newY = p.y + dy * speed * dt;
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
          // On épouse le bloc VISIBLE (retrait WALL.PAD) et non la cellule entière.
          const x0 = c * S + WALL.PAD, x1 = c * S + S - WALL.PAD;
          const y0 = r * S + WALL.PAD, y1 = r * S + S - WALL.PAD;
          const nearX = Math.max(x0, Math.min(x1, x));
          const nearY = Math.max(y0, Math.min(y1, y));
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
          this._events.push({ type: 'hit', victim: ti, by: proj.playerIndex, x: proj.x, y: proj.y });
          toRemove.add(proj.id);
          // Fin de partie : mort subite (1er coup) ou une seule équipe survivante.
          if (this.suddenDeath) {
            this._setOver(shooterTeam);
          } else if (target.hp <= 0) {
            this._onKill(proj.playerIndex, ti, now);
            if (this.over) return;
          }
          break; // un projectile ne touche qu'une cible
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !toRemove.has(p.id));
  }

  // Une élimination vient d'avoir lieu (victime à 0 PV). En mode Frags : on
  // crédite le kill, on programme le respawn de la victime et on vérifie
  // l'objectif. Sinon : élimination classique (fin si une seule équipe survit).
  _onKill(killerIdx, victimIdx, now) {
    if (this.stats[victimIdx]) this.stats[victimIdx].deaths++;
    if (killerIdx >= 0 && this.stats[killerIdx]) this.stats[killerIdx].kills++;
    this._events.push({ type: 'kill', killer: killerIdx, victim: victimIdx });

    if (!this.deathmatch) { this._maybeEndByElimination(); return; }

    // Frags : la victime réapparaîtra après respawnMs.
    const victim = this.players[victimIdx];
    if (victim) victim.respawnAt = now + this.respawnMs;
    // Victoire : 1re équipe (= joueur en FFA) à atteindre l'objectif de kills.
    const killerTeam = this.players[killerIdx]?.team;
    if (killerTeam != null && this.killTarget > 0 && this._teamKills(killerTeam) >= this.killTarget) {
      this._setOver(killerTeam);
    }
  }

  _teamKills(team) {
    let sum = 0;
    this.players.forEach((p, i) => { if (p.team === team) sum += this.stats[i]?.kills || 0; });
    return sum;
  }

  // Mode Frags : réapparition des joueurs dont le délai est écoulé.
  _updateRespawns(now) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p || p.hp > 0 || !p.respawnAt) continue;
      if (now >= p.respawnAt) this._respawn(i, now);
    }
  }

  _respawn(idx, now) {
    const p = this.players[idx];
    const pt = this._pickRespawnPoint(p);
    p.x = pt.x; p.y = pt.y;
    p.vx = 0; p.vy = 0;
    p.hp = this.maxHp;
    p.respawnAt = 0;
    p.gasAccum = 0;
    p.exposed = false;
    p.fx = { speedUntil: 0, burstUntil: 0, rapidUntil: 0, shieldUntil: 0 }; // les effets ne survivent pas à la mort
    p.invincibleUntil = now + Math.max(PLAYER.INVINCIBILITY_MS, 1500); // grâce d'apparition
    p.angle = Math.atan2(this.arena.HEIGHT / 2 - p.y, this.arena.WIDTH / 2 - p.x);
    this._events.push({ type: 'respawn', playerIndex: idx });
  }

  // Choisit un point de réapparition libre (hors mur) le plus loin possible des
  // ennemis vivants → évite de réapparaître sous le feu / le spawn-camping.
  _pickRespawnPoint(forPlayer) {
    const S = this.arena.CELL_SIZE, cols = this.arena.COLS, rows = this.arena.ROWS;
    let best = null, bestScore = -Infinity;
    for (let attempt = 0; attempt < 30; attempt++) {
      const c = 1 + Math.floor(Math.random() * (cols - 2));
      const r = 1 + Math.floor(Math.random() * (rows - 2));
      if (this._wallSet.has(`${c},${r}`)) continue;
      const x = c * S + S / 2, y = r * S + S / 2;
      let nearest = Infinity;
      for (const o of this.players) {
        if (o === forPlayer || o.hp <= 0 || o.team === forPlayer.team) continue;
        nearest = Math.min(nearest, Math.hypot(x - o.x, y - o.y));
      }
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
      if (nearest > 320) break; // assez loin, on s'arrête
    }
    return best || { x: forPlayer.x, y: forPlayer.y };
  }

  // ——— BONUS ramassables ———
  _updateBonuses(now) {
    // Expiration des bonus non ramassés.
    if (this.bonuses.length) this.bonuses = this.bonuses.filter(b => now - b.spawnAt < BONUS.LIFETIME_MS);
    // Apparition (annoncée à tous via l'event 'bonusSpawn').
    if (this.bonuses.length < this.bonusCfg.maxOnMap && now >= this._nextBonusAt) {
      this._spawnBonus(now);
      const jitter = 0.8 + Math.random() * 0.4;
      this._nextBonusAt = now + Math.round(this.bonusCfg.intervalMs * jitter);
    }
    // Ramassage : un joueur vivant qui touche le pickup déclenche l'effet.
    for (let bi = this.bonuses.length - 1; bi >= 0; bi--) {
      const b = this.bonuses[bi];
      for (let pi = 0; pi < this.players.length; pi++) {
        const p = this.players[pi];
        if (!p || p.hp <= 0) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < BONUS.RADIUS + PLAYER.RADIUS) {
          this.bonuses.splice(bi, 1);
          this._applyBonus(pi, b, now);
          break;
        }
      }
      if (this.over) return;
    }
  }

  _spawnBonus(now) {
    const type = this._randomBonusType();
    if (!type) return;
    const cell = this._pickBonusCell();
    if (!cell) return;
    const b = { id: this._bonusIdSeq++, type, x: cell.x, y: cell.y, spawnAt: now };
    this.bonuses.push(b);
    this._events.push({ type: 'bonusSpawn', bonus: { id: b.id, type, x: b.x, y: b.y } });
  }

  _randomBonusType() {
    const types = this.bonusCfg.types;
    if (!types || !types.length) return null;
    return types[Math.floor(Math.random() * types.length)];
  }

  _pickBonusCell() {
    const S = this.arena.CELL_SIZE, cols = this.arena.COLS, rows = this.arena.ROWS;
    for (let attempt = 0; attempt < 40; attempt++) {
      const c = 1 + Math.floor(Math.random() * (cols - 2));
      const r = 1 + Math.floor(Math.random() * (rows - 2));
      if (this._wallSet.has(`${c},${r}`)) continue;
      const x = c * S + S / 2, y = r * S + S / 2;
      if (this.bonuses.some(b => Math.hypot(b.x - x, b.y - y) < S * 2)) continue; // espacement
      return { x, y };
    }
    return null;
  }

  _applyBonus(pi, b, now) {
    const p = this.players[pi];
    if (!p) return;
    switch (b.type) {
      case 'life':   p.hp = Math.min(this.maxHp + 2, p.hp + 1); break;
      case 'speed':  p.fx.speedUntil = now + BONUS.TYPES.speed.dur; break;
      case 'burst':  p.fx.burstUntil = now + BONUS.TYPES.burst.dur; break;
      case 'rapid':  p.fx.rapidUntil = now + BONUS.TYPES.rapid.dur; break;
      case 'shield':
        p.fx.shieldUntil = now + BONUS.TYPES.shield.dur;
        p.invincibleUntil = Math.max(p.invincibleUntil, p.fx.shieldUntil);
        break;
      case 'nuke':   this._detonateNuke(pi, now); break;
    }
    this._events.push({ type: 'bonusPickup', playerIndex: pi, bonus: b.type });
  }

  // Nuke (Frags) : élimine d'un coup tous les adversaires vivants (un bouclier
  // protège). Chaque mort passe par _onKill → crédite les frags et peut clore la partie.
  _detonateNuke(killerIdx, now) {
    const killer = this.players[killerIdx];
    if (!killer) return;
    this._events.push({ type: 'nuke', x: killer.x, y: killer.y, by: killerIdx });
    for (let ti = 0; ti < this.players.length; ti++) {
      const t = this.players[ti];
      if (!t || t.hp <= 0 || t.team === killer.team) continue;
      if (now <= t.invincibleUntil) continue; // bouclier / invincibilité → épargné
      t.hp = 0;
      this._events.push({ type: 'hit', victim: ti, by: killerIdx, x: t.x, y: t.y });
      this._onKill(killerIdx, ti, now);
      if (this.over) return;
    }
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
    // Frags : au temps, c'est l'équipe avec le plus de kills qui l'emporte.
    if (this.deathmatch) return this._resolveByKills();
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

  // Départage Frags au temps écoulé : plus grand cumul de kills par équipe.
  _resolveByKills() {
    const kills = new Array(this.teamCount).fill(0);
    this.players.forEach((p, i) => { kills[p.team] += this.stats[i]?.kills || 0; });
    let best = -Infinity, bestTeam = -1, tie = false;
    kills.forEach((k, t) => {
      if (k > best) { best = k; bestTeam = t; tie = false; }
      else if (k === best) { tie = true; }
    });
    const winnerTeam = tie ? -1 : bestTeam;
    this._setOver(winnerTeam);
    return { winnerTeam, reason: 'timer' };
  }

  getWinnerTeam() {
    if (this.winnerTeam !== null) return this.winnerTeam;
    const aliveTeams = new Set(this.players.filter(p => p.hp > 0).map(p => p.team));
    if (aliveTeams.size === 1) return [...aliveTeams][0];
    return -1;
  }

  // Interest management : état taillé pour un observateur. On n'envoie la
  // position réelle d'un ennemi (et de ses projectiles) que s'il est réellement
  // « vu » — sinon le slot est conservé avec x/y/angle = null (HUD : hp + équipe
  // restent envoyés). Ferme la faille wallhack ET divise la bande passante.
  //
  // Un ennemi E est visible pour l'observateur O si AU MOINS une condition :
  //   1. à ≤ VIEW_RADIUS d'un joueur vivant de l'équipe de O (proximité partagée)
  //   2. balayé par la bande au front d'une onde sonar de l'équipe de O
  //   3. exposé (il vient de pinger → il se trahit)
  //   4. mort subite (tout le monde se voit)
  //   5. grâce : vu il y a moins de GRACE_MS (fondu de sortie)
  getStateFor(observerIndex) {
    const now = Date.now();
    const sd = this.suddenDeath;
    const observer = this.players[observerIndex];
    const obsTeam = observer ? observer.team : -1;
    // Observateur mort (Frags, en attente de respawn) : il ne voit plus personne,
    // même via le sonar d'un coéquipier → on lui sert une arène vide.
    const observerDead = !observer || observer.hp <= 0;

    // Sources de révélation de l'équipe de l'observateur : coéquipiers vivants
    // (proximité) + bandes au front des ondes sonar de l'équipe.
    const sources = [];
    for (const p of this.players) {
      if (p.hp > 0 && p.team === obsTeam) sources.push(p);
    }
    const lingerDist = SONAR.SPEED * (SONAR.REVEAL_LINGER_MS / 1000);
    const bands = [];
    const teamWaves = [];
    for (const w of this.sonarWaves) {
      const owner = this.players[w.playerIndex];
      if (!owner || owner.team !== obsTeam) continue;
      teamWaves.push(w);
      const elapsed = now - w.startTime;
      const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
      if (front > 0) bands.push({ x: w.x, y: w.y, front, inner: front - lingerDist });
    }

    const revealsPoint = (x, y) => {
      for (const s of sources) {
        if (Math.hypot(x - s.x, y - s.y) <= VISION.VIEW_RADIUS) return true;
      }
      for (const b of bands) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d <= SONAR.MAX_RADIUS && d <= b.front && d >= b.inner) return true;
      }
      return false;
    };

    const seen = (this._lastSeen[observerIndex] || (this._lastSeen[observerIndex] = {}));
    // Effets de bonus actifs → ms restantes par effet (rendu + HUD). Omis si vide.
    const fxOf = (p) => {
      const s = p.fx, f = {};
      if (now < s.shieldUntil) f.shield = s.shieldUntil - now;
      if (now < s.speedUntil)  f.speed  = s.speedUntil - now;
      if (now < s.burstUntil)  f.burst  = s.burstUntil - now;
      if (now < s.rapidUntil)  f.rapid  = s.rapidUntil - now;
      return f;
    };
    const full = (p, withPing) => {
      const o = { x: p.x, y: p.y, angle: p.angle, hp: p.hp, team: p.team, exposed: p.exposed };
      const f = fxOf(p);
      if (Object.keys(f).length) o.fx = f;
      if (withPing) {
        o.lastPingTime = p.lastPingTime;   // utile seulement pour soi (anneau de cooldown)
        // Frags : temps restant avant réapparition (ms relatif → insensible au
        // décalage d'horloge client/serveur).
        if (p.hp <= 0 && p.respawnAt) o.respawnIn = Math.max(0, p.respawnAt - now);
      }
      return o;
    };

    const players = this.players.map((p, i) => {
      // Soi-même : toujours en clair.
      if (i === observerIndex) return full(p, true);
      // Culé : on ne garde que ce dont le HUD a besoin (hp + team). x:null =
      // sentinelle « hors-vue » (pas de position → pas dessiné) ; angle/exposed
      // sont inutiles sur un slot invisible.
      const culled = { x: null, y: null, hp: p.hp, team: p.team };
      // Mort en attente de respawn : aucune intel sur autrui (ni allié ni ennemi).
      if (observerDead) return culled;
      // Coéquipiers : toujours en clair.
      if (p.team === obsTeam) return full(p, false);
      // Ennemi mort : pas de position (non dessiné de toute façon), HUD garde hp.
      if (p.hp <= 0) return culled;
      // Ennemi vivant : soumis à l'interest management.
      let visible = sd || p.exposed || revealsPoint(p.x, p.y);
      if (visible) {
        seen[i] = now;
      } else if (seen[i] && now - seen[i] < VISION.GRACE_MS) {
        visible = true; // grâce de sortie
      }
      if (!visible) return culled;
      return full(p, false);
    });

    // Frags : le nombre de kills est public (tableau des scores) pour tous les slots.
    if (this.deathmatch) {
      players.forEach((o, i) => { o.kills = this.stats[i]?.kills || 0; });
    }

    const projectiles = [];
    if (!observerDead) for (const pr of this.projectiles) {
      const owner = this.players[pr.playerIndex];
      const friendly = owner && owner.team === obsTeam;
      if (friendly || sd || revealsPoint(pr.x, pr.y)) {
        projectiles.push({ id: pr.id, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, playerIndex: pr.playerIndex });
      }
    }

    return {
      players,
      projectiles,
      // Toutes les ondes (alliées ET ennemies) sont envoyées pour l'affichage :
      // pinger expose globalement l'émetteur (cf. handlePing → exposed), donc sa
      // position d'émission est déjà révélée — montrer l'anneau ne fuite rien de
      // plus, et le client ne tire AUCUNE vision d'une onde ennemie (mask/fog
      // restent filtrés sur l'équipe). Aucune onde tant qu'on est mort.
      sonarWaves: observerDead ? [] : this.sonarWaves
        .filter(w => this.players[w.playerIndex])
        .map(w => ({ id: w.id, x: w.x, y: w.y, startTime: w.startTime, playerIndex: w.playerIndex })),
      zone: this.zone,
      // Bonus visibles de tous (l'annonce passe par un event, mais le pickup
      // reste affiché sur la carte pour que chacun puisse aller le chercher).
      bonuses: this.bonuses.map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y, spawnAt: b.spawnAt })),
      timeLeft: Math.max(0, this.endTime - now),
      suddenDeath: sd,
    };
  }

  getFullStateFor(observerIndex) {
    return { ...this.getStateFor(observerIndex), walls: this.walls, arena: this.arena };
  }

  getDurationSeconds() {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

module.exports = GameEngine;
