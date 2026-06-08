'use client';
import { useRef, useState, useCallback } from 'react';

// Rayon de débattement du stick (px) et seuils de conversion vecteur → 4 booléens.
// On reproduit le 8-directions du clavier : chaque axe s'active au-delà d'un seuil,
// donc pousser en diagonale engage deux axes (ex. haut + droite).
const MAX_RADIUS = 40;
const DEADZONE = 0.22;     // en deçà : aucun déplacement (zone morte au centre)
const AXIS_THRESH = 0.38;  // au-delà : l'axe correspondant s'active
const EDGE_MARGIN = 52;    // garde la base + son halo dans l'écran (pas de débord)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const NEUTRAL = { up: false, down: false, left: false, right: false };

/**
 * Contrôles tactiles façon twin-thumb pour l'arène sonar.
 *  - Pouce gauche : joystick dynamique (apparaît sous le doigt) → déplacement + visée.
 *  - Pouce droit  : bouton TIR (cyan) et bouton ECHO (magenta), avec anneau de cooldown.
 * Les pointeurs sont indépendants (pointer events), donc on peut bouger et tirer en même temps.
 */
export default function TouchControls({ onMove, onShoot, onPing, onFirstTouch, shootCooldownMs, pingCooldownMs }) {
  const [stick, setStick] = useState(null);       // { bx, by, kx, ky } ou null
  const stickPointer = useRef(null);              // pointerId qui pilote le joystick
  const dirsRef = useRef(NEUTRAL);
  const zoneRef = useRef(null);

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

  const onZoneDown = (e) => {
    if (stickPointer.current !== null) return;
    stickPointer.current = e.pointerId;
    zoneRef.current?.setPointerCapture(e.pointerId);
    onFirstTouch?.();
    // La base naît sous le pouce, mais on la décale juste assez pour que le
    // halo ne déborde pas du bord de l'écran.
    const bx = clamp(e.clientX, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN);
    const by = clamp(e.clientY, EDGE_MARGIN, window.innerHeight - EDGE_MARGIN);
    setStick({ bx, by, kx: 0, ky: 0 });
  };

  const onZoneMove = (e) => {
    if (e.pointerId !== stickPointer.current) return;
    setStick((s) => {
      if (!s) return s;
      let dx = e.clientX - s.bx, dy = e.clientY - s.by;
      const m = Math.hypot(dx, dy);
      if (m > MAX_RADIUS) { dx = (dx / m) * MAX_RADIUS; dy = (dy / m) * MAX_RADIUS; }
      emit(dirsFromVector(dx, dy));
      return { ...s, kx: dx, ky: dy };
    });
  };

  const onZoneUp = (e) => {
    if (e.pointerId !== stickPointer.current) return;
    stickPointer.current = null;
    emit(NEUTRAL);
    setStick(null);
  };

  return (
    <div className="tc-overlay">
      {/* ——— Zone gauche : joystick dynamique ——— */}
      <div
        ref={zoneRef}
        className="tc-stick-zone"
        onPointerDown={onZoneDown}
        onPointerMove={onZoneMove}
        onPointerUp={onZoneUp}
        onPointerCancel={onZoneUp}
      >
        {stick && (
          <div className="tc-stick" style={{ left: stick.bx, top: stick.by }}>
            <span className="tc-stick-ring tc-stick-ring--2" />
            <span className="tc-stick-ring" />
            <span className="tc-stick-cross" />
            <span
              className="tc-stick-knob"
              style={{ transform: `translate(calc(-50% + ${stick.kx}px), calc(-50% + ${stick.ky}px))` }}
            />
          </div>
        )}
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
