'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '../context/AppContext';
import AuthModal from '../components/AuthModal';

export default function HomePage() {
  const { user, onlineCount } = useApp();
  const router = useRouter();
  const bgRef = useRef(null);
  const [showAuth, setShowAuth] = useState(false);

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
    <div style={{ position: 'relative', height: 'calc(100vh - 56px)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <canvas ref={bgRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', textAlign: 'center' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontWeight: 900,
          fontSize: 'clamp(4rem,14vw,9rem)', letterSpacing: '0.5em',
          color: 'var(--cyan)', lineHeight: 1,
          textShadow: '0 0 40px var(--cyan), 0 0 80px rgba(0,255,255,0.3), 0 0 120px rgba(0,255,255,0.1)',
          marginBottom: '1rem',
          animation: 'glitch 6s ease-in-out infinite',
        }}>
          ECHO
        </h1>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.95rem', letterSpacing: '0.06em', marginBottom: '2.5rem' }}>
          L&apos;arène est noire. Émets un ping. Traque ton adversaire.
        </p>
        <button className="btn btn-lg" onClick={handlePlay} style={{ marginBottom: '1.5rem' }}>
          {user ? '▶ Jouer' : 'Se connecter pour jouer'}
        </button>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', letterSpacing: '0.05em' }}>
          {onlineCount} joueur{onlineCount !== 1 ? 's' : ''} en ligne
        </div>
      </div>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <style>{`
        @keyframes glitch {
          0%, 90%, 100% { clip-path: none; transform: none; }
          92% { clip-path: inset(20% 0 60% 0); transform: translateX(-3px); }
          94% { clip-path: inset(60% 0 10% 0); transform: translateX(3px); }
          96% { clip-path: none; transform: none; }
        }
      `}</style>
    </div>
  );
}
