const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const Database   = require('better-sqlite3');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Banco de dados SQLite ────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'telas.db'));

// Cria tabelas se não existirem
db.exec(`
  CREATE TABLE IF NOT EXISTS whitelist (
    ip        TEXT PRIMARY KEY,
    label     TEXT NOT NULL DEFAULT '',
    added_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS admin_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// Senha padrão: admin123 (pode trocar pelo painel)
const configGet = db.prepare('SELECT value FROM admin_config WHERE key = ?');
const configSet = db.prepare('INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)');

function getConfig(key, fallback) {
  const row = configGet.get(key);
  return row ? row.value : fallback;
}

// Garante senha padrão se não existir
if (!configGet.get('admin_password')) {
  configSet.run('admin_password', 'admin123');
}
// Modo whitelist: 'on' = só IPs cadastrados passam | 'off' = todos passam
if (!configGet.get('whitelist_mode')) {
  configSet.run('whitelist_mode', 'off');
}

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
  const mode = getConfig('whitelist_mode', 'off');
  if (mode === 'off') return true;
  return !!db.prepare('SELECT ip FROM whitelist WHERE ip = ?').get(ip);
}

function logAccess(ip, action, detail = '') {
  db.prepare('INSERT INTO access_log (ip, action, detail) VALUES (?, ?, ?)').run(ip, action, detail);
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

// Retorna o IP de quem está acessando
app.get('/api/myip', (req, res) => {
  const ip = getClientIp(req);
  res.json({ ip, allowed: isAllowed(ip) });
});

// ─── Admin: autenticação ──────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const pwd   = getConfig('admin_password', 'admin123');
  if (token === pwd) return next();
  return res.status(401).json({ error: 'Senha incorreta' });
}

// Página do admin (acessível por qualquer IP)
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const pwd = getConfig('admin_password', 'admin123');
  if (password === pwd) {
    const ip = getClientIp(req);
    logAccess(ip, 'ADMIN_LOGIN', 'Login bem-sucedido');
    res.json({ ok: true, token: pwd });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ─── Admin: whitelist ─────────────────────────────────────────────────────────
// Listar todos os IPs
app.get('/api/admin/ips', adminAuth, (req, res) => {
  const ips = db.prepare('SELECT * FROM whitelist ORDER BY added_at DESC').all();
  const mode = getConfig('whitelist_mode', 'off');
  res.json({ ips, mode, total: ips.length });
});

// Adicionar IP
app.post('/api/admin/ips', adminAuth, (req, res) => {
  let { ip, label } = req.body;
  ip    = (ip    || '').trim();
  label = (label || '').trim().substring(0, 60);

  if (!ip) return res.status(400).json({ error: 'IP é obrigatório' });

  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]{2,45}$/;
  if (!ipv4.test(ip) && !ipv6.test(ip)) {
    return res.status(400).json({ error: 'Formato de IP inválido' });
  }

  db.prepare('INSERT OR REPLACE INTO whitelist (ip, label) VALUES (?, ?)').run(ip, label || ip);
  logAccess(ip, 'IP_ADDED', label || '');
  console.log(`[✅ Admin] IP liberado: ${ip} — ${label}`);
  res.json({ ok: true });
});

// Remover IP
app.delete('/api/admin/ips/:ip', adminAuth, (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  const row = db.prepare('SELECT ip FROM whitelist WHERE ip = ?').get(ip);
  if (!row) return res.status(404).json({ error: 'IP não encontrado' });
  db.prepare('DELETE FROM whitelist WHERE ip = ?').run(ip);
  logAccess(ip, 'IP_REMOVED', '');
  console.log(`[🗑 Admin] IP removido: ${ip}`);
  res.json({ ok: true });
});

// Limpar toda a lista
app.delete('/api/admin/ips', adminAuth, (req, res) => {
  db.prepare('DELETE FROM whitelist').run();
  console.log('[🗑 Admin] Whitelist limpa');
  res.json({ ok: true });
});

// Ligar/desligar modo whitelist
app.post('/api/admin/mode', adminAuth, (req, res) => {
  const { mode } = req.body; // 'on' ou 'off'
  if (mode !== 'on' && mode !== 'off') return res.status(400).json({ error: 'mode deve ser "on" ou "off"' });
  configSet.run('whitelist_mode', mode);
  console.log(`[⚙️ Admin] Modo whitelist: ${mode}`);
  res.json({ ok: true, mode });
});

// Trocar senha do admin
app.post('/api/admin/password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });
  }
  configSet.run('admin_password', newPassword);
  console.log('[🔑 Admin] Senha alterada');
  res.json({ ok: true });
});

// ─── Admin: salas online ──────────────────────────────────────────────────────
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  const data = [];
  rooms.forEach((users, roomId) => {
    data.push({
      roomId,
      users: Array.from(users.values()).map(u => ({
        name: u.name,
        ip: u.ip,
        isSharing: u.isSharing
      }))
    });
  });
  res.json({ rooms: data, totalUsers: io.sockets.sockets.size });
});

// ─── Admin: log de acesso ─────────────────────────────────────────────────────
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT 100').all();
  res.json({ logs });
});

// Limpar logs
app.delete('/api/admin/logs', adminAuth, (req, res) => {
  db.prepare('DELETE FROM access_log').run();
  res.json({ ok: true });
});

// ─── Gerenciamento de salas (memória) ─────────────────────────────────────────
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
  console.log(`[+] ${socket.id} | IP: ${clientIp}`);

  socket.on('join-room', ({ roomId, userName }) => {
    const name = (userName || 'Anônimo').substring(0, 24);
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    rooms.get(roomId).set(socket.id, { id: socket.id, name, ip: clientIp, isSharing: false });

    logAccess(clientIp, 'JOIN_ROOM', `${name} → ${roomId}`);
    console.log(`[→] ${name} (${clientIp}) → sala ${roomId}`);

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
    console.log(`[-] ${userName} (${ip}) saiu`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  App:    http://localhost:${PORT}`);
  console.log(`🔐  Admin:  http://localhost:${PORT}/admin`);
  console.log(`📦  Banco:  telas.db`);
  console.log(`🔑  Senha:  admin123  (mude pelo painel)\n`);
});
