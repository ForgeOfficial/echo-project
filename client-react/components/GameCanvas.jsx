'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { GameRenderer } from '../lib/renderer';
import { EV, ARENA, PLAYER, PROJECTILE, SONAR, BONUS } from '../lib/constants';
import { arenaForPlayers } from '../lib/modes';
import { audio } from '../lib/audio';
import TouchControls from './TouchControls';

export default function GameCanvas({ matchData, initialState }) {
  const { socket, user } = useApp();
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const keysRef = useRef({});
  const touchRef = useRef({ up: false, down: false, left: false, right: false });
  const lastInputRef = useRef({});
  const myIdxRef = useRef(0);
  const wallsRef = useRef(null);
  const stageRef = useRef(null);
  const dmgRef = useRef(null);
  const [hudState, setHudState] = useState({ players: [], timeLeft: matchData?.mode?.durationMs ?? 180000, matchInfo: null });
  const audioUnlockedRef = useRef(false);
  const aliveRef = useRef(true);
  // Garde de cooldown local (mêmes durées que le serveur) : évite de jouer le
  // son / d'émettre quand l'action sera de toute façon rejetée pour cooldown.
  const lastPingRef = useRef(0);
  const lastShootRef = useRef(0);
  const myFxRef = useRef(null);            // effets actifs du joueur local (cadence de tir)
  const [bonusAnnounce, setBonusAnnounce] = useState(null); // bannière « bonus apparu »

  // Arène dimensionnée selon le nombre de joueurs (même formule que le serveur),
  // avec le multiplicateur de taille du mode (parties custom).
  const arena = arenaForPlayers(matchData?.mode?.totalPlayers || 2, matchData?.mode?.mapScale || 1);

  // Retour de dégâts quand JE prends un coup : flash rouge + secousse + son
  const playDamageFx = useCallback(() => {
    if (audioUnlockedRef.current) audio.damage();
    if (dmgRef.current) {
      dmgRef.current.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 0 }],
        { duration: 480, easing: 'ease-out' }
      );
    }
    if (stageRef.current) {
      stageRef.current.animate(
        [
          { transform: 'translate(0,0)' },
          { transform: 'translate(-7px,4px)' },
          { transform: 'translate(6px,-5px)' },
          { transform: 'translate(-5px,-3px)' },
          { transform: 'translate(4px,4px)' },
          { transform: 'translate(0,0)' },
        ],
        { duration: 360, easing: 'ease-out' }
      );
    }
  }, []);

  // Initialiser index/équipe/couleurs depuis le payload serveur (fiable).
  useEffect(() => {
    if (!matchData) return;
    const myIdx = matchData.myPlayerIndex ?? 0;
    myIdxRef.current = myIdx;
    const r = rendererRef.current;
    if (r) {
      r.myPlayerIndex = myIdx;
      r.myTeam = matchData.myTeam ?? 0;
      if (matchData.mode?.teamColors) r.teamColors = matchData.mode.teamColors;
    }
    setHudState(h => ({ ...h, matchInfo: matchData }));
  }, [matchData]);

  const unlockAudio = useCallback(() => { audioUnlockedRef.current = true; }, []);

  // Détection tactile (téléphone/tablette) : affiche les contrôles à l'écran.
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    setIsTouch(!!coarse || 'ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  // Handlers branchés sur les contrôles tactiles.
  const handleTouchMove = useCallback((dirs) => {
    touchRef.current = dirs;
    sendInputIfChanged();
  }, []); // sendInputIfChanged est stable (deps stables) ; défini plus bas via hoisting de useCallback
  // Ping / tir gardés par le cooldown : on n'émet (et ne joue le son) que si
  // l'action est réellement disponible. Le serveur reste l'autorité, mais comme
  // les durées sont identiques, ce garde élimine les sons « à vide ».
  const tryPing = useCallback(() => {
    if (!aliveRef.current) return;
    const now = Date.now();
    if (now - lastPingRef.current < SONAR.COOLDOWN_MS) return;
    lastPingRef.current = now;
    socket.current?.emit(EV.PLAYER_PING);
    if (audioUnlockedRef.current) audio.ping();
  }, [socket]);
  const tryShoot = useCallback(() => {
    if (!aliveRef.current) return;
    const now = Date.now();
    // Bonus cadence : cooldown réduit côté client aussi, sinon le garde local
    // throttlerait le tir rapide autorisé par le serveur.
    const cd = myFxRef.current?.rapid ? PROJECTILE.COOLDOWN_MS * BONUS.TYPES.rapid.mult : PROJECTILE.COOLDOWN_MS;
    if (now - lastShootRef.current < cd) return;
    lastShootRef.current = now;
    socket.current?.emit(EV.PLAYER_SHOOT);
    rendererRef.current?.predictShot();   // balle visible immédiatement, depuis le canon
    if (audioUnlockedRef.current) audio.shoot();
  }, [socket]);
  const handleTouchShoot = tryShoot;
  const handleTouchPing = tryPing;

  const buildInputs = useCallback(() => {
    const k = keysRef.current, t = touchRef.current;
    return {
      up:    !!(k['KeyW'] || k['KeyZ'] || k['ArrowUp']    || t.up),
      down:  !!(k['KeyS'] || k['ArrowDown']  || t.down),
      left:  !!(k['KeyA'] || k['KeyQ'] || k['ArrowLeft']  || t.left),
      right: !!(k['KeyD'] || k['ArrowRight'] || t.right),
    };
  }, []);

  const sendInputIfChanged = useCallback(() => {
    const s = socket.current;
    if (!s) return;
    const inputs = buildInputs();
    const last = lastInputRef.current;
    if (inputs.up === last.up && inputs.down === last.down && inputs.left === last.left && inputs.right === last.right) return;
    lastInputRef.current = { ...inputs };
    s.emit(EV.PLAYER_INPUT, inputs);
  }, [socket, buildInputs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new GameRenderer(canvas);
    // L'effet matchData (défini plus haut) a déjà fixé myIdxRef avant la
    // création du renderer : on applique l'index ici pour la bonne POV.
    renderer.myPlayerIndex = myIdxRef.current;
    renderer.myTeam = matchData?.myTeam ?? 0;
    if (matchData?.mode?.teamColors) renderer.teamColors = matchData.mode.teamColors;
    // Prédiction locale : le renderer lit l'état d'entrée courant (clavier + tactile)
    // pour simuler mon déplacement sans attendre l'aller-retour réseau.
    renderer.enablePrediction(buildInputs);
    renderer.setArena(arena); // dimensionnement immédiat (avant le 1er état serveur)
    rendererRef.current = renderer;
    // État initial fourni par JOIN_GAME (murs + positions) : évite d'attendre
    // le prochain full-state pour afficher l'arène, y compris en reconnexion.
    if (initialState) {
      if (initialState.walls) wallsRef.current = initialState.walls;
      renderer.setState(initialState);
    }
    renderer.start();
    return () => renderer.stop();
  }, []);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const onFullState = (state) => {
      if (state.walls) wallsRef.current = state.walls;
      rendererRef.current?.setState(state);
    };
    const onState = (state) => {
      rendererRef.current?.setState({ ...state, walls: wallsRef.current });
      const me = state.players?.[myIdxRef.current];
      if (me) { aliveRef.current = me.hp > 0; myFxRef.current = me.fx || null; }
      setHudState(h => ({ ...h, players: state.players || [], timeLeft: state.timeLeft, suddenDeath: state.suddenDeath }));
    };
    const onHit = ({ playerIndex, by, x, y }) => {
      rendererRef.current?.triggerHit(playerIndex);
      if (playerIndex === myIdxRef.current) {
        playDamageFx();                                  // je perds une vie
      } else if (by === myIdxRef.current) {
        if (audioUnlockedRef.current) audio.hitConfirm(); // c'est MOI qui touche
        // Révèle brièvement la cible touchée, même si elle est hors-vue : un
        // marqueur d'impact apparaît à l'endroit du tir réussi (le serveur ne
        // m'envoie x/y que pour mes propres touches).
        if (x != null && y != null) {
          rendererRef.current?.triggerHitReveal(playerIndex, x, y);
          rendererRef.current?.consumeLocalShotAt(x, y); // éteint la balle prédite sur l'impact
        }
      }
    };
    const onBonusSpawn = (bonus) => {
      setBonusAnnounce({ ...bonus, key: bonus.id });
      if (audioUnlockedRef.current) audio.bonusAppear();
    };
    const onBonusPickup = () => { if (audioUnlockedRef.current) audio.bonusPickup(); };
    const onNuke = ({ x, y }) => {
      rendererRef.current?.triggerNuke(x, y);
      if (audioUnlockedRef.current) audio.nuke();
    };
    // La fin de partie (GAME_END) est gérée au niveau de la page /games/:id :
    // elle démonte GameCanvas, ce qui stoppe le renderer via le cleanup.
    s.on(EV.GAME_FULL_STATE, onFullState);
    s.on(EV.GAME_STATE, onState);
    s.on(EV.PLAYER_HIT, onHit);
    s.on(EV.BONUS_SPAWN, onBonusSpawn);
    s.on(EV.BONUS_PICKUP, onBonusPickup);
    s.on(EV.NUKE, onNuke);
    return () => {
      s.off(EV.GAME_FULL_STATE, onFullState);
      s.off(EV.GAME_STATE, onState);
      s.off(EV.PLAYER_HIT, onHit);
      s.off(EV.BONUS_SPAWN, onBonusSpawn);
      s.off(EV.BONUS_PICKUP, onBonusPickup);
      s.off(EV.NUKE, onNuke);
    };
  }, [socket, playDamageFx]);

  // Auto-effacement de la bannière d'annonce de bonus.
  useEffect(() => {
    if (!bonusAnnounce) return;
    const t = setTimeout(() => setBonusAnnounce(null), 2800);
    return () => clearTimeout(t);
  }, [bonusAnnounce]);

  useEffect(() => {
    // Touches qui font défiler la page par défaut → on bloque le scroll,
    // sinon l'arène sort du cadre quand on joue aux flèches.
    const SCROLL_KEYS = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
    ]);
    const onKeyDown = (e) => {
      unlockAudio();
      if (SCROLL_KEYS.has(e.code)) e.preventDefault();
      if (keysRef.current[e.code]) return;
      keysRef.current[e.code] = true;
      if (e.code === 'Space') tryPing();
      if (e.code === 'KeyF' || e.code === 'Enter') { e.preventDefault(); tryShoot(); }
      sendInputIfChanged();
    };
    const onKeyUp = (e) => {
      keysRef.current[e.code] = false;
      sendInputIfChanged();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [socket, sendInputIfChanged, unlockAudio, tryPing, tryShoot]);

  // Mise à l'échelle du stage pour qu'il tienne toujours dans la fenêtre
  // (évite que l'arène déborde sous le fold → fausse impression de "sortie de map")
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const STAGE_W = arena.WIDTH, STAGE_H = arena.HEIGHT + 56; // canvas + HUD ~56
    const recompute = () => {
      // En tactile, le jeu passe en plein écran (navbar masquée) et les
      // contrôles flottent par-dessus → on exploite presque toute la surface.
      const availW = window.innerWidth - (isTouch ? 12 : 32);
      const availH = window.innerHeight - (isTouch ? 12 : 56 + 32);
      setScale(Math.min(1, availW / STAGE_W, availH / STAGE_H));
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
    };
  }, [isTouch, arena.WIDTH, arena.HEIGHT]);

  const { players, timeLeft, matchInfo, suddenDeath } = hudState;
  const info = matchInfo || matchData;
  const mode = info?.mode;
  const roster = info?.players ?? [];
  const teamColors = mode?.teamColors ?? ['255,255,255', '255,69,58'];
  const teamNames = mode?.teamNames ?? ['Blanc', 'Rouge'];
  const teamSize = mode?.teamSize ?? 1;
  const teamCount = mode?.teamCount ?? 2;
  const maxHp = mode?.maxHp ?? PLAYER.MAX_HP;
  const manyTeams = teamCount > 2; // FFA / 3+ équipes → HUD compact en bandeau
  const timeWarning = timeLeft < 30000;

  // Mode Frags : objectif de kills + réapparition.
  const isFrags = mode?.objective === 'deathmatch';
  const killTarget = mode?.killTarget || 0;
  const me = players[myIdxRef.current];
  const respawnSecLeft = isFrags && me && me.hp <= 0 && me.respawnIn != null
    ? Math.ceil(me.respawnIn / 1000) : 0;
  // Effets de bonus actifs du joueur local (icône + secondes restantes).
  const activeEffects = me?.fx
    ? Object.keys(me.fx).filter(k => me.fx[k] > 0 && BONUS.TYPES[k]).map(k => ({ key: k, ms: me.fx[k], def: BONUS.TYPES[k] }))
    : [];
  // Cumul de kills par équipe (= par joueur en FFA) pour le tableau de scores.
  const teamKills = isFrags
    ? roster.reduce((acc, p, idx) => {
        acc[p.team] = (acc[p.team] || 0) + (players[idx]?.kills || 0);
        return acc;
      }, {})
    : {};
  const fragLeader = isFrags
    ? Math.max(0, ...Object.values(teamKills))
    : 0;

  const formatTime = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Pastilles de PV avec gestion de la surcharge (Vie+ peut dépasser maxHp → dots dorés).
  const hpDots = (hp, col) => {
    const count = Math.max(maxHp, hp);
    return Array.from({ length: count }).map((_, i) => {
      const filled = i < hp;
      const over = i >= maxHp; // pastille de surcharge (bonus Vie+)
      const c = over ? '#FFD700' : col;
      return (
        <span key={i} className="hp-dot" style={filled
          ? { background: c, border: `1px solid ${c}`, boxShadow: `0 0 8px ${c}` }
          : { background: 'transparent', border: `1px solid ${c}`, opacity: 0.3 }} />
      );
    });
  };

  const renderMember = (m) => {
    const hp = players[m.idx]?.hp ?? maxHp;
    const col = `rgb(${teamColors[m.team] ?? teamColors[0]})`;
    return (
      <div key={m.idx} className={`hud-member${hp <= 0 ? ' dead' : ''}`}>
        <span className="hud-name" style={{ color: col }}>{m.pseudo ?? 'Joueur'}</span>
        <div className="hud-hp">{hpDots(hp, col)}</div>
        {isFrags && <span className="hud-kills" style={{ color: col }}>{players[m.idx]?.kills || 0}<small>☠</small></span>}
        {!isFrags && teamSize === 1 && !manyTeams && m.elo != null && <span className="hud-elo-badge">{m.elo}</span>}
      </div>
    );
  };

  // HUD compact pour FFA / 3+ équipes : tous les joueurs en bandeau, le mien en tête.
  const scoreboard = () => {
    const all = roster.map((p, idx) => ({ ...p, idx }));
    all.sort((a, b) => (a.idx === myIdxRef.current ? -1 : b.idx === myIdxRef.current ? 1 : 0));
    return (
      <div className="hud-scoreboard">
        {all.map(m => {
          const hp = players[m.idx]?.hp ?? maxHp;
          const col = `rgb(${teamColors[m.team] ?? teamColors[0]})`;
          return (
            <div key={m.idx} className={`hud-chip${hp <= 0 ? ' dead' : ''}${m.idx === myIdxRef.current ? ' me' : ''}`} style={{ borderColor: col }}>
              <span className="hud-chip-dot" style={{ background: col, boxShadow: `0 0 8px ${col}` }} />
              <span className="hud-chip-name" style={{ color: col }}>{m.pseudo ?? `J${m.idx + 1}`}</span>
              <div className="hud-hp">{hpDots(hp, col)}</div>
              {isFrags && <span className="hud-kills" style={{ color: col }}>{players[m.idx]?.kills || 0}<small>☠</small></span>}
            </div>
          );
        })}
      </div>
    );
  };

  const teamPanel = (t, side) => {
    const members = roster.map((p, idx) => ({ ...p, idx })).filter(p => p.team === t);
    const cls = `hud-side ${side}${teamSize > 1 ? ' team' : ''}`;
    return (
      <div className={cls}>
        {teamSize > 1 && (
          <span className="hud-team-label" style={{ color: `rgb(${teamColors[t]})` }}>{teamNames[t]}</span>
        )}
        {(members.length ? members : [{ pseudo: `Joueur ${t + 1}`, team: t, idx: t }]).map(renderMember)}
      </div>
    );
  };

  return (
    <div className={`game-shell${isTouch ? ' touch' : ''}`}>
      {/* scale sur le wrapper externe, shake sur .game-stage (ne se gênent pas) */}
      <div className="game-scaler" style={{ transform: `scale(${scale})` }}>
      <div className="game-stage" ref={stageRef} style={{ width: arena.WIDTH }}>
        <div className="game-hud" style={{ width: arena.WIDTH }}>
          {manyTeams ? (
            <>
              {scoreboard()}
              <div className="hud-center">
                <div className="hud-timer" style={{ color: timeWarning ? 'var(--warn)' : 'var(--text)' }}>
                  {formatTime(timeLeft)}
                </div>
                {isFrags && <div className="hud-objective">🎯 {fragLeader} / {killTarget}</div>}
              </div>
            </>
          ) : (
            <>
              {teamPanel(0, 'left')}
              <div className="hud-center">
                <div className="hud-timer" style={{ color: suddenDeath ? '#FF3C50' : (timeWarning ? 'var(--warn)' : 'var(--text)') }}>
                  {suddenDeath ? '☠ SUBITE' : formatTime(timeLeft)}
                </div>
                {isFrags && <div className="hud-objective">🎯 {fragLeader} / {killTarget}</div>}
              </div>
              {teamPanel(1, 'right')}
            </>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <canvas ref={canvasRef} className="game-canvas" />
          {/* overlay de dégâts (flash rouge depuis les bords) */}
          <div ref={dmgRef} className="damage-overlay-fx" />
          {suddenDeath && <div className="sudden-death-banner">MORT SUBITE</div>}

          {/* Annonce « un bonus est apparu » (vue par tous) */}
          {bonusAnnounce && BONUS.TYPES[bonusAnnounce.type] && (
            <div key={bonusAnnounce.key} className="bonus-announce" style={{ '--bc': `rgb(${BONUS.TYPES[bonusAnnounce.type].color})` }}>
              <span className="bonus-announce-icon">{BONUS.TYPES[bonusAnnounce.type].icon}</span>
              <span className="bonus-announce-txt">
                <b>{BONUS.TYPES[bonusAnnounce.type].label}</b>
                <small>apparu sur la carte</small>
              </span>
            </div>
          )}

          {/* Effets de bonus actifs du joueur local */}
          {activeEffects.length > 0 && (
            <div className="fx-bar">
              {activeEffects.map(fx => (
                <div key={fx.key} className="fx-chip" style={{ borderColor: `rgb(${fx.def.color})`, color: `rgb(${fx.def.color})` }}>
                  <span className="fx-icon">{fx.def.icon}</span>
                  <span className="fx-sec">{Math.ceil(fx.ms / 1000)}s</span>
                </div>
              ))}
            </div>
          )}
          {respawnSecLeft > 0 && (
            <div className="respawn-overlay">
              <div className="respawn-label">ÉLIMINÉ</div>
              <div className="respawn-count">{respawnSecLeft}</div>
              <div className="respawn-sub">réapparition…</div>
            </div>
          )}
        </div>
        {!isTouch && (
          <div className="game-controls-hint">
            <span>ZQSD/WASD · Flèches — déplacement</span>
            <span><b>Espace</b> — sonar</span>
            <span><b>F / Entrée</b> — tir</span>
          </div>
        )}
      </div>
      </div>

      {isTouch && (
        <TouchControls
          onMove={handleTouchMove}
          onShoot={handleTouchShoot}
          onPing={handleTouchPing}
          onFirstTouch={unlockAudio}
          shootCooldownMs={PROJECTILE.COOLDOWN_MS}
          pingCooldownMs={SONAR.COOLDOWN_MS}
        />
      )}
    </div>
  );
}
