'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getProfile } from '../../../lib/api';
import { getRank } from '../../../lib/constants';

export default function ProfilePage() {
  const { pseudo } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProfile(pseudo).then(d => { setData(d); setLoading(false); });
  }, [pseudo]);

  if (loading) return <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-dim)' }}>Chargement...</div>;
  if (!data) return <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--magenta)' }}>Joueur introuvable</div>;

  const rank = getRank(data.elo);
  const total = data.wins + data.losses + data.draws;
  const ratio = total > 0 ? Math.round(data.wins / total * 100) : 0;
  const avgAcc = data.matches.length > 0
    ? Math.round(data.matches.reduce((s, m) => s + m.accuracy, 0) / data.matches.length)
    : 0;

  return (
    <div className="profile-container">
      <div className="profile-header">
        <div className="profile-avatar" style={{ borderColor: rank.color, color: rank.color, textShadow: `0 0 12px ${rank.color}` }}>
          {data.pseudo[0].toUpperCase()}
        </div>
        <div>
          <div className="profile-name" style={{ color: rank.color }}>{data.pseudo}</div>
          <div className="profile-rank">{rank.icon} {rank.name} — {data.elo} Elo</div>
        </div>
      </div>

      <div className="profile-stats">
        {[
          { val: data.elo, lbl: 'Elo', color: rank.color },
          { val: data.wins, lbl: 'Victoires', color: 'var(--green)' },
          { val: total, lbl: 'Parties', color: 'var(--text)' },
          { val: `${ratio}%`, lbl: 'Ratio', color: 'var(--cyan)' },
          { val: `${avgAcc}%`, lbl: 'Précision', color: 'var(--cyan)' },
        ].map(({ val, lbl, color }) => (
          <div key={lbl} className="stat-card">
            <span className="stat-value" style={{ color }}>{val}</span>
            <span className="stat-label">{lbl}</span>
          </div>
        ))}
      </div>

      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.1em', marginBottom: '1rem', color: 'var(--text)', fontSize: '0.85rem' }}>
          Historique
        </h3>
        {data.matches.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Aucune partie jouée</p>
        ) : (
          <div className="match-list">
            {data.matches.map((m, i) => {
              const sign = m.eloDelta > 0 ? '+' : '';
              const cls = m.eloDelta >= 0 ? 'pos' : 'neg';
              const date = new Date(m.createdAt).toLocaleDateString('fr-FR');
              return (
                <div key={i} className="match-row">
                  <span className={`match-result ${m.result}`}>{m.result}</span>
                  <span className="match-opponent">vs {m.opponent}</span>
                  <span className={`match-delta ${cls}`}>{sign}{m.eloDelta}</span>
                  <span className="match-date">{date}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
