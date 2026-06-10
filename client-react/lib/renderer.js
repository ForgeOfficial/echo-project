import { ARENA, PLAYER, SONAR, PROJECTILE, WALL, BONUS } from './constants';
import { ARENA_THEMES, themedAccent, currentTheme } from './theme';

const DEFAULT_TEAM_COLORS = ['255,255,255', '255,69,58']; // équipe 0 blanche, 1 rouge

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
    // Arène dynamique (taille selon le nb de joueurs) : valeur par défaut puis
    // remplacée par setArena() dès qu'on connaît la partie.
    this.arena = { CELL_SIZE: ARENA.CELL_SIZE, COLS: ARENA.COLS, ROWS: ARENA.ROWS, WIDTH: ARENA.WIDTH, HEIGHT: ARENA.HEIGHT };
    // Rendu HiDPI : le canvas est en pixels physiques (plafonné à 2× pour la
    // perf), tout le dessin reste en coordonnées logiques via setTransform.
    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    this._applySize();
    // Sprites pré-rendus (balles, murs, fond) : remplacent shadowBlur et les
    // gradients recréés à chaque frame — trop coûteux à 60fps.
    this._spriteCache = new Map();
    this._bg = null;
    this._wallFogAt = 0;
    this.myPlayerIndex = 0;
    this.myTeam = 0;
    this.teamColors = DEFAULT_TEAM_COLORS;
    this._rafId = null;
    this._lastTs = 0;
    this._hitFlash = [];
    this._hitReveals = [];   // marqueurs « tu as touché ici » (cibles hors-vue)
    this._nukeFx = null;     // flash plein écran d'une nuke
    this._localShots = [];   // tirs prédits localement (sortent du canon sans attendre le serveur)
    this._pendingShots = []; // échéances (performance.now) des balles de rafale à venir
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

    // Palette d'arène selon le thème (sombre = abysse, clair = brume).
    this._themeName = currentTheme();
    this.T = ARENA_THEMES[this._themeName];

    // Calques offscreen réutilisés (l'environnement passe par le fog, le reste est net)
    this._scene = this._makeLayer();
    this._mask = this._makeLayer();
    this._fog = this._makeLayer();   // voile d'obscurité (tout sombre sauf la flaque de lumière)
  }

  _teamColor(team) {
    const c = this.teamColors[team] || this.teamColors[0] || DEFAULT_TEAM_COLORS[0];
    // En clair, les teintes pensées pour fond noir (blanc, jaune…) sont densifiées.
    return themedAccent(c, this._themeName);
  }

  // Suit l'attribut data-theme de <html>. Au changement : nouvelle palette et
  // purge des rendus pré-calculés (fond, murs, sprites de balles).
  _syncTheme() {
    const name = currentTheme();
    if (name === this._themeName) return;
    this._themeName = name;
    this.T = ARENA_THEMES[name];
    this._bg = null;
    this._wallSpriteC = null;
    this._spriteCache.clear();
  }

  // Coéquipiers vivants (moi inclus) : sources de vision partagée. On exige une
  // position : un slot culé (x null, ex. quand JE suis mort en attente de respawn)
  // ne révèle rien.
  _friendlies(s) {
    return (s.players || []).filter(p => p && p.team === this.myTeam && p.hp > 0 && p.x != null);
  }

  // Taille physique = logique × dpr ; taille CSS = logique. Le transform fait
  // que tout le code de dessin continue de raisonner en coordonnées logiques.
  _applySize() {
    const dpr = this._dpr, W = this.arena.WIDTH, H = this.arena.HEIGHT;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _makeLayer() {
    const c = document.createElement('canvas');
    c.width = Math.round(this.arena.WIDTH * this._dpr);
    c.height = Math.round(this.arena.HEIGHT * this._dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    return { canvas: c, ctx };
  }

  // Adopte des dimensions d'arène (canvas + calques offscreen) si elles changent.
  setArena(arena) {
    if (!arena || !arena.WIDTH || !arena.HEIGHT) return;
    if (arena.WIDTH === this.arena.WIDTH && arena.HEIGHT === this.arena.HEIGHT) return;
    this.arena = { ...arena };
    this._applySize();
    this._scene = this._makeLayer();
    this._mask = this._makeLayer();
    this._fog = this._makeLayer();
    this._bg = null;
  }

  // Fond statique (abysse + grille) pré-rendu une fois par taille d'arène :
  // évite un gradient radial plein écran et ~70 strokes par frame.
  _buildBg() {
    const layer = this._makeLayer();
    const ctx = layer.ctx;
    const W = this.arena.WIDTH, H = this.arena.HEIGHT, S = this.arena.CELL_SIZE;
    const bg = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.75);
    bg.addColorStop(0, this.T.bg0);
    bg.addColorStop(1, this.T.bg1);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = this.T.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = S; x < W; x += S) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = S; y < H; y += S) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    return layer;
  }

  // Sprite « balle » (cœur blanc + halo couleur) : remplace le shadowBlur par
  // projectile, rendu une seule fois par couleur puis blitté.
  _dotSprite(color, coreR, glowR) {
    const key = `${color}|${coreR}|${glowR}`;
    let s = this._spriteCache.get(key);
    if (s) return s;
    const dpr = this._dpr, size = glowR * 2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(size * dpr);
    c.height = Math.ceil(size * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    const g = x.createRadialGradient(glowR, glowR, 0, glowR, glowR, glowR);
    g.addColorStop(0, this.T.core);
    g.addColorStop(coreR / glowR, this.T.core);
    g.addColorStop(Math.min(1, coreR / glowR + 0.12), `rgba(${color},0.85)`);
    g.addColorStop(1, `rgba(${color},0)`);
    x.fillStyle = g;
    x.beginPath(); x.arc(glowR, glowR, glowR, 0, Math.PI * 2); x.fill();
    s = { canvas: c, size };
    this._spriteCache.set(key, s);
    return s;
  }

  // Sprite « bloc de mur » : le dégradé + contour est identique pour tous les
  // murs → rendu une fois, puis un drawImage par mur visible.
  _wallSprite() {
    const S = this.arena.CELL_SIZE;
    if (this._wallSpriteC && this._wallSpriteFor === S) return this._wallSpriteC;
    const sz = S - WALL.PAD * 2;
    const dpr = this._dpr;
    const c = document.createElement('canvas');
    c.width = Math.ceil(sz * dpr);
    c.height = Math.ceil(sz * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    const g = x.createLinearGradient(0, 0, 0, sz);
    g.addColorStop(0, this.T.wall0);
    g.addColorStop(1, this.T.wall1);
    x.fillStyle = g;
    this._roundRect(x, 0, 0, sz, sz, 6);
    x.fill();
    x.strokeStyle = this.T.wallStroke;
    x.lineWidth = 1;
    this._roundRect(x, 0.5, 0.5, sz - 1, sz - 1, 6);
    x.stroke();
    this._wallSpriteC = c;
    this._wallSpriteFor = S;
    this._wallSpriteSz = sz;
    return c;
  }

  start() { this._rafId = requestAnimationFrame(ts => this._loop(ts)); }
  stop() { if (this._rafId) cancelAnimationFrame(this._rafId); this._rafId = null; }

  setState(state) {
    if (state.arena) this.setArena(state.arena);
    if (state.walls) {
      this._lastWalls = state.walls;
      // Index des murs pour la collision prédite (mêmes clés que le serveur).
      this._wallSetPred = new Set(
        state.walls.map(w => `${Math.round(w.x / this.arena.CELL_SIZE)},${Math.round(w.y / this.arena.CELL_SIZE)}`)
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

    // Bonus vitesse : même multiplicateur que le serveur pour rester synchro.
    const speed = PLAYER.SPEED * (me.fx?.speed ? BONUS.TYPES.speed.mult : 1);
    // Résolution par poussée, exactement comme le serveur (murs désactivés en
    // mort subite) : on déplace puis on repousse hors des obstacles.
    const r = this._predResolve(latest, this._pred.x + dx * speed * dt, this._pred.y + dy * speed * dt);
    this._pred.x = r.x;
    this._pred.y = r.y;

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

  // Miroir de GameEngine._resolveCollisions : repousse le cercle prédit hors
  // des murs et des autres joueurs (itéré pour les coins / poussées en chaîne).
  _predResolve(latest, x, y) {
    const A = this.arena, R = PLAYER.RADIUS;
    const useWalls = !latest.suddenDeath;
    const players = latest.players || [];
    const minDist = R * 2;
    for (let iter = 0; iter < 4; iter++) {
      x = Math.max(R, Math.min(A.WIDTH - R, x));
      y = Math.max(R, Math.min(A.HEIGHT - R, y));
      let moved = false;
      for (let i = 0; i < players.length; i++) {
        if (i === this.myPlayerIndex) continue;
        const o = players[i];
        if (!o || o.x == null || o.hp <= 0) continue; // ennemi culé (hors-vue) : pas de collision prédite
        const dx = x - o.x, dy = y - o.y;
        const d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d > 0.0001) { x = o.x + (dx / d) * minDist; y = o.y + (dy / d) * minDist; }
        else { x = o.x + minDist; }
        moved = true;
      }
      if (useWalls) {
        const w = this._predPushOutOfWalls(x, y, R);
        if (w) { x = w.x; y = w.y; moved = true; }
      }
      if (!moved) break;
    }
    return { x, y };
  }

  // Miroir de GameEngine._pushOutOfWalls (mêmes boîtes : bloc visible, retrait WALL.PAD).
  _predPushOutOfWalls(x, y, radius) {
    const set = this._wallSetPred;
    if (!set || set.size === 0) return null;
    const S = this.arena.CELL_SIZE;
    let moved = false;
    const minC = Math.floor((x - radius) / S), maxC = Math.floor((x + radius) / S);
    const minR = Math.floor((y - radius) / S), maxR = Math.floor((y + radius) / S);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (!set.has(`${c},${r}`)) continue;
        const x0 = c * S + WALL.PAD, x1 = c * S + S - WALL.PAD;
        const y0 = r * S + WALL.PAD, y1 = r * S + S - WALL.PAD;
        const nearX = Math.max(x0, Math.min(x1, x));
        const nearY = Math.max(y0, Math.min(y1, y));
        const dx = x - nearX, dy = y - nearY;
        const d = Math.hypot(dx, dy);
        if (d >= radius) continue;
        if (d > 0.0001) {
          x = nearX + (dx / d) * radius;
          y = nearY + (dy / d) * radius;
        } else {
          const exits = [
            { p: x - x0, ax: 'x', v: x0 - radius },
            { p: x1 - x, ax: 'x', v: x1 + radius },
            { p: y - y0, ax: 'y', v: y0 - radius },
            { p: y1 - y, ax: 'y', v: y1 + radius },
          ];
          const e = exits.reduce((a, b) => (b.p < a.p ? b : a));
          if (e.ax === 'x') x = e.v; else y = e.v;
        }
        moved = true;
      }
    }
    return moved ? { x, y } : null;
  }

  // Reconstruit un état positionnel interpolé à (now - délai).
  _sampleState() {
    const buf = this._buffer;
    if (buf.length === 0) return null;
    const latest = buf[buf.length - 1].state;
    const base = {
      sonarWaves: latest.sonarWaves,
      timeLeft: latest.timeLeft,
      suddenDeath: latest.suddenDeath,
      zone: latest.zone,
      bonuses: latest.bonuses,
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
      // Interest management : un ennemi culé a x/y = null. Pas d'interpolation
      // si l'une des deux bornes est nulle (apparition/disparition) → on prend
      // l'état le plus récent (b) tel quel ; un x null = « ne pas dessiner ».
      if (b.x == null || a.x == null) return b;
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

  // Marqueur d'impact affiché à l'endroit où MON tir a touché, même si la cible
  // est hors-vue (interest management). Donne un retour visuel au hit-marker
  // sonore : on voit enfin qui/où on a touché.
  triggerHitReveal(victimIndex, x, y) {
    this._hitReveals.push({ x, y, victimIndex, start: Date.now() });
    if (this._hitReveals.length > 12) this._hitReveals.shift();
  }

  triggerNuke(x, y) { this._nukeFx = { x, y, start: Date.now() }; }

  // Tir prédit localement : la balle part immédiatement du bout du canon
  // PRÉDIT (donc aligné sur le vaisseau affiché), sans attendre l'aller-retour
  // serveur. Elle simule TOUT son trajet côté client ; en contrepartie on
  // n'affiche PAS le projectile serveur de mes propres tirs
  // (cf. _drawProjectiles) → une seule balle, pas de doublon. Les dégâts
  // restent gérés par le serveur. Rafale : les balles suivantes de la salve
  // sont programmées au même rythme que le serveur (cf. _fireDueBurstShots).
  predictShot() {
    if (!this._pred) return;
    const me = this._buffer[this._buffer.length - 1]?.state?.players?.[this.myPlayerIndex];
    if (!me || me.hp <= 0) return;
    this._spawnLocalShot();
    if (me.fx?.burst) {
      const B = BONUS.TYPES.burst;
      for (let k = 1; k < B.shots; k++) {
        this._pendingShots.push(performance.now() + k * B.intervalMs);
      }
    }
  }

  _spawnLocalShot() {
    const angle = this._pred?.angle || 0;
    const mx = this._pred.x + Math.cos(angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2);
    const my = this._pred.y + Math.sin(angle) * (PLAYER.RADIUS + PROJECTILE.RADIUS + 2);
    this._localShots.push({ x: mx, y: my, vx: Math.cos(angle) * PROJECTILE.SPEED, vy: Math.sin(angle) * PROJECTILE.SPEED, born: performance.now() });
  }

  // Tire les balles de rafale arrivées à échéance, dans l'axe prédit COURANT
  // (le serveur fait pareil avec p.angle au moment du tir).
  _fireDueBurstShots() {
    if (!this._pendingShots.length) return;
    if (!this._pred) { this._pendingShots = []; return; }
    const now = performance.now();
    while (this._pendingShots.length && now >= this._pendingShots[0]) {
      this._pendingShots.shift();
      this._spawnLocalShot();
    }
  }

  // Mon tir a touché (event PLAYER_HIT à mon nom) : on retire le ghost le plus
  // proche de l'impact → il « s'éteint » sur la cible comme le ferait la vraie balle.
  consumeLocalShotAt(x, y) {
    if (!this._localShots.length) return;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < this._localShots.length; i++) {
      const d = Math.hypot(this._localShots[i].x - x, this._localShots[i].y - y);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd < 60) this._localShots.splice(bi, 1);
  }

  _advanceLocalShots(dtMs) {
    if (!this._localShots.length) return;
    const dt = Math.min(dtMs, 50) / 1000;
    const now = performance.now();
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    this._localShots = this._localShots.filter(s => {
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (now - s.born > 6000) return false;           // garde-fou anti-fuite
      if (s.x < 0 || s.x > W || s.y < 0 || s.y > H) return false;
      return !this._shotHitsWall(s.x, s.y);
    });
  }

  _shotHitsWall(x, y) {
    const set = this._wallSetPred;
    if (!set || !set.size) return false;
    const S = this.arena.CELL_SIZE, c = Math.floor(x / S), r = Math.floor(y / S);
    if (!set.has(`${c},${r}`)) return false;
    const x0 = c * S + WALL.PAD, x1 = c * S + S - WALL.PAD;
    const y0 = r * S + WALL.PAD, y1 = r * S + S - WALL.PAD;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  // Balle prédite : rendue exactement comme un projectile serveur (traînée +
  // tête lumineuse), pleine opacité — c'est LA balle visible de mes tirs.
  _drawLocalShots(ctx) {
    if (!this._localShots.length) return;
    const color = this._teamColor(this.myTeam);
    ctx.save();
    for (const s of this._localShots) {
      const speed = Math.hypot(s.vx, s.vy);
      if (speed > 0) {
        const tx = s.x - (s.vx / speed) * 18, ty = s.y - (s.vy / speed) * 18;
        const tg = ctx.createLinearGradient(s.x, s.y, tx, ty);
        tg.addColorStop(0, `rgba(${color},0.6)`);
        tg.addColorStop(1, `rgba(${color},0)`);
        ctx.strokeStyle = tg; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
      }
      const sp = this._dotSprite(color, PROJECTILE.RADIUS, 16);
      ctx.drawImage(sp.canvas, s.x - 16, s.y - 16, sp.size, sp.size);
    }
    ctx.restore();
  }

  // Lance la célébration de l'équipe gagnante (à la dernière position connue
  // d'un de ses joueurs).
  startCelebration(winnerTeam) {
    const last = this._buffer[this._buffer.length - 1]?.state;
    const wp = last?.players?.find(p => p.team === winnerTeam && p.hp > 0)
      || last?.players?.find(p => p.team === winnerTeam);
    const x = wp?.x ?? this.arena.WIDTH / 2;
    const y = wp?.y ?? this.arena.HEIGHT / 2;
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
    this._fireDueBurstShots();
    this._advanceLocalShots(dt);
    this._draw();
    this._rafId = requestAnimationFrame(ts2 => this._loop(ts2));
  }

  // Brouillard mural reconstruit localement (le serveur n'envoie plus la grille
  // de visibilité). Une cellule est « éclairée » si elle est dans le voisinage
  // immédiat d'un coéquipier (3×3) ou dans la bande au front d'une de nos ondes
  // — même géométrie que l'ancien computeVisibility serveur. Renvoie un Set de
  // clés `row*COLS+col`, recalculé une fois par frame dans _draw.
  _computeWallFog(s, now) {
    const A = this.arena, S = A.CELL_SIZE;
    const set = new Set();
    // Révélation des murs en DISQUE autour de chaque coéquipier, calé sur la
    // PORTÉE du halo de lumière (cf. _buildMask) : ainsi les murs sont dessinés
    // partout où la lumière les éclaire, et c'est le masque (dégradé) qui gère
    // le fondu doux du bord — plus de coupure nette au milieu de la lumière.
    const REVEAL_R = 118;
    const REVEAL_R2 = REVEAL_R * REVEAL_R; // comparaisons au carré : pas de sqrt par cellule
    const reach = Math.ceil(REVEAL_R / S);
    for (const f of this._friendlies(s)) {
      const pc = Math.floor(f.x / S), pr = Math.floor(f.y / S);
      for (let dr = -reach; dr <= reach; dr++) {
        for (let dc = -reach; dc <= reach; dc++) {
          const r = pr + dr, c = pc + dc;
          if (r < 0 || r >= A.ROWS || c < 0 || c >= A.COLS) continue;
          const dx = c * S + S / 2 - f.x, dy = r * S + S / 2 - f.y;
          if (dx * dx + dy * dy <= REVEAL_R2) set.add(r * A.COLS + c);
        }
      }
    }
    if (s.sonarWaves) {
      const lingerDist = SONAR.SPEED * (SONAR.REVEAL_LINGER_MS / 1000);
      for (const wave of s.sonarWaves) {
        if (s.players?.[wave.playerIndex]?.team !== this.myTeam) continue;
        const elapsed = now - wave.startTime;
        const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
        if (front <= 0) continue;
        const inner = Math.max(0, front - lingerDist);
        const front2 = front * front, inner2 = inner * inner;
        const max2 = SONAR.MAX_RADIUS * SONAR.MAX_RADIUS;
        const minC = Math.max(0, Math.floor((wave.x - front) / S));
        const maxC = Math.min(A.COLS - 1, Math.floor((wave.x + front) / S));
        const minR = Math.max(0, Math.floor((wave.y - front) / S));
        const maxR = Math.min(A.ROWS - 1, Math.floor((wave.y + front) / S));
        for (let r = minR; r <= maxR; r++) {
          for (let c = minC; c <= maxC; c++) {
            const dx = c * S + S / 2 - wave.x, dy = r * S + S / 2 - wave.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= max2 && d2 <= front2 && d2 >= inner2) set.add(r * A.COLS + c);
          }
        }
      }
    }
    return set;
  }

  _isVisible(s, x, y) {
    const set = this._wallFog;
    if (!set) return true;
    const col = Math.floor(x / this.arena.CELL_SIZE);
    const row = Math.floor(y / this.arena.CELL_SIZE);
    if (col < 0 || col >= this.arena.COLS || row < 0 || row >= this.arena.ROWS) return false;
    return set.has(row * this.arena.COLS + col);
  }

  _draw() {
    const ctx = this.ctx;
    const now = Date.now();
    this._syncTheme();
    if (this._celebration) { this._drawCelebration(ctx, now); return; }

    const s = this._sampleState();
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    // Brouillard mural local (remplace la grille de visibilité serveur), lu par
    // _isVisible (_drawWalls). Recalculé au rythme des ticks serveur (~30Hz),
    // pas à chaque frame : la géométrie n'évolue pas plus vite.
    if (!s) {
      this._wallFog = null;
    } else if (now - this._wallFogAt >= 33 || !this._wallFog) {
      this._wallFog = this._computeWallFog(s, now);
      this._wallFogAt = now;
    }

    if (s && s.suddenDeath) { this._drawSuddenDeath(ctx, s, now); return; }

    // ——— 1. Fond : abysse + grille (calque statique pré-rendu) ———
    if (!this._bg) this._bg = this._buildBg();
    ctx.drawImage(this._bg.canvas, 0, 0, W, H);

    if (!s) { this._drawFrame(now); return; }

    // ——— 2. Masque de lumière (construit UNE fois : sert au voile ET aux murs) ———
    this._buildMask(s, now);

    // ——— 2a. Voile d'obscurité : on plonge toute l'arène dans le noir, puis on
    // perce la flaque de lumière (destination-out du masque). Le sol/grille hors
    // de la lumière devient vraiment sombre → sensation d'être « dans l'ombre ».
    const fctx = this._fog.ctx;
    fctx.clearRect(0, 0, W, H);
    fctx.fillStyle = this.T.fog;
    fctx.fillRect(0, 0, W, H);
    fctx.save();
    fctx.globalCompositeOperation = 'destination-out';
    fctx.drawImage(this._mask.canvas, 0, 0, W, H);
    fctx.restore();
    ctx.drawImage(this._fog.canvas, 0, 0, W, H);

    // ——— 2b. Murs découpés par la lumière (le masque gère le fondu du bord) ———
    const sctx = this._scene.ctx;
    sctx.clearRect(0, 0, W, H);
    this._drawWalls(sctx, s);
    sctx.save();
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(this._mask.canvas, 0, 0, W, H);
    sctx.restore();
    ctx.drawImage(this._scene.canvas, 0, 0, W, H);

    // ——— 3. Zone toxique (gaz) derrière les entités ———
    if (s.zone) this._drawZone(ctx, s, now);

    // ——— 4. Éléments nets par-dessus le fog ———
    this._drawBonuses(ctx, s, now);
    this._drawSonarWaves(ctx, s, now);
    this._drawProjectiles(ctx, s);
    this._drawLocalShots(ctx);
    this._drawEnemies(ctx, s, now);
    this._drawTeammates(ctx, s, now);
    this._drawSelf(ctx, s, now);
    this._drawHitReveals(ctx, now);
    this._drawNuke(ctx, now);

    // ——— 5. Cadre + vignette + alerte gaz ———
    this._drawFrame(now);
    this._drawVignette();
    if (s.zone) this._drawGasWarning(ctx, s, now);
  }

  // Mort subite : arène entièrement claire, sans murs ni brouillard, teinte
  // rouge de tension. Tous les joueurs sont pleinement visibles.
  _drawSuddenDeath(ctx, s, now) {
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.75);
    bg.addColorStop(0, this.T.sd0);
    bg.addColorStop(1, this.T.sd1);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.strokeStyle = `rgba(255,60,80,${0.05 + 0.03 * pulse})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const S = this.arena.CELL_SIZE;
    for (let x = S; x < W; x += S) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = S; y < H; y += S) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();

    this._drawProjectiles(ctx, s);
    this._drawLocalShots(ctx);
    if (s.players) {
      s.players.forEach((p, idx) => {
        if (!p || p.x == null || p.hp <= 0 || idx === this.myPlayerIndex) return;
        const isHit = (this._hitFlash[idx] || 0) > 0;
        if (isHit && Math.floor(now / 80) % 2 === 0) return;
        this._drawEntity(ctx, p, this._teamColor(p.team), now, { self: false, alpha: 1 });
      });
    }
    this._drawSelf(ctx, s, now);
    this._drawHitReveals(ctx, now);

    ctx.save();
    ctx.strokeStyle = `rgba(255,60,80,${(0.6 + 0.3 * pulse) * 0.3})`;
    ctx.lineWidth = 8;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.strokeStyle = `rgba(255,60,80,${0.6 + 0.3 * pulse})`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.restore();
    this._drawVignette();
  }

  // Masque de lumière doux : halos des coéquipiers (vision partagée) + disques
  // feutrés au front des ondes de mon équipe.
  _buildMask(s, now) {
    const mctx = this._mask.ctx;
    mctx.clearRect(0, 0, this.arena.WIDTH, this.arena.HEIGHT);

    for (const f of this._friendlies(s)) {
      // Flaque de lumière : zone proche bien lisible, puis fondu progressif vers
      // le noir. C'est ce dégradé qui sculpte le bord de la lumière (et, via le
      // voile, l'obscurité autour).
      const auraR = 112;
      const g = mctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, auraR);
      g.addColorStop(0, 'rgba(255,255,255,0.97)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      mctx.fillStyle = g;
      mctx.beginPath(); mctx.arc(f.x, f.y, auraR, 0, Math.PI * 2); mctx.fill();
    }

    if (s.sonarWaves) {
      // Balayage sonar : glow REMPLI (intérieur faiblement éclairé qui fait le
      // pont avec le halo perso, crête lumineuse au front, bord extérieur fondu).
      // Évite le « trou noir » entre l'aura et l'onde → une seule lumière qui
      // s'étend au lieu de deux cercles.
      for (const wave of s.sonarWaves) {
        if (s.players?.[wave.playerIndex]?.team !== this.myTeam) continue; // seulement mon équipe
        const elapsed = now - wave.startTime;
        const front = Math.min((elapsed / 1000) * SONAR.SPEED, SONAR.MAX_RADIUS);
        if (front <= 6) continue;
        const life = Math.max(0, 1 - elapsed / SONAR.LIFETIME_MS);
        if (life <= 0) continue;
        const g = mctx.createRadialGradient(wave.x, wave.y, 0, wave.x, wave.y, front);
        g.addColorStop(0, `rgba(255,255,255,${0.10 * life})`);   // pont vers l'aura
        g.addColorStop(0.78, `rgba(255,255,255,${0.16 * life})`);
        g.addColorStop(0.92, `rgba(255,255,255,${0.5 * life})`); // crête au front
        g.addColorStop(1, 'rgba(255,255,255,0)');                 // bord fondu
        mctx.fillStyle = g;
        mctx.beginPath(); mctx.arc(wave.x, wave.y, front, 0, Math.PI * 2); mctx.fill();
      }
    }
  }

  _drawWalls(ctx, s) {
    if (!s.walls) return;
    const sprite = this._wallSprite();
    const sz = this._wallSpriteSz;
    const half = this.arena.CELL_SIZE / 2;
    for (const w of s.walls) {
      if (!this._isVisible(s, w.x + half, w.y + half)) continue;
      ctx.drawImage(sprite, w.x + WALL.PAD, w.y + WALL.PAD, sz, sz);
    }
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
      // crête : passe large translucide (glow) + trait net, sans shadowBlur
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${alpha * 0.22})`;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${color},${alpha * 0.75})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // léger halo intérieur qui adoucit la transition vers la traîne révélée
      if (radius > 24) {
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius - 12, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color},${alpha * 0.14})`;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  _drawProjectiles(ctx, s) {
    if (!s.projectiles) return;
    ctx.save();
    s.projectiles.forEach(p => {
      // Mes propres tirs sont rendus en prédiction locale (ghost) → on n'affiche
      // pas leur version serveur, sinon on verrait deux balles.
      if (p.playerIndex === this.myPlayerIndex) return;
      // Le serveur ne nous envoie déjà que les projectiles visibles (interest
      // management) : on dessine tout ce qu'on reçoit.
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
      const sp = this._dotSprite(color, PROJECTILE.RADIUS, 16);
      ctx.drawImage(sp.canvas, p.x - 16, p.y - 16, sp.size, sp.size);
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
      if (!p || p.x == null || p.hp <= 0 || p.team === this.myTeam) return;
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

  // Marqueur d'identité « c'est toi », visible uniquement par le joueur local
  // (rendu dans _drawSelf, qui n'existe que sur son client). Aide à se localiser
  // au milieu des coéquipiers de même couleur — sans le cercle vert criard
  // d'avant : halo doux qui respire + réticule segmenté en rotation + balise
  // chevron flottante. Le vert jade reste distinct des couleurs d'équipe
  // (cyan/magenta) mais en version raffinée.
  _drawSelfMarker(ctx, me, now) {
    const col = this.T.self;                   // jade doux, lisible mais pas agressif
    const breathe = 1 + 0.05 * Math.sin(now / 600);
    const baseR = PLAYER.RADIUS + 13;
    ctx.save();
    ctx.translate(me.x, me.y);

    // Halo radial diffus (pas d'anneau dur) qui respire lentement.
    const auraR = baseR * 1.7 * breathe;
    const halo = ctx.createRadialGradient(0, 0, baseR * 0.5, 0, 0, auraR);
    halo.addColorStop(0, `rgba(${col},0)`);
    halo.addColorStop(0.72, `rgba(${col},0.07)`);
    halo.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, auraR, 0, Math.PI * 2); ctx.fill();

    // Réticule de verrouillage : 4 arcs courts en rotation douce.
    ctx.save();
    ctx.rotate(now / 1700);
    ctx.strokeStyle = `rgba(${col},0.92)`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const r = baseR * breathe;
    const seg = (Math.PI / 2) * 0.4;           // longueur de chaque arc
    for (let i = 0; i < 4; i++) {
      const a0 = i * (Math.PI / 2) + Math.PI / 4 - seg / 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, a0, a0 + seg);
      ctx.stroke();
    }
    ctx.restore();

    // Balise « toi » : petit chevron qui plane au-dessus avec un léger bob.
    const bob = -(PLAYER.RADIUS + 24) + 2 * Math.sin(now / 420);
    ctx.save();
    ctx.translate(0, bob);
    ctx.fillStyle = `rgba(${col},0.9)`;
    ctx.beginPath();
    ctx.moveTo(0, 5);
    ctx.lineTo(-5, -3);
    ctx.lineTo(5, -3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // Entité partagée : halo + anneau + proue directionnelle + coeur dégradé.
  _drawEntity(ctx, p, color, now, { self, alpha = 1 }) {
    const angle = p.angle || 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);

    // Halo un peu plus présent qu'avant : il compense la disparition du
    // shadowBlur sur le cœur (glow désormais porté uniquement par ce gradient).
    const haloR = self ? 34 : 28;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    glow.addColorStop(0, `rgba(${color},${self ? 0.42 : 0.38})`);
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
    ctx.fillStyle = `rgba(${color},0.95)`;
    ctx.beginPath();
    ctx.moveTo(PLAYER.RADIUS + 10, 0);
    ctx.lineTo(PLAYER.RADIUS + 2, -5);
    ctx.lineTo(PLAYER.RADIUS + 2, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const core = ctx.createRadialGradient(0, -3, 1, 0, 0, PLAYER.RADIUS);
    core.addColorStop(0, this.T.core);
    core.addColorStop(0.4, `rgba(${color},0.9)`);
    core.addColorStop(1, `rgba(${color},0.25)`);
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER.RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${color},1)`;
    ctx.stroke();

    // Effets de bonus actifs (rendus dans le repère translaté de l'entité).
    if (p.fx) {
      if (p.fx.shield) {
        ctx.save();
        ctx.rotate(now / 600);
        ctx.beginPath();
        const rr = PLAYER.RADIUS + 9;
        for (let i = 0; i < 6; i++) {
          const a = i * (Math.PI / 3), hx = Math.cos(a) * rr, hy = Math.sin(a) * rr;
          i ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(140,205,255,0.3)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(140,205,255,0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
      const buff = p.fx.burst ? '255,210,0' : p.fx.rapid ? '255,130,40' : p.fx.speed ? '0,230,255' : null;
      if (buff) {
        ctx.save();
        ctx.strokeStyle = `rgba(${buff},${0.45 + 0.3 * Math.sin(now / 120)})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, PLAYER.RADIUS + 12, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    if (self && p.lastPingTime) {
      const cd = Math.min((now - p.lastPingTime) / SONAR.COOLDOWN_MS, 1);
      if (cd < 1) {
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER.RADIUS + 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cd);
        ctx.strokeStyle = `rgba(${color},0.55)`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Bonus ramassables : orbe en losange lumineux + icône, halo pulsé, pop à
  // l'apparition, anneau-balise au début et clignotement en fin de vie.
  _drawBonuses(ctx, s, now) {
    if (!s.bonuses || !s.bonuses.length) return;
    ctx.save();
    for (const b of s.bonuses) {
      const def = BONUS.TYPES[b.type];
      if (!def) continue;
      const col = themedAccent(def.color, this._themeName);
      const age = now - b.spawnAt;
      const remaining = BONUS.LIFETIME_MS - age;
      if (remaining < 3000 && Math.floor(now / 180) % 2 === 0) continue; // clignote avant disparition
      const pop = Math.min(1, age / 300);
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      const r = BONUS.RADIUS * (0.6 + 0.4 * pop);

      ctx.save();
      ctx.translate(b.x, b.y);
      // halo
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.4);
      halo.addColorStop(0, `rgba(${col},${0.32 + 0.16 * pulse})`);
      halo.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2); ctx.fill();
      // orbe losange
      ctx.scale(pop, pop);
      ctx.fillStyle = `rgba(${col},0.92)`;
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(${this.T.ink},0.85)`; ctx.stroke();
      // icône (blanche : posée sur l'orbe colorée dense, lisible dans les deux thèmes)
      ctx.fillStyle = '#fff';
      ctx.font = '600 15px "Clash Display", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, 0, 1);
      ctx.restore();

      // anneau-balise au début (attire l'œil de tous)
      if (age < 1600) {
        const t = age / 1600;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r + t * 32, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(1 - t) * 0.8})`;
        ctx.lineWidth = 2; ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Nuke : flash plein écran vert acide + onde de choc géante depuis l'épicentre.
  _drawNuke(ctx, now) {
    if (!this._nukeFx) return;
    const el = now - this._nukeFx.start;
    const DUR = 1100;
    if (el >= DUR) { this._nukeFx = null; return; }
    const W = this.arena.WIDTH, H = this.arena.HEIGHT, t = el / DUR;
    const flash = Math.max(0, 1 - el / 260);
    if (flash > 0) { ctx.fillStyle = `rgba(225,255,190,${0.75 * flash})`; ctx.fillRect(0, 0, W, H); }
    const { x, y } = this._nukeFx;
    const nk = themedAccent('163,230,53', this._themeName);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, t * Math.hypot(W, H), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${nk},${(1 - t) * 0.3})`;
    ctx.lineWidth = (6 * (1 - t) + 1) + 12;
    ctx.stroke();
    ctx.strokeStyle = `rgba(${nk},${(1 - t) * 0.9})`;
    ctx.lineWidth = 6 * (1 - t) + 1;
    ctx.stroke();
    ctx.restore();
  }

  // Retour visuel des touches sur cible hors-vue : flash blanc bref, onde de
  // choc dans la couleur de la cible, et croix « hit-marker » qui s'écarte.
  _drawHitReveals(ctx, now) {
    if (!this._hitReveals.length) return;
    const DUR = 850;
    const latest = this._buffer[this._buffer.length - 1]?.state;
    ctx.save();
    for (let i = this._hitReveals.length - 1; i >= 0; i--) {
      const h = this._hitReveals[i];
      const el = now - h.start;
      if (el >= DUR) { this._hitReveals.splice(i, 1); continue; }
      const t = el / DUR;             // progression 0→1
      const a = 1 - t;                // alpha décroissant
      const ease = 1 - (1 - t) * (1 - t);
      const team = latest?.players?.[h.victimIndex]?.team;
      const color = team != null ? this._teamColor(team) : '255,80,80';

      ctx.save();
      ctx.translate(h.x, h.y);

      // Flash central très bref (impact)
      const flash = Math.max(0, 1 - el / 180);
      if (flash > 0) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 24);
        g.addColorStop(0, `rgba(${this.T.ink},${0.9 * flash})`);
        g.addColorStop(0.5, `rgba(${color},${0.55 * flash})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      }

      // Onde de choc qui s'étend et s'estompe
      ctx.beginPath();
      ctx.arc(0, 0, 9 + ease * 30, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${a * 0.3})`;
      ctx.lineWidth = (0.5 + 2.5 * a) + 5;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${color},${a * 0.9})`;
      ctx.lineWidth = 0.5 + 2.5 * a;
      ctx.stroke();

      // Croix « hit-marker » en diagonale (style FPS) qui s'écarte légèrement
      const gap = 6 + ease * 7, len = 7;
      ctx.strokeStyle = `rgba(${this.T.ink},${a})`;
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        const ang = Math.PI / 4 + k * (Math.PI / 2);
        const ux = Math.cos(ang), uy = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(ux * gap, uy * gap);
        ctx.lineTo(ux * (gap + len), uy * (gap + len));
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  _drawCelebration(ctx, now) {
    const c = this._celebration;
    const el = now - c.start;
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const color = this._teamColor(c.winnerTeam);
    const flash = Math.max(0, 1 - el / 700);

    const bg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, W * 0.9);
    bg.addColorStop(0, `rgba(${color},${0.22 + 0.5 * flash})`);
    bg.addColorStop(0.5, `rgba(${color},${0.06 + 0.16 * flash})`);
    bg.addColorStop(1, this.T.bg1);
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
      ctx.strokeStyle = `rgba(${color},${a * 0.25})`;
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${color},${a * 0.8})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

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
      ctx.fillStyle = p.white ? this.T.confetti : `rgb(${p.color})`;
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

  // Cadre minimaliste : un liseré blanc discret qui respire à peine, et des
  // coins légèrement plus marqués. Plus de néon pulsé — l'arène reste sobre.
  _drawFrame(now) {
    const ctx = this.ctx;
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 1600);
    ctx.save();
    ctx.strokeStyle = `rgba(${this.T.ink},${0.08 + 0.04 * pulse})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

    ctx.strokeStyle = `rgba(${this.T.ink},0.4)`;
    ctx.lineWidth = 2;
    const L = 22, o = 2;
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
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${this.T.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Zone toxique : bandes de gaz acide autour du rectangle sûr + bord animé.
  _drawZone(ctx, s, now) {
    const z = s.zone;
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 350);
    ctx.save();
    ctx.fillStyle = `rgba(${this.T.zoneFill},${0.10 + 0.07 * pulse})`;
    ctx.fillRect(0, 0, W, z.y);                              // haut
    ctx.fillRect(0, z.y + z.h, W, H - (z.y + z.h));          // bas
    ctx.fillRect(0, z.y, z.x, z.h);                          // gauche
    ctx.fillRect(z.x + z.w, z.y, W - (z.x + z.w), z.h);      // droite

    // Bord du sanctuaire : pointillés défilants, lumineux.
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = -((now / 40) % 24);
    ctx.strokeStyle = `rgba(${this.T.zoneEdge},${(0.6 + 0.3 * pulse) * 0.3})`;
    ctx.lineWidth = 9;
    ctx.strokeRect(z.x, z.y, z.w, z.h);
    ctx.strokeStyle = `rgba(${this.T.zoneEdge},${0.6 + 0.3 * pulse})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(z.x, z.y, z.w, z.h);
    ctx.restore();
  }

  // Alerte plein écran quand MON joueur est dans le gaz (visible uniquement par lui).
  _drawGasWarning(ctx, s, now) {
    const me = s.players?.[this.myPlayerIndex];
    if (!me || me.hp <= 0) return;
    const z = s.zone;
    if (me.x >= z.x && me.x <= z.x + z.w && me.y >= z.y && me.y <= z.y + z.h) return;
    const W = this.arena.WIDTH, H = this.arena.HEIGHT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 170);
    ctx.save();
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.18, W / 2, H / 2, W * 0.72);
    g.addColorStop(0, `rgba(${this.T.zoneFill},0)`);
    g.addColorStop(1, `rgba(${this.T.zoneFill},${0.22 + 0.2 * pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = `rgba(255,45,45,${(0.5 + 0.35 * pulse) * 0.3})`;
    ctx.lineWidth = 14;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.strokeStyle = `rgba(255,45,45,${0.5 + 0.35 * pulse})`;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);

    ctx.fillStyle = `rgba(${this.T.gasText},${0.82 + 0.18 * pulse})`;
    ctx.font = '600 24px "Clash Display", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☠ ZONE TOXIQUE — REVIENS', W / 2, 38);
    ctx.restore();
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
