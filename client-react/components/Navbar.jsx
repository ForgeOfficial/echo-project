'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { getRank } from '../lib/constants';
import AuthModal from './AuthModal';

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
