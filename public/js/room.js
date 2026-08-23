/* ═══════════════════════════════════════════════════════════════════════════════
   TELAS — room.js
   Lógica WebRTC: sinalização via Socket.IO, câmera, microfone, tela, chat
═══════════════════════════════════════════════════════════════════════════════ */

// ─── Configuração WebRTC ──────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

// ─── Estado global ────────────────────────────────────────────────────────────
const roomId   = window.location.pathname.split('/room/')[1];
const userName = localStorage.getItem('telas_username') || 'Anônimo';

let socket          = null;
let localStream     = null;   // câmera + microfone
let screenStream    = null;   // tela compartilhada
let isSharing       = false;
let micEnabled      = true;
let camEnabled      = true;
let chatOpen        = false;
let unreadMessages  = 0;

// peers: Map<socketId, RTCPeerConnection>
const peers = new Map();
// remoteStreams: Map<socketId, MediaStream>
const remoteStreams = new Map();

// ─── Elementos DOM ────────────────────────────────────────────────────────────
const myVideo           = document.getElementById('myVideo');
const myVideoTile       = document.getElementById('myVideoTile');
const myVideoLabel      = document.getElementById('myVideoLabel');
const myMutedIcon       = document.getElementById('myMutedIcon');
const screenVideo       = document.getElementById('screenVideo');
const screenTile        = document.getElementById('screenTile');
const screenLabel       = document.getElementById('screenLabel');
const videoGrid         = document.getElementById('videoGrid');
const emptyState        = document.getElementById('emptyState');

const btnShareScreen    = document.getElementById('btnShareScreen');
const shareScreenLabel  = document.getElementById('shareScreenLabel');
const btnToggleMic      = document.getElementById('btnToggleMic');
const btnToggleCam      = document.getElementById('btnToggleCam');
const btnLeave          = document.getElementById('btnLeave');
const btnToggleChat     = document.getElementById('btnToggleChat');
const btnCloseChat      = document.getElementById('btnCloseChat');
const chatPanel         = document.getElementById('chatPanel');
const chatMessages      = document.getElementById('chatMessages');
const chatInput         = document.getElementById('chatInput');
const btnSendChat       = document.getElementById('btnSendChat');
const chatBadge         = document.getElementById('chatBadge');

const roomIdDisplay     = document.getElementById('roomIdDisplay');
const headerRoomName    = document.getElementById('headerRoomName');
const participantsList  = document.getElementById('participantsList');
const userCount         = document.getElementById('userCount');
const myAvatarSidebar   = document.getElementById('myAvatarSidebar');
const myNameSidebar     = document.getElementById('myNameSidebar');
const btnCopyLink       = document.getElementById('btnCopyLink');
const shareLinkInput    = document.getElementById('shareLinkInput');
const btnCopyLinkMain   = document.getElementById('btnCopyLinkMain');
const toastEl           = document.getElementById('toast');

// ─── Utilitários ──────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function getInitial(name) {
  return (name || '?')[0].toUpperCase();
}

function getAvatarColor(id) {
  const colors = ['#5865F2','#57F287','#FEE75C','#EB459E','#ED4245','#FF7043','#26A69A'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ─── UI: Participantes ────────────────────────────────────────────────────────
function renderParticipants(users) {
  participantsList.innerHTML = '';
  const count = users.length;
  if (userCount) userCount.textContent = count;
  const pcEl = document.getElementById('participantCount');
  if (pcEl) pcEl.textContent = count;

  const sorted = [...users].sort((a, b) => {
    if (a.id === socket.id) return -1;
    if (b.id === socket.id) return 1;
    return 0;
  });

  sorted.forEach(user => {
    const isMe = user.id === socket.id;
    const item = document.createElement('div');
    // Suporta ambos os layouts (antigo e Discord)
    item.className = `dc-voice-user${isMe ? ' me' : ''} participant-item${isMe ? ' me' : ''}`;
    item.dataset.userId = user.id;

    const color = getAvatarColor(user.id);
    item.innerHTML = `
      <div class="dc-voice-user-avatar" style="background:${color}">${getInitial(user.name)}</div>
      <span class="dc-voice-user-name participant-name">${escapeHtml(user.name)}${isMe ? ' (você)' : ''}</span>
      <div class="dc-voice-user-icons">
        ${user.isSharing ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="#faa81a" stroke-width="2"/></svg>' : ''}
        <div class="status-dot ${user.isSharing ? 'sharing' : 'online'}"></div>
      </div>
    `;
    participantsList.appendChild(item);
  });

  // Esconde/mostra empty state
  const otherUsers = users.filter(u => u.id !== socket.id);
  emptyState.classList.toggle('hidden', otherUsers.length > 0);
}

// ─── UI: Tiles de vídeo remoto ────────────────────────────────────────────────
function createRemoteTile(userId, userName) {
  const existing = document.getElementById(`tile-${userId}`);
  if (existing) return existing;

  const tile = document.createElement('div');
  tile.className = 'dc-video-tile';
  tile.id = `tile-${userId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsinline = true;
  video.id = `video-${userId}`;

  const label = document.createElement('div');
  label.className = 'dc-tile-label';
  label.id = `label-${userId}`;
  label.textContent = userName;

  // Overlay sem câmera
  const noCam = document.createElement('div');
  noCam.className = 'no-cam-overlay';
  noCam.id = `nocam-${userId}`;
  const color = getAvatarColor(userId);
  noCam.innerHTML = `
    <div class="avatar-large" style="background:${color}">${getInitial(userName)}</div>
    <span>${escapeHtml(userName)}</span>
  `;

  tile.appendChild(video);
  tile.appendChild(noCam);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
  return tile;
}

function removeRemoteTile(userId) {
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) tile.remove();
}

function updateTileStream(userId, stream) {
  const video = document.getElementById(`video-${userId}`);
  const noCam = document.getElementById(`nocam-${userId}`);
  if (!video) return;

  const hasVideo = stream && stream.getVideoTracks().length > 0 &&
                   stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

  video.srcObject = stream || null;
  if (noCam) noCam.style.display = hasVideo ? 'none' : 'flex';
}

// ─── UI: Tela compartilhada ───────────────────────────────────────────────────
function showScreenTile(userId, uName) {
  screenTile.classList.remove('hidden');
  videoGrid.classList.add('has-screen');
  screenLabel.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
    </svg>
    Tela de ${escapeHtml(uName)}
  `;
}

function hideScreenTile() {
  screenTile.classList.add('hidden');
  videoGrid.classList.remove('has-screen');
  screenVideo.srcObject = null;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function appendChatMessage({ userId, userName: uName, message, timestamp, system = false }) {
  const isMe = userId === socket.id;

  const div = document.createElement('div');
  div.className = `dc-chat-msg${system ? ' system' : isMe ? ' mine' : ''}`;

  if (system) {
    div.innerHTML = `<div class="dc-msg-text">${escapeHtml(message)}</div>`;
  } else {
    div.innerHTML = `
      <div class="dc-msg-header">
        <span class="dc-msg-author">${escapeHtml(uName)}</span>
        <span class="dc-msg-time">${formatTime(timestamp)}</span>
      </div>
      <div class="dc-msg-text">${escapeHtml(message)}</div>
    `;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Badge de não lido
  if (!chatOpen && !system) {
    unreadMessages++;
    chatBadge.textContent = unreadMessages > 9 ? '9+' : unreadMessages;
    chatBadge.classList.remove('hidden');
  }
}

function sendChatMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { roomId, message: msg });
  chatInput.value = '';
}

// ─── WebRTC: criar peer connection ────────────────────────────────────────────
function createPeerConnection(userId) {
  if (peers.has(userId)) return peers.get(userId);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(userId, pc);

  // Adiciona trilhas locais
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  // Adiciona tela se estiver compartilhando
  if (screenStream) {
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
  }

  // ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { targetId: userId, candidate: e.candidate });
    }
  };

  // Recebe stream remoto
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;

    remoteStreams.set(userId, stream);

    // Verifica se é tela (mais de uma track de vídeo ou label contém 'screen')
    const videoTracks = stream.getVideoTracks();
    const isScreen = videoTracks.some(t =>
      t.label.toLowerCase().includes('screen') ||
      t.label.toLowerCase().includes('display') ||
      t.label.toLowerCase().includes('monitor') ||
      t.label.toLowerCase().includes('window') ||
      t.label.toLowerCase().includes('entire')
    );

    if (isScreen) {
      screenVideo.srcObject = stream;
      const uName = getUserName(userId);
      showScreenTile(userId, uName);
    } else {
      updateTileStream(userId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] ${userId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      closePeerConnection(userId);
    }
  };

  return pc;
}

function closePeerConnection(userId) {
  const pc = peers.get(userId);
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    peers.delete(userId);
  }
  remoteStreams.delete(userId);
}

// ─── WebRTC: negociação ───────────────────────────────────────────────────────
async function callUser(userId) {
  const pc = createPeerConnection(userId);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { targetId: userId, offer: pc.localDescription });
  } catch (err) {
    console.error('[WebRTC] Erro ao criar offer:', err);
  }
}

async function handleOffer(fromId, offer) {
  const pc = createPeerConnection(fromId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { targetId: fromId, answer: pc.localDescription });
  } catch (err) {
    console.error('[WebRTC] Erro ao processar offer:', err);
  }
}

async function handleAnswer(fromId, answer) {
  const pc = peers.get(fromId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('[WebRTC] Erro ao processar answer:', err);
  }
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peers.get(fromId);
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    // Ignora erros de ICE em duplicata
  }
}

// Renegociar (quando adicionamos trilha de tela)
async function renegotiateWithPeer(userId) {
  const pc = peers.get(userId);
  if (!pc) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { targetId: userId, offer: pc.localDescription });
  } catch (err) {
    console.error('[WebRTC] Erro ao renegociar:', err);
  }
}

// ─── Mídia: câmera e microfone ────────────────────────────────────────────────
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    myVideo.srcObject = localStream;
    const noCam = document.getElementById('nocam-me');
    if (noCam) noCam.style.display = 'none';
  } catch (err) {
    console.warn('[Mídia] Não foi possível acessar câmera/mic:', err.message);
    // Tenta só áudio
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      camEnabled = false;
      updateCamButton();
    } catch {
      localStream = new MediaStream();
      micEnabled = false;
      camEnabled = false;
      updateMicButton();
      updateCamButton();
    }
    myVideo.srcObject = localStream;
    showNoCamOverlay('myVideoTile', userName);
  }
}

function showNoCamOverlay(tileId, name) {
  const tile = document.getElementById(tileId);
  if (!tile) return;
  let overlay = tile.querySelector('.no-cam-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'no-cam-overlay';
    overlay.id = 'nocam-me';
    tile.insertBefore(overlay, tile.firstChild);
  }
  const color = getAvatarColor(socket ? socket.id : 'me');
  overlay.innerHTML = `
    <div class="avatar-large" style="background:${color}">${getInitial(name)}</div>
    <span>${escapeHtml(name)}</span>
  `;
  overlay.style.display = 'flex';
}

function toggleMic() {
  micEnabled = !micEnabled;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  }
  updateMicButton();
}

function toggleCam() {
  camEnabled = !camEnabled;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  }
  updateCamButton();
  // Mostra/esconde overlay sem câmera no tile próprio
  const overlay = document.getElementById('nocam-me');
  if (overlay) overlay.style.display = camEnabled ? 'none' : 'flex';
  else if (!camEnabled) showNoCamOverlay('myVideoTile', userName);
}

function updateMicButton() {
  btnToggleMic.classList.toggle('muted', !micEnabled);
  btnToggleMic.title = micEnabled ? 'Silenciar microfone' : 'Ativar microfone';
  myMutedIcon.classList.toggle('hidden', micEnabled);
}

function updateCamButton() {
  btnToggleCam.classList.toggle('muted', !camEnabled);
  btnToggleCam.title = camEnabled ? 'Desligar câmera' : 'Ligar câmera';
}

// ─── Compartilhamento de tela ─────────────────────────────────────────────────
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' },
      audio: true
    });

    // Mostra na tela local
    screenVideo.srcObject = screenStream;
    showScreenTile(socket.id, userName);

    // Adiciona trilhas em todos os peers
    screenStream.getTracks().forEach(track => {
      peers.forEach((pc, userId) => {
        pc.addTrack(track, screenStream);
        renegotiateWithPeer(userId);
      });
    });

    // Quando o usuário para pelo botão do navegador
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    isSharing = true;
    btnShareScreen.classList.add('active');
    shareScreenLabel.textContent = 'Parar Compartilhamento';
    socket.emit('screen-share-started', { roomId });
    showToast('Compartilhamento de tela iniciado', 'success');

  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error('[Tela] Erro ao compartilhar:', err);
      showToast('Não foi possível compartilhar a tela', 'error');
    }
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());

    // Remove trilhas dos peers
    peers.forEach((pc, userId) => {
      const senders = pc.getSenders();
      senders.forEach(sender => {
        if (screenStream.getTracks().includes(sender.track)) {
          pc.removeTrack(sender);
        }
      });
      renegotiateWithPeer(userId);
    });

    screenStream = null;
  }

  hideScreenTile();
  isSharing = false;
  btnShareScreen.classList.remove('active');
  shareScreenLabel.textContent = 'Compartilhar Tela';
  socket.emit('screen-share-stopped', { roomId });
  showToast('Compartilhamento encerrado', 'info');
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  // Conexão estabelecida — entrar na sala
  socket.on('connect', () => {
    console.log('[Socket] Conectado:', socket.id);
    socket.emit('join-room', { roomId, userName });

    // Atualiza UI com dados próprios
    myVideoLabel.textContent = userName + ' (você)';
    myNameSidebar.textContent = userName;
    myAvatarSidebar.textContent = getInitial(userName);
    myAvatarSidebar.style.background = getAvatarColor(socket.id);
    roomIdDisplay && (roomIdDisplay.textContent = roomId);
    headerRoomName.textContent = `geral`;
    document.title = `TELAS — #${roomId}`;

    // Preenche info de voz estilo Discord
    const voiceRoomId = document.getElementById('voiceRoomId');
    if (voiceRoomId) voiceRoomId.textContent = roomId;

    const fullLink = `${window.location.origin}/room/${roomId}`;
    if (shareLinkInput) shareLinkInput.value = fullLink;
  });

  // Lista de usuários ao entrar
  socket.on('room-users', ({ users }) => {
    renderParticipants(users);
    // Chama cada usuário já na sala
    users.forEach(user => {
      if (user.id !== socket.id) {
        createRemoteTile(user.id, user.name);
        callUser(user.id);
      }
    });
  });

  // Novo usuário entrou
  socket.on('user-joined', ({ userId, userName: uName, users }) => {
    console.log(`[+] ${uName} entrou`);
    renderParticipants(users);
    createRemoteTile(userId, uName);
    appendChatMessage({ userId: null, userName: null, message: `${uName} entrou na sala`, system: true, timestamp: Date.now() });
    showToast(`${uName} entrou na sala`, 'success');
    // O novo usuário irá fazer o offer para nós via room-users
  });

  // Usuário saiu
  socket.on('user-left', ({ userId, userName: uName, users }) => {
    console.log(`[-] ${uName} saiu`);
    closePeerConnection(userId);
    removeRemoteTile(userId);
    renderParticipants(users);

    // Se estava compartilhando tela, esconde
    if (screenVideo.srcObject && remoteStreams.get(userId) === screenVideo.srcObject) {
      hideScreenTile();
    }

    appendChatMessage({ userId: null, userName: null, message: `${uName} saiu da sala`, system: true, timestamp: Date.now() });
    showToast(`${uName} saiu da sala`, 'info');
  });

  // Offer recebido
  socket.on('offer', ({ fromId, fromName, offer }) => {
    handleOffer(fromId, offer);
  });

  // Answer recebido
  socket.on('answer', ({ fromId, answer }) => {
    handleAnswer(fromId, answer);
  });

  // ICE candidate recebido
  socket.on('ice-candidate', ({ fromId, candidate }) => {
    handleIceCandidate(fromId, candidate);
  });

  // Alguém começou a compartilhar tela
  socket.on('screen-share-started', ({ userId, userName: uName }) => {
    // A tela vai aparecer via ontrack
    appendChatMessage({ userId: null, userName: null, message: `${uName} está compartilhando a tela 🖥️`, system: true, timestamp: Date.now() });
    // Atualiza participante na lista
    const item = participantsList.querySelector(`[data-user-id="${userId}"]`);
    if (item) {
      const dot = item.querySelector('.status-dot');
      if (dot) { dot.className = 'status-dot sharing'; }
    }
  });

  // Alguém parou de compartilhar tela
  socket.on('screen-share-stopped', ({ userId }) => {
    hideScreenTile();
    const item = participantsList.querySelector(`[data-user-id="${userId}"]`);
    if (item) {
      const dot = item.querySelector('.status-dot');
      if (dot) { dot.className = 'status-dot online'; }
    }
  });

  // Chat
  socket.on('chat-message', (data) => {
    appendChatMessage(data);
  });

  // Desconexão
  socket.on('disconnect', () => {
    console.warn('[Socket] Desconectado');
    showToast('Conexão perdida. Reconectando...', 'error');
  });

  socket.on('reconnect', () => {
    showToast('Reconectado!', 'success');
    socket.emit('join-room', { roomId, userName });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getUserName(userId) {
  const item = participantsList.querySelector(`[data-user-id="${userId}"] .participant-name`);
  return item ? item.textContent.replace(' (você)', '') : 'Usuário';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Link copiado!', 'success');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Link copiado!', 'success');
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────
btnShareScreen.addEventListener('click', () => {
  if (isSharing) stopScreenShare();
  else startScreenShare();
});

btnToggleMic.addEventListener('click', toggleMic);
btnToggleCam.addEventListener('click', toggleCam);

btnLeave.addEventListener('click', () => {
  if (confirm('Tem certeza que quer sair da sala?')) {
    // Limpa streams
    localStream?.getTracks().forEach(t => t.stop());
    screenStream?.getTracks().forEach(t => t.stop());
    peers.forEach(pc => pc.close());
    socket?.disconnect();
    window.location.href = '/';
  }
});

// Chat
btnToggleChat.addEventListener('click', () => {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chatPanel');
  panel.classList.toggle('open', chatOpen);
  if (chatOpen) {
    unreadMessages = 0;
    chatBadge.classList.add('hidden');
    chatInput.focus();
  }
});

const btnCloseChatEl = document.getElementById('btnCloseChat');
if (btnCloseChatEl) btnCloseChatEl.addEventListener('click', () => {
  chatOpen = false;
  document.getElementById('chatPanel').classList.remove('open');
});

btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Copiar link
const roomLink = `${window.location.origin}/room/${roomId}`;
btnCopyLink?.addEventListener('click', () => copyToClipboard(roomLink));
btnCopyLinkMain?.addEventListener('click', () => copyToClipboard(roomLink));

// ─── Inicialização ────────────────────────────────────────────────────────────
async function init() {
  // Redireciona se não tiver nome
  if (!localStorage.getItem('telas_username')) {
    window.location.href = '/';
    return;
  }

  await initLocalMedia();
  initSocket();
}

init();
