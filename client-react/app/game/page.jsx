'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import confetti from 'canvas-confetti';
import { useApp } from '../../context/AppContext';
import GameCanvas from '../../components/GameCanvas';
import { EV } from '../../lib/constants';

const STAGE = { QUEUE: 'queue', PLAYING: 'playing', END: 'end' };
const PLAYER_COLORS = ['#00FFFF', '#FF00FF'];

export default function GamePage() {
  const { user, socket, onlineCount } = useApp();
  const router = useRouter();
  const [stage, setStage] = useState(STAGE.QUEUE);
  const [elapsed, setElapsed] = useState(0);
  const [endData, setEndData] = useState(null);

  const [matchData, setMatchData] = useState(null);

  useEffect(() => {
    if (!user) { router.replace('/'); return; }
    const s = socket.current;
    if (!s) return;
    s.emit(EV.QUEUE_JOIN, { elo: user.elo || 1000 });

    const onMatchFound = (data) => {
      // myPlayerIndex est envoyé directement par le serveur — pas de matching pseudo
      setMatchData(data);
      setStage(STAGE.PLAYING);
    };
    s.on(EV.MATCH_FOUND, onMatchFound);
    return () => s.off(EV.MATCH_FOUND, onMatchFound);
  }, [user, socket, router]);

  useEffect(() => {
    if (stage !== STAGE.QUEUE) return;
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const handleEnd = useCallback((result, stats, eloDelta, winnerIndex) => {
    setEndData({ result, stats, eloDelta, winnerIndex });
    setStage(STAGE.END);
  }, []);

  function leaveQueue() {
    socket.current?.emit(EV.QUEUE_LEAVE);
    router.replace('/');
  }

  function rematch() {
    setStage(STAGE.QUEUE);
    setElapsed(0);
    setEndData(null);
    const s = socket.current;
    if (s && user) s.emit(EV.QUEUE_JOIN, { elo: user.elo || 1000 });
  }

  if (stage === STAGE.QUEUE) {
    const mins = Math.floor(elapsed / 60);
    const secs = String(elapsed % 60).padStart(2, '0');
    return (
      <div className="queue-screen">
        <div className="queue-ring" />
        <div className="queue-title">Recherche d&apos;adversaire</div>
        <div className="queue-elapsed">{mins}:{secs}</div>
        <div className="queue-online">{onlineCount} joueur{onlineCount !== 1 ? 's' : ''} en ligne</div>
        <button className="btn btn-outline" onClick={leaveQueue}>Annuler</button>
      </div>
    );
  }

  if (stage === STAGE.END && endData) {
    const wIdx = endData.winnerIndex;
    const winnerPseudo = wIdx >= 0 ? (matchData?.players?.[wIdx]?.pseudo ?? 'Joueur') : null;
    const winnerColor = wIdx >= 0 ? PLAYER_COLORS[wIdx] : '#FFD700';
    return (
      <EndScreen
        {...endData}
        winnerPseudo={winnerPseudo}
        winnerColor={winnerColor}
        onRematch={rematch}
        onHome={() => router.replace('/')}
      />
    );
  }

  return <GameCanvas onEnd={handleEnd} matchData={matchData} />;
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

function EndScreen({ result, stats, eloDelta, winnerPseudo, winnerColor, onRematch, onHome }) {
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
