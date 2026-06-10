'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { getRank } from '../lib/constants';
import AuthModal from './AuthModal';

function ThemeToggle() {
  // 'dark' au SSR, resynchronisé au montage avec ce que le script anti-FOUC
  // du layout a appliqué — évite tout écart d'hydratation.
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('echo-theme', next); } catch {}
    setTheme(next);
  };
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
      title={theme === 'dark' ? 'Thème clair' : 'Thème sombre'}
    >
      {theme === 'dark' ? (
        /* soleil → propose le thème clair */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
        </svg>
      ) : (
        /* lune → propose le thème sombre */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6a8.5 8.5 0 1 0 10.6 10.6Z" />
        </svg>
      )}
    </button>
  );
}

export default function Navbar() {
  const { user, logout } = useApp();
  const pathname = usePathname();
  const [showAuth, setShowAuth] = useState(false);

  return (
    <>
      <nav className="navbar">
        <Link href="/" className="navbar-logo">ECHO</Link>
        <div className="navbar-links">
          <Link href="/" className={`navbar-link${pathname === '/' ? ' active' : ''}`}>Accueil</Link>
          <Link href="/leaderboard" className={`navbar-link${pathname === '/leaderboard' ? ' active' : ''}`}>Classement</Link>
        </div>
        <div className="navbar-user">
          <ThemeToggle />
          {user ? (
            <>
              <Link href={`/profile/${user.pseudo}`} style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>{getRank(user.elo).icon}</span>
                <span className="navbar-pseudo">{user.pseudo}</span>
                <span className="navbar-elo">{user.elo}</span>
              </Link>
              <button className="btn btn-outline" style={{ fontSize: '0.75rem', padding: '0.35rem 0.8rem' }} onClick={logout}>
                Déco
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setShowAuth(true)}>Connexion</button>
          )}
        </div>
      </nav>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </>
  );
}
