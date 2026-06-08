export const ARENA = {
  WIDTH: 800,
  HEIGHT: 600,
  CELL_SIZE: 40,
  COLS: 20,
  ROWS: 15,
};

export const PLAYER = {
  RADIUS: 12,
  SPEED: 150,
  MAX_HP: 3,
  INVINCIBILITY_MS: 500,
  COLORS: ['#00FFFF', '#FF00FF'],
};

export const SONAR = {
  SPEED: 200,
  MAX_RADIUS: 400,
  LIFETIME_MS: 2000,
  COOLDOWN_MS: 1500,
  REVEAL_LINGER_MS: 500,
  EXPOSE_DURATION_MS: 1000,
};

export const PROJECTILE = {
  RADIUS: 5,
  SPEED: 400,
  COOLDOWN_MS: 500,
  MAX_ACTIVE: 3,
};

export const GAME = {
  TICK_MS: 33,
  FULL_STATE_INTERVAL_MS: 2000,
  MAX_DURATION_MS: 180000,
  RECONNECT_TIMEOUT_MS: 10000,
};

export const ELO = {
  DEFAULT: 1000,
  K_LOW: 32,
  K_HIGH: 16,
  K_THRESHOLD: 1200,
};

export const RANKS = [
  { name: 'Bronze',  minElo: 0,    color: '#CD7F32', icon: '🥉' },
  { name: 'Argent',  minElo: 1100, color: '#C0C0C0', icon: '🥈' },
  { name: 'Or',      minElo: 1300, color: '#FFD700', icon: '🥇' },
  { name: 'Platine', minElo: 1500, color: '#00CED1', icon: '💎' },
  { name: 'Diamant', minElo: 1700, color: '#B9F2FF', icon: '👑' },
];

export const EV = {
  PLAYER_INPUT:    'player:input',
  PLAYER_PING:     'player:ping',
  PLAYER_SHOOT:    'player:shoot',
  GAME_STATE:      'game:state',
  GAME_FULL_STATE: 'game:full-state',
  GAME_END:        'game:end',
  GAME_ABANDONED:  'game:abandoned',
  MATCH_FOUND:     'match:found',
  QUEUE_JOIN:      'queue:join',
  QUEUE_LEAVE:     'queue:leave',
  QUEUE_STATUS:    'queue:status',
  PLAYER_HIT:      'player:hit',
};

export function getRank(elo) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (elo >= RANKS[i].minElo) return RANKS[i];
  }
  return RANKS[0];
}
