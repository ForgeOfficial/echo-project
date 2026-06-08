const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const GameEngine = require('./GameEngine');
const { calculateElo, saveMatchResult } = require('../services/eloService');
const { GAME, SOCKET_EVENTS: EV } = require('../../../shared/constants');
const { MODES, getMode, buildCustomMode } = require('../../../shared/modes');

// ──────────────────────────────────────────────────────────────────────────
// État serveur, indexé par userId (et non socket.id) pour survivre aux
// reconnexions. Une partie = une "room" identifiée par un UUID stable. Les
// modes en équipe passent par un salon (lobby) avant la partie.
// ──────────────────────────────────────────────────────────────────────────
const queue = [];                 // file du matchmaking classique (1v1)
const rooms = new Map();          // gameId -> room (partie en cours)
const userActiveGame = new Map(); // userId -> gameId (partie live)
const finishedGames = new Map();  // gameId -> { resultByUserId, timer }
const socketToUser = new Map();   // socket.id -> userId
const abandonTimers = new Map();  // userId -> timeout de grâce (en partie)

const lobbies = new Map();        // code -> lobby
const userLobby = new Map();      // userId -> code
const lobbyTimers = new Map();    // userId -> timeout de grâce (en salon)
const LOBBY_GRACE_MS = 20000;

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

    // ───────── Matchmaking classique (1v1, file instantanée) ─────────
    socket.on(EV.QUEUE_JOIN, (data) => {
      if (!player) { socket.emit('error', { msg: 'Non authentifié' }); return; }
      const existing = roomOf(player.userId);
      if (existing && !existing.engine.over) {
        socket.emit(EV.MATCH_FOUND, { gameId: existing.gameId });
        return;
      }
      if (queue.find(q => q.userId === player.userId)) return;

      queue.push({ socketId: socket.id, userId: player.userId, pseudo: player.pseudo, elo: data?.elo || 1000 });
      socket.emit(EV.QUEUE_STATUS, { waiting: true, online: onlineCount });

      if (queue.length >= 2) {
        const [a, b] = queue.splice(0, 2);
        createGame(io, MODES.classic, [
          { ...a, team: 0 },
          { ...b, team: 1 },
        ]);
      }
    });

    socket.on(EV.QUEUE_LEAVE, () => {
      const idx = queue.findIndex(q => q.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);
    });

    // ───────── Salons (modes en équipe) ─────────
    socket.on(EV.LOBBY_QUICKPLAY, (data) => {
      if (!player) { socket.emit(EV.LOBBY_ERROR, { msg: 'Non authentifié' }); return; }
      const mode = getMode(data?.mode);
      if (!mode.usesLobby) { socket.emit(EV.LOBBY_ERROR, { msg: 'Mode invalide' }); return; }
      if (userLobby.has(player.userId)) { socket.emit(EV.LOBBY_JOINED, { code: userLobby.get(player.userId) }); return; }

      // Rejoindre un salon public ouvert du même mode, sinon en créer un.
      let lobby = [...lobbies.values()].find(l => !l.isPrivate && l.mode.id === mode.id && l.members.length < mode.totalPlayers);
      if (!lobby) lobby = createLobby(mode, false, player.userId);
      joinLobby(io, socket, lobby, player, data?.elo);
    });

    socket.on(EV.LOBBY_CREATE, (data) => {
      if (!player) { socket.emit(EV.LOBBY_ERROR, { msg: 'Non authentifié' }); return; }
      // Une config présente → partie personnalisée (FFA/équipes sur-mesure).
      const mode = data?.config ? buildCustomMode(data.config) : getMode(data?.mode);
      if (!mode.usesLobby) { socket.emit(EV.LOBBY_ERROR, { msg: 'Mode invalide' }); return; }
      if (userLobby.has(player.userId)) { socket.emit(EV.LOBBY_JOINED, { code: userLobby.get(player.userId) }); return; }
      const lobby = createLobby(mode, true, player.userId);
      joinLobby(io, socket, lobby, player, data?.elo);
    });

    socket.on(EV.LOBBY_JOIN, (data) => {
      if (!player) { socket.emit(EV.LOBBY_ERROR, { msg: 'Non authentifié' }); return; }
      const code = String(data?.code || '').trim();
      const lobby = lobbies.get(code);
      if (!lobby) { socket.emit(EV.LOBBY_ERROR, { msg: 'Salon introuvable' }); return; }

      // Déjà membre (reconnexion / refresh) : on réattache et on resynchronise.
      const existing = lobby.members.find(m => m.userId === player.userId);
      if (existing) {
        const t = lobbyTimers.get(player.userId);
        if (t) { clearTimeout(t); lobbyTimers.delete(player.userId); }
        existing.socketId = socket.id;
        existing.connected = true;
        socket.emit(EV.LOBBY_JOINED, { code });
        broadcastLobby(io, lobby);
        return;
      }

      if (lobby.members.length >= lobby.mode.totalPlayers) { socket.emit(EV.LOBBY_ERROR, { msg: 'Salon complet' }); return; }
      joinLobby(io, socket, lobby, player, data?.elo);
    });

    socket.on(EV.LOBBY_SET_TEAM, (data) => {
      if (!player) return;
      const lobby = lobbies.get(userLobby.get(player.userId));
      if (!lobby) return;
      const member = lobby.members.find(m => m.userId === player.userId);
      if (!member) return;
      // FFA ou répartition automatique verrouillée : pas de choix manuel d'équipe.
      if (lobby.mode.format === 'ffa' || lobby.mode.autoBalance) { socket.emit(EV.LOBBY_ERROR, { msg: 'Équipes attribuées automatiquement' }); return; }
      const team = Number(data?.team);
      if (!(team >= 0 && team < lobby.mode.teamCount)) return;
      const occupancy = lobby.members.filter(m => m.team === team && m.userId !== player.userId).length;
      if (occupancy >= lobby.mode.teamSize) { socket.emit(EV.LOBBY_ERROR, { msg: 'Équipe complète' }); return; }
      member.team = team;
      broadcastLobby(io, lobby);
      maybeAutoStart(io, lobby);
    });

    socket.on(EV.LOBBY_LEAVE, () => {
      if (!player) return;
      removeFromLobby(io, player.userId);
    });

    socket.on(EV.LOBBY_START, () => {
      if (!player) return;
      const lobby = lobbies.get(userLobby.get(player.userId));
      if (!lobby) return;
      if (lobby.hostUserId !== player.userId) { socket.emit(EV.LOBBY_ERROR, { msg: "Seul l'hôte peut lancer" }); return; }
      // Privé : départ anticipé autorisé (≥1 joueur par équipe). Public : complet requis.
      const ready = lobby.isPrivate ? canHostStart(lobby) : isLobbyReady(lobby);
      if (!ready) { socket.emit(EV.LOBBY_ERROR, { msg: 'Il faut au moins un joueur par équipe' }); return; }
      startLobby(io, lobby);
    });

    // ───────── (Re)joindre une partie par UUID ─────────
    socket.on(EV.JOIN_GAME, ({ gameId }) => {
      if (!player) { socket.emit('error', { msg: 'Non authentifié' }); return; }

      const room = rooms.get(gameId);
      if (room && !room.engine.over) {
        const idx = findIndex(room, player.userId);
        if (idx === -1) { socket.emit(EV.GAME_NOT_FOUND, { gameId }); return; }
        cancelAbandon(player.userId);
        room.players[idx].socketId = socket.id;
        room.players[idx].connected = true;
        room.engine.players[idx].socketId = socket.id;
        socket.join(gameId);
        socket.emit(EV.GAME_JOINED, gameJoinedPayload(room, idx));
        return;
      }

      const fin = finishedGames.get(gameId);
      if (fin && fin.resultByUserId.has(player.userId)) {
        socket.emit(EV.GAME_END, fin.resultByUserId.get(player.userId));
        return;
      }

      socket.emit(EV.GAME_NOT_FOUND, { gameId });
    });

    // Actions de jeu : routées via userId → partie → index.
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

      const qIdx = queue.findIndex(q => q.socketId === socket.id);
      if (qIdx !== -1) queue.splice(qIdx, 1);

      const userId = socketToUser.get(socket.id);
      socketToUser.delete(socket.id);
      if (userId === undefined) return;

      // Salon : grâce courte (le temps d'un refresh) puis retrait.
      const lobby = lobbies.get(userLobby.get(userId));
      if (lobby) {
        const m = lobby.members.find(x => x.userId === userId);
        if (m && m.socketId === socket.id) {
          m.connected = false;
          broadcastLobby(io, lobby);
          const lt = setTimeout(() => { lobbyTimers.delete(userId); removeFromLobby(io, userId); }, LOBBY_GRACE_MS);
          lobbyTimers.set(userId, lt);
        }
      }

      // Partie : la partie continue, le joueur se fige (tuable). Abandon après grâce.
      const room = roomOf(userId);
      if (!room || room.engine.over) return;
      const pIdx = findIndex(room, userId);
      if (pIdx === -1) return;
      if (room.players[pIdx].socketId !== socket.id) return;

      room.players[pIdx].connected = false;
      room.engine.handleInput(pIdx, { up: false, down: false, left: false, right: false });

      cancelAbandon(userId);
      const timer = setTimeout(() => {
        abandonTimers.delete(userId);
        const r = roomOf(userId);
        if (!r || r.engine.over) return;
        const i = findIndex(r, userId);
        if (i === -1 || r.players[i].connected) return;
        const team = r.players[i].team;
        // En équipe, on n'abandonne que si TOUTE l'équipe est partie ; sinon la
        // partie continue (le coéquipier joue, le joueur figé reste tuable).
        if (r.players.some(p => p.team === team && p.connected)) return;
        const winnerTeam = r.players.find(p => p.team !== team)?.team ?? -1;
        _endGame(io, r, { winnerTeam, reason: 'abandon' });
      }, GAME.RECONNECT_TIMEOUT_MS);
      abandonTimers.set(userId, timer);
    });
  });
}

// ─────────────────────────── Parties ───────────────────────────

function gameJoinedPayload(room, idx) {
  return {
    gameId: room.gameId,
    myPlayerIndex: idx,
    myTeam: room.players[idx].team,
    mode: publicMode(room.mode),
    players: room.players.map(p => ({ pseudo: p.pseudo, elo: p.elo, team: p.team })),
    state: room.engine.getFullStateFor(idx),
  };
}

// Diffuse un état taillé par observateur (interest management) à chaque joueur
// connecté. L'index moteur = position dans room.players (ordre d'addPlayer).
function emitPerPlayer(io, room, event, fullState) {
  room.players.forEach((p, idx) => {
    if (!p.connected) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit(event, fullState ? room.engine.getFullStateFor(idx) : room.engine.getStateFor(idx));
  });
}

function createGame(io, mode, roster) {
  const gameId = crypto.randomUUID();
  const engine = new GameEngine(gameId, mode);
  roster.forEach(r => engine.addPlayer(r.userId, r.pseudo, r.elo || 1000, r.socketId, r.team));
  engine.start();

  const players = roster.map(r => ({
    userId: r.userId, pseudo: r.pseudo, elo: r.elo || 1000, socketId: r.socketId, team: r.team, connected: true,
  }));
  const room = { gameId, mode, engine, players, tickInterval: null, fullStateInterval: null, ended: false };
  rooms.set(gameId, room);
  for (const p of players) userActiveGame.set(p.userId, gameId);

  for (const p of players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit(EV.MATCH_FOUND, { gameId });
  }

  room.tickInterval = setInterval(() => {
    const result = engine.tick(GAME.TICK_MS);
    engine.consumeEvents().forEach(e => {
      if (e.type === 'hit') {
        // Position de l'impact transmise UNIQUEMENT au tireur → il voit où il a
        // touché même hors-vue, sans divulguer la cible aux autres joueurs.
        room.players.forEach((p, idx) => {
          const sock = io.sockets.sockets.get(p.socketId);
          if (!sock) return;
          const payload = { playerIndex: e.victim, by: e.by };
          if (idx === e.by) { payload.x = e.x; payload.y = e.y; }
          sock.emit(EV.PLAYER_HIT, payload);
        });
      }
    });
    if (engine.over) { _endGame(io, room, result); return; }
    emitPerPlayer(io, room, EV.GAME_STATE, false);
  }, GAME.TICK_MS);

  room.fullStateInterval = setInterval(() => {
    if (!engine.over) emitPerPlayer(io, room, EV.GAME_FULL_STATE, true);
  }, GAME.FULL_STATE_INTERVAL_MS);

  return gameId;
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

  const { engine, players, gameId, mode } = room;
  const winnerTeam = (result && result.winnerTeam !== undefined) ? result.winnerTeam : engine.getWinnerTeam();
  const reason = result?.reason || 'normal';

  // Persistance + Elo uniquement pour les modes classés (1v1 pour l'instant).
  let eloDeltas = players.map(() => 0);
  if (mode.ranked && players.length === 2) {
    const [p1, p2] = players;
    const [d1, d2] = calculateElo(p1.elo, p2.elo, winnerTeam);
    eloDeltas = [d1, d2];
    try {
      const s = engine.stats;
      await saveMatchResult({
        player1Id: p1.userId, player2Id: p2.userId,
        winnerId: winnerTeam === 0 ? p1.userId : winnerTeam === 1 ? p2.userId : null,
        player1HpLeft: engine.players[0].hp, player2HpLeft: engine.players[1].hp,
        durationSeconds: engine.getDurationSeconds(),
        player1EloDelta: d1, player2EloDelta: d2,
        player1Pings: s[0].pings, player2Pings: s[1].pings,
        player1Shots: s[0].shots, player2Shots: s[1].shots,
        player1Hits: s[0].hits, player2Hits: s[1].hits,
      });
    } catch (e) {
      console.error('[endGame] saveMatchResult a échoué', e);
    }
  }

  const endFor = (idx) => ({
    winnerTeam,
    myPlayerIndex: idx,
    myTeam: players[idx].team,
    myStats: engine.stats[idx],
    eloDelta: eloDeltas[idx],
    players: players.map(p => ({ pseudo: p.pseudo, team: p.team })),
    mode: publicMode(mode),
    reason,
  });

  const resultByUserId = new Map();
  players.forEach((p, idx) => resultByUserId.set(p.userId, endFor(idx)));
  _storeFinished(gameId, resultByUserId);

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

// ─────────────────────────── Salons ───────────────────────────

function publicMode(mode) {
  return {
    id: mode.id, label: mode.label, short: mode.short, ranked: mode.ranked,
    format: mode.format || 'team',
    teamSize: mode.teamSize, teamCount: mode.teamCount, totalPlayers: mode.totalPlayers,
    teamNames: mode.teamNames, teamColors: mode.teamColors,
    maxHp: mode.maxHp || 3, durationMs: mode.durationMs, borderMap: !!mode.borderMap,
    autoBalance: !!mode.autoBalance,
    objective: mode.objective || 'survival',
    killTarget: mode.killTarget || 0,
    respawnMs: mode.respawnMs || 0,
  };
}

function genCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (lobbies.has(c));
  return c;
}

function createLobby(mode, isPrivate, hostUserId) {
  const code = genCode();
  const lobby = { code, mode, isPrivate, hostUserId, members: [], createdAt: Date.now() };
  lobbies.set(code, lobby);
  return lobby;
}

function teamCounts(lobby) {
  const c = new Array(lobby.mode.teamCount).fill(0);
  for (const m of lobby.members) if (m.team != null) c[m.team]++;
  return c;
}

function autoTeam(lobby) {
  const counts = teamCounts(lobby);
  let best = null, bestN = Infinity;
  for (let t = 0; t < lobby.mode.teamCount; t++) {
    if (counts[t] < lobby.mode.teamSize && counts[t] < bestN) { bestN = counts[t]; best = t; }
  }
  return best;
}

function isLobbyReady(lobby) {
  if (lobby.members.length !== lobby.mode.totalPlayers) return false;
  return teamCounts(lobby).every(x => x === lobby.mode.teamSize);
}

// Départ anticipé réservé aux salons privés : l'hôte peut lancer en sous-effectif.
// FFA : au moins 2 joueurs. Équipes : au moins 2 équipes non vides (permet 2v1…).
function canHostStart(lobby) {
  if (!lobby.isPrivate) return false;
  if (lobby.members.length < 2) return false;
  if (lobby.mode.format === 'ffa') return true;
  return teamCounts(lobby).filter(x => x > 0).length >= 2;
}

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    isPrivate: lobby.isPrivate,
    hostUserId: lobby.hostUserId,
    mode: publicMode(lobby.mode),
    members: lobby.members.map(m => ({ userId: m.userId, pseudo: m.pseudo, team: m.team, connected: m.connected })),
    canStart: isLobbyReady(lobby),
    canHostStart: canHostStart(lobby),
  };
}

function broadcastLobby(io, lobby) {
  const snap = lobbySnapshot(lobby);
  for (const m of lobby.members) {
    const s = io.sockets.sockets.get(m.socketId);
    if (s) s.emit(EV.LOBBY_STATE, snap);
  }
}

function joinLobby(io, socket, lobby, player, elo) {
  const team = autoTeam(lobby);
  if (team === null) { socket.emit(EV.LOBBY_ERROR, { msg: 'Salon complet' }); return; }
  lobby.members.push({
    userId: player.userId, pseudo: player.pseudo, elo: elo || 1000, socketId: socket.id, team, connected: true,
  });
  userLobby.set(player.userId, lobby.code);
  socket.emit(EV.LOBBY_JOINED, { code: lobby.code });
  broadcastLobby(io, lobby);
  maybeAutoStart(io, lobby);
}

function removeFromLobby(io, userId) {
  const code = userLobby.get(userId);
  if (!code) return;
  const lobby = lobbies.get(code);
  userLobby.delete(userId);
  const lt = lobbyTimers.get(userId);
  if (lt) { clearTimeout(lt); lobbyTimers.delete(userId); }
  if (!lobby) return;
  lobby.members = lobby.members.filter(m => m.userId !== userId);
  if (lobby.members.length === 0) { lobbies.delete(code); return; }
  if (lobby.hostUserId === userId) lobby.hostUserId = lobby.members[0].userId;
  broadcastLobby(io, lobby);
}

function maybeAutoStart(io, lobby) {
  // Public : démarre dès que complet. Privé : seulement si l'hôte a demandé
  // l'attente de l'effectif complet (sinon départ manuel via LOBBY_START).
  if (lobby.isPrivate && lobby.mode.waitForFull === false) return;
  if (isLobbyReady(lobby)) startLobby(io, lobby);
}

function startLobby(io, lobby) {
  const roster = lobby.members.map(m => ({
    userId: m.userId, pseudo: m.pseudo, elo: m.elo, socketId: m.socketId, team: m.team,
  }));
  // Dissoudre le salon AVANT de créer la partie (createGame pose userActiveGame).
  for (const m of lobby.members) {
    userLobby.delete(m.userId);
    const lt = lobbyTimers.get(m.userId);
    if (lt) { clearTimeout(lt); lobbyTimers.delete(m.userId); }
  }
  lobbies.delete(lobby.code);
  createGame(io, lobby.mode, roster);
}

module.exports = { setupSocketHandlers };
