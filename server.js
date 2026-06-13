const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { [code]: { admin: socketId, members: [{ id, name, seat }] } }
const rooms = {};

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

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('room_update', {
    code,
    admin: room.admin,
    members: room.members,
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ name }) => {
    if (!name) return;
    const code = generateCode();
    rooms[code] = {
      admin: socket.id,
      members: [{ id: socket.id, name, seat: 0 }],
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
    if (room.members.find(m => m.id === socket.id)) return;
    const seat = room.members.length;
    room.members.push({ id: socket.id, name, seat });
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
    room.members = room.members.filter(m => m.id !== targetId);
    reassignSeats(room);
    broadcastRoom(currentRoom);
  });

  socket.on('randomise_seats', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.admin !== socket.id) return;
    const shuffled = shuffle(room.members);
    shuffled.forEach((m, i) => { m.seat = i; });
    room.members = shuffled;
    broadcastRoom(currentRoom);
  });

  socket.on('disconnect', () => {
    if (currentRoom) removeFromRoom(socket.id, currentRoom);
  });

  function removeFromRoom(id, code) {
    const room = rooms[code];
    if (!room) return;
    room.members = room.members.filter(m => m.id !== id);
    socket.leave(code);
    if (room.members.length === 0) {
      delete rooms[code];
      return;
    }
    if (room.admin === id) {
      room.admin = room.members[0].id;
    }
    reassignSeats(room);
    broadcastRoom(code);
  }

  function reassignSeats(room) {
    room.members.forEach((m, i) => { m.seat = i; });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CheeseThief running on http://localhost:${PORT}`));
