const jwt = require('jsonwebtoken');
const GameEngine = require('./GameEngine');
const { calculateElo, saveMatchResult } = require('../services/eloService');
const { GAME, SOCKET_EVENTS: EV } = require('../../../shared/constants');

const queue = [];
const rooms = new Map();
const socketToRoom = new Map();
const socketToPlayer = new Map();
const disconnectTimers = new Map();
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

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    onlineCount++;
    broadcastOnlineCount(io);
    const player = getPlayerInfo(socket);

    socket.on(EV.QUEUE_JOIN, async (data) => {
      if (!player) { socket.emit('error', { msg: 'Non authentifié' }); return; }
      if (socketToRoom.has(socket.id)) return;
      if (queue.find(q => q.userId === player.userId)) return;

      const userData = { socketId: socket.id, userId: player.userId, pseudo: player.pseudo, elo: data.elo || 1000 };
      queue.push(userData);
      socket.emit(EV.QUEUE_STATUS, { waiting: true, online: onlineCount });

      if (queue.length >= 2) {
        const [p1, p2] = queue.splice(0, 2);
        const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const engine = new GameEngine(roomId);
        engine.addPlayer(p1.userId, p1.pseudo, p1.elo, p1.socketId);
        engine.addPlayer(p2.userId, p2.pseudo, p2.elo, p2.socketId);
        engine.start();

        const room = { roomId, engine, players: [p1, p2], tickInterval: null, fullStateInterval: null };
        rooms.set(roomId, room);
        socketToRoom.set(p1.socketId, roomId);
        socketToRoom.set(p2.socketId, roomId);
        socketToPlayer.set(p1.socketId, 0);
        socketToPlayer.set(p2.socketId, 1);

        const p1Socket = io.sockets.sockets.get(p1.socketId);
        const p2Socket = io.sockets.sockets.get(p2.socketId);
        if (p1Socket) p1Socket.join(roomId);
        if (p2Socket) p2Socket.join(roomId);

        const matchPayload = {
          roomId,
          players: [
            { pseudo: p1.pseudo, elo: p1.elo },
            { pseudo: p2.pseudo, elo: p2.elo },
          ],
        };
        if (p1Socket) p1Socket.emit(EV.MATCH_FOUND, { ...matchPayload, myPlayerIndex: 0 });
        if (p2Socket) p2Socket.emit(EV.MATCH_FOUND, { ...matchPayload, myPlayerIndex: 1 });

        io.to(roomId).emit(EV.GAME_FULL_STATE, engine.getFullState());

        room.tickInterval = setInterval(() => {
          const result = engine.tick(GAME.TICK_MS);
          // Émettre les coups encaissés ce tick (même le coup fatal)
          const events = engine.consumeEvents();
          events.forEach(e => {
            if (e.type === 'hit') io.to(roomId).emit(EV.PLAYER_HIT, { playerIndex: e.victim, by: e.by });
          });
          if (engine.over) {
            clearInterval(room.tickInterval);
            clearInterval(room.fullStateInterval);
            _endGame(io, room, result);
            return;
          }
          io.to(roomId).emit(EV.GAME_STATE, engine.getState());
        }, GAME.TICK_MS);

        room.fullStateInterval = setInterval(() => {
          if (!engine.over) io.to(roomId).emit(EV.GAME_FULL_STATE, engine.getFullState());
        }, GAME.FULL_STATE_INTERVAL_MS);
      }
    });

    socket.on(EV.QUEUE_LEAVE, () => {
      const idx = queue.findIndex(q => q.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);
    });

    socket.on(EV.PLAYER_INPUT, (inputs) => {
      _throttleGuard(socket);
      const roomId = socketToRoom.get(socket.id);
      const playerIndex = socketToPlayer.get(socket.id);
      if (roomId === undefined || playerIndex === undefined) return;
      const room = rooms.get(roomId);
      if (!room || room.engine.over) return;
      room.engine.handleInput(playerIndex, inputs);
    });

    socket.on(EV.PLAYER_PING, () => {
      _throttleGuard(socket);
      const roomId = socketToRoom.get(socket.id);
      const playerIndex = socketToPlayer.get(socket.id);
      if (roomId === undefined || playerIndex === undefined) return;
      const room = rooms.get(roomId);
      if (!room || room.engine.over) return;
      room.engine.handlePing(playerIndex);
    });

    socket.on(EV.PLAYER_SHOOT, () => {
      _throttleGuard(socket);
      const roomId = socketToRoom.get(socket.id);
      const playerIndex = socketToPlayer.get(socket.id);
      if (roomId === undefined || playerIndex === undefined) return;
      const room = rooms.get(roomId);
      if (!room || room.engine.over) return;
      room.engine.handleShoot(playerIndex);
    });

    socket.on('disconnect', () => {
      onlineCount = Math.max(0, onlineCount - 1);
      broadcastOnlineCount(io);
      const idx = queue.findIndex(q => q.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);

      const roomId = socketToRoom.get(socket.id);
      if (!roomId) { cleanup(socket.id); return; }

      const room = rooms.get(roomId);
      if (!room || room.engine.over) { cleanup(socket.id); return; }

      const timer = setTimeout(() => {
        const playerIndex = socketToPlayer.get(socket.id);
        clearInterval(room.tickInterval);
        clearInterval(room.fullStateInterval);
        room.engine.over = true;
        const winnerIndex = playerIndex === 0 ? 1 : 0;
        io.to(roomId).emit(EV.GAME_ABANDONED, { winnerIndex, reason: 'disconnect' });
        _cleanupRoom(roomId);
      }, GAME.RECONNECT_TIMEOUT_MS);
      disconnectTimers.set(socket.id, timer);
    });

    socket.on(EV.RECONNECT, ({ roomId }) => {
      if (!player) return;
      const timer = disconnectTimers.get(socket.id);
      if (timer) { clearTimeout(timer); disconnectTimers.delete(socket.id); }
      const room = rooms.get(roomId);
      if (!room || room.engine.over) { socket.emit('error', { msg: 'Partie terminée' }); return; }
      socket.join(roomId);
      socket.emit(EV.GAME_FULL_STATE, room.engine.getFullState());
    });
  });
}

const _eventCounters = new Map();
function _throttleGuard(socket) {
  const now = Date.now();
  const data = _eventCounters.get(socket.id) || { count: 0, window: now };
  if (now - data.window > 1000) { data.count = 0; data.window = now; }
  data.count++;
  _eventCounters.set(socket.id, data);
}

async function _endGame(io, room, timerResult) {
  const { engine, players, roomId } = room;
  let winnerIndex = timerResult ? timerResult.winnerIndex : engine.getWinnerIndex();
  const [p1, p2] = players;
  const [elo1Delta, elo2Delta] = calculateElo(p1.elo, p2.elo, winnerIndex);
  const duration = engine.getDurationSeconds();
  const s = engine.stats;

  await saveMatchResult({
    player1Id: p1.userId, player2Id: p2.userId, winnerId: winnerIndex === 0 ? p1.userId : winnerIndex === 1 ? p2.userId : null,
    player1HpLeft: engine.players[0].hp, player2HpLeft: engine.players[1].hp,
    durationSeconds: duration,
    player1EloDelta: elo1Delta, player2EloDelta: elo2Delta,
    player1Pings: s[0].pings, player2Pings: s[1].pings,
    player1Shots: s[0].shots, player2Shots: s[1].shots,
    player1Hits: s[0].hits, player2Hits: s[1].hits,
  });

  const p1Socket = io.sockets.sockets.get(p1.socketId);
  const p2Socket = io.sockets.sockets.get(p2.socketId);

  const endPayload = (myIdx) => ({
    winnerIndex,
    myStats: engine.stats[myIdx],
    eloDelta: myIdx === 0 ? elo1Delta : elo2Delta,
  });

  if (p1Socket) p1Socket.emit(EV.GAME_END, endPayload(0));
  if (p2Socket) p2Socket.emit(EV.GAME_END, endPayload(1));

  _cleanupRoom(roomId);
}

function _cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearInterval(room.tickInterval);
  clearInterval(room.fullStateInterval);
  for (const p of room.players) {
    socketToRoom.delete(p.socketId);
    socketToPlayer.delete(p.socketId);
    disconnectTimers.delete(p.socketId);
  }
  rooms.delete(roomId);
}

function cleanup(socketId) {
  socketToRoom.delete(socketId);
  socketToPlayer.delete(socketId);
  _eventCounters.delete(socketId);
}

module.exports = { setupSocketHandlers };
