const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Banco de dados simples em JSON ──────────────────────────────────────────
// No Railway usa /tmp que é gravável. Localmente usa a pasta do projeto.
const DB_PATH = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/telas-db.json'
  : path.join(__dirname, 'telas-db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch {}
  return {
    whitelist: {},        // { ip: { ip, label, added_at } }
    config: {
      admin_password: 'admin123',
      whitelist_mode: 'off'
    },
    logs: []              // [{ id, ip, action, detail, created_at }]
  };
}

function saveDb(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch {}
}

let db = loadDb();
let logId = db.logs.length > 0 ? Math.max(...db.logs.map(l => l.id)) + 1 : 1;

function getConfig(key) { return db.config[key]; }
function setConfig(key, value) { db.config[key] = value; saveDb(db); }

// ─── Helpers de IP ────────────────────────────────────────────────────────────
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconhecido';
}

function getSocketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address || 'desconhecido';
}

const ALWAYS_ALLOWED = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

function isAllowed(ip) {
  if (ALWAYS_ALLOWED.includes(ip)) return true;
  if (getConfig('whitelist_mode') === 'off') return true;
  return !!db.whitelist[ip];
}

function logAccess(ip, action, detail = '') {
  const entry = {
    id: logId++,
    ip,
    action,
    detail,
    created_at: new Date().toLocaleString('pt-BR')
  };
  db.logs.unshift(entry);
  if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
  saveDb(db);
}

// ─── Middleware de proteção por IP ────────────────────────────────────────────
function ipGuard(req, res, next) {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin') || req.path === '/api/myip') {
    return next();
  }
  const ip = getClientIp(req);
  if (isAllowed(ip)) return next();
  logAccess(ip, 'BLOCKED', req.path);
  return res.status(403).sendFile(path.join(__dirname, 'public', 'blocked.html'));
}

app.use(ipGuard);

// ─── Rotas principais ─────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/room/:roomId', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'room.html')));

app.get('/api/create-room', (req, res) => {
  res.json({ roomId: uuidv4().substring(0, 8) });
});

app.get('/api/myip', (req, res) => {
  const ip = getClientIp(req);
  res.json({ ip, allowed: isAllowed(ip) });
});

// ─── Admin auth ───────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === getConfig('admin_password')) return next();
  return res.status(401).json({ error: 'Senha incorreta' });
}

app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === getConfig('admin_password')) {
    logAccess(getClientIp(req), 'ADMIN_LOGIN', 'Login bem-sucedido');
    res.json({ ok: true, token: password });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ─── Admin: whitelist ─────────────────────────────────────────────────────────
app.get('/api/admin/ips', adminAuth, (req, res) => {
  const ips = Object.values(db.whitelist).sort((a, b) =>
    new Date(b.added_at) - new Date(a.added_at));
  res.json({ ips, mode: getConfig('whitelist_mode'), total: ips.length });
});

app.post('/api/admin/ips', adminAuth, (req, res) => {
  let { ip, label } = req.body;
  ip    = (ip    || '').trim();
  label = (label || '').trim().substring(0, 60);
  if (!ip) return res.status(400).json({ error: 'IP é obrigatório' });

  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]{2,45}$/;
  if (!ipv4.test(ip) && !ipv6.test(ip))
    return res.status(400).json({ error: 'Formato de IP inválido' });

  db.whitelist[ip] = { ip, label: label || ip, added_at: new Date().toLocaleString('pt-BR') };
  saveDb(db);
  logAccess(ip, 'IP_ADDED', label || '');
  res.json({ ok: true });
});

app.delete('/api/admin/ips/:ip', adminAuth, (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  if (!db.whitelist[ip]) return res.status(404).json({ error: 'IP não encontrado' });
  delete db.whitelist[ip];
  saveDb(db);
  logAccess(ip, 'IP_REMOVED', '');
  res.json({ ok: true });
});

app.delete('/api/admin/ips', adminAuth, (req, res) => {
  db.whitelist = {};
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/mode', adminAuth, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'on' && mode !== 'off') return res.status(400).json({ error: 'mode deve ser "on" ou "off"' });
  setConfig('whitelist_mode', mode);
  res.json({ ok: true, mode });
});

app.post('/api/admin/password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });
  setConfig('admin_password', newPassword);
  res.json({ ok: true });
});

// ─── Admin: salas e logs ──────────────────────────────────────────────────────
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  const data = [];
  rooms.forEach((users, roomId) => {
    data.push({
      roomId,
      users: Array.from(users.values()).map(u => ({
        name: u.name, ip: u.ip, isSharing: u.isSharing
      }))
    });
  });
  res.json({ rooms: data, totalUsers: io.sockets.sockets.size });
});

app.get('/api/admin/logs', adminAuth, (req, res) => {
  res.json({ logs: db.logs.slice(0, 100) });
});

app.delete('/api/admin/logs', adminAuth, (req, res) => {
  db.logs = [];
  saveDb(db);
  res.json({ ok: true });
});

// ─── Salas em memória ─────────────────────────────────────────────────────────
const rooms = new Map();

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values());
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const ip = getSocketIp(socket);
  if (isAllowed(ip)) return next();
  return next(new Error('IP não autorizado'));
});

io.on('connection', (socket) => {
  const clientIp = getSocketIp(socket);

  socket.on('join-room', ({ roomId, userName }) => {
    const name = (userName || 'Anônimo').substring(0, 24);
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    rooms.get(roomId).set(socket.id, { id: socket.id, name, ip: clientIp, isSharing: false });

    logAccess(clientIp, 'JOIN_ROOM', `${name} → ${roomId}`);

    socket.to(roomId).emit('user-joined', {
      userId: socket.id, userName: name, users: getRoomUsers(roomId)
    });
    socket.emit('room-users', { users: getRoomUsers(roomId), roomId });

    socket.data.roomId   = roomId;
    socket.data.userName = name;
    socket.data.ip       = clientIp;
  });

  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { fromId: socket.id, fromName: socket.data.userName, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  socket.on('screen-share-started', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.has(socket.id)) room.get(socket.id).isSharing = true;
    socket.to(roomId).emit('screen-share-started', { userId: socket.id, userName: socket.data.userName });
  });

  socket.on('screen-share-stopped', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.has(socket.id)) room.get(socket.id).isSharing = false;
    socket.to(roomId).emit('screen-share-stopped', { userId: socket.id });
  });

  socket.on('chat-message', ({ roomId, message }) => {
    if (!message?.trim()) return;
    io.to(roomId).emit('chat-message', {
      userId: socket.id,
      userName: socket.data.userName,
      message: message.substring(0, 500),
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const { roomId, userName, ip } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(roomId);
    }
    socket.to(roomId).emit('user-left', { userId: socket.id, userName, users: getRoomUsers(roomId) });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  App:    http://localhost:${PORT}`);
  console.log(`🔐  Admin:  http://localhost:${PORT}/admin`);
  console.log(`🔑  Senha:  ${getConfig('admin_password')}\n`);
});
