'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { GameRenderer } from '../lib/renderer';
import { EV, ARENA, PLAYER, PROJECTILE, SONAR } from '../lib/constants';
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
  const [hudState, setHudState] = useState({ players: [], timeLeft: ARENA.MAX_DURATION_MS ?? 180000, matchInfo: null });
  const audioUnlockedRef = useRef(false);

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
  const handleTouchShoot = useCallback(() => {
    socket.current?.emit(EV.PLAYER_SHOOT);
    if (audioUnlockedRef.current) audio.shoot();
  }, [socket]);
  const handleTouchPing = useCallback(() => {
    socket.current?.emit(EV.PLAYER_PING);
    if (audioUnlockedRef.current) audio.ping();
  }, [socket]);

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
      setHudState(h => ({ ...h, players: state.players || [], timeLeft: state.timeLeft, suddenDeath: state.suddenDeath }));
    };
    const onHit = ({ playerIndex }) => {
      rendererRef.current?.triggerHit(playerIndex);
      if (playerIndex === myIdxRef.current) {
        playDamageFx();                                  // je perds une vie
      } else if (audioUnlockedRef.current) {
        audio.hitConfirm();                              // je touche l'adversaire
      }
    };
    // La fin de partie (GAME_END) est gérée au niveau de la page /games/:id :
    // elle démonte GameCanvas, ce qui stoppe le renderer via le cleanup.
    s.on(EV.GAME_FULL_STATE, onFullState);
    s.on(EV.GAME_STATE, onState);
    s.on(EV.PLAYER_HIT, onHit);
    return () => {
      s.off(EV.GAME_FULL_STATE, onFullState);
      s.off(EV.GAME_STATE, onState);
      s.off(EV.PLAYER_HIT, onHit);
    };
  }, [socket, playDamageFx]);

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
      if (e.code === 'Space') {
        socket.current?.emit(EV.PLAYER_PING);
        if (audioUnlockedRef.current) audio.ping();
      }
      if (e.code === 'KeyF' || e.code === 'Enter') {
        e.preventDefault();
        socket.current?.emit(EV.PLAYER_SHOOT);
        if (audioUnlockedRef.current) audio.shoot();
      }
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
  }, [socket, sendInputIfChanged, unlockAudio]);

  // Mise à l'échelle du stage pour qu'il tienne toujours dans la fenêtre
  // (évite que l'arène déborde sous le fold → fausse impression de "sortie de map")
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const STAGE_W = 800, STAGE_H = 656; // canvas 600 + HUD ~56
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
  }, [isTouch]);

  const { players, timeLeft, matchInfo, suddenDeath } = hudState;
  const info = matchInfo || matchData;
  const mode = info?.mode;
  const roster = info?.players ?? [];
  const teamColors = mode?.teamColors ?? ['0,255,255', '255,0,255'];
  const teamNames = mode?.teamNames ?? ['Cyan', 'Magenta'];
  const teamSize = mode?.teamSize ?? 1;
  const timeWarning = timeLeft < 30000;

  const formatTime = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const renderMember = (m) => {
    const hp = players[m.idx]?.hp ?? PLAYER.MAX_HP;
    const col = `rgb(${teamColors[m.team] ?? teamColors[0]})`;
    return (
      <div key={m.idx} className="hud-member">
        <span className="hud-name" style={{ color: col }}>{m.pseudo ?? 'Joueur'}</span>
        <div className="hud-hp">
          {Array.from({ length: PLAYER.MAX_HP }).map((_, i) => (
            <span key={i} className="hp-dot" style={i < hp
              ? { background: col, border: `1px solid ${col}`, boxShadow: `0 0 8px ${col}` }
              : { background: 'transparent', border: `1px solid ${col}`, opacity: 0.3 }} />
          ))}
        </div>
        {teamSize === 1 && m.elo != null && <span className="hud-elo-badge">{m.elo}</span>}
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
      <div className="game-stage" ref={stageRef}>
        <div className="game-hud">
          {teamPanel(0, 'left')}
          <div className="hud-timer" style={{ color: suddenDeath ? '#FF3C50' : (timeWarning ? 'var(--warn)' : 'var(--text)') }}>
            {suddenDeath ? '☠ SUBITE' : formatTime(timeLeft)}
          </div>
          {teamPanel(1, 'right')}
        </div>
        <div style={{ position: 'relative' }}>
          <canvas ref={canvasRef} className="game-canvas" />
          {/* overlay de dégâts (flash rouge depuis les bords) */}
          <div ref={dmgRef} className="damage-overlay-fx" />
          {suddenDeath && <div className="sudden-death-banner">MORT SUBITE</div>}
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
