'use client';
import { useState } from 'react';

// Modal de configuration d'une partie personnalisée. Produit une `config` que
// le serveur valide/borne via buildCustomMode (cf. shared/modes.js).
const DURATIONS = [
  { sec: 60, label: '1 min' },
  { sec: 120, label: '2 min' },
  { sec: 180, label: '3 min' },
  { sec: 300, label: '5 min' },
];

function Stepper({ label, value, min, max, onChange, hint }) {
  return (
    <div className="cg-field">
      <div className="cg-field-label">{label}{hint && <span className="cg-hint">{hint}</span>}</div>
      <div className="cg-stepper">
        <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button>
        <span className="cg-stepper-val">{value}</span>
        <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <button type="button" className={`cg-toggle${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="cg-toggle-track"><span className="cg-toggle-knob" /></span>
      <span className="cg-toggle-text">{label}{hint && <span className="cg-hint">{hint}</span>}</span>
    </button>
  );
}

export default function CustomGameModal({ onClose, onCreate }) {
  const [format, setFormat] = useState('ffa');
  const [objective, setObjective] = useState('survival');
  const [playerCount, setPlayerCount] = useState(4);
  const [teamCount, setTeamCount] = useState(2);
  const [teamSize, setTeamSize] = useState(2);
  const [durationSec, setDurationSec] = useState(120);
  const [lives, setLives] = useState(3);
  const [killTarget, setKillTarget] = useState(15);
  const [respawnSec, setRespawnSec] = useState(3);
  const [waitForFull, setWaitForFull] = useState(true);
  const [autoBalance, setAutoBalance] = useState(true);
  const [borderMap, setBorderMap] = useState(true);

  const total = format === 'ffa' ? playerCount : teamCount * teamSize;
  const tooMany = total > 32;
  const isFrags = objective === 'deathmatch';

  function submit() {
    if (tooMany) return;
    onCreate({
      format,
      objective,
      playerCount, teamCount, teamSize,
      durationSec, lives, waitForFull,
      killTarget, respawnSec,
      autoBalance: format === 'team' ? autoBalance : true,
      borderMap: isFrags ? false : borderMap, // Frags incompatible zone toxique
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cg-box" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3 className="cg-title">Partie personnalisée</h3>

        {/* Format */}
        <div className="cg-seg">
          <button type="button" className={format === 'ffa' ? 'active' : ''} onClick={() => setFormat('ffa')}>Chacun pour soi</button>
          <button type="button" className={format === 'team' ? 'active' : ''} onClick={() => setFormat('team')}>Équipes</button>
        </div>

        {/* Objectif / mode de jeu */}
        <div className="cg-field">
          <div className="cg-field-label">Mode de jeu</div>
          <div className="cg-seg">
            <button type="button" className={!isFrags ? 'active' : ''} onClick={() => setObjective('survival')}>Survie</button>
            <button type="button" className={isFrags ? 'active' : ''} onClick={() => setObjective('deathmatch')}>Frags</button>
          </div>
          <div className="cg-mode-desc">
            {isFrags
              ? 'Réapparition après ta mort · 1er à atteindre l\'objectif de kills gagne.'
              : 'Une vie : dernier(s) en vie ou plus de PV au temps écoulé.'}
          </div>
        </div>

        {/* Effectif */}
        {format === 'ffa' ? (
          <Stepper label="Joueurs" value={playerCount} min={2} max={32} onChange={setPlayerCount} />
        ) : (
          <div className="cg-row2">
            <Stepper label="Équipes" value={teamCount} min={2} max={8} onChange={setTeamCount} />
            <Stepper label="Par équipe" value={teamSize} min={1} max={8} onChange={setTeamSize} />
          </div>
        )}
        <div className={`cg-total${tooMany ? ' err' : ''}`}>
          {tooMany ? `Trop de joueurs (${total}) — max 32` : `${total} joueurs · arène adaptée`}
        </div>

        {/* Durée */}
        <div className="cg-field">
          <div className="cg-field-label">Durée</div>
          <div className="cg-seg sm">
            {DURATIONS.map(d => (
              <button type="button" key={d.sec} className={durationSec === d.sec ? 'active' : ''} onClick={() => setDurationSec(d.sec)}>{d.label}</button>
            ))}
          </div>
        </div>

        {/* Vies / réglages Frags */}
        {isFrags ? (
          <div className="cg-row2">
            <Stepper label="Kills pour gagner" value={killTarget} min={5} max={50} onChange={setKillTarget} hint="1er à atteindre" />
            <Stepper label="Respawn (s)" value={respawnSec} min={1} max={10} onChange={setRespawnSec} hint="délai de réapparition" />
          </div>
        ) : null}
        <Stepper label={isFrags ? 'PV par vie' : 'Vies (PV)'} value={lives} min={1} max={9} onChange={setLives} hint={isFrags ? 'touches avant de respawn' : 'touches avant élimination'} />

        {/* Options */}
        <div className="cg-opts">
          <Toggle label="Attendre l'effectif complet" checked={waitForFull} onChange={setWaitForFull} hint="sinon l'hôte lance quand il veut" />
          {format === 'team' && (
            <Toggle label="Répartition auto des équipes" checked={autoBalance} onChange={setAutoBalance} hint="sinon chacun choisit" />
          )}
          {!isFrags && (
            <Toggle label="Zone toxique qui rétrécit" checked={borderMap} onChange={setBorderMap} hint="gaz mortel hors de la zone" />
          )}
        </div>

        <button className="btn btn-lg cg-create" onClick={submit} disabled={tooMany}>Créer la partie</button>
      </div>
    </div>
  );
}
