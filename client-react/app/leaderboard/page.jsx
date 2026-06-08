'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '../../context/AppContext';
import { getLeaderboard } from '../../lib/api';
import { getRank } from '../../lib/constants';

export default function LeaderboardPage() {
  const { user } = useApp();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLeaderboard().then(data => { setEntries(data); setLoading(false); });
  }, []);

  return (
    <div className="lb-container">
      <h1 className="page-title">Classement</h1>
      {loading ? (
        <p style={{ textAlign: 'center', color: 'var(--text-dim)' }}>Chargement...</p>
      ) : (
        <table className="lb-table">
          <thead>
            <tr>
              <th>#</th><th>Rang</th><th>Joueur</th><th>Elo</th>
              <th>Victoires</th><th>Parties</th><th>Ratio</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rank = getRank(e.elo);
              const total = e.wins + e.losses + e.draws;
              const ratio = total > 0 ? Math.round(e.wins / total * 100) : 0;
              const isMe = e.id === user?.id;
              return (
                <tr key={e.id} className={isMe ? 'me' : ''}>
                  <td><span className="lb-rank-no">{i + 1}</span></td>
                  <td><span style={{ color: rank.color }}>{rank.icon} {rank.name}</span></td>
                  <td><Link href={`/profile/${e.pseudo}`} className="lb-pseudo">{e.pseudo}</Link></td>
                  <td><span className="lb-elo">{e.elo}</span></td>
                  <td>{e.wins}</td>
                  <td>{total}</td>
                  <td>{ratio}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
