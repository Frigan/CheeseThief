const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const game = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { [code]: { admin, members: [{ id, name, seat }], game, discussionTimer } }
const rooms = {};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function gameActive(room) {
  return room.game && room.game.phase !== 'lobby';
}

// Players actually dealt into the current round (members without a die are spectators).
function participantIds(room) {
  return room.game ? Object.keys(room.game.dice) : [];
}

function isParticipant(room, id) {
  return !!(room.game && room.game.dice[id] !== undefined);
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('room_update', {
    code,
    admin: room.admin,
    members: room.members,
    gamePhase: room.game ? room.game.phase : 'lobby',
    participantIds: gameActive(room) ? participantIds(room) : null,
    scores: room.scores,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  });
}

// Award 1 session point to every player on the winning side of a finished round.
function awardPoints(room) {
  const g = room.game;
  if (!g || !g.result) return;
  const r = g.result;
  const parts = Object.keys(g.dice);
  let winnerIds = [];
  if (r.winners === 'fallMouse') {
    if (r.fallMouseId) winnerIds = [r.fallMouseId];
  } else if (r.winners === 'thief') {
    // Thief and their followers — but never a Fall Mouse who was a follower.
    winnerIds = [r.thiefId, ...r.followerIds.filter(f => f !== r.fallMouseId)];
  } else {
    // Sleepyheads: everyone who isn't the thief, a follower, or the Fall Mouse.
    winnerIds = parts.filter(id =>
      id !== r.thiefId && id !== r.fallMouseId && !r.followerIds.includes(id));
  }
  winnerIds.forEach(id => { room.scores[id] = (room.scores[id] || 0) + 1; });
}

// Public (non-secret) snapshot of the game, safe for everyone in the room.
function broadcastGame(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const g = room.game;
  io.to(code).emit('game_update', {
    phase: g.phase,
    ackedCount: g.acked.length,
    total: participantIds(room).length,
    votedIds: Object.keys(g.votes),
    timerEndsAt: g.timerEndsAt || null,
    result: g.phase === 'results' ? g.result : null,
  });
}

// Send each member only the slice of game state they're allowed to see.
// Members who joined mid-round have no die and receive a spectator marker.
function sendSecrets(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  room.members.forEach(m => {
    if (isParticipant(room, m.id)) {
      io.to(m.id).emit('your_secret', game.secretFor(room.game, m.id));
    } else {
      io.to(m.id).emit('your_secret', { spectator: true });
    }
  });
}

function clearTimer(room) {
  if (room.discussionTimer) {
    clearTimeout(room.discussionTimer);
    room.discussionTimer = null;
  }
}

function abortGame(code, reason) {
  const room = rooms[code];
  if (!room) return;
  clearTimer(room);
  room.game = null;
  io.to(code).emit('game_aborted', { reason });
  broadcastRoom(code);
}

function resolveAndReveal(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  clearTimer(room);
  game.resolveVote(room.game, participantIds(room));
  awardPoints(room);
  room.game.phase = 'results';
  broadcastGame(code);
  broadcastRoom(code); // push updated session scores
}

// Remove a player from a room, handling host hand-off and in-progress rounds.
function departRoom(code, id) {
  const room = rooms[code];
  if (!room) return;
  const wasParticipant = isParticipant(room, id);
  const wasThief = wasParticipant && room.game.thiefId === id;

  room.members = room.members.filter(m => m.id !== id);
  delete room.scores[id];
  if (room.members.length === 0) {
    clearTimer(room);
    delete rooms[code];
    return;
  }
  if (room.admin === id) room.admin = room.members[0].id;
  room.members.forEach((m, i) => { m.seat = i; });

  if (wasParticipant) {
    game.removeParticipant(room.game, id);
    // Losing the thief or dropping below the minimum cancels the round.
    if (wasThief || participantIds(room).length < MIN_PLAYERS) {
      abortGame(code, 'Too few players remain — the round was cancelled.');
      return;
    }
    broadcastRoom(code);
    sendSecrets(code);
    // A departure during voting can complete the tally.
    if (room.game.phase === 'voting' &&
        Object.keys(room.game.votes).length >= participantIds(room).length) {
      resolveAndReveal(code);
    } else {
      broadcastGame(code);
    }
    return;
  }
  broadcastRoom(code);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  function isHost() {
    const room = rooms[currentRoom];
    return room && room.admin === socket.id;
  }

  socket.on('create_room', ({ name }) => {
    if (!name) return;
    const code = generateCode();
    rooms[code] = {
      admin: socket.id,
      members: [{ id: socket.id, name: String(name).slice(0, 20), seat: 0 }],
      game: null,
      discussionTimer: null,
      scores: { [socket.id]: 0 },
    };
    currentRoom = code;
    socket.join(code);
    socket.emit('joined_room', { code, isAdmin: true });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ name, code }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('error', 'Room not found.');
      return;
    }
    if (room.members.length >= MAX_PLAYERS) {
      socket.emit('error', `Room is full (max ${MAX_PLAYERS} players).`);
      return;
    }
    if (room.members.find(m => m.id === socket.id)) return;
    const joiningMidGame = gameActive(room);
    room.members.push({ id: socket.id, name: String(name).slice(0, 20), seat: room.members.length });
    if (!(socket.id in room.scores)) room.scores[socket.id] = 0;
    currentRoom = code;
    socket.join(code);
    socket.emit('joined_room', { code, isAdmin: false });
    broadcastRoom(code);
    // A late joiner spectates the current round, then plays the next one.
    if (joiningMidGame) {
      io.to(socket.id).emit('your_secret', { spectator: true });
      broadcastGame(code);
    }
  });

  socket.on('leave_room', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    socket.leave(currentRoom);
    departRoom(currentRoom, socket.id);
    currentRoom = null;
  });

  socket.on('kick_member', ({ targetId }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.admin !== socket.id) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('kicked');
      target.leave(currentRoom);
    }
    departRoom(currentRoom, targetId);
  });

  socket.on('randomise_seats', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.admin !== socket.id || gameActive(room)) return;
    const shuffled = shuffle(room.members);
    shuffled.forEach((m, i) => { m.seat = i; });
    room.members = shuffled;
    broadcastRoom(currentRoom);
  });

  // ── Game actions ──────────────────────────────────────────────

  socket.on('start_game', (opts = {}) => {
    const room = rooms[currentRoom];
    if (!room || !isHost() || gameActive(room)) return;
    if (room.members.length < MIN_PLAYERS || room.members.length > MAX_PLAYERS) {
      socket.emit('error', `Need ${MIN_PLAYERS}-${MAX_PLAYERS} players to start.`);
      return;
    }
    const discussionSeconds = [90, 120, 180, 240, 300].includes(opts.discussionSeconds)
      ? opts.discussionSeconds : 90;
    room.game = game.startGame(room.members, {
      fallMouse: !!opts.fallMouse,
      discussionSeconds,
    });
    broadcastRoom(currentRoom);
    sendSecrets(currentRoom);
    broadcastGame(currentRoom);
  });

  socket.on('ack_role', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game || room.game.phase !== 'roleReveal') return;
    if (room.game.acked.includes(socket.id)) return; // already acked — don't re-broadcast
    room.game.acked.push(socket.id);
    broadcastGame(currentRoom);
  });

  socket.on('begin_night', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game || !isHost() || room.game.phase !== 'roleReveal') return;
    room.game.phase = 'night';
    sendSecrets(currentRoom);
    broadcastGame(currentRoom);
  });

  socket.on('peek_player', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game || room.game.phase !== 'night') return;
    if (game.applyPeek(room.game, socket.id, targetId)) {
      io.to(socket.id).emit('your_secret', game.secretFor(room.game, socket.id));
    }
  });

  socket.on('choose_follower', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game || room.game.phase !== 'night') return;
    if (game.chooseFollower(room.game, socket.id, targetId)) {
      sendSecrets(currentRoom);
    }
  });

  socket.on('begin_discussion', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game || !isHost() || room.game.phase !== 'night') return;
    // Fill any follower slots the thief didn't pick before moving on.
    game.autofillFollowers(room.game);
    sendSecrets(currentRoom);
    room.game.phase = 'discussion';
    const secs = room.game.config.discussionSeconds;
    room.game.timerEndsAt = Date.now() + secs * 1000;
    clearTimer(room);
    room.discussionTimer = setTimeout(() => {
      if (rooms[currentRoom] && rooms[currentRoom].game && rooms[currentRoom].game.phase === 'discussion') {
        rooms[currentRoom].game.phase = 'voting';
        rooms[currentRoom].game.timerEndsAt = null;
        broadcastGame(currentRoom);
      }
    }, secs * 1000);
    broadcastGame(currentRoom);
  });

  socket.on('begin_voting', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game || !isHost() || room.game.phase !== 'discussion') return;
    clearTimer(room);
    room.game.phase = 'voting';
    room.game.timerEndsAt = null;
    broadcastGame(currentRoom);
  });

  socket.on('cast_vote', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game || room.game.phase !== 'voting') return;
    if (game.castVote(room.game, socket.id, targetId)) {
      broadcastGame(currentRoom);
      // Auto-resolve once every participant has voted.
      if (Object.keys(room.game.votes).length >= participantIds(room).length) {
        resolveAndReveal(currentRoom);
      }
    }
  });

  socket.on('end_voting', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game || !isHost() || room.game.phase !== 'voting') return;
    resolveAndReveal(currentRoom);
  });

  socket.on('play_again', () => {
    const room = rooms[currentRoom];
    if (!room || !isHost()) return;
    clearTimer(room);
    room.game = null;
    broadcastRoom(currentRoom);
    io.to(currentRoom).emit('game_update', { phase: 'lobby' });
  });

  socket.on('reset_scores', () => {
    const room = rooms[currentRoom];
    if (!room || !isHost()) return;
    Object.keys(room.scores).forEach(id => { room.scores[id] = 0; });
    broadcastRoom(currentRoom);
  });

  socket.on('disconnect', () => {
    if (currentRoom) departRoom(currentRoom, socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CheeseThief running on http://localhost:${PORT}`));
