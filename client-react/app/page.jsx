'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '../context/AppContext';
import { EV } from '../lib/constants';
import AuthModal from '../components/AuthModal';

export default function HomePage() {
  const { user, socket, socketReady, onlineCount } = useApp();
  const router = useRouter();
  const bgRef = useRef(null);
  const [showAuth, setShowAuth] = useState(false);
  const [code, setCode] = useState('');
  const [lobbyErr, setLobbyErr] = useState('');

  // Entrée/sortie des salons (2v2) : on écoute la confirmation pour naviguer.
  useEffect(() => {
    if (!socketReady) return;
    const s = socket.current;
    if (!s) return;
    const onJoined = ({ code: c }) => router.push(`/lobby/${c}`);
    const onError = ({ msg }) => setLobbyErr(msg || 'Erreur');
    // Démarrage instantané possible (4e joueur d'une partie rapide) : on capte
    // MATCH_FOUND ici aussi pour filer directement en partie.
    const onMatch = ({ gameId }) => router.replace(`/games/${gameId}`);
    s.on(EV.LOBBY_JOINED, onJoined);
    s.on(EV.LOBBY_ERROR, onError);
    s.on(EV.MATCH_FOUND, onMatch);
    return () => { s.off(EV.LOBBY_JOINED, onJoined); s.off(EV.LOBBY_ERROR, onError); s.off(EV.MATCH_FOUND, onMatch); };
  }, [socket, socketReady, router]);

  const needAuth = () => { if (!user) { setShowAuth(true); return true; } return false; };
  const quickplay = () => { if (needAuth()) return; socket.current?.emit(EV.LOBBY_QUICKPLAY, { mode: 'duo', elo: user.elo || 1000 }); };
  const createPrivate = () => { if (needAuth()) return; socket.current?.emit(EV.LOBBY_CREATE, { mode: 'duo', elo: user.elo || 1000 }); };
  const joinCode = () => {
    if (needAuth()) return;
    const c = code.trim();
    if (c) socket.current?.emit(EV.LOBBY_JOIN, { code: c, elo: user.elo || 1000 });
  };

  useEffect(() => {
    const canvas = bgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const waves = [];

    const spawn = () => waves.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: 0,
      maxR: 200 + Math.random() * 250,
      color: Math.random() > 0.5 ? '0,255,255' : '255,0,255',
      speed: 55 + Math.random() * 50,
    });

    for (let i = 0; i < 6; i++) spawn();
    const interval = setInterval(spawn, 2200);

    let last = performance.now();
    let raf;
    const loop = (now) => {
      const dt = (now - last) / 1000; last = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i]; w.r += w.speed * Math.max(0, dt);
        const a = Math.max(0, 1 - w.r / w.maxR);
        if (a <= 0 || w.r <= 0) { waves.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${w.color},${a * 0.28})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); clearInterval(interval); window.removeEventListener('resize', onResize); };
  }, []);

  function handlePlay() {
    if (!user) { setShowAuth(true); return; }
    router.push('/game');
  }

  return (
    <div className="home">
      <canvas ref={bgRef} className="home-bg" />

      <div className="home-inner">
        <header className="home-hero">
          <h1 className="home-title">ECHO</h1>
          <p className="home-tagline">
            L&apos;arène est noire. Émets un ping. Traque ton adversaire.
          </p>
        </header>

        <div className="mode-grid">
          {/* ——— Carte vedette : 1v1 classé ——— */}
          <button className="mode-card mode-card--featured" onClick={handlePlay}>
            <span className="mode-card-glow" aria-hidden />
            <div className="mode-card-head">
              <span className="mode-card-tag">1V1</span>
              <span className="mode-badge mode-badge--ranked">★ Classé</span>
            </div>
            <div className="mode-card-name">Duel</div>
            <p className="mode-card-desc">
              Tête-à-tête sonar. Chaque victoire compte au classement Elo.
            </p>
            <span className="mode-card-cta">
              {user ? '▶ JOUER' : 'Se connecter pour jouer'}
            </span>
          </button>

          {/* ——— Modes en équipe ——— */}
          <div className="mode-team-col">
            <div className="mode-team-label">En équipe — 2V2</div>

            <button className="mode-card mode-card--team mode-card--public" onClick={quickplay}>
              <div className="mode-card-head">
                <span className="mode-card-tag">2V2</span>
                <span className="mode-badge mode-badge--public">Public</span>
              </div>
              <div className="mode-card-name">Partie rapide</div>
              <p className="mode-card-desc">Matchmaking d&apos;équipe instantané.</p>
            </button>

            <button className="mode-card mode-card--team mode-card--private" onClick={createPrivate}>
              <div className="mode-card-head">
                <span className="mode-card-tag">2V2</span>
                <span className="mode-badge mode-badge--private">Privé</span>
              </div>
              <div className="mode-card-name">Créer privé</div>
              <p className="mode-card-desc">Invite tes amis. Lance même en 2v1.</p>
            </button>

            <div className="mode-card mode-card--join">
              <div className="mode-card-head">
                <span className="mode-card-tag">CODE</span>
                <span className="mode-badge mode-badge--join">Rejoindre</span>
              </div>
              <div className="mode-join-row">
                <input
                  className="mode-code-input"
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 4)); setLobbyErr(''); }}
                  placeholder="0000"
                  inputMode="numeric"
                  maxLength={4}
                  onKeyDown={(e) => e.key === 'Enter' && joinCode()}
                />
                <button className="btn" onClick={joinCode} disabled={code.length < 4}>Entrer</button>
              </div>
            </div>
          </div>
        </div>

        {lobbyErr && <div className="lobby-error home-err">{lobbyErr}</div>}

        <div className="home-online">
          <span className="home-online-dot" />
          {onlineCount} joueur{onlineCount !== 1 ? 's' : ''} en ligne
        </div>
      </div>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  );
}
