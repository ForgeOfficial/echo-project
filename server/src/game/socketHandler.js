const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const GameEngine = require('./GameEngine');
const { calculateElo, saveMatchResult } = require('../services/eloService');
const { GAME, SOCKET_EVENTS: EV } = require('../../../shared/constants');

// ──────────────────────────────────────────────────────────────────────────
// État serveur. Tout est indexé par userId (et non socket.id) : un joueur garde
// son identité à travers les reconnexions (fermeture/réouverture de page, où le
// socket.id change). Une partie = une "room" identifiée par un UUID stable.
// ──────────────────────────────────────────────────────────────────────────
const queue = [];                 // joueurs en attente d'adversaire
const rooms = new Map();          // gameId -> room (partie en cours)
const userActiveGame = new Map(); // userId -> gameId (partie live à laquelle il appartient)
const finishedGames = new Map();  // gameId -> { resultByUserId: Map<userId, payload>, timer }
const socketToUser = new Map();   // socket.id -> userId (résolu depuis le JWT)
const abandonTimers = new Map();  // userId -> timeout de grâce après déconnexion
let onlineCount = 0;

function getPlayerInfo(socket) {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

function broadcastOnlineCount(io) {
  io.emit(EV.QUEUE_STATUS, { online: onlineCount });
}

function findIndex(room, userId) {
  return room.players.findIndex(p => p.userId === userId);
}

function roomOf(userId) {
  const gameId = userActiveGame.get(userId);
  return gameId ? rooms.get(gameId) : null;
}

function cancelAbandon(userId) {
  const t = abandonTimers.get(userId);
  if (t) { clearTimeout(t); abandonTimers.delete(userId); }
}

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    onlineCount++;
    broadcastOnlineCount(io);
    const player = getPlayerInfo(socket);
    if (player) socketToUser.set(socket.id, player.userId);

    socket.on(EV.QUEUE_JOIN, (data) => {
      if (!player) { socket.emit('error', { msg: 'Non authentifié' }); return; }
      // Déjà dans une partie en cours → on le renvoie vers elle plutôt que de
      // le remettre en file (évite les doubles parties).
      const existing = roomOf(player.userId);
      if (existing && !existing.engine.over) {
        socket.emit(EV.MATCH_FOUND, { gameId: existing.gameId });
        return;
      }
      if (queue.find(q => q.userId === player.userId)) return;

      queue.push({ socketId: socket.id, userId: player.userId, pseudo: player.pseudo, elo: data?.elo || 1000 });
      socket.emit(EV.QUEUE_STATUS, { waiting: true, online: onlineCount });

      if (queue.length >= 2) startMatch(io);
    });

    socket.on(EV.QUEUE_LEAVE, () => {
      const idx = queue.findIndex(q => q.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);
    });

    // (Re)joindre une partie par son UUID. Source de vérité unique : que ce soit
    // un nouveau match ou un retour après refresh, le client appelle ça avec le
    // gameId de l'URL /games/:gameId.
    socket.on(EV.JOIN_GAME, ({ gameId }) => {
      if (!player) { socket.emit('error', { msg: 'Non authentifié' }); return; }

      const room = rooms.get(gameId);
      if (room && !room.engine.over) {
        const idx = findIndex(room, player.userId);
        if (idx === -1) { socket.emit(EV.GAME_NOT_FOUND, { gameId }); return; }
        // (Ré)attache le socket courant au joueur : nouveau socket.id après un
        // reload, on le propage partout et on annule le timer d'abandon.
        cancelAbandon(player.userId);
        room.players[idx].socketId = socket.id;
        room.players[idx].connected = true;
        room.engine.players[idx].socketId = socket.id;
        socket.join(gameId);
        socket.emit(EV.GAME_JOINED, {
          gameId,
          myPlayerIndex: idx,
          players: room.players.map(p => ({ pseudo: p.pseudo, elo: p.elo })),
          state: room.engine.getFullState(),
        });
        return;
      }

      // Partie déjà terminée (le joueur était absent au moment de la fin) :
      // on lui renvoie le résultat conservé pour qu'il voie l'écran de fin.
      const fin = finishedGames.get(gameId);
      if (fin && fin.resultByUserId.has(player.userId)) {
        socket.emit(EV.GAME_END, fin.resultByUserId.get(player.userId));
        return;
      }

      socket.emit(EV.GAME_NOT_FOUND, { gameId });
    });

    // Actions de jeu : routées via userId → partie → index, robuste aux reconnexions.
    const actOnGame = (fn) => {
      const userId = socketToUser.get(socket.id);
      if (userId === undefined) return;
      const room = roomOf(userId);
      if (!room || room.engine.over) return;
      const idx = findIndex(room, userId);
      if (idx === -1) return;
      fn(room, idx);
    };

    socket.on(EV.PLAYER_INPUT, (inputs) => { _throttleGuard(socket); actOnGame((r, i) => r.engine.handleInput(i, inputs)); });
    socket.on(EV.PLAYER_PING, () => { _throttleGuard(socket); actOnGame((r, i) => r.engine.handlePing(i)); });
    socket.on(EV.PLAYER_SHOOT, () => { _throttleGuard(socket); actOnGame((r, i) => r.engine.handleShoot(i)); });

    socket.on('disconnect', () => {
      onlineCount = Math.max(0, onlineCount - 1);
      broadcastOnlineCount(io);
      _eventCounters.delete(socket.id);

      const idx = queue.findIndex(q => q.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);

      const userId = socketToUser.get(socket.id);
      socketToUser.delete(socket.id);
      if (userId === undefined) return;

      const room = roomOf(userId);
      if (!room || room.engine.over) return;
      const pIdx = findIndex(room, userId);
      if (pIdx === -1) return;
      // Si un autre socket a déjà repris ce joueur (reload rapide), ce
      // 'disconnect' tardif ne doit pas relancer de timer d'abandon.
      if (room.players[pIdx].socketId !== socket.id) return;

      room.players[pIdx].connected = false;
      // Le joueur déconnecté se fige sur place : il reste vulnérable (l'adversaire
      // peut le tuer pendant son absence) mais n'arrête pas la partie.
      room.engine.handleInput(pIdx, { up: false, down: false, left: false, right: false });

      // Grâce : s'il ne revient pas à temps, l'adversaire gagne par abandon.
      cancelAbandon(userId);
      const timer = setTimeout(() => {
        abandonTimers.delete(userId);
        const r = roomOf(userId);
        if (!r || r.engine.over) return;
        const i = findIndex(r, userId);
        if (i === -1 || r.players[i].connected) return;
        _endGame(io, r, { winnerIndex: i === 0 ? 1 : 0, reason: 'abandon' });
      }, GAME.RECONNECT_TIMEOUT_MS);
      abandonTimers.set(userId, timer);
    });
  });
}

function startMatch(io) {
  const [p1, p2] = queue.splice(0, 2);
  const gameId = crypto.randomUUID();
  const engine = new GameEngine(gameId);
  engine.addPlayer(p1.userId, p1.pseudo, p1.elo, p1.socketId);
  engine.addPlayer(p2.userId, p2.pseudo, p2.elo, p2.socketId);
  engine.start();

  const players = [p1, p2].map(p => ({
    userId: p.userId, pseudo: p.pseudo, elo: p.elo, socketId: p.socketId, connected: true,
  }));
  const room = { gameId, engine, players, tickInterval: null, fullStateInterval: null, ended: false };
  rooms.set(gameId, room);
  userActiveGame.set(p1.userId, gameId);
  userActiveGame.set(p2.userId, gameId);

  // On dit juste aux deux clients de naviguer vers /games/:gameId. Le détail
  // (index, joueurs, état) est servi par JOIN_GAME une fois sur la page.
  for (const p of players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit(EV.MATCH_FOUND, { gameId });
  }

  room.tickInterval = setInterval(() => {
    const result = engine.tick(GAME.TICK_MS);
    engine.consumeEvents().forEach(e => {
      if (e.type === 'hit') io.to(gameId).emit(EV.PLAYER_HIT, { playerIndex: e.victim, by: e.by });
    });
    if (engine.over) {
      _endGame(io, room, result);
      return;
    }
    io.to(gameId).emit(EV.GAME_STATE, engine.getState());
  }, GAME.TICK_MS);

  room.fullStateInterval = setInterval(() => {
    if (!engine.over) io.to(gameId).emit(EV.GAME_FULL_STATE, engine.getFullState());
  }, GAME.FULL_STATE_INTERVAL_MS);
}

const _eventCounters = new Map();
function _throttleGuard(socket) {
  const now = Date.now();
  const data = _eventCounters.get(socket.id) || { count: 0, window: now };
  if (now - data.window > 1000) { data.count = 0; data.window = now; }
  data.count++;
  _eventCounters.set(socket.id, data);
}

async function _endGame(io, room, result) {
  if (room.ended) return; // idempotent : tick final ET timer d'abandon peuvent appeler
  room.ended = true;
  clearInterval(room.tickInterval);
  clearInterval(room.fullStateInterval);
  room.engine.over = true;

  const { engine, players, gameId } = room;
  const winnerIndex = result ? result.winnerIndex : engine.getWinnerIndex();
  const reason = result?.reason || 'normal';
  const [p1, p2] = players;
  const [elo1Delta, elo2Delta] = calculateElo(p1.elo, p2.elo, winnerIndex);
  const duration = engine.getDurationSeconds();
  const s = engine.stats;

  try {
    await saveMatchResult({
      player1Id: p1.userId, player2Id: p2.userId,
      winnerId: winnerIndex === 0 ? p1.userId : winnerIndex === 1 ? p2.userId : null,
      player1HpLeft: engine.players[0].hp, player2HpLeft: engine.players[1].hp,
      durationSeconds: duration,
      player1EloDelta: elo1Delta, player2EloDelta: elo2Delta,
      player1Pings: s[0].pings, player2Pings: s[1].pings,
      player1Shots: s[0].shots, player2Shots: s[1].shots,
      player1Hits: s[0].hits, player2Hits: s[1].hits,
    });
  } catch (e) {
    console.error('[endGame] saveMatchResult a échoué', e);
  }

  const endFor = (idx) => ({
    winnerIndex,
    myPlayerIndex: idx,
    myStats: engine.stats[idx],
    eloDelta: idx === 0 ? elo1Delta : elo2Delta,
    players: players.map(p => ({ pseudo: p.pseudo, elo: p.elo })),
    reason,
  });

  // On conserve le résultat par joueur pour ceux qui reviendront sur l'URL.
  const resultByUserId = new Map();
  players.forEach((p, idx) => resultByUserId.set(p.userId, endFor(idx)));
  _storeFinished(gameId, resultByUserId);

  // On émet aux joueurs encore connectés.
  players.forEach((p, idx) => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock && p.connected) sock.emit(EV.GAME_END, endFor(idx));
  });

  _cleanupRoom(room);
}

function _storeFinished(gameId, resultByUserId) {
  const prev = finishedGames.get(gameId);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => finishedGames.delete(gameId), GAME.FINISHED_GAME_TTL_MS);
  finishedGames.set(gameId, { resultByUserId, timer });
}

function _cleanupRoom(room) {
  clearInterval(room.tickInterval);
  clearInterval(room.fullStateInterval);
  for (const p of room.players) {
    if (userActiveGame.get(p.userId) === room.gameId) userActiveGame.delete(p.userId);
    cancelAbandon(p.userId);
  }
  rooms.delete(room.gameId);
}

module.exports = { setupSocketHandlers };
