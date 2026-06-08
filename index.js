const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);

  if (ext && MIME[ext]) {
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(200, { 'Content-Type': MIME[ext] });
        res.end(data);
      }
    });
  } else {
    // Fallback: serve index.html for SPA
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('AndroidCalc server running');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const MAX_USERS = 2;
const users = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('register', (userName) => {
    // Kick any stale/ghost socket registered under the same name (reconnect,
    // app backgrounded, WiFi drop). This frees the slot the real device needs.
    for (const [id, user] of users) {
      if (id !== socket.id && user.name === userName) {
        const stale = io.sockets.sockets.get(id);
        users.delete(id);
        if (stale) stale.disconnect(true);
        console.log(`Removed stale socket for ${userName} (${id})`);
      }
    }

    // Enforce the 2-user cap only after deduping, so ghosts can't lock anyone out.
    if (!users.has(socket.id) && users.size >= MAX_USERS) {
      socket.emit('error-full', 'Room is full. Only 2 users allowed.');
      socket.disconnect(true);
      return;
    }

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
