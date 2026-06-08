'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { GameRenderer } from '../lib/renderer';
import { EV, ARENA, PLAYER } from '../lib/constants';
import { audio } from '../lib/audio';

export default function GameCanvas({ onEnd, matchData }) {
  const { socket, user } = useApp();
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const keysRef = useRef({});
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

  // Initialiser playerIndex depuis le payload serveur (fiable, pas de matching pseudo)
  useEffect(() => {
    if (!matchData) return;
    const myIdx = matchData.myPlayerIndex ?? 0;
    myIdxRef.current = myIdx;
    if (rendererRef.current) rendererRef.current.myPlayerIndex = myIdx;
    setHudState(h => ({ ...h, matchInfo: matchData }));
  }, [matchData]);

  const unlockAudio = useCallback(() => { audioUnlockedRef.current = true; }, []);

  const buildInputs = useCallback(() => ({
    up:    !!(keysRef.current['KeyW'] || keysRef.current['ArrowUp']),
    down:  !!(keysRef.current['KeyS'] || keysRef.current['ArrowDown']),
    left:  !!(keysRef.current['KeyA'] || keysRef.current['ArrowLeft']),
    right: !!(keysRef.current['KeyD'] || keysRef.current['ArrowRight']),
  }), []);

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
    rendererRef.current = renderer;
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
    const onGameEnd = (data) => {
      rendererRef.current?.stop();
      keysRef.current = {};
      s.emit(EV.PLAYER_INPUT, { up: false, down: false, left: false, right: false });
      const result = data.winnerIndex === myIdxRef.current ? 'win' : data.winnerIndex === -1 ? 'draw' : 'lose';
      onEnd?.(result, data.myStats, data.eloDelta, data.winnerIndex);
    };
    const onAbandoned = (data) => {
      rendererRef.current?.stop();
      const result = data.winnerIndex === myIdxRef.current ? 'win' : 'lose';
      onEnd?.(result, { pings: 0, shots: 0, hits: 0 }, 0, data.winnerIndex);
    };

    s.on(EV.GAME_FULL_STATE, onFullState);
    s.on(EV.GAME_STATE, onState);
    s.on(EV.PLAYER_HIT, onHit);
    s.on(EV.GAME_END, onGameEnd);
    s.on(EV.GAME_ABANDONED, onAbandoned);
    return () => {
      s.off(EV.GAME_FULL_STATE, onFullState);
      s.off(EV.GAME_STATE, onState);
      s.off(EV.PLAYER_HIT, onHit);
      s.off(EV.GAME_END, onGameEnd);
      s.off(EV.GAME_ABANDONED, onAbandoned);
    };
  }, [socket, onEnd, playDamageFx]);

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
      const availW = window.innerWidth - 32;
      const availH = window.innerHeight - 56 - 32; // navbar + marges
      setScale(Math.min(1, availW / STAGE_W, availH / STAGE_H));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);

  const { players, timeLeft, matchInfo, suddenDeath } = hudState;
  const p1 = matchInfo?.players[0] ?? matchData?.players[0];
  const p2 = matchInfo?.players[1] ?? matchData?.players[1];
  const hp1 = players[0]?.hp ?? PLAYER.MAX_HP;
  const hp2 = players[1]?.hp ?? PLAYER.MAX_HP;
  const timeWarning = timeLeft < 30000;

  const formatTime = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="game-shell">
      {/* scale sur le wrapper externe, shake sur .game-stage (ne se gênent pas) */}
      <div className="game-scaler" style={{ transform: `scale(${scale})` }}>
      <div className="game-stage" ref={stageRef}>
        <div className="game-hud">
          <div className="hud-side">
            <span className="hud-name p1">{p1?.pseudo ?? 'Joueur 1'}</span>
            <div className="hud-hp">
              {Array.from({ length: PLAYER.MAX_HP }).map((_, i) => (
                <span key={i} className={`hp-dot p1 ${i < hp1 ? 'filled' : 'empty'}`} />
              ))}
            </div>
            <span className="hud-elo-badge">{p1?.elo ?? ''}</span>
          </div>
          <div className="hud-timer" style={{ color: suddenDeath ? '#FF3C50' : (timeWarning ? 'var(--warn)' : 'var(--text)') }}>
            {suddenDeath ? '☠ SUBITE' : formatTime(timeLeft)}
          </div>
          <div className="hud-side right">
            <span className="hud-name p2">{p2?.pseudo ?? 'Joueur 2'}</span>
            <div className="hud-hp">
              {Array.from({ length: PLAYER.MAX_HP }).map((_, i) => (
                <span key={i} className={`hp-dot p2 ${i < hp2 ? 'filled' : 'empty'}`} />
              ))}
            </div>
            <span className="hud-elo-badge">{p2?.elo ?? ''}</span>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <canvas ref={canvasRef} className="game-canvas" />
          {/* overlay de dégâts (flash rouge depuis les bords) */}
          <div ref={dmgRef} className="damage-overlay-fx" />
          {suddenDeath && <div className="sudden-death-banner">MORT SUBITE</div>}
        </div>
        <div className="game-controls-hint">
          <span>ZQSD/WASD · Flèches — déplacement</span>
          <span><b>Espace</b> — sonar</span>
          <span><b>F / Entrée</b> — tir</span>
        </div>
      </div>
      </div>
    </div>
  );
}
