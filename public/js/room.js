/* ═══════════════════════════════════════════════════════════════
   TELAS — room.js  |  WebRTC + Socket.IO
═══════════════════════════════════════════════════════════════ */

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// ── Estado ────────────────────────────────────────────────────
const roomId   = window.location.pathname.split('/room/')[1];
const userName = localStorage.getItem('telas_username') || 'Anônimo';

let socket         = null;
let localStream    = null;
let screenStream   = null;
let isSharing      = false;
let micEnabled     = true;
let camEnabled     = true;
let chatOpen       = false;
let unreadCount    = 0;

const peers        = new Map(); // socketId → RTCPeerConnection
const remoteStreams = new Map(); // socketId → MediaStream

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const myVideo          = $('myVideo');
const myVideoTile      = $('myVideoTile');
const myVideoLabel     = $('myVideoLabel');
const myMutedIcon      = $('myMutedIcon');
const myNoCamOverlay   = $('myNoCamOverlay');
const myCardAvatar     = $('myCardAvatar');
const myRing           = $('myRing');
const screenVideo      = $('screenVideo');
const screenTile       = $('screenTile');
const screenLabel      = $('screenLabel');
const videoGrid        = $('videoGrid');
const emptyState       = $('emptyState');

const btnShareScreen   = $('btnShareScreen');
const shareScreenLabel = $('shareScreenLabel');
const btnToggleMic     = $('btnToggleMic');
const btnToggleCam     = $('btnToggleCam');
const ctrlMic          = $('ctrlMic');
const ctrlCam          = $('ctrlCam');
const ctrlLeave        = $('ctrlLeave');
const btnLeave         = $('btnLeave');
const btnToggleChat    = null;
const btnCloseChat     = null;
const chatPanel        = null;
const chatMessages     = null;
const chatInput        = null;
const btnSendChat      = null;
const chatBadge        = null;

const myAvatarSidebar  = $('myAvatarSidebar');
const myNameSidebar    = $('myNameSidebar');
const participantsList = $('participantsList');
const userCount        = $('userCount');
const channelBadge     = $('channelBadge');
const headerRoomName   = $('headerRoomName');
const voiceStatusRoom  = $('voiceStatusRoom');
const shareLinkInput   = $('shareLinkInput');
const btnCopyLink      = $('btnCopyLink');
const btnCopyLinkMain  = null;
const toastEl          = $('toast');

// ── Utils ─────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function initial(name) { return (name || '?')[0].toUpperCase(); }

function avatarColor(id) {
  const p = ['#5865f2','#23a559','#f0b232','#eb459e','#f23f42','#ff7043','#26a69a'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return p[Math.abs(h) % p.length];
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => toast('Link copiado!', 'success'))
    .catch(() => { /* fallback silencioso */ });
}

// ── Participantes (sidebar) ───────────────────────────────────
function renderParticipants(users) {
  participantsList.innerHTML = '';
  userCount.textContent = users.length;
  channelBadge.textContent = users.length;

  const sorted = [...users].sort((a, b) =>
    a.id === socket.id ? -1 : b.id === socket.id ? 1 : 0);

  sorted.forEach(u => {
    const isMe = u.id === socket.id;
    const div  = document.createElement('div');
    div.className = `sidebar-user${isMe ? ' me' : ''}`;
    div.dataset.userId = u.id;

    const color = avatarColor(u.id);
    div.innerHTML = `
      <div class="sidebar-user-avatar" style="background:${color}">${initial(u.name)}</div>
      <span class="sidebar-user-name">${esc(u.name)}${isMe ? ' (você)' : ''}</span>
      <div class="sidebar-user-icons ${!micEnabled && isMe ? 'muted' : ''}">
        ${u.isSharing ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="#f0b232" stroke-width="2"/></svg>' : ''}
      </div>
    `;
    participantsList.appendChild(div);
  });

  const others = users.filter(u => u.id !== socket.id);
  // Esconde meu próprio card quando não há outros usuários
  if (myVideoTile) myVideoTile.classList.toggle('hidden', others.length === 0);
}

// ── Tiles remotos ─────────────────────────────────────────────
function createRemoteTile(userId, uName) {
  if ($(`tile-${userId}`)) return;

  const card = document.createElement('div');
  card.className = 'participant-card';
  card.id = `tile-${userId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsinline = true;
  video.id = `video-${userId}`;
  video.className = 'card-video';

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  overlay.id = `overlay-${userId}`;
  const color = avatarColor(userId);
  overlay.innerHTML = `
    <div class="card-avatar" style="background:${color}">${initial(uName)}</div>
    <div class="speaking-ring" id="ring-${userId}"></div>
  `;

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  footer.innerHTML = `
    <span class="card-name" id="name-${userId}">${esc(uName)}</span>
    <span class="card-muted hidden" id="muted-${userId}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V5a3 3 0 00-5.94-.6" stroke="currentColor" stroke-width="2"/>
      </svg>
    </span>
  `;

  card.appendChild(video);
  card.appendChild(overlay);
  card.appendChild(footer);
  videoGrid.appendChild(card);
}

function removeRemoteTile(userId) {
  $(`tile-${userId}`)?.remove();
}

function setRemoteStream(userId, stream) {
  const video   = $(`video-${userId}`);
  const overlay = $(`overlay-${userId}`);
  if (!video) return;

  const hasVid = stream?.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  video.srcObject = stream || null;
  if (overlay) overlay.className = `card-overlay${hasVid ? ' hidden' : ''}`;
}

// ── Tela compartilhada ────────────────────────────────────────
function showScreen(userId, uName) {
  screenTile.classList.remove('hidden');
  // Ativa layout lado a lado via call-area
  document.querySelector('.call-area').classList.add('has-screen');
  screenLabel.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
    </svg> Tela de ${esc(uName)}`;
}

function hideScreen() {
  screenTile.classList.add('hidden');
  document.querySelector('.call-area').classList.remove('has-screen');
  screenVideo.srcObject = null;
}

// ── Chat ──────────────────────────────────────────────────────
function addChatMsg({ userId, userName: uName, message, timestamp, system = false }) {
  // Chat removido — não faz nada
}

function sendChat() {
  // Chat removido
}

// ── WebRTC ────────────────────────────────────────────────────
function getPeer(userId) {
  if (peers.has(userId)) return peers.get(userId);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(userId, pc);

  // Adiciona trilhas locais
  localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));
  if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { targetId: userId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    const stream = e.streams[0];
    if (!stream) return;
    remoteStreams.set(userId, stream);

    const isScreen = stream.getVideoTracks().some(t =>
      /screen|display|monitor|window|entire/i.test(t.label));

    if (isScreen) {
      screenVideo.srcObject = stream;
      const uName = getUserName(userId);
      showScreen(userId, uName);
    } else {
      setRemoteStream(userId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected'].includes(pc.connectionState)) dropPeer(userId);
  };

  return pc;
}

function dropPeer(userId) {
  const pc = peers.get(userId);
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.close(); peers.delete(userId); }
  remoteStreams.delete(userId);
}

async function callUser(userId) {
  const pc = getPeer(userId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  socket.emit('offer', { targetId: userId, offer: pc.localDescription });
}

async function handleOffer(fromId, offer) {
  const pc = getPeer(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { targetId: fromId, answer: pc.localDescription });
}

async function handleAnswer(fromId, answer) {
  await peers.get(fromId)?.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleIce(fromId, candidate) {
  try { await peers.get(fromId)?.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

async function renegotiate(userId) {
  const pc = peers.get(userId);
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { targetId: userId, offer: pc.localDescription });
}

// ── Mídia local ───────────────────────────────────────────────
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    myVideo.srcObject = localStream;
    myNoCamOverlay.classList.add('hidden');
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      camEnabled = false;
      updateCamUI();
    } catch {
      localStream = new MediaStream();
      micEnabled = false;
      camEnabled = false;
      updateMicUI();
      updateCamUI();
    }
    myVideo.srcObject = localStream;
    showMyOverlay();
  }
}

function showMyOverlay() {
  myNoCamOverlay.classList.remove('hidden');
  const color = socket ? avatarColor(socket.id) : '#5865f2';
  myCardAvatar.style.background = color;
  myCardAvatar.textContent = initial(userName);
}

function toggleMic() {
  micEnabled = !micEnabled;
  localStream?.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  updateMicUI();
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream?.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  updateCamUI();
  if (camEnabled) {
    myNoCamOverlay.classList.add('hidden');
  } else {
    showMyOverlay();
  }
}

function updateMicUI() {
  const muted = !micEnabled;
  ctrlMic?.classList.toggle('muted', muted);
  btnToggleMic?.classList.toggle('muted', muted);
  myMutedIcon?.classList.toggle('hidden', !muted);
}

function updateCamUI() {
  ctrlCam?.classList.toggle('muted', !camEnabled);
  btnToggleCam?.classList.toggle('muted', !camEnabled);
}

// ── Screen share ──────────────────────────────────────────────
async function startShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, cursor: 'always' },
      audio: true
    });

    screenVideo.srcObject = screenStream;
    showScreen(socket.id, userName);

    screenStream.getTracks().forEach(track => {
      peers.forEach((_, uid) => {
        getPeer(uid).addTrack(track, screenStream);
        renegotiate(uid);
      });
    });

    screenStream.getVideoTracks()[0].onended = stopShare;

    isSharing = true;
    btnShareScreen.classList.add('sharing');
    shareScreenLabel.textContent = 'Parar';
    socket.emit('screen-share-started', { roomId });
    toast('Compartilhamento iniciado', 'success');
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Não foi possível compartilhar', 'error');
  }
}

function stopShare() {
  screenStream?.getTracks().forEach(t => {
    t.stop();
    peers.forEach((pc) => {
      pc.getSenders().filter(s => s.track === t).forEach(s => pc.removeTrack(s));
    });
  });
  peers.forEach((_, uid) => renegotiate(uid));
  screenStream = null;
  hideScreen();
  isSharing = false;
  btnShareScreen.classList.remove('sharing');
  shareScreenLabel.textContent = 'Tela';
  socket.emit('screen-share-stopped', { roomId });
  toast('Compartilhamento encerrado', 'info');
}

function getUserName(userId) {
  return $(`name-${userId}`)?.textContent ||
    participantsList.querySelector(`[data-user-id="${userId}"] .sidebar-user-name`)?.textContent?.replace(' (você)','') ||
    'Usuário';
}

// ── Socket.IO ─────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, userName });

    myVideoLabel.textContent = 'Você';
    myNameSidebar.textContent = userName;
    myAvatarSidebar.textContent = initial(userName);
    myAvatarSidebar.style.background = avatarColor(socket.id);
    headerRoomName.textContent = 'geral';
    voiceStatusRoom.textContent = `sala #${roomId}`;
    document.title = `TELAS — #${roomId}`;

    const link = `${location.origin}/room/${roomId}`;
    if (shareLinkInput) shareLinkInput.value = link;

    // Esconde meu card até que outros entrem
    if (myVideoTile) myVideoTile.classList.add('hidden');

    showMyOverlay();
  });

  socket.on('room-users', ({ users }) => {
    renderParticipants(users);
    users.forEach(u => {
      if (u.id !== socket.id) {
        createRemoteTile(u.id, u.name);
        callUser(u.id);
      }
    });
  });

  socket.on('user-joined', ({ userId, userName: uName, users }) => {
    renderParticipants(users);
    createRemoteTile(userId, uName);
    addChatMsg({ userId: null, userName: null, message: `${uName} entrou na sala`, system: true, timestamp: Date.now() });
    toast(`${uName} entrou`, 'success');
  });

  socket.on('user-left', ({ userId, userName: uName, users }) => {
    dropPeer(userId);
    removeRemoteTile(userId);
    renderParticipants(users);
    if (remoteStreams.get(userId) === screenVideo.srcObject) hideScreen();
    addChatMsg({ userId: null, userName: null, message: `${uName} saiu da sala`, system: true, timestamp: Date.now() });
    toast(`${uName} saiu`, 'info');
  });

  socket.on('offer', ({ fromId, offer })             => handleOffer(fromId, offer));
  socket.on('answer', ({ fromId, answer })            => handleAnswer(fromId, answer));
  socket.on('ice-candidate', ({ fromId, candidate }) => handleIce(fromId, candidate));

  socket.on('screen-share-started', ({ userId, userName: uName }) => {
    addChatMsg({ userId: null, userName: null, message: `${uName} está compartilhando a tela 🖥️`, system: true, timestamp: Date.now() });
  });

  socket.on('screen-share-stopped', ({ userId }) => {
    if ($(`video-${userId}`)?.srcObject === screenVideo.srcObject) hideScreen();
  });

  socket.on('chat-message', data => addChatMsg(data));

  socket.on('disconnect', () => toast('Conexão perdida…', 'error'));
  socket.on('reconnect',  () => { toast('Reconectado!', 'success'); socket.emit('join-room', { roomId, userName }); });
}

// ── Event listeners ───────────────────────────────────────────
btnShareScreen.addEventListener('click', () => isSharing ? stopShare() : startShare());

// Mic — dois botões (sidebar e barra de controles)
ctrlMic?.addEventListener('click', toggleMic);
btnToggleMic?.addEventListener('click', toggleMic);

// Cam — dois botões
ctrlCam?.addEventListener('click', toggleCam);
btnToggleCam?.addEventListener('click', toggleCam);

// Sair — dois botões
function leaveRoom() {
  if (!confirm('Sair da sala?')) return;
  localStream?.getTracks().forEach(t => t.stop());
  screenStream?.getTracks().forEach(t => t.stop());
  peers.forEach(pc => pc.close());
  socket?.disconnect();
  location.href = '/';
}
ctrlLeave?.addEventListener('click', leaveRoom);
btnLeave?.addEventListener('click', leaveRoom);

// Chat removido

// Copiar link
const roomLink = `${location.origin}/room/${roomId}`;
btnCopyLink?.addEventListener('click', () => copyText(roomLink));
btnCopyLinkMain?.addEventListener('click', () => copyText(roomLink));

// ── Init ──────────────────────────────────────────────────────
async function init() {
  if (!localStorage.getItem('telas_username')) { location.href = '/'; return; }
  await initMedia();
  initSocket();
}

init();
