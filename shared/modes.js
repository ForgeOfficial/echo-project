// Registre des modes de jeu. Un seul moteur (GameEngine) lit ce descripteur ;
// ajouter un mode = ajouter une entrée ici (pas de duplication de logique).

// Palette néon : une couleur par équipe (FFA = une équipe par joueur). Jusqu'à 8.
const TEAM_PALETTE = [
  '0,255,255',    // cyan
  '255,0,200',    // magenta
  '255,210,0',    // or
  '0,255,136',    // vert
  '255,120,40',   // orange
  '150,110,255',  // violet
  '60,160,255',   // bleu
  '255,70,120',   // rose
];

const TEAM_NAMES_2 = ['Rouge', 'Bleu'];

// Taille de l'arène en fonction du nombre de joueurs : plus on est nombreux,
// plus la carte est grande (cellules de 40px, ratio ~4:3). Source unique
// partagée client/serveur pour que physique et rendu coïncident.
function arenaForPlayers(n) {
  // 2j→20, 8j→26, 16j→37, 30j→55 (densité de joueurs raisonnable jusqu'à ~32).
  const cols = Math.max(20, Math.min(60, Math.round(16 + n * 1.3)));
  const rows = Math.round(cols * 0.75);
  const CELL_SIZE = 40;
  return { CELL_SIZE, COLS: cols, ROWS: rows, WIDTH: cols * CELL_SIZE, HEIGHT: rows * CELL_SIZE };
}

function clampInt(v, lo, hi, dflt) {
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

// Construit (et valide) un mode custom à partir d'une config client.
// config = { format:'ffa'|'team', playerCount, teamCount, teamSize,
//            durationSec, lives, waitForFull, autoBalance, borderMap }
function buildCustomMode(config = {}) {
  const format = config.format === 'team' ? 'team' : 'ffa';
  const lives = clampInt(config.lives, 1, 9, 3);
  const durationSec = clampInt(config.durationSec, 30, 600, 120);
  // Objectif de partie : 'survival' (dernier en vie / le plus de PV au temps,
  // comportement historique) ou 'deathmatch' (Frags : respawn + 1er à X kills).
  const objective = config.objective === 'deathmatch' ? 'deathmatch' : 'survival';
  const deathmatch = objective === 'deathmatch';
  const killTarget = clampInt(config.killTarget, 5, 50, 15);
  const respawnMs = clampInt(config.respawnSec, 1, 10, 3) * 1000;
  // En Frags, la zone toxique n'a pas de sens (on réapparaît) → désactivée.
  const borderMap = deathmatch ? false : !!config.borderMap;

  const MAX_PLAYERS = 32; // borne dure (interest management → scaling ~30j)
  let teamCount, teamSize, totalPlayers;
  if (format === 'ffa') {
    totalPlayers = clampInt(config.playerCount, 2, MAX_PLAYERS, 4);
    teamCount = totalPlayers; // chacun son "équipe"
    teamSize = 1;
  } else {
    teamCount = clampInt(config.teamCount, 2, 8, 2); // palette = 8 couleurs
    teamSize = clampInt(config.teamSize, 1, 8, 2);
    totalPlayers = teamCount * teamSize;
    if (totalPlayers > MAX_PLAYERS) { // borne dure : on réduit la taille d'équipe
      teamSize = Math.max(1, Math.floor(MAX_PLAYERS / teamCount));
      totalPlayers = teamCount * teamSize;
    }
  }

  const teamColors = Array.from({ length: teamCount }, (_, i) => TEAM_PALETTE[i % TEAM_PALETTE.length]);
  const teamNames = format === 'ffa'
    ? Array.from({ length: teamCount }, (_, i) => `J${i + 1}`)
    : (teamCount === 2 ? TEAM_NAMES_2.slice() : Array.from({ length: teamCount }, (_, i) => `Équipe ${i + 1}`));

  const baseShort = format === 'ffa' ? `FFA ${totalPlayers}` : `${teamCount}×${teamSize}`;
  return {
    id: 'custom',
    label: 'Personnalisée',
    short: deathmatch ? `${baseShort} · ${killTarget} frags` : baseShort,
    format,
    objective,
    killTarget,
    respawnMs,
    teamSize,
    teamCount,
    totalPlayers,
    ranked: false,
    usesLobby: true,
    friendlyFire: false,
    sharedVision: format === 'team' && teamSize > 1,
    suddenDeath: false,
    maxHp: lives,
    durationMs: durationSec * 1000,
    borderMap,
    waitForFull: config.waitForFull !== false,
    autoBalance: format === 'team' ? config.autoBalance !== false : true,
    teamNames,
    teamColors,
  };
}

const MODES = {
  classic: {
    id: 'classic',
    label: 'Classique',
    short: '1v1',
    format: 'team',
    teamSize: 1,
    teamCount: 2,
    totalPlayers: 2,
    ranked: true,        // sauvegarde + Elo
    usesLobby: false,    // matchmaking instantané (file d'attente)
    friendlyFire: false,
    sharedVision: false, // pas d'allié → sans objet
    suddenDeath: true,
    maxHp: 3,
    durationMs: 180000,
    borderMap: false,
    waitForFull: true,
    autoBalance: true,
    teamNames: ['Cyan', 'Magenta'],
    teamColors: ['0,255,255', '255,0,255'],
  },
  duo: {
    id: 'duo',
    label: '2 contre 2',
    short: '2v2',
    format: 'team',
    teamSize: 2,
    teamCount: 2,
    totalPlayers: 4,
    ranked: false,       // non classé pour l'instant (pas de persistance)
    usesLobby: true,     // salon avec choix d'équipe
    friendlyFire: false,
    sharedVision: true,  // les coéquipiers partagent vision + sonar
    suddenDeath: false,  // égalité au temps → match nul
    maxHp: 3,
    durationMs: 180000,
    borderMap: false,
    waitForFull: true,
    autoBalance: false, // 2v2 : choix manuel des équipes (Rouge/Bleu)
    teamNames: ['Rouge', 'Bleu'],
    teamColors: ['255,59,72', '54,124,255'],
  },
};

function getMode(id) {
  return MODES[id] || MODES.classic;
}

if (typeof module !== 'undefined') {
  module.exports = { MODES, getMode, buildCustomMode, arenaForPlayers, TEAM_PALETTE };
}
