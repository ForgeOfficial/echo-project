'use client';
import { useRef, useState, useCallback } from 'react';

// Rayon de débattement du stick (px) et seuils de conversion vecteur → 4 booléens.
// On reproduit le 8-directions du clavier : chaque axe s'active au-delà d'un seuil,
// donc pousser en diagonale engage deux axes (ex. haut + droite).
const MAX_RADIUS = 40;
const DEADZONE = 0.22;     // en deçà : aucun déplacement (zone morte au centre)
const AXIS_THRESH = 0.38;  // au-delà : l'axe correspondant s'active

const NEUTRAL = { up: false, down: false, left: false, right: false };

/**
 * Contrôles tactiles façon twin-thumb pour l'arène sonar.
 *  - Pouce gauche : joystick FIXE (toujours au même endroit) → déplacement + visée.
 *  - Pouce droit  : bouton TIR (cyan) et bouton ECHO (magenta), avec anneau de cooldown.
 * Les pointeurs sont indépendants (pointer events), donc on peut bouger et tirer en même temps.
 */
export default function TouchControls({ onMove, onShoot, onPing, onFirstTouch, shootCooldownMs, pingCooldownMs }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 }); // décalage du knob / centre fixe
  const [active, setActive] = useState(false);
  const stickPointer = useRef(null);                // pointerId qui pilote le joystick
  const centerRef = useRef({ x: 0, y: 0 });         // centre fixe de la base (px écran)
  const dirsRef = useRef(NEUTRAL);
  const zoneRef = useRef(null);
  const baseRef = useRef(null);

  const emit = useCallback((dirs) => {
    const d = dirsRef.current;
    if (d.up === dirs.up && d.down === dirs.down && d.left === dirs.left && d.right === dirs.right) return;
    dirsRef.current = dirs;
    onMove(dirs);
  }, [onMove]);

  const dirsFromVector = (dx, dy) => {
    const nx = dx / MAX_RADIUS, ny = dy / MAX_RADIUS;
    if (Math.hypot(nx, ny) < DEADZONE) return NEUTRAL;
    return {
      left:  nx < -AXIS_THRESH,
      right: nx >  AXIS_THRESH,
      up:    ny < -AXIS_THRESH,
      down:  ny >  AXIS_THRESH,
    };
  };

  const apply = (clientX, clientY) => {
    const c = centerRef.current;
    let dx = clientX - c.x, dy = clientY - c.y;
    const m = Math.hypot(dx, dy);
    if (m > MAX_RADIUS) { dx = (dx / m) * MAX_RADIUS; dy = (dy / m) * MAX_RADIUS; }
    emit(dirsFromVector(dx, dy));
    setKnob({ x: dx, y: dy });
  };

  const onZoneDown = (e) => {
    if (stickPointer.current !== null) return;
    stickPointer.current = e.pointerId;
    zoneRef.current?.setPointerCapture(e.pointerId);
    onFirstTouch?.();
    // Centre = milieu de la base fixe (jamais déplacée → jamais hors écran).
    const r = baseRef.current?.getBoundingClientRect();
    if (r) centerRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setActive(true);
    apply(e.clientX, e.clientY);
  };

  const onZoneMove = (e) => {
    if (e.pointerId !== stickPointer.current) return;
    apply(e.clientX, e.clientY);
  };

  const onZoneUp = (e) => {
    if (e.pointerId !== stickPointer.current) return;
    stickPointer.current = null;
    emit(NEUTRAL);
    setKnob({ x: 0, y: 0 });
    setActive(false);
  };

  return (
    <div className="tc-overlay">
      {/* ——— Zone gauche : capte le doigt, le joystick reste fixe ——— */}
      <div
        ref={zoneRef}
        className="tc-stick-zone"
        onPointerDown={onZoneDown}
        onPointerMove={onZoneMove}
        onPointerUp={onZoneUp}
        onPointerCancel={onZoneUp}
      >
        <div ref={baseRef} className={`tc-stick${active ? ' is-active' : ''}`}>
          <span className="tc-stick-ring tc-stick-ring--2" />
          <span className="tc-stick-ring" />
          <span className="tc-stick-cross" />
          <span
            className="tc-stick-knob"
            style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
          />
        </div>
      </div>

      {/* ——— Zone droite : actions ——— */}
      <div className="tc-actions">
        <ActionButton
          variant="echo"
          label="ECHO"
          cooldownMs={pingCooldownMs}
          onPress={() => { onFirstTouch?.(); onPing(); }}
        />
        <ActionButton
          variant="fire"
          label="TIR"
          cooldownMs={shootCooldownMs}
          onPress={() => { onFirstTouch?.(); onShoot(); }}
        />
      </div>
    </div>
  );
}

function ActionButton({ variant, label, cooldownMs, onPress }) {
  const [coolKey, setCoolKey] = useState(0);
  const [cooling, setCooling] = useState(false);
  const timer = useRef(null);

  const press = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (cooling) return;          // verrou client aligné sur le cooldown serveur
    onPress();
    setCooling(true);
    setCoolKey((k) => k + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCooling(false), cooldownMs);
  };

  return (
    <button
      type="button"
      className={`tc-btn tc-btn--${variant}${cooling ? ' is-cooling' : ''}`}
      onPointerDown={press}
      onContextMenu={(e) => e.preventDefault()}
    >
      {variant === 'echo'
        ? <span className="tc-icon-echo" aria-hidden />
        : <span className="tc-icon-fire" aria-hidden />}
      <span className="tc-btn-label">{label}</span>
      {/* anneau de cooldown : balayage conique qui se vide */}
      <span
        key={coolKey}
        className="tc-cooldown"
        style={{ animationDuration: `${cooldownMs}ms`, animationPlayState: cooling ? 'running' : 'paused' }}
      />
      {/* onde sonar émise à chaque pression (signature ECHO, discret pour TIR) */}
      <span key={`r${coolKey}`} className="tc-ripple" />
    </button>
  );
}
