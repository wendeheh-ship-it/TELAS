/* TELAS — room.js | WebRTC + Socket.IO */

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// ── Estado ────────────────────────────────────────
const roomId   = window.location.pathname.split('/room/')[1];
const userName = localStorage.getItem('telas_username') || 'Anônimo';

let socket       = null;
let localStream  = null;
let screenStream = null;
let isSharing    = false;
let micEnabled   = true;
let camEnabled   = true;

const peers        = new Map();
const remoteStreams = new Map();

// ── DOM ───────────────────────────────────────────
const $ = id => document.getElementById(id);

const myVideo         = $('myVideo');
const myVideoTile     = $('myVideoTile');
const myVideoLabel    = $('myVideoLabel');
const myNoCamOverlay  = $('myNoCamOverlay');
const myCardAvatar    = $('myCardAvatar');
const myRing          = $('myRing');
const screenVideo     = $('screenVideo');
const screenTile      = $('screenTile');
const screenLabel     = $('screenLabel');
const videoGrid       = $('videoGrid');

const ctrlMic         = $('ctrlMic');
const ctrlCam         = $('ctrlCam');
const btnShareScreen  = $('btnShareScreen');
const ctrlLeave       = $('ctrlLeave');
const btnLeave        = $('btnLeave');
const btnCopyLink     = $('btnCopyLink');
const btnToggleMic    = $('btnToggleMic');  // legado oculto
const btnToggleCam    = $('btnToggleCam');  // legado oculto

const topbarBadge     = $('topbarBadge');
const topbarPeople    = $('topbarPeople');
const shareLinkInput  = $('shareLinkInput');
const toastEl         = $('toast');

// ── Utils ─────────────────────────────────────────
function toast(msg, type = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function initial(name) { return (name || '?')[0].toUpperCase(); }

function avatarColor(id) {
  const p = ['#5865f2','#2dc653','#f0b232','#eb459e','#ed4245','#ff7043','#26a69a','#ab71f2'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return p[Math.abs(h) % p.length];
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => toast('Link copiado!', 'success'))
    .catch(() => toast('Erro ao copiar', 'error'));
}

// ── Grid: atualiza classe de layout ───────────────
function updateGridClass() {
  const cards = videoGrid.querySelectorAll('.participant-card:not(.hidden)');
  const n = cards.length;
  videoGrid.className = 'participants-grid';
  if (n === 1) videoGrid.classList.add('p1');
  else if (n === 2) videoGrid.classList.add('p2');
  else if (n === 3) videoGrid.classList.add('p3');
  else if (n === 4) videoGrid.classList.add('p4');
  else videoGrid.classList.add('p-many');
}

// ── Atualiza badge do topo ────────────────────────
function updateTopbar(users) {
  const n = users.length;
  topbarPeople.textContent = n === 1 ? '1 pessoa' : `${n} pessoas`;
}

// ── Participantes ─────────────────────────────────
function renderParticipants(users) {
  updateTopbar(users);
  updateGridClass();
}

// ── Tiles remotos ─────────────────────────────────
function createRemoteTile(userId, uName) {
  if ($(`tile-${userId}`)) return;

  const card = document.createElement('div');
  card.className = 'participant-card';
  card.id = `tile-${userId}`;

  // Vídeo
  const video = document.createElement('video');
  video.autoplay = true; video.playsinline = true;
  video.className = 'card-video';
  video.id = `video-${userId}`;

  // Overlay sem câmera
  const overlay = document.createElement('div');
  overlay.className = 'card-cam-off';
  overlay.id = `overlay-${userId}`;
  const color = avatarColor(userId);
  overlay.innerHTML = `
    <div class="card-avatar" style="background:${color}">${initial(uName)}</div>
    <div class="speaking-ring" id="ring-${userId}"></div>
  `;

  // Ícone mudo
  const mutedIcon = document.createElement('div');
  mutedIcon.className = 'card-muted-icon hidden';
  mutedIcon.id = `muted-${userId}`;
  mutedIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M9 9v3a3 3 0 005.12 2.12" stroke="currentColor" stroke-width="2"/>
  </svg>`;

  // Nome
  const nameTag = document.createElement('div');
  nameTag.className = 'card-name-tag';
  nameTag.id = `name-${userId}`;
  nameTag.textContent = uName;

  card.appendChild(video);
  card.appendChild(overlay);
  card.appendChild(mutedIcon);
  card.appendChild(nameTag);
  videoGrid.appendChild(card);
  updateGridClass();
}

function removeRemoteTile(userId) {
  $(`tile-${userId}`)?.remove();
  updateGridClass();
}

function setRemoteStream(userId, stream) {
  const video   = $(`video-${userId}`);
  const overlay = $(`overlay-${userId}`);
  if (!video) return;
  const hasVid = stream?.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  video.srcObject = stream || null;
  if (overlay) overlay.className = `card-cam-off${hasVid ? ' hidden' : ''}`;
}

// ── Tela compartilhada ────────────────────────────
function showScreen(userId, uName) {
  screenTile.classList.remove('hidden');
  screenLabel.textContent = `Tela de ${uName}`;
}

function hideScreen() {
  screenTile.classList.add('hidden');
  screenVideo.srcObject = null;
}

// ── Mídia local ───────────────────────────────────
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    myVideo.srcObject = localStream;
    myNoCamOverlay.classList.add('hidden');
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      camEnabled = false; updateCamUI();
    } catch {
      localStream = new MediaStream();
      micEnabled = false; camEnabled = false;
      updateMicUI(); updateCamUI();
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
  if (camEnabled) myNoCamOverlay.classList.add('hidden');
  else showMyOverlay();
}

function updateMicUI() {
  ctrlMic?.classList.toggle('muted', !micEnabled);
  const mutedEl = $('myMutedIcon');
  mutedEl?.classList.toggle('hidden', micEnabled);
}

function updateCamUI() {
  ctrlCam?.classList.toggle('muted', !camEnabled);
}

// ── Screen share ──────────────────────────────────
async function startShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, cursor: 'always' }, audio: true
    });
    screenVideo.srcObject = screenStream;
    showScreen(socket.id, userName);
    screenStream.getTracks().forEach(track => {
      peers.forEach((pc, uid) => {
        pc.addTrack(track, screenStream);
        renegotiate(uid);
      });
    });
    screenStream.getVideoTracks()[0].onended = stopShare;
    isSharing = true;
    btnShareScreen.classList.add('sharing');
    socket.emit('screen-share-started', { roomId });
    toast('Compartilhando tela', 'success');
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Erro ao compartilhar', 'error');
  }
}

function stopShare() {
  screenStream?.getTracks().forEach(t => {
    t.stop();
    peers.forEach(pc => {
      pc.getSenders().filter(s => s.track === t).forEach(s => pc.removeTrack(s));
    });
  });
  peers.forEach((_, uid) => renegotiate(uid));
  screenStream = null;
  hideScreen();
  isSharing = false;
  btnShareScreen.classList.remove('sharing');
  socket.emit('screen-share-stopped', { roomId });
  toast('Compartilhamento encerrado', 'info');
}

// ── WebRTC ────────────────────────────────────────
function getPeer(userId) {
  if (peers.has(userId)) return peers.get(userId);
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(userId, pc);
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
      const uName = getRemoteName(userId);
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

function getRemoteName(userId) {
  return $(`name-${userId}`)?.textContent || 'Usuário';
}

// ── Socket.IO ─────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, userName });
    document.title = `TELAS — #${roomId}`;
    const link = `${location.origin}/room/${roomId}`;
    if (shareLinkInput) shareLinkInput.value = link;
    // Define avatar do meu card
    showMyOverlay();
    myVideoLabel.textContent = userName;
    updateGridClass();
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
    toast(`${uName} entrou`, 'success');
  });

  socket.on('user-left', ({ userId, userName: uName, users }) => {
    dropPeer(userId);
    removeRemoteTile(userId);
    renderParticipants(users);
    if (remoteStreams.get(userId) === screenVideo.srcObject) hideScreen();
    toast(`${uName} saiu`, 'info');
  });

  socket.on('offer',         ({ fromId, offer })      => handleOffer(fromId, offer));
  socket.on('answer',        ({ fromId, answer })      => handleAnswer(fromId, answer));
  socket.on('ice-candidate', ({ fromId, candidate })   => handleIce(fromId, candidate));

  socket.on('screen-share-started', ({ userId, userName: uName }) => {
    toast(`${uName} está compartilhando a tela`, 'info');
  });
  socket.on('screen-share-stopped', () => hideScreen());

  // Chat — mantido no socket mas sem UI
  socket.on('chat-message', () => {});

  socket.on('disconnect', () => toast('Conexão perdida…', 'error'));
  socket.on('reconnect',  () => { toast('Reconectado!', 'success'); socket.emit('join-room', { roomId, userName }); });
}

// ── Event listeners ───────────────────────────────
btnShareScreen?.addEventListener('click', () => isSharing ? stopShare() : startShare());

ctrlMic?.addEventListener('click', toggleMic);
btnToggleMic?.addEventListener('click', toggleMic);

ctrlCam?.addEventListener('click', toggleCam);
btnToggleCam?.addEventListener('click', toggleCam);

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

const roomLink = `${location.origin}/room/${roomId}`;
btnCopyLink?.addEventListener('click', () => copyText(roomLink));

// ── Init ──────────────────────────────────────────
async function init() {
  if (!localStorage.getItem('telas_username')) { location.href = '/'; return; }
  await initMedia();
  initSocket();
}

init();
