// Miroir client de shared/modes.js (le serveur a sa version CommonJS).
export const TEAM_PALETTE = [
  '0,255,255', '255,0,200', '255,210,0', '0,255,136',
  '255,120,40', '150,110,255', '60,160,255', '255,70,120',
];

// Doit rester identique à shared/modes.js (physique serveur ↔ rendu client).
export function arenaForPlayers(n, scale = 1) {
  // 2j→20, 8j→26, 16j→37, 30j→55. Identique à shared/modes.js.
  let cols = Math.max(20, Math.min(60, Math.round(16 + n * 1.3)));
  if (scale && scale !== 1) cols = Math.max(14, Math.min(80, Math.round(cols * scale)));
  const rows = Math.round(cols * 0.75);
  const CELL_SIZE = 40;
  return { CELL_SIZE, COLS: cols, ROWS: rows, WIDTH: cols * CELL_SIZE, HEIGHT: rows * CELL_SIZE };
}

export const MODES = {
  classic: {
    id: 'classic', label: 'Classique', short: '1v1', format: 'team',
    teamSize: 1, teamCount: 2, totalPlayers: 2, ranked: true, usesLobby: false,
    friendlyFire: false, sharedVision: false, suddenDeath: true, maxHp: 3,
    durationMs: 180000, borderMap: false, waitForFull: true, autoBalance: true,
    teamNames: ['Cyan', 'Magenta'], teamColors: ['0,255,255', '255,0,255'],
  },
  duo: {
    id: 'duo', label: '2 contre 2', short: '2v2', format: 'team',
    teamSize: 2, teamCount: 2, totalPlayers: 4, ranked: false, usesLobby: true,
    friendlyFire: false, sharedVision: true, suddenDeath: false, maxHp: 3,
    durationMs: 180000, borderMap: false, waitForFull: true, autoBalance: false,
    teamNames: ['Rouge', 'Bleu'], teamColors: ['255,59,72', '54,124,255'],
  },
};

export function getMode(id) {
  return MODES[id] || MODES.classic;
}
