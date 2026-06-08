// Miroir client de shared/modes.js (le serveur a sa version CommonJS).
export const MODES = {
  classic: {
    id: 'classic',
    label: 'Classique',
    short: '1v1',
    teamSize: 1,
    teamCount: 2,
    totalPlayers: 2,
    ranked: true,
    usesLobby: false,
    friendlyFire: false,
    sharedVision: false,
    suddenDeath: true,
    teamNames: ['Cyan', 'Magenta'],
    teamColors: ['0,255,255', '255,0,255'],
  },
  duo: {
    id: 'duo',
    label: '2 contre 2',
    short: '2v2',
    teamSize: 2,
    teamCount: 2,
    totalPlayers: 4,
    ranked: false,
    usesLobby: true,
    friendlyFire: false,
    sharedVision: true,
    suddenDeath: false,
    teamNames: ['Rouge', 'Bleu'],
    teamColors: ['255,59,72', '54,124,255'],
  },
};

export function getMode(id) {
  return MODES[id] || MODES.classic;
}
