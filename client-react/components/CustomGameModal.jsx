'use client';
import { useState } from 'react';
import { arenaForPlayers } from '../lib/modes';
import { BONUS, BONUS_TYPE_IDS } from '../lib/constants';
import Portal from './Portal';

const BONUS_FREQS = [
  { v: 'low', label: 'Rares' },
  { v: 'normal', label: 'Normal' },
  { v: 'high', label: 'Fréquents' },
];

// Multiplicateurs de taille d'arène (par-dessus le scaling auto par effectif).
const MAP_SIZES = [
  { scale: 0.75, label: 'Compact' },
  { scale: 1, label: 'Normale' },
  { scale: 1.3, label: 'Grande' },
  { scale: 1.6, label: 'Immense' },
];

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
  const [mapScale, setMapScale] = useState(1);
  const [waitForFull, setWaitForFull] = useState(true);
  const [autoBalance, setAutoBalance] = useState(true);
  const [borderMap, setBorderMap] = useState(true);
  const [bonusEnabled, setBonusEnabled] = useState(true);
  const [bonusFreq, setBonusFreq] = useState('normal');
  const [bonusSel, setBonusSel] = useState(() => Object.fromEntries(BONUS_TYPE_IDS.map(id => [id, true])));

  const total = format === 'ffa' ? playerCount : teamCount * teamSize;
  const tooMany = total > 32;
  const isFrags = objective === 'deathmatch';
  const arenaPreview = arenaForPlayers(Math.max(2, Math.min(32, total)), mapScale);
  // La nuke n'existe qu'en Frags ; on masque le chip sinon.
  const availBonusTypes = BONUS_TYPE_IDS.filter(id => !BONUS.TYPES[id].deathmatchOnly || isFrags);

  function submit() {
    if (tooMany) return;
    const types = availBonusTypes.filter(id => bonusSel[id]);
    onCreate({
      format,
      objective,
      playerCount, teamCount, teamSize,
      durationSec, lives, waitForFull,
      killTarget, respawnSec, mapScale,
      autoBalance: format === 'team' ? autoBalance : true,
      borderMap: isFrags ? false : borderMap, // Frags incompatible zone toxique
      bonus: { enabled: bonusEnabled && types.length > 0, types, frequency: bonusFreq },
    });
  }

  return (
    <Portal>
    <div className="modal-overlay" onClick={onClose}>
      <div className="cg-box" onClick={e => e.stopPropagation()}>
        <header className="cg-head">
          <div className="cg-head-eyebrow">Configuration</div>
          <h3 className="cg-title">Partie personnalisée</h3>
          <button className="modal-close cg-head-close" onClick={onClose} aria-label="Fermer">✕</button>
        </header>

        <div className="cg-scroll">
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

        {/* Taille de l'arène */}
        <div className="cg-field">
          <div className="cg-field-label">
            Taille de l&apos;arène
            <span className="cg-hint">{arenaPreview.COLS}×{arenaPreview.ROWS} cases · plus de monde = plus grand</span>
          </div>
          <div className="cg-seg sm">
            {MAP_SIZES.map(m => (
              <button type="button" key={m.scale} className={mapScale === m.scale ? 'active' : ''} onClick={() => setMapScale(m.scale)}>{m.label}</button>
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
          <Toggle label="Bonus sur la carte" checked={bonusEnabled} onChange={setBonusEnabled} hint="objets à ramasser pendant la partie" />
        </div>

        {/* Sélection des bonus + fréquence */}
        {bonusEnabled && (
          <div className="cg-field cg-bonus">
            <div className="cg-bonus-grid">
              {availBonusTypes.map(id => {
                const def = BONUS.TYPES[id];
                const on = bonusSel[id];
                return (
                  <button type="button" key={id}
                    className={`cg-bonus-chip${on ? ' on' : ''}`}
                    style={on ? { borderColor: `rgb(${def.color})`, color: `rgb(${def.color})`, boxShadow: `0 0 10px rgba(${def.color},0.3)` } : undefined}
                    onClick={() => setBonusSel(s => ({ ...s, [id]: !s[id] }))}>
                    <span className="cg-bonus-ic">{def.icon}</span>{def.label}
                  </button>
                );
              })}
            </div>
            <div className="cg-seg sm">
              {BONUS_FREQS.map(f => (
                <button type="button" key={f.v} className={bonusFreq === f.v ? 'active' : ''} onClick={() => setBonusFreq(f.v)}>{f.label}</button>
              ))}
            </div>
          </div>
        )}
        </div>

        <footer className="cg-foot">
          <button className="btn btn-lg cg-create" onClick={submit} disabled={tooMany}>Créer la partie</button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}
