// Source unique : shared/constants.js (CommonJS, partagé avec le serveur).
// Ce fichier ne fait que ré-exporter en ESM — ne rien redéfinir ici, sinon
// physique serveur et prédiction client divergent.
import shared from '../../shared/constants';

export const ARENA = shared.ARENA;
export const PLAYER = shared.PLAYER;
export const SONAR = shared.SONAR;
export const PROJECTILE = shared.PROJECTILE;
export const WALL = shared.WALL;
export const BONUS = shared.BONUS;
export const BONUS_TYPE_IDS = shared.BONUS_TYPE_IDS;
export const VISION = shared.VISION;
export const GAME = shared.GAME;
export const ELO = shared.ELO;
export const RANKS = shared.RANKS;
export const EV = shared.SOCKET_EVENTS;

export function getRank(elo) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (elo >= RANKS[i].minElo) return RANKS[i];
  }
  return RANKS[0];
}
