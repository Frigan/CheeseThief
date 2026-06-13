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

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('room_update', {
    code,
    admin: room.admin,
    members: room.members,
    gamePhase: room.game ? room.game.phase : 'lobby',
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  });
}

// Public (non-secret) snapshot of the game, safe for everyone in the room.
function broadcastGame(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const g = room.game;
  io.to(code).emit('game_update', {
    phase: g.phase,
    ackedCount: g.acked.length,
    total: room.members.length,
    votedIds: Object.keys(g.votes),
    timerEndsAt: g.timerEndsAt || null,
    result: g.phase === 'results' ? g.result : null,
  });
}

// Send each member only the slice of game state they're allowed to see.
function sendSecrets(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  room.members.forEach(m => {
    io.to(m.id).emit('your_secret', game.secretFor(room.game, m.id));
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
    if (gameActive(room)) {
      socket.emit('error', 'A game is in progress. Try again after this round.');
      return;
    }
    if (room.members.length >= MAX_PLAYERS) {
      socket.emit('error', `Room is full (max ${MAX_PLAYERS} players).`);
      return;
    }
    if (room.members.find(m => m.id === socket.id)) return;
    room.members.push({ id: socket.id, name: String(name).slice(0, 20), seat: room.members.length });
    currentRoom = code;
    socket.join(code);
    socket.emit('joined_room', { code, isAdmin: false });
    broadcastRoom(code);
  });

  socket.on('leave_room', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    removeFromRoom(socket.id, currentRoom);
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
    if (gameActive(room) && room.game.dice[targetId] !== undefined) {
      room.members = room.members.filter(m => m.id !== targetId);
      reassignSeats(room);
      abortGame(currentRoom, 'A player was removed — the round was cancelled.');
      return;
    }
    room.members = room.members.filter(m => m.id !== targetId);
    reassignSeats(room);
    broadcastRoom(currentRoom);
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

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room || !isHost() || gameActive(room)) return;
    if (room.members.length < MIN_PLAYERS || room.members.length > MAX_PLAYERS) {
      socket.emit('error', `Need ${MIN_PLAYERS}-${MAX_PLAYERS} players to start.`);
      return;
    }
    room.game = game.startGame(room.members);
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
      // Auto-resolve once everyone has voted.
      if (Object.keys(room.game.votes).length >= room.members.length) {
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

  socket.on('disconnect', () => {
    if (currentRoom) removeFromRoom(socket.id, currentRoom);
  });

  // ── Helpers bound to this socket ──────────────────────────────

  function resolveAndReveal(code) {
    const room = rooms[code];
    if (!room || !room.game) return;
    clearTimer(room);
    const ids = room.members.map(m => m.id);
    game.resolveVote(room.game, ids);
    room.game.phase = 'results';
    broadcastGame(code);
  }

  function removeFromRoom(id, code) {
    const room = rooms[code];
    if (!room) return;
    const wasInGame = gameActive(room) && room.game.dice[id] !== undefined;
    room.members = room.members.filter(m => m.id !== id);
    socket.leave(code);

    if (room.members.length === 0) {
      clearTimer(room);
      delete rooms[code];
      return;
    }
    if (room.admin === id) {
      room.admin = room.members[0].id;
    }
    reassignSeats(room);

    if (wasInGame) {
      abortGame(code, 'A player left — the round was cancelled.');
      return;
    }
    broadcastRoom(code);
  }

  function reassignSeats(room) {
    room.members.forEach((m, i) => { m.seat = i; });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CheeseThief running on http://localhost:${PORT}`));
