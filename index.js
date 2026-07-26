const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// --- Presencia: registra la ultima conexion en Supabase (funciona para app Y web) ---
const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://nsydgcsszificogtalxv.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zeWRnY3NzemlmaWNvZ3RhbHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzU5MTEsImV4cCI6MjA5NjQ1MTkxMX0.CL9cGdUtqjNjgy_yYGUoclwVQj69myZ_dCLfKu9-esc';

function recordPresence(userName) {
  if (!userName) return;
  const body = JSON.stringify({ user_name: userName, last_seen: Date.now() });
  const url = new URL('/rest/v1/presence', SUPABASE_URL);
  const req = https.request(
    {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      res.on('data', () => {});
      res.on('end', () => {});
    }
  );
  req.on('error', (e) => console.error('presence error:', e.message));
  req.write(body);
  req.end();
}

// --- Notificaciones "clima": avisa a la otra persona (conexion o mensaje)
// disfrazado como el clima REAL de Apodaca, N.L. (Open-Meteo, sin API key) ---
const APODACA = { lat: 25.7817, lon: -100.1886 };
const WEATHER_TTL = 10 * 60 * 1000; // cachear el clima 10 min
const NOTIFY_MIN_MS = 40 * 1000; // throttle por persona para no saturar
let weatherCache = { text: null, at: 0 };
const notifyThrottle = new Map(); // actorName -> ultimo push (ms)

const WMO = {
  0: 'Cielo despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado',
  3: 'Nublado', 45: 'Niebla', 48: 'Niebla', 51: 'Llovizna ligera',
  53: 'Llovizna', 55: 'Llovizna intensa', 56: 'Llovizna helada',
  57: 'Llovizna helada', 61: 'Lluvia ligera', 63: 'Lluvia', 65: 'Lluvia fuerte',
  66: 'Lluvia helada', 67: 'Lluvia helada', 71: 'Nieve ligera', 73: 'Nieve',
  75: 'Nieve intensa', 77: 'Aguanieve', 80: 'Chubascos', 81: 'Chubascos',
  82: 'Chubascos fuertes', 85: 'Chubascos de nieve', 86: 'Chubascos de nieve',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo',
};

function getWeather(cb) {
  const now = Date.now();
  if (weatherCache.text && now - weatherCache.at < WEATHER_TTL) {
    return cb(weatherCache.text);
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${APODACA.lat}` +
    `&longitude=${APODACA.lon}&current=temperature_2m,weather_code` +
    `&timezone=America/Monterrey`;
  https
    .get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = Math.round(j.current.temperature_2m);
          const desc = WMO[j.current.weather_code] || 'Despejado';
          weatherCache = { text: `${t}° · ${desc}`, at: now };
        } catch (e) {
          /* usa lo que haya en cache */
        }
        cb(weatherCache.text || '24° · Despejado');
      });
    })
    .on('error', () => cb(weatherCache.text || '24° · Despejado'));
}

function sendExpoPush(token, body) {
  const payload = JSON.stringify({
    to: token,
    title: 'El tiempo en Apodaca',
    body,
    sound: null,
    channelId: 'clima',
    priority: 'high',
  });
  const req = https.request(
    {
      method: 'POST',
      hostname: 'exp.host',
      path: '/--/api/v2/push/send',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      res.on('data', () => {});
      res.on('end', () => {});
    }
  );
  req.on('error', (e) => console.error('push error:', e.message));
  req.write(payload);
  req.end();
}

// Envia el "clima" a la otra persona (todos los tokens salvo el que hizo la accion)
function notifyOther(actorName) {
  if (!actorName) return;
  const now = Date.now();
  if (now - (notifyThrottle.get(actorName) || 0) < NOTIFY_MIN_MS) return;
  notifyThrottle.set(actorName, now);

  const url = new URL('/rest/v1/push_tokens?select=user_name,token', SUPABASE_URL);
  https
    .get(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let rows = [];
          try {
            rows = JSON.parse(d);
          } catch (e) {
            return;
          }
          // Si la tabla aun no existe, Supabase devuelve un objeto de error
          if (!Array.isArray(rows)) return;
          const targets = rows.filter(
            (r) => r.user_name !== actorName && r.token
          );
          if (!targets.length) return;
          getWeather((body) => targets.forEach((r) => sendExpoPush(r.token, body)));
        });
      }
    )
    .on('error', (e) => console.error('token fetch error:', e.message));
}

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

    // Guarda la hora de entrada (app o web) para la "ultima conexion"
    recordPresence(userName);

    // Avisa a la otra persona (disfrazado del clima) que este usuario entro
    notifyOther(userName);

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
    // Avisa a la otra persona (disfrazado del clima) que llego un mensaje
    notifyOther(data.sender);
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
      // Guarda la hora de salida como ultima conexion (app o web)
      recordPresence(user.name);
      socket.broadcast.emit('user-status', { name: user.name, online: false });
      users.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
