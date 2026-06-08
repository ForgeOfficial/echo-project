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

  let status;
  if (lobby.isPrivate) status = isHost ? (lobby.canStart ? 'Prêt à lancer' : 'Complète les équipes (2 par camp)') : "En attente de l'hôte…";
  else status = lobby.canStart ? 'Démarrage…' : `En attente de joueurs… (${lobby.members.length}/${mode.totalPlayers})`;

  return (
    <div className="lobby-screen">
      <div className="lobby-card">
        <div className="lobby-header">
          <span className="lobby-mode">{mode.label}</span>
          {lobby.isPrivate ? (
            <button className="lobby-code" onClick={copyCode} title="Copier le code">
              Code <b>{lobby.code}</b> <span className="lobby-copy">{copied ? '✓ copié' : '⧉'}</span>
            </button>
          ) : (
            <span className="lobby-tag">Partie rapide</span>
          )}
        </div>

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
                <button
                  className="btn btn-outline lobby-join-btn"
                  onClick={() => setTeam(t)}
                  disabled={iAmHere || (teamFull && !iAmHere)}
                >
                  {iAmHere ? 'Ton équipe' : teamFull ? 'Complète' : 'Rejoindre'}
                </button>
              </div>
            );
          })}
        </div>

        {error && <div className="lobby-error">{error}</div>}

        <div className="lobby-actions">
          <button className="btn btn-outline" onClick={leave}>Quitter</button>
          {lobby.isPrivate && isHost ? (
            <button className="btn" onClick={start} disabled={!lobby.canStart}>Lancer la partie</button>
          ) : (
            <span className="lobby-status">{status}</span>
          )}
        </div>
      </div>
    </div>
  );
}
