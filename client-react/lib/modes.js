// Source unique : shared/modes.js (CommonJS, partagé avec le serveur).
// Simple ré-export ESM — toute la définition des modes vit côté shared.
import shared from '../../shared/modes';

export const MODES = shared.MODES;
export const getMode = shared.getMode;
export const buildCustomMode = shared.buildCustomMode;
export const arenaForPlayers = shared.arenaForPlayers;
export const TEAM_PALETTE = shared.TEAM_PALETTE;
