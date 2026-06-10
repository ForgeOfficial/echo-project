// Registre des modes de jeu. Un seul moteur (GameEngine) lit ce descripteur ;
// ajouter un mode = ajouter une entrée ici (pas de duplication de logique).
const { BONUS, BONUS_TYPE_IDS } = require('./constants');

// Fréquence d'apparition des bonus (multiplicateur sur l'intervalle de base).
const BONUS_FREQ = { low: 1.9, normal: 1, high: 0.55 };

// Construit/valide la config de bonus d'un mode. Le type « nuke » n'est gardé
// qu'en deathmatch (Frags).
function buildBonusConfig(cfg = {}, deathmatch, { intervalMul = 1, maxOnMap = BONUS.MAX_ON_MAP } = {}) {
  const enabled = cfg.enabled !== false;
  let types = Array.isArray(cfg.types) && cfg.types.length ? cfg.types.slice() : BONUS_TYPE_IDS.slice();
  types = types.filter(t => BONUS.TYPES[t] && (!BONUS.TYPES[t].deathmatchOnly || deathmatch));
  const freq = BONUS_FREQ[cfg.frequency] || 1;
  return {
    enabled: enabled && types.length > 0,
    types,
    intervalMs: Math.round(BONUS.SPAWN_INTERVAL_MS * freq * intervalMul),
    maxOnMap,
  };
}

// Palette moderne (teintes vives mais raffinées) : une couleur par équipe
// (FFA = une équipe par joueur). Jusqu'à 8.
const TEAM_PALETTE = [
  '100,210,255',  // cyan
  '255,69,58',    // rouge
  '255,214,10',   // jaune
  '48,209,88',    // vert
  '255,159,10',   // orange
  '191,90,242',   // violet
  '10,132,255',   // bleu
  '255,55,95',    // rose
];

const TEAM_NAMES_2 = ['Rouge', 'Bleu'];

// Taille de l'arène en fonction du nombre de joueurs : plus on est nombreux,
// plus la carte est grande (cellules de 40px, ratio ~4:3). Source unique
// partagée client/serveur pour que physique et rendu coïncident.
function arenaForPlayers(n, scale = 1) {
  // 2j→20, 8j→26, 16j→37, 30j→55 (densité de joueurs raisonnable jusqu'à ~32).
  let cols = Math.max(20, Math.min(60, Math.round(16 + n * 1.3)));
  // Multiplicateur de taille (parties custom) appliqué PAR-DESSUS le scaling auto.
  // À scale=1 on garde exactement le comportement historique (modes classés).
  if (scale && scale !== 1) cols = Math.max(14, Math.min(80, Math.round(cols * scale)));
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
  // Multiplicateur de taille d'arène (par-dessus le scaling auto par effectif).
  let mapScale = Number(config.mapScale);
  if (!Number.isFinite(mapScale)) mapScale = 1;
  mapScale = Math.max(0.6, Math.min(1.8, mapScale));
  // En Frags, la zone toxique n'a pas de sens (on réapparaît) → désactivée.
  const borderMap = deathmatch ? false : !!config.borderMap;
  const bonus = buildBonusConfig(config.bonus, deathmatch);

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
    mapScale,
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
    bonus,
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
    // Set léger sans nuke, fréquence basse, 1 seul à la fois (équité des modes classés).
    bonus: { enabled: true, types: ['burst', 'life', 'speed', 'shield', 'rapid'], intervalMs: 24000, maxOnMap: 1 },
    waitForFull: true,
    autoBalance: true,
    // 1v1 monochrome : toi en blanc, l'adversaire en rouge signal.
    teamNames: ['Blanc', 'Rouge'],
    teamColors: ['255,255,255', '255,69,58'],
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
    bonus: { enabled: true, types: ['burst', 'life', 'speed', 'shield', 'rapid'], intervalMs: 24000, maxOnMap: 1 },
    waitForFull: true,
    autoBalance: false, // 2v2 : choix manuel des équipes (Rouge/Bleu)
    teamNames: ['Rouge', 'Bleu'],
    teamColors: ['255,69,58', '10,132,255'],
  },
};

// Duel 1v1 « libre » : identique au classique mais sans Elo ni persistance.
// Sert au matchmaking invité (file séparée), pour ne jamais mêler invités et
// comptes dans une partie classée.
MODES.casual = { ...MODES.classic, id: 'casual', label: 'Duel libre', short: '1v1 libre', ranked: false };

function getMode(id) {
  return MODES[id] || MODES.classic;
}

if (typeof module !== 'undefined') {
  module.exports = { MODES, getMode, buildCustomMode, arenaForPlayers, TEAM_PALETTE };
}
