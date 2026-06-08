'use client';
import { useState } from 'react';
import { useApp } from '../context/AppContext';

export default function AuthModal({ onClose }) {
  const { login, register } = useApp();
  const [tab, setTab] = useState('login');
  const [loginData, setLoginData] = useState({ pseudo: '', password: '' });
  const [regData, setRegData] = useState({ pseudo: '', password: '' });
  const [loginErr, setLoginErr] = useState('');
  const [regErr, setRegErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true); setLoginErr('');
    const result = await login(loginData.pseudo, loginData.password);
    setLoading(false);
    if (result.error) setLoginErr(result.error);
    else onClose();
  }

  async function handleRegister(e) {
    e.preventDefault();
    setLoading(true); setRegErr('');
    const result = await register(regData.pseudo, regData.password);
    setLoading(false);
    if (result.error) setRegErr(result.error);
    else onClose();
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-tabs">
          <button className={`modal-tab${tab === 'login' ? ' active' : ''}`} onClick={() => setTab('login')}>Connexion</button>
          <button className={`modal-tab${tab === 'register' ? ' active' : ''}`} onClick={() => setTab('register')}>Inscription</button>
        </div>
        <button className="modal-close" onClick={onClose}>✕</button>

        {tab === 'login' ? (
          <form className="auth-form" onSubmit={handleLogin}>
            <h3>Connexion</h3>
            <input className="input-field" placeholder="Pseudo" required autoComplete="username"
              value={loginData.pseudo} onChange={e => setLoginData(p => ({ ...p, pseudo: e.target.value }))} />
            <input className="input-field" type="password" placeholder="Mot de passe" required autoComplete="current-password"
              value={loginData.password} onChange={e => setLoginData(p => ({ ...p, password: e.target.value }))} />
            <div className="form-error">{loginErr}</div>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? 'Connexion...' : 'Se connecter'}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleRegister}>
            <h3>Inscription</h3>
            <input className="input-field" placeholder="Pseudo (3–20 caractères)" required autoComplete="username"
              value={regData.pseudo} onChange={e => setRegData(p => ({ ...p, pseudo: e.target.value }))} />
            <input className="input-field" type="password" placeholder="Mot de passe (8+ caractères)" required autoComplete="new-password"
              value={regData.password} onChange={e => setRegData(p => ({ ...p, password: e.target.value }))} />
            <div className="form-error">{regErr}</div>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? 'Création...' : 'Créer un compte'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
