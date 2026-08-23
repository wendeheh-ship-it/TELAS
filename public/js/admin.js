/* ═══════════════════════════════════════════════════════════════════════════════
   TELAS — admin.js
═══════════════════════════════════════════════════════════════════════════════ */

let adminToken = sessionStorage.getItem('adminToken') || null;
let myIp       = '—';

// ─── Toast ────────────────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
function toast(msg, type = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken || '' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    // Carrega dados ao mudar de aba
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'whitelist') loadWhitelist();
    if (tab === 'rooms')     loadRooms();
    if (tab === 'logs')      loadLogs();
    if (tab === 'settings')  loadSettings();
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────
const loginScreen = document.getElementById('loginScreen');
const adminPanel  = document.getElementById('adminPanel');

async function checkMyIp() {
  try {
    const data = await fetch('/api/myip').then(r => r.json());
    myIp = data.ip;
    document.getElementById('myIpValue').textContent    = myIp;
    document.getElementById('myIpSidebar').textContent  = myIp;
    document.getElementById('myIpSettings').textContent = myIp;
  } catch { /* ignora */ }
}
checkMyIp();

async function doLogin() {
  const pwd = document.getElementById('loginPassword').value;
  if (!pwd) return;
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  btn.textContent = 'Verificando...';

  try {
    const data = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    }).then(r => r.json());

    if (data.ok) {
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      loginScreen.classList.add('hidden');
      adminPanel.classList.remove('hidden');
      loadDashboard();
    } else {
      document.getElementById('loginError').classList.remove('hidden');
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginPassword').focus();
    }
  } catch {
    toast('Erro de conexão', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Entrar`;
  }
}

document.getElementById('btnLogin').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// Se já tinha token salvo, entra direto
if (adminToken) {
  loginScreen.classList.add('hidden');
  adminPanel.classList.remove('hidden');
  loadDashboard();
}

// Logout
document.getElementById('btnLogout').addEventListener('click', () => {
  sessionStorage.removeItem('adminToken');
  adminToken = null;
  adminPanel.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [ipsData, roomsData] = await Promise.all([
      api('GET', '/api/admin/ips'),
      api('GET', '/api/admin/rooms')
    ]);

    document.getElementById('statIpCount').textContent   = ipsData.total ?? 0;
    document.getElementById('statRoomCount').textContent = roomsData.rooms?.length ?? 0;
    document.getElementById('statUserCount').textContent = roomsData.totalUsers ?? 0;

    const mode = ipsData.mode || 'off';
    const modeEl = document.getElementById('statMode');
    const modeCard = document.getElementById('statModeCard');
    if (mode === 'on') {
      modeEl.textContent = 'PROTEGIDO';
      modeCard.className = 'stat-icon red';
    } else {
      modeEl.textContent = 'LIVRE';
      modeCard.className = 'stat-icon green';
    }

    // Salas no dashboard
    const dashRooms = document.getElementById('dashRooms');
    if (!roomsData.rooms?.length) {
      dashRooms.innerHTML = '<div class="empty-msg">Nenhuma sala ativa no momento.</div>';
    } else {
      dashRooms.innerHTML = roomsData.rooms.map(r => `
        <div class="room-list-item">
          <div class="room-dot"></div>
          <div class="room-list-id">#${r.roomId}</div>
          <div class="room-list-users">${r.users.map(u => u.name).join(', ')}</div>
          <div style="font-size:12px;color:var(--text2)">${r.users.length} usuário${r.users.length !== 1 ? 's' : ''}</div>
        </div>
      `).join('');
    }

    // Atualiza badges da nav
    document.getElementById('navIpCount').textContent   = ipsData.total ?? 0;
    document.getElementById('navRoomCount').textContent = roomsData.rooms?.length ?? 0;

  } catch (e) { toast('Erro ao carregar dashboard', 'error'); }
}

document.getElementById('btnRefreshDash').addEventListener('click', loadDashboard);

// ─── Whitelist ────────────────────────────────────────────────────────────────
let currentMode = 'off';

async function loadWhitelist() {
  try {
    const data = await api('GET', '/api/admin/ips');
    currentMode = data.mode || 'off';
    renderIpList(data.ips || []);
    updateModeUI(currentMode);
    document.getElementById('navIpCount').textContent = data.total ?? 0;
  } catch { toast('Erro ao carregar whitelist', 'error'); }
}

function renderIpList(ips) {
  const list = document.getElementById('ipList');
  document.getElementById('ipListCount').textContent = ips.length;

  if (!ips.length) {
    list.innerHTML = '<div class="empty-msg">Nenhum IP cadastrado. Adicione abaixo.</div>';
    return;
  }

  list.innerHTML = ips.map(entry => `
    <div class="ip-row" id="row-${CSS.escape(entry.ip)}">
      <div class="ip-addr">${escHtml(entry.ip)}</div>
      <div class="ip-label-txt">${escHtml(entry.label || '—')}</div>
      <div class="ip-date">${entry.added_at || ''}</div>
      <button class="btn-icon-red" onclick="removeIp('${escHtml(entry.ip)}')" title="Remover">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `).join('');
}

function updateModeUI(mode) {
  const toggle = document.getElementById('toggleWhitelistMode');
  const label  = document.getElementById('modeLabel');
  const banner = document.getElementById('modeBanner');
  const bannerText = document.getElementById('modeBannerText');

  toggle.checked = mode === 'on';
  if (mode === 'on') {
    label.textContent = 'LIGADA';
    label.className = 'mode-label on';
    banner.className = 'info-banner danger';
    bannerText.textContent = 'Proteção ATIVA — só IPs da lista abaixo conseguem acessar o app.';
  } else {
    label.textContent = 'DESLIGADA';
    label.className = 'mode-label off';
    banner.className = 'info-banner';
    bannerText.textContent = 'Modo livre — todos podem acessar o app. Ligue a proteção para filtrar por IP.';
  }
}

// Toggle modo whitelist
document.getElementById('toggleWhitelistMode').addEventListener('change', async (e) => {
  const mode = e.target.checked ? 'on' : 'off';
  try {
    const data = await api('POST', '/api/admin/mode', { mode });
    if (data.ok) {
      currentMode = mode;
      updateModeUI(mode);
      toast(mode === 'on' ? '🔒 Proteção ativada!' : '🔓 Proteção desativada', mode === 'on' ? 'warn' : 'success');
    }
  } catch { toast('Erro ao alterar modo', 'error'); }
});

// Adicionar IP
document.getElementById('btnAddIp').addEventListener('click', addIp);
document.getElementById('newIpInput').addEventListener('keydown', e => { if (e.key === 'Enter') addIp(); });

async function addIp() {
  const ip    = document.getElementById('newIpInput').value.trim();
  const label = document.getElementById('newIpLabel').value.trim();
  if (!ip) { toast('Digite um IP válido', 'error'); return; }

  try {
    const data = await api('POST', '/api/admin/ips', { ip, label });
    if (data.ok) {
      document.getElementById('newIpInput').value = '';
      document.getElementById('newIpLabel').value = '';
      toast(`✅ IP ${ip} adicionado!`, 'success');
      loadWhitelist();
    } else {
      toast(data.error || 'Erro ao adicionar IP', 'error');
    }
  } catch { toast('Erro de conexão', 'error'); }
}

// Adicionar meu próprio IP
document.getElementById('btnAddMyIp').addEventListener('click', () => {
  document.getElementById('newIpInput').value = myIp;
  document.getElementById('newIpLabel').value = 'Meu PC';
});

// Remover IP
async function removeIp(ip) {
  if (!confirm(`Remover o IP ${ip} da whitelist?`)) return;
  try {
    const data = await api('DELETE', `/api/admin/ips/${encodeURIComponent(ip)}`);
    if (data.ok) {
      toast(`🗑 IP ${ip} removido`, 'info');
      loadWhitelist();
    }
  } catch { toast('Erro ao remover IP', 'error'); }
}

// Limpar tudo
document.getElementById('btnClearIps').addEventListener('click', async () => {
  if (!confirm('Limpar TODOS os IPs da whitelist? O modo proteção continuará ativo.')) return;
  try {
    const data = await api('DELETE', '/api/admin/ips');
    if (data.ok) { toast('Lista limpa', 'info'); loadWhitelist(); }
  } catch { toast('Erro', 'error'); }
});

// ─── Salas Online ─────────────────────────────────────────────────────────────
async function loadRooms() {
  try {
    const data = await api('GET', '/api/admin/rooms');
    const container = document.getElementById('roomsList');
    document.getElementById('navRoomCount').textContent = data.rooms?.length ?? 0;

    if (!data.rooms?.length) {
      container.innerHTML = '<div class="empty-msg">Nenhuma sala ativa no momento.</div>';
      container.style.display = 'block';
      return;
    }

    container.style.display = 'grid';
    container.innerHTML = data.rooms.map(room => `
      <div class="room-card">
        <div class="room-card-header">
          <div class="room-card-id">#${room.roomId}</div>
          <div class="room-card-count">${room.users.length} usuário${room.users.length !== 1 ? 's' : ''}</div>
        </div>
        ${room.users.map(u => `
          <div class="room-user-row">
            <div class="room-user-avatar" style="background:${strColor(u.name)}">${u.name[0]?.toUpperCase()}</div>
            <div class="room-user-name">${escHtml(u.name)}</div>
            <div class="room-user-ip">${escHtml(u.ip)}</div>
            ${u.isSharing ? '<div class="room-user-sharing">🖥️</div>' : ''}
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch { toast('Erro ao carregar salas', 'error'); }
}

document.getElementById('btnRefreshRooms').addEventListener('click', loadRooms);

// ─── Logs ─────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const data = await api('GET', '/api/admin/logs');
    const tbody = document.getElementById('logsBody');
    if (!data.logs?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">Nenhum log registrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.logs.map(log => `
      <tr>
        <td style="color:var(--text2)">${log.id}</td>
        <td class="ip-col">${escHtml(log.ip)}</td>
        <td><span class="log-action ${log.action}">${log.action}</span></td>
        <td style="color:var(--text2)">${escHtml(log.detail || '—')}</td>
        <td class="log-time">${log.created_at}</td>
      </tr>
    `).join('');
  } catch { toast('Erro ao carregar logs', 'error'); }
}

document.getElementById('btnRefreshLogs').addEventListener('click', loadLogs);
document.getElementById('btnClearLogs').addEventListener('click', async () => {
  if (!confirm('Limpar todos os logs?')) return;
  const data = await api('DELETE', '/api/admin/logs');
  if (data.ok) { toast('Logs limpos', 'info'); loadLogs(); }
});

// ─── Configurações ────────────────────────────────────────────────────────────
function loadSettings() {
  document.getElementById('appLink').textContent   = `${location.origin}/`;
  document.getElementById('adminLink').textContent = `${location.origin}/admin`;
  document.getElementById('myIpSettings').textContent = myIp;
}

document.getElementById('btnChangePass').addEventListener('click', async () => {
  const np  = document.getElementById('newPassInput').value;
  const cp  = document.getElementById('confirmPassInput').value;
  const fb  = document.getElementById('passFeedback');

  fb.classList.remove('hidden', 'success', 'error');

  if (!np || np.length < 4) {
    fb.className = 'feedback error'; fb.textContent = 'Senha deve ter ao menos 4 caracteres.'; return;
  }
  if (np !== cp) {
    fb.className = 'feedback error'; fb.textContent = 'As senhas não coincidem.'; return;
  }

  try {
    const data = await api('POST', '/api/admin/password', { newPassword: np });
    if (data.ok) {
      adminToken = np;
      sessionStorage.setItem('adminToken', np);
      fb.className = 'feedback success'; fb.textContent = '✅ Senha alterada com sucesso!';
      document.getElementById('newPassInput').value    = '';
      document.getElementById('confirmPassInput').value = '';
    } else {
      fb.className = 'feedback error'; fb.textContent = data.error || 'Erro ao salvar senha.';
    }
  } catch { fb.className = 'feedback error'; fb.textContent = 'Erro de conexão.'; }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function strColor(str) {
  const palette = ['#5865F2','#57F287','#FEE75C','#EB459E','#ED4245','#FF7043','#26A69A'];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

// Auto-refresh a cada 30s quando painel está aberto
setInterval(() => {
  if (!adminToken) return;
  const active = document.querySelector('.tab-content.active')?.id;
  if (active === 'tab-dashboard') loadDashboard();
  if (active === 'tab-rooms')     loadRooms();
}, 30000);
