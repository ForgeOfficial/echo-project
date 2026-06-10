'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useApp } from '../../../context/AppContext';
import GameCanvas from '../../../components/GameCanvas';
import { EV } from '../../../lib/constants';

const STAGE = { LOADING: 'loading', PLAYING: 'playing', END: 'end' };

// 'r,g,b' (couleurs d'équipe) → hex, requis par canvas-confetti et le CSS.
function rgbToHex(rgb) {
  const [r, g, b] = String(rgb).split(',').map(n => parseInt(n, 10));
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x || 0)).toString(16).padStart(2, '0')).join('');
}

export default function GamePage() {
  const { user, setUser, socket, socketReady, authReady } = useApp();
  const router = useRouter();
  const { gameId } = useParams();

  const [stage, setStage] = useState(STAGE.LOADING);
  const [matchData, setMatchData] = useState(null);
  const [initialState, setInitialState] = useState(null);
  const [endData, setEndData] = useState(null);
  const endedRef = useRef(false);

  const handleEnd = useCallback((data) => {
    if (endedRef.current) return; // GAME_END ne doit s'appliquer qu'une fois
    endedRef.current = true;
    setEndData(data);
    setStage(STAGE.END);
    // Répercute le delta d'Elo sur l'utilisateur du contexte pour que le Navbar
    // reflète le nouveau score en direct (la valeur fait autorité côté serveur).
    if (data.eloDelta) setUser(u => u ? { ...u, elo: u.elo + data.eloDelta } : u);
  }, [setUser]);

  // (Re)joindre la partie par son UUID : marche pour un nouveau match comme pour
  // un retour après fermeture de page. Le serveur réattache le socket et renvoie
  // soit l'état courant (partie en cours), soit le résultat (partie déjà finie).
  useEffect(() => {
    if (authReady && !user) { router.replace('/'); return; }
    if (!user || !socketReady) return;
    const s = socket.current;
    if (!s) return;

    const onJoined = ({ myPlayerIndex, myTeam, players, mode, state }) => {
      setMatchData({ myPlayerIndex, myTeam, players, mode });
      setInitialState(state);
      setStage(STAGE.PLAYING);
    };
    const onEnd = (data) => handleEnd(data);
    const onNotFound = () => router.replace('/');

    s.on(EV.GAME_JOINED, onJoined);
    s.on(EV.GAME_END, onEnd);
    s.on(EV.GAME_NOT_FOUND, onNotFound);
    s.emit(EV.JOIN_GAME, { gameId });

    return () => {
      s.off(EV.GAME_JOINED, onJoined);
      s.off(EV.GAME_END, onEnd);
      s.off(EV.GAME_NOT_FOUND, onNotFound);
    };
  }, [gameId, user, socket, socketReady, authReady, router, handleEnd]);

  function rematch() {
    router.replace('/game');
  }

  if (stage === STAGE.END && endData) {
    const myTeam = endData.myTeam ?? matchData?.myTeam ?? 0;
    const wTeam = endData.winnerTeam;
    const result = wTeam === myTeam ? 'win' : wTeam === -1 ? 'draw' : 'lose';
    const mode = endData.mode ?? matchData?.mode;
    const teamColors = mode?.teamColors ?? ['255,255,255', '255,69,58'];
    const teamNames = mode?.teamNames ?? ['Blanc', 'Rouge'];
    const teamSize = mode?.teamSize ?? 1;
    const players = endData.players ?? matchData?.players ?? [];
    const winners = wTeam >= 0 ? players.filter(p => p.team === wTeam).map(p => p.pseudo) : [];
    const winnerLabel = wTeam < 0 ? null : (teamSize > 1 ? `Équipe ${teamNames[wTeam]}` : winners[0]);
    const winnerColor = wTeam >= 0 ? rgbToHex(teamColors[wTeam]) : '#FFD700';
    return (
      <EndScreen
        result={result}
        stats={endData.myStats ?? { pings: 0, shots: 0, hits: 0 }}
        eloDelta={endData.eloDelta ?? 0}
        reason={endData.reason}
        winnerLabel={winnerLabel}
        winners={teamSize > 1 ? winners : []}
        winnerColor={winnerColor}
        showElo={mode?.ranked !== false}
        onRematch={rematch}
        onHome={() => router.replace('/')}
      />
    );
  }

  if (stage === STAGE.PLAYING) {
    return <GameCanvas matchData={matchData} initialState={initialState} />;
  }

  return (
    <div className="queue-screen">
      <div className="queue-ring" />
      <div className="queue-title">Connexion à la partie…</div>
    </div>
  );
}

// « Bouhhhhhh » : huée de foule synthétisée (pas de fichier son nécessaire)
function playBoo() {
  try {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return;
    const ac = new Ctx();
    const t0 = ac.currentTime;
    const dur = 1.4;

    const master = ac.createGain();
    master.connect(ac.destination);
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.5, t0 + 0.18);
    master.gain.setValueAtTime(0.5, t0 + dur - 0.45);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // Filtre passe-bas → voyelle « ooo » sourde plutôt que sciante
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(750, t0);
    lp.frequency.linearRampToValueAtTime(380, t0 + dur);
    lp.Q.value = 5;
    lp.connect(master);

    // Plusieurs voix désaccordées = foule qui hue, pitch descendant « bouuuh »
    [70, 98, 110, 116].forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.15, t0);
      o.frequency.linearRampToValueAtTime(f * 0.82, t0 + dur);
      const lfo = ac.createOscillator();
      lfo.frequency.value = 4.5 + i;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = f * 0.035;
      lfo.connect(lfoGain).connect(o.frequency);
      const g = ac.createGain();
      g.gain.value = 0.22;
      o.connect(g).connect(lp);
      o.start(t0); o.stop(t0 + dur + 0.05);
      lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    });

    setTimeout(() => ac.close().catch(() => {}), (dur + 0.3) * 1000);
  } catch { /* audio indisponible, on ignore */ }
}

function EndScreen({ result, stats, eloDelta, reason, winnerLabel, winners = [], winnerColor, showElo = true, onRematch, onHome }) {
  const acc = stats.shots > 0 ? Math.round((stats.hits / stats.shots) * 100) : 0;
  const sign = eloDelta > 0 ? '+' : '';
  const eloCls = eloDelta >= 0 ? 'pos' : 'neg';
  const labels = { win: 'TU REMPORTES LE DUEL', lose: 'DÉFAITE', draw: 'ÉGALITÉ' };

  useEffect(() => {
    // Plus de particules (confettis/tomates) : trop lourdes sur mobile → lag.
    // On garde uniquement la huée audio pour la défaite (aucun coût visuel).
    if (result === 'lose') playBoo();
  }, [result]);

  return (
    <div className="end-screen">
      <div className="champion-card">
        {winnerLabel ? (
          <>
            <div className="champion-trophy" style={{ '--wc': winnerColor }}>🏆</div>
            <div className="champion-label">{winners.length > 1 ? 'Équipe victorieuse' : 'Champion du duel'}</div>
            <div className="champion-name" style={{ color: winnerColor, '--wc': winnerColor }}>
              {winnerLabel}
            </div>
            {winners.length > 1 && (
              <div className="champion-label" style={{ marginTop: '0.15rem' }}>{winners.join(' · ')}</div>
            )}
          </>
        ) : (
          <div className="champion-name" style={{ color: '#FFD700' }}>ÉGALITÉ</div>
        )}

        <div className={`champion-verdict ${result}`}>{labels[result]}</div>

        {reason === 'abandon' && (
          <div className="champion-label" style={{ marginTop: '0.25rem' }}>
            {result === 'win' ? 'Adversaire déconnecté' : 'Abandon — déconnexion'}
          </div>
        )}

        <div className="end-stats">
          <div className="end-stat"><span className="end-stat-val">{stats.pings}</span><span className="end-stat-lbl">Pings</span></div>
          <div className="end-stat"><span className="end-stat-val">{stats.shots}</span><span className="end-stat-lbl">Tirs</span></div>
          <div className="end-stat"><span className="end-stat-val">{stats.hits}</span><span className="end-stat-lbl">Touches</span></div>
          <div className="end-stat"><span className="end-stat-val">{acc}%</span><span className="end-stat-lbl">Précision</span></div>
        </div>

        {showElo
          ? <div className={`end-elo ${eloCls}`}>{sign}{eloDelta} Elo</div>
          : <div className="end-elo" style={{ opacity: 0.6 }}>Partie non classée</div>}

        <div className="end-actions">
          <button className="btn" onClick={onRematch}>Rejouer</button>
          <button className="btn btn-outline" onClick={onHome}>Accueil</button>
        </div>
      </div>
    </div>
  );
}
