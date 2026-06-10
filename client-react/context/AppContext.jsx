'use client';
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import * as api from '../lib/api';
import { EV } from '../lib/constants';

const AppCtx = createContext(null);

// Session invité : sans refresh token côté serveur, on conserve l'access token
// (et le pseudo) en local pour survivre à un rechargement — notamment en
// pleine partie, où le même userId doit être réutilisé pour se reconnecter.
const GUEST_KEY = 'echo-guest';
function saveGuest(accessToken, user) {
  try { localStorage.setItem(GUEST_KEY, JSON.stringify({ accessToken, user })); } catch {}
}
function loadGuest() {
  try { return JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch { return null; }
}
function clearGuest() {
  try { localStorage.removeItem(GUEST_KEY); } catch {}
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const socketRef = useRef(null);
  const currentTokenRef = useRef(undefined);
  const [socketReady, setSocketReady] = useState(false);
  // Passe à true une fois le refresh initial du token résolu : avant ça, `user`
  // peut être null sans que l'utilisateur soit réellement déconnecté. Les pages
  // protégées (jeu) attendent ce flag avant de décider de rediriger.
  const [authReady, setAuthReady] = useState(false);

  const connectSocket = useCallback((token) => {
    const t = token || '';
    // Dédup : ne JAMAIS recréer un socket avec le même token.
    // Évite que le tryRefresh initial (résolu en retard) ou StrictMode
    // détruise le socket en cours de partie et orpheline le joueur.
    if (socketRef.current && currentTokenRef.current === t) return;
    currentTokenRef.current = t;
    if (socketRef.current) socketRef.current.disconnect();
    const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3001';
    const s = io(SERVER_URL, { auth: { token: t }, autoConnect: true });
    s.on('connect', () => setSocketReady(true));
    s.on('disconnect', () => setSocketReady(false));
    s.on(EV.QUEUE_STATUS, (d) => setOnlineCount(d.online || 0));
    socketRef.current = s;
  }, []);

  useEffect(() => {
    api.onTokenChange((u) => { setUser(u); connectSocket(api.getToken()); });
    api.tryRefresh().then(ok => {
      // En cas de succès, onTokenChange a déjà (re)connecté le socket.
      if (ok) return;
      // Pas de compte : on tente de restaurer une session invité locale.
      const g = loadGuest();
      if (g?.accessToken) {
        api.setToken(g.accessToken);
        setUser(g.user);
        connectSocket(g.accessToken);
      } else {
        connectSocket(null);
      }
    }).finally(() => setAuthReady(true));
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
      currentTokenRef.current = undefined;
    };
  }, [connectSocket]);

  const login = useCallback(async (pseudo, password) => {
    const data = await api.login(pseudo, password);
    if (data.error) return { error: data.error };
    clearGuest(); // un vrai compte prend le pas sur toute session invité
    api.setToken(data.accessToken);
    setUser(data.user);
    connectSocket(data.accessToken);
    return { ok: true };
  }, [connectSocket]);

  const register = useCallback(async (pseudo, password) => {
    const data = await api.register(pseudo, password);
    if (data.error) return { error: data.error };
    clearGuest();
    api.setToken(data.accessToken);
    setUser(data.user);
    connectSocket(data.accessToken);
    return { ok: true };
  }, [connectSocket]);

  const guestLogin = useCallback(async (pseudo) => {
    const data = await api.guestLogin(pseudo);
    if (data.error) return { error: data.error };
    saveGuest(data.accessToken, data.user);
    api.setToken(data.accessToken);
    setUser(data.user);
    connectSocket(data.accessToken);
    return { ok: true };
  }, [connectSocket]);

  const logout = useCallback(async () => {
    clearGuest();
    await api.logout();
    api.setToken(null);
    setUser(null);
    connectSocket(null);
  }, [connectSocket]);

  return (
    <AppCtx.Provider value={{ user, setUser, onlineCount, socket: socketRef, socketReady, authReady, login, register, guestLogin, logout }}>
      {children}
    </AppCtx.Provider>
  );
}

export function useApp() {
  return useContext(AppCtx);
}
