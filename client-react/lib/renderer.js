import { ARENA, PLAYER, SONAR, PROJECTILE } from './constants';

const DEFAULT_TEAM_COLORS = ['0,255,255', '255,0,255']; // équipe 0 cyan, 1 magenta

// Détection de proximité d'un ennemi : pleinement visible sous NEAR, fondu
// progressif jusqu'à disparaître au-delà de FAR.
const PROX_NEAR = 80;
const PROX_FAR = 185;

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class GameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.canvas.width = ARENA.WIDTH;
    this.canvas.height = ARENA.HEIGHT;
    this.myPlayerIndex = 0;
    this.myTeam = 0;
    this.teamColors = DEFAULT_TEAM_COLORS;
    this._rafId = null;
    this._lastTs = 0;
    this._hitFlash = [];
    this._lastWalls = null;

    // Interpolation : on bufferise les snapshots serveur et on rend avec un
    // léger retard en lissant entre deux états → mouvement fluide à 60fps.
    this._buffer = [];
    this._interpDelay = 90; // ms (≈ 2,7 ticks à 30Hz, absorbe le jitter)

    // Prédiction locale : MON perso est simulé côté client (physique identique
    // au serveur) pour une réponse instantanée, puis réconcilié en douceur avec
    // l'autorité serveur. Les autres restent interpolés (cf. _interpDelay).
    this._predEnabled = false;
    this._getInputs = null;     // () => { up, down, left, right }
    this._pred = null;          // { x, y, angle } position prédite, ou null (mort/non init)
    this._wallSetPred = null;   // Set("col,row") pour la collision locale

    this._celebration = null;
    this._confetti = [];
    this._lastCelebTs = 0;

    // Calques offscreen réutilisés (l'environnement passe par le fog, le reste est net)
    this._scene = this._makeLayer();
    this._mask = this._makeLayer();
  }

  _teamColor(team) {
    return this.teamColors[team] || this.teamColors[0] || DEFAULT_TEAM_COLORS[0];
  }

  // Coéquipiers vivants (moi inclus) : sources de vision partagée.
  _friendlies(s) {
    return (s.players || []).filter(p => p && p.team === this.myTeam && p.hp > 0);
  }

  _makeLayer() {
    const c = document.createElement('canvas');
    c.width = ARENA.WIDTH;
    c.height = ARENA.HEIGHT;
    return { canvas: c, ctx: c.getContext('2d') };
  }

  start() { this._rafId = requestAnimationFrame(ts => this._loop(ts)); }
  stop() { if (this._rafId) cancelAnimationFrame(this._rafId); this._rafId = null; }

  setState(state) {
    if (state.walls) {
      this._lastWalls = state.walls;
      // Index des murs pour la collision prédite (mêmes clés que le serveur).
      this._wallSetPred = new Set(
        state.walls.map(w => `${Math.round(w.x / ARENA.CELL_SIZE)},${Math.round(w.y / ARENA.CELL_SIZE)}`)
      );
    }
    this._buffer.push({ t: performance.now(), state });
    if (this._buffer.length > 16) this._buffer.shift();
  }

  // Active la prédiction du joueur local. getInputs() doit renvoyer l'état
  // d'entrée courant (le même qui est envoyé au serveur).
  enablePrediction(getInputs) {
    this._getInputs = getInputs;
    this._predEnabled = true;
  }

  // Avance la position prédite d'une frame, puis la réconcilie avec le serveur.
  _stepPrediction(dtMs) {
    if (!this._predEnabled || !this._getInputs) return;
    const latest = this._buffer[this._buffer.length - 1]?.state;
    const me = latest?.players?.[this.myPlayerIndex];
    if (!me) return;
    if (me.hp <= 0) { this._pred = null; return; }       // mort → on affiche le serveur
    if (!this._pred) { this._pred = { x: me.x, y: me.y, angle: me.angle || 0 }; }

    const dt = Math.min(dtMs, 50) / 1000;                // clamp anti-saut (onglet en arrière-plan)
    const inp = this._getInputs();
    let dx = 0, dy = 0;
    if (inp.up) dy -= 1;
    if (inp.down) dy += 1;
    if (inp.left) dx -= 1;
    if (inp.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx /= Math.SQRT2; dy /= Math.SQRT2; }
    if (dx !== 0 || dy !== 0) this._pred.angle = Math.atan2(dy, dx);

    let nx = this._pred.x + dx * PLAYER.SPEED * dt;
    let ny = this._pred.y + dy * PLAYER.SPEED * dt;
    nx = Math.max(PLAYER.RADIUS, Math.min(ARENA.WIDTH - PLAYER.RADIUS, nx));
    ny = Math.max(PLAYER.RADIUS, Math.min(ARENA.HEIGHT - PLAYER.RADIUS, ny));
    // Collision axe par axe, exactement comme le serveur (murs désactivés en mort subite).
    const useWalls = !latest.suddenDeath;
    if (!(useWalls && this._predWall(nx, this._pred.y)) && !this._predPlayer(latest, nx, this._pred.y)) this._pred.x = nx;
    if (!(useWalls && this._predWall(this._pred.x, ny)) && !this._predPlayer(latest, this._pred.x, ny)) this._pred.y = ny;

    // Réconciliation : zone morte = l'avance de prédiction normale due à la
    // latence (on ne la corrige pas → pas de rubber-band). Au-delà = vrai
    // désync (poussée d'un adversaire, perte de paquet) → on rattrape en douceur.
    const err = Math.hypot(me.x - this._pred.x, me.y - this._pred.y);
    if (err > 90) {
      this._pred.x = me.x; this._pred.y = me.y;          // gros écart → snap
    } else if (err > 28) {
      const k = 0.18;
      this._pred.x += (me.x - this._pred.x) * k;
      this._pred.y += (me.y - this._pred.y) * k;
    }
  }

  _predWall(x, y) {
    const set = this._wallSetPred;
    if (!set || set.size === 0) return false;
    const S = ARENA.CELL_SIZE, R = PLAYER.RADIUS;
    const minC = Math.floor((x - R) / S), maxC = Math.floor((x + R) / S);
    const minR = Math.floor((y - R) / S), maxR = Math.floor((y + R) / S);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (set.has(`${c},${r}`)) {
          const wx = c * S, wy = r * S;
          const nearX = Math.max(wx, Math.min(wx + S, x));
          const nearY = Math.max(wy, Math.min(wy + S, y));
          if (Math.hypot(x - nearX, y - nearY) < R) return true;
        }
      }
    }
    return false;
  }

  _predPlayer(latest, x, y) {
    const players = latest.players || [];
    const min = PLAYER.RADIUS * 2;
    for (let i = 0; i < players.length; i++) {
      if (i === this.myPlayerIndex) continue;
      const o = players[i];
      if (!o || o.hp <= 0) continue;
      if (Math.hypot(x - o.x, y - o.y) < min) return true;
    }
    return false;
  }

  // Reconstruit un état positionnel interpolé à (now - délai).
  _sampleState() {
    const buf = this._buffer;
    if (buf.length === 0) return null;
    const latest = buf[buf.length - 1].state;
    const base = {
      visibility: latest.visibility,
      sonarWaves: latest.sonarWaves,
      timeLeft: latest.timeLeft,
      suddenDeath: latest.suddenDeath,
      walls: this._lastWalls,
    };
    let players, projectiles;
    if (buf.length === 1) {
      players = latest.players;
      projectiles = latest.projectiles;
    } else {
      const renderT = performance.now() - this._interpDelay;
      let a = buf[0], b = buf[1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderT && buf[i + 1].t >= renderT) { a = buf[i]; b = buf[i + 1]; break; }
        a = buf[i]; b = buf[i + 1];
      }
      const span = b.t - a.t;
      let f = span > 0 ? (renderT - a.t) / span : 1;
      f = Math.max(0, Math.min(1, f));
      players = this._lerpPlayers(a.state.players, b.state.players, f);
      projectiles = this._lerpProjectiles(a.state.projectiles, b.state.projectiles, f);
    }

    // MON perso : on remplace la position serveur (en retard) par la position
    // prédite localement → réponse instantanée aux entrées.
    if (this._pred && players && players[this.myPlayerIndex]) {
      players = players.slice();
      players[this.myPlayerIndex] = {
        ...players[this.myPlayerIndex],
        x: this._pred.x, y: this._pred.y, angle: this._pred.angle,
      };
    }
    return { ...base, players, projectiles };
  }

  _lerpAngle(a, b, f) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * f;
  }

  _lerpPlayers(pa, pb, f) {
    if (!pb) return pa || [];
    if (!pa) return pb;
    return pb.map((b, i) => {
      const a = pa[i];
      if (!a) return b;
      return {
        ...b,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: this._lerpAngle(a.angle || 0, b.angle || 0, f),
      };
    });
  }

  _lerpProjectiles(pa, pb, f) {
    if (!pb) return [];
    const aById = new Map((pa || []).map(p => [p.id, p]));
    return pb.map(b => {
      const a = aById.get(b.id);
      if (!a) return b;
      return { ...b, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    });
  }

  triggerHit(playerIndex) { this._hitFlash[playerIndex] = 500; }

  // Lance la célébration de l'équipe gagnante (à la dernière position connue
  // d'un de ses joueurs).
  startCelebration(winnerTeam) {
    const last = this._buffer[this._buffer.length - 1]?.state;
    const wp = last?.players?.find(p => p.team === winnerTeam && p.hp > 0)
      || last?.players?.find(p => p.team === winnerTeam);
    const x = wp?.x ?? ARENA.WIDTH / 2;
    const y = wp?.y ?? ARENA.HEIGHT / 2;
    this._celebration = { winnerTeam, x, y, start: Date.now() };
    this._lastCelebTs = Date.now();
    const color = this._teamColor(winnerTeam);
    this._confetti = [];
    for (let i = 0; i < 100; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 360;
      this._confetti.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 140,
        life: 0, max: 1300 + Math.random() * 1300,
        size: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 10,
        white: Math.random() < 0.35,
        color,
      });
    }
  }

  _loop(ts) {
    const dt = ts - this._lastTs;
    this._lastTs = ts;
    for (let i = 0; i < this._hitFlash.length; i++) {
      this._hitFlash[i] = Math.max(0, (this._hitFlash[i] || 0) - dt);
    }
    this._stepPrediction(dt);
    this._draw();
    this._rafId = requestAnimationFrame(ts2 => this._loop(ts2));
  }

  _isVisible(s, x, y) {
    const vis = s.visibility?.[this.myPlayerIndex];
    if (!vis) return true;
    const col = Math.floor(x / ARENA.CELL_SIZE);
    const row = Math.floor(y / ARENA.CELL_SIZE);
    if (col < 0 || col >= ARENA.COLS || row < 0 || row >= ARENA.ROWS) return false;
    return vis[row * ARENA.COLS + col];
  }

  _draw() {
    const ctx = this.ctx;
    const now = Date.now();
    if (this._celebration) { this._drawCelebration(ctx, now); return; }

    const s = this._sampleState();
    const W = ARENA.WIDTH, H = ARENA.HEIGHT;

    if (s && s.suddenDeath) { this._drawSuddenDeath(ctx, s, now); return; }

    // ——— 1. Fond : abysse en dégradé ———
    const bg = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.75);
    bg.addColorStop(0, '#06141f');
    bg.addColorStop(1, '#01060d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    this._drawGrid(now);

    if (!s) { this._drawFrame(now); return; }

    // ——— 2. Environnement "découvert" (murs) sur le calque scène, puis fog ———
    const sctx = this._scene.ctx;
    sctx.clearRect(0, 0, W, H);
    this._drawWalls(sctx, s);
    this._buildMask(s, now);
    sctx.save();
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(this._mask.canvas, 0, 0);
    sctx.restore();
    ctx.drawImage(this._scene.canvas, 0, 0);

    // ——— 3. Éléments nets par-dessus le fog ———
    this._drawSonarWaves(ctx, s, now);
    this._drawProjectiles(ctx, s);
    this._drawEnemies(ctx, s, now);
    this._drawTeammates(ctx, s, now);
    this._drawSelf(ctx, s, now);

    // ——— 4. Cadre + vignette ———
    this._drawFrame(now);
    this._drawVignette();
  }

  // Mort subite : arène entièrement claire, sans murs ni brouillard, teinte
  // rouge de tension. Tous les joueurs sont pleinement visibles.
  _drawSuddenDeath(ctx, s, now) {
    const W = ARENA.WIDTH, H = ARENA.HEIGHT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.75);
    bg.addColorStop(0, '#1a0810');
    bg.addColorStop(1, '#0a0206');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.strokeStyle = `rgba(255,60,80,${0.05 + 0.03 * pulse})`;
    ctx.lineWidth = 1;
    for (let x = ARENA.CELL_SIZE; x < W; x += ARENA.CELL_SIZE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = ARENA.CELL_SIZE; y < H; y += ARENA.CELL_SIZE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();

    this._drawProjectiles(ctx, s);
    if (s.players) {
      s.players.forEach((p, idx) => {
        if (!p || p.hp <= 0 || idx === this.myPlayerIndex) return;
        const isHit = (this._hitFlash[idx] || 0) > 0;
        if (isHit && Math.floor(now / 80) % 2 === 0) return;
        this._drawEntity(ctx, p, this._teamColor(p.team), now, { self: false, alpha: 1 });
      });
    }
    this._drawSelf(ctx, s, now);

    ctx.save();
    ctx.strokeStyle = `rgba(255,60,80,${0.6 + 0.3 * pulse})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(255,60,80,0.7)';
    ctx.shadowBlur = 16;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.restore();
    this._drawVignette();
  }

  _drawGrid(now) {
    const ctx = this.ctx;
    const pulse = 0.025 + 0.012 * Math.sin(now / 1400);
    ctx.save();
    ctx.strokeStyle = `rgba(0,255,255,${pulse})`;
    ctx.lineWidth = 1;
    for (let x = ARENA.CELL_SIZE; x < ARENA.WIDTH; x += ARENA.CELL_SIZE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.HEIGHT); ctx.stroke();
    }
    for (let y = ARENA.CELL_SIZE; y < ARENA.HEIGHT; y += ARENA.CELL_SIZE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.WIDTH, y); ctx.stroke();
    }
    ctx.restore();
  }

  // Masque de lumière doux : halos des coéquipiers (vision partagée) + disques
  // feutrés au front des ondes de mon équipe.
  _buildMask(s, now) {
    const mctx = this._mask.ctx;
    mctx.clearRect(0, 0, ARENA.WIDTH, ARENA.HEIGHT);

    for (const f of this._friendlies(s)) {
      const auraR = 95;
      const g = mctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, auraR);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      mctx.fillStyle = g;
      mctx.beginPath(); mctx.arc(f.x, f.y, auraR, 0, Math.PI * 2); mctx.fill();
    }

    if (s.sonarWaves) {
      const lingerDist = SONAR.SPEED * (SONAR.REVEAL_LINGER_MS / 1000);
      for (const wave of s.sonarWaves) {
        if (s.players?.[wave.playerIndex]?.team !== this.myTeam) continue; // seulement mon équipe
        const elapsed = now - wave.startTime;
        const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
        if (front <= 0) continue;
        const life = Math.max(0, 1 - elapsed / SONAR.LIFETIME_MS);
        if (life <= 0) continue;
        const inner = Math.max(0, (front - lingerDist) / front);
        const g = mctx.createRadialGradient(wave.x, wave.y, 0, wave.x, wave.y, front);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(inner, 'rgba(255,255,255,0)');
        g.addColorStop((inner + 1) / 2, `rgba(255,255,255,${0.35 * life})`);
        g.addColorStop(0.95, `rgba(255,255,255,${0.6 * life})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        mctx.fillStyle = g;
        mctx.beginPath(); mctx.arc(wave.x, wave.y, front, 0, Math.PI * 2); mctx.fill();
      }
    }
  }

  _drawWalls(ctx, s) {
    if (!s.walls) return;
    const R = 6;
    s.walls.forEach(w => {
      if (!this._isVisible(s, w.x + ARENA.CELL_SIZE / 2, w.y + ARENA.CELL_SIZE / 2)) return;
      const x = w.x + 3, y = w.y + 3, sz = ARENA.CELL_SIZE - 6;
      const g = ctx.createLinearGradient(x, y, x, y + sz);
      g.addColorStop(0, '#123047');
      g.addColorStop(1, '#0a1c2c');
      ctx.fillStyle = g;
      this._roundRect(ctx, x, y, sz, sz, R);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,255,255,0.22)';
      ctx.lineWidth = 1;
      this._roundRect(ctx, x + 0.5, y + 0.5, sz - 1, sz - 1, R);
      ctx.stroke();
    });
  }

  _drawSonarWaves(ctx, s, now) {
    if (!s.sonarWaves) return;
    ctx.save();
    s.sonarWaves.forEach(wave => {
      const elapsed = now - wave.startTime;
      const radius = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
      const progress = elapsed / SONAR.LIFETIME_MS;
      if (progress >= 1 || radius <= 0) return;
      const alpha = Math.max(0, 1 - progress);
      const color = this._teamColor(s.players?.[wave.playerIndex]?.team);
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${alpha * 0.9})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgba(${color},0.8)`;
      ctx.shadowBlur = 20;
      ctx.stroke();
      if (radius > 24) {
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius - 14, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color},${alpha * 0.18})`;
        ctx.lineWidth = 1;
        ctx.shadowBlur = 4;
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  _drawProjectiles(ctx, s) {
    if (!s.projectiles) return;
    ctx.save();
    s.projectiles.forEach(p => {
      // Les tirs de mon équipe sont toujours visibles ; ceux des ennemis
      // seulement dans les zones révélées.
      const friendly = s.players?.[p.playerIndex]?.team === this.myTeam;
      if (!friendly && !s.suddenDeath && !this._isVisible(s, p.x, p.y)) return;
      const color = this._teamColor(s.players?.[p.playerIndex]?.team);
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 0) {
        const tx = p.x - (p.vx / speed) * 18, ty = p.y - (p.vy / speed) * 18;
        const tg = ctx.createLinearGradient(p.x, p.y, tx, ty);
        tg.addColorStop(0, `rgba(${color},0.6)`);
        tg.addColorStop(1, `rgba(${color},0)`);
        ctx.strokeStyle = tg;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, PROJECTILE.RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = `rgba(${color},1)`;
      ctx.shadowBlur = 16;
      ctx.fill();
    });
    ctx.restore();
  }

  // Ennemis : révélés selon 3 sources avec un fondu progressif (pas de "pop") :
  //  - proximité d'un de mes coéquipiers (vision partagée)
  //  - onde sonar de mon équipe qui les balaie
  //  - exposition : quand ils pingent (ils se trahissent)
  _drawEnemies(ctx, s, now) {
    if (!s.players) return;
    const friendlies = this._friendlies(s);
    s.players.forEach((p, idx) => {
      if (!p || p.hp <= 0 || p.team === this.myTeam) return;
      const isHit = (this._hitFlash[idx] || 0) > 0;
      if (isHit && Math.floor(now / 80) % 2 === 0) return;

      let alpha = 0;
      for (const f of friendlies) {
        const dist = Math.hypot(p.x - f.x, p.y - f.y);
        alpha = Math.max(alpha, 1 - smoothstep(PROX_NEAR, PROX_FAR, dist));
      }
      if (this._isVisible(s, p.x, p.y)) alpha = Math.max(alpha, 1);
      if (p.exposed) alpha = Math.max(alpha, 1);
      if (alpha <= 0.02) return;

      this._drawEntity(ctx, p, this._teamColor(p.team), now, { self: false, alpha });
    });
  }

  // Coéquipiers (hors moi) : toujours visibles grâce à la vision partagée.
  _drawTeammates(ctx, s, now) {
    if (!s.players) return;
    s.players.forEach((p, idx) => {
      if (!p || p.hp <= 0 || idx === this.myPlayerIndex || p.team !== this.myTeam) return;
      const isHit = (this._hitFlash[idx] || 0) > 0;
      if (isHit && Math.floor(now / 80) % 2 === 0) return;
      this._drawEntity(ctx, p, this._teamColor(p.team), now, { self: false, alpha: 1 });
    });
  }

  // Mon entité : echo core net + balayage radar + cooldown
  _drawSelf(ctx, s, now) {
    if (!s.players) return;
    const me = s.players[this.myPlayerIndex];
    if (!me || me.hp <= 0) return;
    const isHit = (this._hitFlash[this.myPlayerIndex] || 0) > 0;
    if (isHit && Math.floor(now / 70) % 2 === 0) return;
    this._drawSelfMarker(ctx, me, now);
    this._drawEntity(ctx, me, this._teamColor(this.myTeam), now, { self: true });
  }

  // Cercle vert de repérage, visible uniquement par le joueur local (rendu dans
  // _drawSelf, qui n'existe que sur son client). L'aide à se localiser au milieu
  // des coéquipiers de même couleur.
  _drawSelfMarker(ctx, me, now) {
    const pulse = 0.6 + 0.25 * Math.sin(now / 350);
    const r = PLAYER.RADIUS + 16;
    ctx.save();
    ctx.translate(me.x, me.y);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(80,255,120,${pulse})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(80,255,120,0.8)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
  }

  // Entité partagée : halo + anneau + proue directionnelle + coeur dégradé.
  _drawEntity(ctx, p, color, now, { self, alpha = 1 }) {
    const angle = p.angle || 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);

    const haloR = self ? 34 : 28;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    glow.addColorStop(0, `rgba(${color},${self ? 0.32 : 0.28})`);
    glow.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, haloR, 0, Math.PI * 2); ctx.fill();

    if (self && ctx.createConicGradient) {
      ctx.save();
      ctx.rotate(now / 700);
      const sweep = ctx.createConicGradient(0, 0, 0);
      sweep.addColorStop(0, `rgba(${color},0.5)`);
      sweep.addColorStop(0.12, `rgba(${color},0)`);
      sweep.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = sweep;
      ctx.beginPath(); ctx.arc(0, 0, PLAYER.RADIUS + 7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = `rgba(${color},${self ? 0.35 : 0.5})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, PLAYER.RADIUS + 7, 0, Math.PI * 2); ctx.stroke();

    ctx.save();
    ctx.rotate(angle);
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `rgba(${color},0.95)`;
    ctx.beginPath();
    ctx.moveTo(PLAYER.RADIUS + 10, 0);
    ctx.lineTo(PLAYER.RADIUS + 2, -5);
    ctx.lineTo(PLAYER.RADIUS + 2, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const core = ctx.createRadialGradient(0, -3, 1, 0, 0, PLAYER.RADIUS);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.4, `rgba(${color},0.9)`);
    core.addColorStop(1, `rgba(${color},0.25)`);
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER.RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.shadowColor = `rgba(${color},1)`;
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${color},1)`;
    ctx.stroke();

    if (self && p.lastPingTime) {
      const cd = Math.min((now - p.lastPingTime) / SONAR.COOLDOWN_MS, 1);
      if (cd < 1) {
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER.RADIUS + 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cd);
        ctx.strokeStyle = `rgba(${color},0.55)`;
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 0;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawCelebration(ctx, now) {
    const c = this._celebration;
    const el = now - c.start;
    const W = ARENA.WIDTH, H = ARENA.HEIGHT;
    const color = this._teamColor(c.winnerTeam);
    const flash = Math.max(0, 1 - el / 700);

    const bg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, W * 0.9);
    bg.addColorStop(0, `rgba(${color},${0.22 + 0.5 * flash})`);
    bg.addColorStop(0.5, `rgba(${color},${0.06 + 0.16 * flash})`);
    bg.addColorStop(1, '#01060d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(el / 1400);
    const rays = 12;
    for (let i = 0; i < rays; i++) {
      ctx.rotate((Math.PI * 2) / rays);
      const rg = ctx.createLinearGradient(0, 0, W, 0);
      rg.addColorStop(0, `rgba(${color},${0.06 + 0.16 * flash})`);
      rg.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(W, -16); ctx.lineTo(W, 16);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    for (let k = 0; k < 4; k++) {
      const wEl = el - k * 420;
      if (wEl < 0) continue;
      const r = (wEl / 1000) * 430;
      const a = Math.max(0, 1 - wEl / 1100);
      if (a <= 0) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${a * 0.8})`;
      ctx.lineWidth = 3;
      ctx.shadowColor = `rgba(${color},0.8)`;
      ctx.shadowBlur = 20;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    const dt = Math.min(50, now - this._lastCelebTs) / 1000;
    this._lastCelebTs = now;
    ctx.save();
    this._confetti.forEach(p => {
      p.life += dt * 1000;
      p.vy += 240 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      const a = Math.max(0, 1 - p.life / p.max);
      if (a <= 0) return;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.white ? '#fff' : `rgb(${p.color})`;
      ctx.shadowColor = p.white ? '#fff' : `rgba(${p.color},1)`;
      ctx.shadowBlur = 8;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
      ctx.restore();
    });
    ctx.restore();
    ctx.globalAlpha = 1;

    const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 90);
    glow.addColorStop(0, `rgba(${color},0.5)`);
    glow.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(c.x, c.y, 90, 0, Math.PI * 2); ctx.fill();

    const pulse = 1.6 + 0.18 * Math.sin(el / 110);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(pulse, pulse);
    this._drawEntity(ctx, { x: 0, y: 0, angle: el / 600, hp: 1, lastPingTime: 0 }, color, now, { self: false, alpha: 1 });
    ctx.restore();

    this._drawFrame(now);
    this._drawVignette();
  }

  _drawFrame(now) {
    const ctx = this.ctx;
    const W = ARENA.WIDTH, H = ARENA.HEIGHT;
    const pulse = 0.5 + 0.2 * Math.sin(now / 1000);
    ctx.save();
    ctx.strokeStyle = `rgba(0,255,255,${pulse})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,255,255,0.6)';
    ctx.shadowBlur = 12;
    ctx.strokeRect(2, 2, W - 4, H - 4);

    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(0,255,255,0.9)`;
    ctx.lineWidth = 2.5;
    const L = 26, o = 2;
    const corners = [
      [o, o, 1, 1], [W - o, o, -1, 1], [o, H - o, 1, -1], [W - o, H - o, -1, -1],
    ];
    corners.forEach(([cx, cy, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * L, cy);
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawVignette() {
    const ctx = this.ctx;
    const W = ARENA.WIDTH, H = ARENA.HEIGHT;
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
