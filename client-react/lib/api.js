let _accessToken = null;
let _onTokenChange = null;

export function setToken(token) {
  _accessToken = token;
}
export function getToken() {
  return _accessToken;
}
export function onTokenChange(fn) {
  _onTokenChange = fn;
}

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;
  const res = await fetch(path, { ...options, headers, credentials: 'include' });
  if (res.status === 401 && path !== '/auth/refresh' && path !== '/auth/login') {
    const ok = await tryRefresh();
    if (ok) {
      headers['Authorization'] = `Bearer ${_accessToken}`;
      return fetch(path, { ...options, headers, credentials: 'include' });
    }
  }
  return res;
}

export async function tryRefresh() {
  try {
    const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      _accessToken = data.accessToken;
      if (_onTokenChange) _onTokenChange(data.user);
      return true;
    }
  } catch {}
  return false;
}

async function safeJson(res) {
  try { return await res.json(); }
  catch { return { error: `Erreur serveur (${res.status})` }; }
}

export async function register(pseudo, password) {
  const res = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ pseudo, password }) });
  return safeJson(res);
}

export async function login(pseudo, password) {
  const res = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ pseudo, password }) });
  return safeJson(res);
}

export async function guestLogin(pseudo) {
  const res = await apiFetch('/auth/guest', { method: 'POST', body: JSON.stringify({ pseudo }) });
  return safeJson(res);
}

export async function logout() {
  await apiFetch('/auth/logout', { method: 'POST' });
  _accessToken = null;
}

export async function getMe() {
  const res = await apiFetch('/auth/me');
  return res.ok ? res.json() : null;
}

export async function getLeaderboard() {
  const res = await apiFetch('/api/leaderboard');
  return res.ok ? res.json() : [];
}

export async function getProfile(pseudo) {
  const res = await apiFetch(`/api/profile/${encodeURIComponent(pseudo)}`);
  return res.ok ? res.json() : null;
}
