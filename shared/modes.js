// Registre des modes de jeu. Un seul moteur (GameEngine) lit ce descripteur ;
// ajouter un mode = ajouter une entrée ici (pas de duplication de logique).
const MODES = {
  classic: {
    id: 'classic',
    label: 'Classique',
    short: '1v1',
    teamSize: 1,
    teamCount: 2,
    totalPlayers: 2,
    ranked: true,        // sauvegarde + Elo
    usesLobby: false,    // matchmaking instantané (file d'attente)
    friendlyFire: false,
    sharedVision: false, // pas d'allié → sans objet
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
    ranked: false,       // non classé pour l'instant (pas de persistance)
    usesLobby: true,     // salon avec choix d'équipe
    friendlyFire: false,
    sharedVision: true,  // les coéquipiers partagent vision + sonar
    suddenDeath: false,  // égalité au temps → match nul
    teamNames: ['Rouge', 'Bleu'],
    teamColors: ['255,59,72', '54,124,255'],
  },
};

function getMode(id) {
  return MODES[id] || MODES.classic;
}

if (typeof module !== 'undefined') {
  module.exports = { MODES, getMode };
}
