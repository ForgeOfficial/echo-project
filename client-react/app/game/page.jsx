'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '../../context/AppContext';
import { EV } from '../../lib/constants';

// Écran de matchmaking : on rejoint la file, et dès qu'un adversaire est trouvé
// le serveur renvoie un gameId → on navigue vers /games/:gameId où se déroule
// (et se reprend) la partie.
export default function MatchmakingPage() {
  const { user, socket, socketReady, authReady, onlineCount } = useApp();
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (authReady && !user) { router.replace('/'); return; }
    if (!user || !socketReady) return;
    const s = socket.current;
    if (!s) return;

    s.emit(EV.QUEUE_JOIN, { elo: user.elo || 1000 });

    const onMatchFound = ({ gameId }) => router.replace(`/games/${gameId}`);
    s.on(EV.MATCH_FOUND, onMatchFound);
    return () => s.off(EV.MATCH_FOUND, onMatchFound);
  }, [user, socket, socketReady, authReady, router]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function leaveQueue() {
    socket.current?.emit(EV.QUEUE_LEAVE);
    router.replace('/');
  }

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
