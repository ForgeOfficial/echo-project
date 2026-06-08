'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useApp } from '../../../context/AppContext';
import { EV } from '../../../lib/constants';

export default function LobbyPage() {
  const { user, socket, socketReady, authReady } = useApp();
  const router = useRouter();
  const { code } = useParams();

  const [lobby, setLobby] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (authReady && !user) { router.replace('/'); return; }
    if (!user || !socketReady) return;
    const s = socket.current;
    if (!s) return;

    const onState = (snap) => { if (snap.code === code) { setLobby(snap); setError(''); } };
    const onError = ({ msg }) => {
      setError(msg || 'Erreur');
      if (/introuvable|complet/i.test(msg || '')) setTimeout(() => router.replace('/'), 1500);
    };
    const onMatch = ({ gameId }) => router.replace(`/games/${gameId}`);

    s.on(EV.LOBBY_STATE, onState);
    s.on(EV.LOBBY_ERROR, onError);
    s.on(EV.MATCH_FOUND, onMatch);
    // (Re)joindre / resynchroniser par le code de l'URL.
    s.emit(EV.LOBBY_JOIN, { code, elo: user.elo || 1000 });

    return () => {
      s.off(EV.LOBBY_STATE, onState);
      s.off(EV.LOBBY_ERROR, onError);
      s.off(EV.MATCH_FOUND, onMatch);
      // En quittant la page (hors démarrage de partie), on libère la place.
      s.emit(EV.LOBBY_LEAVE);
    };
  }, [code, user, socket, socketReady, authReady, router]);

  function setTeam(t) { socket.current?.emit(EV.LOBBY_SET_TEAM, { team: t }); }
  function start() { socket.current?.emit(EV.LOBBY_START); }
  function leave() { socket.current?.emit(EV.LOBBY_LEAVE); router.replace('/'); }
  function copyCode() {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  if (!lobby) {
    return (
      <div className="lobby-screen">
        <div className="queue-ring" />
        <div className="queue-title">{error || 'Connexion au salon…'}</div>
      </div>
    );
  }

  const mode = lobby.mode;
  const me = lobby.members.find(m => m.userId === user?.id);
  const isHost = lobby.hostUserId === user?.id;
  const full = lobby.members.length >= mode.totalPlayers;
  // Privé : l'hôte peut lancer en sous-effectif (1v1 / 2v1…). Public : complet requis.
  const hostCanStart = lobby.isPrivate ? lobby.canHostStart : lobby.canStart;
  const isFFA = mode.format === 'ffa';
  const locked = isFFA || mode.autoBalance; // pas de choix manuel d'équipe
  const durLabel = `${Math.round((mode.durationMs || 180000) / 60000)} min`;

  let status;
  if (lobby.isPrivate) {
    if (!isHost) status = "En attente de l'hôte…";
    else if (full) status = 'Prêt à lancer';
    else if (lobby.canHostStart) status = `Lançable à ${lobby.members.length}/${mode.totalPlayers} (sous-effectif)`;
    else status = isFFA ? 'Il faut au moins 2 joueurs' : 'Il faut au moins 2 équipes occupées';
  } else {
    status = lobby.canStart ? 'Démarrage…' : `En attente de joueurs… (${lobby.members.length}/${mode.totalPlayers})`;
  }

  return (
    <div className="lobby-screen">
      <div className="lobby-card">
        <div className="lobby-header">
          <div className="lobby-header-l">
            <span className="lobby-mode">{mode.label}</span>
            <div className="lobby-meta">
              <span className="lobby-meta-tag">{isFFA ? `MÊLÉE · ${mode.totalPlayers}J` : `${mode.teamCount}×${mode.teamSize}`}</span>
              <span className="lobby-meta-tag">{mode.maxHp} vies</span>
              <span className="lobby-meta-tag">{durLabel}</span>
              {mode.borderMap && <span className="lobby-meta-tag toxic">☠ Zone toxique</span>}
            </div>
          </div>
          {lobby.isPrivate ? (
            <button className="lobby-code" onClick={copyCode} title="Copier le code">
              Code <b>{lobby.code}</b> <span className="lobby-copy">{copied ? '✓ copié' : '⧉'}</span>
            </button>
          ) : (
            <span className="lobby-tag">Partie rapide</span>
          )}
        </div>

        {isFFA ? (
          <div className="lobby-ffa">
            {lobby.members.map(m => {
              const col = `rgb(${mode.teamColors[m.team % mode.teamColors.length]})`;
              return (
                <div key={m.userId} className="lobby-slot filled" style={{ borderColor: col }}>
                  <span style={{ opacity: m.connected ? 1 : 0.4, color: col }}>{m.pseudo}</span>
                  {m.userId === user?.id && <span className="lobby-you">toi</span>}
                  {m.userId === lobby.hostUserId && <span className="lobby-host">hôte</span>}
                </div>
              );
            })}
            {Array.from({ length: Math.max(0, mode.totalPlayers - lobby.members.length) }).map((_, i) => (
              <div key={`e${i}`} className="lobby-slot"><span className="lobby-empty">Libre</span></div>
            ))}
          </div>
        ) : (
          <div className="lobby-teams">
            {Array.from({ length: mode.teamCount }).map((_, t) => {
              const col = `rgb(${mode.teamColors[t]})`;
              const members = lobby.members.filter(m => m.team === t);
              const iAmHere = me?.team === t;
              const teamFull = members.length >= mode.teamSize;
              return (
                <div key={t} className="lobby-team" style={{ borderColor: col }}>
                  <div className="lobby-team-name" style={{ color: col }}>{mode.teamNames[t]}</div>
                  {Array.from({ length: mode.teamSize }).map((_, i) => {
                    const m = members[i];
                    return (
                      <div key={i} className={`lobby-slot${m ? ' filled' : ''}`} style={m ? { borderColor: col } : undefined}>
                        {m ? (
                          <>
                            <span style={{ opacity: m.connected ? 1 : 0.4 }}>{m.pseudo}</span>
                            {m.userId === user?.id && <span className="lobby-you">toi</span>}
                            {m.userId === lobby.hostUserId && <span className="lobby-host">hôte</span>}
                          </>
                        ) : <span className="lobby-empty">Libre</span>}
                      </div>
                    );
                  })}
                  {locked ? (
                    iAmHere ? <span className="lobby-auto">Auto</span> : <span className="lobby-auto" />
                  ) : (
                    <button
                      className="btn btn-outline lobby-join-btn"
                      onClick={() => setTeam(t)}
                      disabled={iAmHere || (teamFull && !iAmHere)}
                    >
                      {iAmHere ? 'Ton équipe' : teamFull ? 'Complète' : 'Rejoindre'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error && <div className="lobby-error">{error}</div>}

        <div className="lobby-actions">
          <button className="btn btn-outline" onClick={leave}>Quitter</button>
          {lobby.isPrivate && isHost ? (
            <div className="lobby-start-wrap">
              <span className="lobby-status">{status}</span>
              <button className="btn" onClick={start} disabled={!hostCanStart}>
                {full ? 'Lancer la partie' : `Lancer (${lobby.members.length} joueurs)`}
              </button>
            </div>
          ) : (
            <span className="lobby-status">{status}</span>
          )}
        </div>
      </div>
    </div>
  );
}
