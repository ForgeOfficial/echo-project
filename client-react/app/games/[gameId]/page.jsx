'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import confetti from 'canvas-confetti';
import { useApp } from '../../../context/AppContext';
import GameCanvas from '../../../components/GameCanvas';
import { EV } from '../../../lib/constants';

const STAGE = { LOADING: 'loading', PLAYING: 'playing', END: 'end' };
const PLAYER_COLORS = ['#00FFFF', '#FF00FF'];

export default function GamePage() {
  const { user, setUser, socket, socketReady, authReady } = useApp();
  const router = useRouter();
  const { gameId } = useParams();

  const [stage, setStage] = useState(STAGE.LOADING);
  const [matchData, setMatchData] = useState(null);
  const [initialState, setInitialState] = useState(null);
  const [endData, setEndData] = useState(null);
  const endedRef = useRef(false);

  const handleEnd = useCallback((data) => {
    if (endedRef.current) return; // GAME_END ne doit s'appliquer qu'une fois
    endedRef.current = true;
    setEndData(data);
    setStage(STAGE.END);
    // Répercute le delta d'Elo sur l'utilisateur du contexte pour que le Navbar
    // reflète le nouveau score en direct (la valeur fait autorité côté serveur).
    if (data.eloDelta) setUser(u => u ? { ...u, elo: u.elo + data.eloDelta } : u);
  }, [setUser]);

  // (Re)joindre la partie par son UUID : marche pour un nouveau match comme pour
  // un retour après fermeture de page. Le serveur réattache le socket et renvoie
  // soit l'état courant (partie en cours), soit le résultat (partie déjà finie).
  useEffect(() => {
    if (authReady && !user) { router.replace('/'); return; }
    if (!user || !socketReady) return;
    const s = socket.current;
    if (!s) return;

    const onJoined = ({ myPlayerIndex, players, state }) => {
      setMatchData({ myPlayerIndex, players });
      setInitialState(state);
      setStage(STAGE.PLAYING);
    };
    const onEnd = (data) => handleEnd(data);
    const onNotFound = () => router.replace('/');

    s.on(EV.GAME_JOINED, onJoined);
    s.on(EV.GAME_END, onEnd);
    s.on(EV.GAME_NOT_FOUND, onNotFound);
    s.emit(EV.JOIN_GAME, { gameId });

    return () => {
      s.off(EV.GAME_JOINED, onJoined);
      s.off(EV.GAME_END, onEnd);
      s.off(EV.GAME_NOT_FOUND, onNotFound);
    };
  }, [gameId, user, socket, socketReady, authReady, router, handleEnd]);

  function rematch() {
    router.replace('/game');
  }

  if (stage === STAGE.END && endData) {
    const myIdx = endData.myPlayerIndex ?? matchData?.myPlayerIndex ?? 0;
    const wIdx = endData.winnerIndex;
    const result = wIdx === myIdx ? 'win' : wIdx === -1 ? 'draw' : 'lose';
    const players = endData.players ?? matchData?.players ?? [];
    const winnerPseudo = wIdx >= 0 ? (players[wIdx]?.pseudo ?? 'Joueur') : null;
    const winnerColor = wIdx >= 0 ? PLAYER_COLORS[wIdx] : '#FFD700';
    return (
      <EndScreen
        result={result}
        stats={endData.myStats ?? { pings: 0, shots: 0, hits: 0 }}
        eloDelta={endData.eloDelta ?? 0}
        reason={endData.reason}
        winnerPseudo={winnerPseudo}
        winnerColor={winnerColor}
        onRematch={rematch}
        onHome={() => router.replace('/')}
      />
    );
  }

  if (stage === STAGE.PLAYING) {
    return <GameCanvas matchData={matchData} initialState={initialState} />;
  }

  return (
    <div className="queue-screen">
      <div className="queue-ring" />
      <div className="queue-title">Connexion à la partie…</div>
    </div>
  );
}

// « Bouhhhhhh » : huée de foule synthétisée (pas de fichier son nécessaire)
function playBoo() {
  try {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return;
    const ac = new Ctx();
    const t0 = ac.currentTime;
    const dur = 1.4;

    const master = ac.createGain();
    master.connect(ac.destination);
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.5, t0 + 0.18);
    master.gain.setValueAtTime(0.5, t0 + dur - 0.45);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // Filtre passe-bas → voyelle « ooo » sourde plutôt que sciante
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(750, t0);
    lp.frequency.linearRampToValueAtTime(380, t0 + dur);
    lp.Q.value = 5;
    lp.connect(master);

    // Plusieurs voix désaccordées = foule qui hue, pitch descendant « bouuuh »
    [70, 98, 110, 116].forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.15, t0);
      o.frequency.linearRampToValueAtTime(f * 0.82, t0 + dur);
      const lfo = ac.createOscillator();
      lfo.frequency.value = 4.5 + i;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = f * 0.035;
      lfo.connect(lfoGain).connect(o.frequency);
      const g = ac.createGain();
      g.gain.value = 0.22;
      o.connect(g).connect(lp);
      o.start(t0); o.stop(t0 + dur + 0.05);
      lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    });

    setTimeout(() => ac.close().catch(() => {}), (dur + 0.3) * 1000);
  } catch { /* audio indisponible, on ignore */ }
}

function EndScreen({ result, stats, eloDelta, reason, winnerPseudo, winnerColor, onRematch, onHome }) {
  const acc = stats.shots > 0 ? Math.round((stats.hits / stats.shots) * 100) : 0;
  const sign = eloDelta > 0 ? '+' : '';
  const eloCls = eloDelta >= 0 ? 'pos' : 'neg';
  const labels = { win: 'TU REMPORTES LE DUEL', lose: 'DÉFAITE', draw: 'ÉGALITÉ' };

  useEffect(() => {
    let raf;

    if (result === 'win') {
      // 🎉 Le gagnant a droit aux confettis
      const colors = [winnerColor, '#ffffff'];
      confetti({ particleCount: 140, spread: 100, startVelocity: 45, origin: { y: 0.4 }, colors, scalar: 1.1 });
      setTimeout(() => confetti({ particleCount: 80, spread: 120, startVelocity: 35, origin: { y: 0.5 }, colors }), 200);

      const end = Date.now() + 1600;
      const frame = () => {
        confetti({ particleCount: 4, angle: 60, spread: 55, startVelocity: 40, origin: { x: 0, y: 0.6 }, colors });
        confetti({ particleCount: 4, angle: 120, spread: 55, startVelocity: 40, origin: { x: 1, y: 0.6 }, colors });
        if (Date.now() < end) raf = requestAnimationFrame(frame);
      };
      frame();
    } else if (result === 'lose') {
      // 🍅 Le perdant se prend des tomates + un « bouhhh » de la foule
      playBoo();
      const tomato = confetti.shapeFromText({ text: '🍅', scalar: 3 });
      const splat = ['#c1121f', '#e63946', '#9d0208'];
      const splatShape = () => confetti({ particleCount: 18, spread: 70, startVelocity: 12, gravity: 1.1, ticks: 60, origin: { y: 0.55 }, colors: splat, shapes: ['circle'], scalar: 0.8 });
      const throwFrom = (x, angle) => confetti({
        particleCount: 6, angle, spread: 35, startVelocity: 60, gravity: 1.5, ticks: 110,
        origin: { x, y: 0.75 }, shapes: [tomato], scalar: 3, flat: false,
      });

      const end = Date.now() + 1700;
      const frame = () => {
        throwFrom(-0.05, 55);
        throwFrom(1.05, 125);
        if (Math.random() < 0.4) splatShape();
        if (Date.now() < end) raf = requestAnimationFrame(frame);
      };
      frame();
    }

    return () => raf && cancelAnimationFrame(raf);
  }, [result, winnerColor]);

  return (
    <div className="end-screen">
      <div className="champion-card">
        {winnerPseudo ? (
          <>
            <div className="champion-trophy" style={{ '--wc': winnerColor }}>🏆</div>
            <div className="champion-label">Champion du duel</div>
            <div className="champion-name" style={{ color: winnerColor, '--wc': winnerColor }}>
              {winnerPseudo}
            </div>
          </>
        ) : (
          <div className="champion-name" style={{ color: '#FFD700' }}>ÉGALITÉ</div>
        )}

        <div className={`champion-verdict ${result}`}>{labels[result]}</div>

        {reason === 'abandon' && (
          <div className="champion-label" style={{ marginTop: '0.25rem' }}>
            {result === 'win' ? 'Adversaire déconnecté' : 'Abandon — déconnexion'}
          </div>
        )}

        <div className="end-stats">
          <div className="end-stat"><span className="end-stat-val">{stats.pings}</span><span className="end-stat-lbl">Pings</span></div>
          <div className="end-stat"><span className="end-stat-val">{stats.shots}</span><span className="end-stat-lbl">Tirs</span></div>
          <div className="end-stat"><span className="end-stat-val">{stats.hits}</span><span className="end-stat-lbl">Touches</span></div>
          <div className="end-stat"><span className="end-stat-val">{acc}%</span><span className="end-stat-lbl">Précision</span></div>
        </div>

        <div className={`end-elo ${eloCls}`}>{sign}{eloDelta} Elo</div>

        <div className="end-actions">
          <button className="btn" onClick={onRematch}>Rejouer</button>
          <button className="btn btn-outline" onClick={onHome}>Accueil</button>
        </div>
      </div>
    </div>
  );
}
