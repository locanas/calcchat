const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AndroidCalc server running');
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const MAX_USERS = 2;
const users = new Map();

io.on('connection', (socket) => {
  if (users.size >= MAX_USERS) {
    socket.emit('error-full', 'Room is full. Only 2 users allowed.');
    socket.disconnect();
    return;
  }

  console.log(`User connected: ${socket.id}`);

  socket.on('register', (userName) => {
    users.set(socket.id, { name: userName, typing: false });
    console.log(`Registered: ${userName} (${socket.id})`);

    // Notify this user about who else is online
    for (const [id, user] of users) {
      if (id !== socket.id) {
        socket.emit('user-status', { name: user.name, online: true });
      }
    }

    // Notify others that this user joined
    socket.broadcast.emit('user-status', { name: userName, online: true });
  });

  // Relay messages (never stored)
  socket.on('message', (data) => {
    socket.broadcast.emit('message', {
      id: data.id,
      text: data.text,
      sender: data.sender,
      type: data.type || 'text',
      media_url: data.media_url || null,
      timestamp: data.timestamp,
    });
  });

  // Typing indicator
  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (user) {
      user.typing = isTyping;
      socket.broadcast.emit('typing', { name: user.name, isTyping });
    }
  });

  // WebRTC signaling for voice/video calls
  socket.on('call-offer', (data) => {
    socket.broadcast.emit('call-offer', data);
  });

  socket.on('call-answer', (data) => {
    socket.broadcast.emit('call-answer', data);
  });

  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', data);
  });

  socket.on('call-end', () => {
    socket.broadcast.emit('call-end');
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`Disconnected: ${user.name}`);
      socket.broadcast.emit('user-status', { name: user.name, online: false });
      users.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
