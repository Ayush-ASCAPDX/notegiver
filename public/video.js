let socket;
let me;
let localStream = null;
let peerConnection = null;
let activePeer = "";
let pendingOffer = null;
let pendingIceCandidates = [];
let activeCallId = "";
let isMuted = false;
let isCameraOff = false;
let ringTimeoutId = null;
let timerInterval = null;
let timerStartedAt = 0;
let callEndedRedirectTimer = null;
let isRingingOutgoing = false;
const debugEnabled = true;
const debugState = {
  socket: "disconnected",
  callState: "idle",
  pcState: "none",
  iceState: "none",
  signalingState: "none",
  localTracks: "0a/0v",
  remoteTracks: "0a/0v",
  sentIce: 0,
  recvIce: 0
};

const OFFER_STORAGE_KEY = "chat:incoming_offer";
const RING_TIMEOUT_MS = 30000;
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const callStatus = document.getElementById("callStatus");
const connectionBadge = document.getElementById("connectionBadge");
const timerBadge = document.getElementById("timerBadge");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteEmpty = document.getElementById("remoteEmpty");
const remoteLabel = document.getElementById("remoteLabel");
const localMediaState = document.getElementById("localMediaState");
const incomingBanner = document.getElementById("incomingBanner");
const incomingText = document.getElementById("incomingText");
const startCallBtn = document.getElementById("startCallBtn");
const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const endCallBtn = document.getElementById("endCallBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const acceptCallBtn = document.getElementById("acceptCallBtn");
const declineCallBtn = document.getElementById("declineCallBtn");
let debugPanel = null;

const params = new URLSearchParams(window.location.search);
const prefilledTarget = (params.get("with") || "").trim().toLowerCase();
const shouldAutoStart = params.get("autostart") === "1";
const shouldAutoAcceptIncoming = params.get("incoming") === "1";
const initialCallId = (params.get("callId") || "").trim();

function buildCallId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function setStatus(message) {
  callStatus.textContent = message;
  setDebug("status", message);
}

function setCallState(state) {
  const labels = {
    idle: "Idle",
    ringing: "Ringing",
    incoming: "Incoming",
    connecting: "Connecting",
    connected: "Connected",
    closed: "Ended",
    failed: "Failed"
  };
  connectionBadge.textContent = labels[state] || state;
  setDebug("callState", state);
}

function ensureDebugPanel() {
  if (!debugEnabled || debugPanel) return;
  debugPanel = document.createElement("pre");
  debugPanel.id = "webrtcDebugPanel";
  debugPanel.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2000;background:rgba(2,6,23,0.88);color:#cbd5e1;border:1px solid #334155;border-radius:8px;padding:8px;max-width:92vw;max-height:40vh;overflow:auto;font:11px/1.35 monospace;white-space:pre-wrap;";
  document.body.appendChild(debugPanel);
  renderDebug();
}

function setDebug(key, value) {
  if (!debugEnabled) return;
  debugState[key] = value;
  renderDebug();
}

function renderDebug() {
  if (!debugEnabled || !debugPanel) return;
  debugPanel.textContent =
    `socket=${debugState.socket}\n` +
    `call=${debugState.callState}\n` +
    `pc=${debugState.pcState} ice=${debugState.iceState} signal=${debugState.signalingState}\n` +
    `local=${debugState.localTracks} remote=${debugState.remoteTracks}\n` +
    `ice sent=${debugState.sentIce} recv=${debugState.recvIce}\n` +
    `status=${debugState.status || ""}`;
}

function updateLocalTrackDebug() {
  const a = localStream ? localStream.getAudioTracks().length : 0;
  const v = localStream ? localStream.getVideoTracks().length : 0;
  setDebug("localTracks", `${a}a/${v}v`);
}

function updateRemoteTrackDebug() {
  const stream = remoteVideo.srcObject;
  const a = stream && typeof stream.getAudioTracks === "function" ? stream.getAudioTracks().length : 0;
  const v = stream && typeof stream.getVideoTracks === "function" ? stream.getVideoTracks().length : 0;
  setDebug("remoteTracks", `${a}a/${v}v`);
}

function setInCallUI(inCall) {
  muteBtn.disabled = !inCall;
  cameraBtn.disabled = !inCall;
  endCallBtn.disabled = !inCall;
}

function setRingingUI(ringing) {
  isRingingOutgoing = ringing;
  startCallBtn.disabled = ringing;
  if (ringing) endCallBtn.disabled = false;
}

function clearRingTimeout() {
  if (ringTimeoutId) clearTimeout(ringTimeoutId);
  ringTimeoutId = null;
}

function beginRingTimeout() {
  clearRingTimeout();
  ringTimeoutId = setTimeout(() => {
    if (!isRingingOutgoing || !activePeer) return;
    socket.emit("video-end", { to: activePeer, callId: activeCallId });
    setStatus(`@${activePeer} did not answer.`);
    cleanupCall({ nextState: "idle", redirect: true });
  }, RING_TIMEOUT_MS);
}

function showIncoming(from) {
  incomingText.textContent = `Incoming call from @${from}`;
  incomingBanner.classList.remove("hidden");
}

function hideIncoming() {
  incomingBanner.classList.add("hidden");
}

function persistOffer(value) {
  localStorage.setItem(OFFER_STORAGE_KEY, JSON.stringify({
    ...value,
    at: Date.now()
  }));
}

function consumePersistedOffer() {
  const raw = localStorage.getItem(OFFER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.from || !parsed?.offer) return null;
    if (Date.now() - Number(parsed.at || 0) > 1000 * 60 * 2) return null;
    return parsed;
  } catch (_) {
    return null;
  } finally {
    localStorage.removeItem(OFFER_STORAGE_KEY);
  }
}

function updateTargetLabel() {
  remoteLabel.textContent = activePeer ? `@${activePeer}` : (prefilledTarget ? `@${prefilledTarget}` : "Remote");
}

function updateLocalMediaLabel() {
  const micState = isMuted ? "Mic off" : "Mic on";
  const camState = isCameraOff ? "Cam off" : "Cam on";
  localMediaState.textContent = `${micState} . ${camState}`;
}

function startTimer() {
  if (timerInterval) return;
  timerStartedAt = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    timerBadge.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerBadge.textContent = "00:00";
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: "user"
    }
  });
  localVideo.srcObject = localStream;
  localVideo.play?.().catch(() => {});
  applyTrackState();
  updateLocalTrackDebug();
  return localStream;
}

function createPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }

  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (!event.candidate || !activePeer) return;
    setDebug("sentIce", Number(debugState.sentIce || 0) + 1);
    socket.emit("video-ice", {
      to: activePeer,
      candidate: event.candidate,
      callId: activeCallId
    });
  };

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      const stream = remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream();
      if (event.track) stream.addTrack(event.track);
      remoteVideo.srcObject = stream;
    }
    remoteVideo.play?.().catch(() => {});
    remoteEmpty.classList.add("hidden");
    updateRemoteTrackDebug();
  };

  pc.onconnectionstatechange = () => {
    setDebug("pcState", pc.connectionState);
    setDebug("iceState", pc.iceConnectionState);
    setDebug("signalingState", pc.signalingState);
    if (pc.connectionState === "connected") {
      setCallState("connected");
      setStatus(`Connected with @${activePeer}.`);
      setInCallUI(true);
      setRingingUI(false);
      clearRingTimeout();
      startTimer();
      return;
    }

    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      if (!callStatus.textContent.includes("ended")) {
        setStatus("Call ended.");
      }
      cleanupCall({ nextState: "closed", redirect: true });
    }
  };

  peerConnection = pc;
  setDebug("pcState", pc.connectionState);
  setDebug("iceState", pc.iceConnectionState);
  setDebug("signalingState", pc.signalingState);
  return pc;
}

function drainIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return Promise.resolve();
  const queue = [...pendingIceCandidates];
  pendingIceCandidates = [];

  return queue.reduce((promise, candidate) => {
    return promise.then(async () => {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (_) {
        // Ignore stale ICE candidates.
      }
    });
  }, Promise.resolve());
}

function stopLocalMedia() {
  if (!localStream) return;
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
}

function cleanupCall(options = {}) {
  const { nextState = "idle", redirect = false, preserveStatus = false } = options;
  clearRingTimeout();
  hideIncoming();
  stopTimer();

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  stopLocalMedia();
  remoteVideo.srcObject = null;
  updateLocalTrackDebug();
  updateRemoteTrackDebug();
  remoteEmpty.classList.remove("hidden");

  setCallState(nextState);
  setInCallUI(false);
  setRingingUI(false);
  startCallBtn.disabled = false;

  pendingOffer = null;
  pendingIceCandidates = [];
  activePeer = "";
  activeCallId = "";
  isMuted = false;
  isCameraOff = false;
  muteBtn.textContent = "Mic On";
  cameraBtn.textContent = "Cam On";
  updateLocalMediaLabel();
  updateTargetLabel();

  if (!preserveStatus && nextState === "closed") {
    setStatus("Call ended.");
  }

  if (redirect) {
    redirectToChat(700);
  }
}

async function waitForSocketConnection(timeoutMs = 3500) {
  if (socket && socket.connected) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      resolve();
    };
    const onConnect = () => finish();
    const timeout = setTimeout(finish, timeoutMs);
    socket.on("connect", onConnect);
  });
}

async function startCall() {
  const to = activePeer || prefilledTarget;
  if (!to) {
    setStatus("No target user selected.");
    return;
  }
  if (to === me.username) {
    setStatus("You cannot call yourself.");
    return;
  }
  if (activePeer && (peerConnection || pendingOffer)) {
    setStatus("You are already in a call flow.");
    return;
  }

  try {
    activePeer = to;
    activeCallId = buildCallId();
    updateTargetLabel();
    pendingIceCandidates = [];
    setCallState("ringing");
    setStatus(`Calling @${to}...`);
    setRingingUI(true);
    await waitForSocketConnection();
    await ensureLocalStream();
    const pc = createPeerConnection();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("video-offer", { to, offer, callId: activeCallId });
    beginRingTimeout();
  } catch (error) {
    setStatus(`Call failed: ${error.message || "Unknown error"}`);
    cleanupCall({ nextState: "failed" });
  }
}

async function acceptIncoming() {
  if (!pendingOffer) return;
  const { from, offer, callId } = pendingOffer;
  hideIncoming();

  try {
    activePeer = from;
    activeCallId = callId || buildCallId();
    updateTargetLabel();
    setCallState("connecting");
    setStatus(`Connecting with @${from}...`);
    await waitForSocketConnection();
    await ensureLocalStream();
    const pc = createPeerConnection();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await drainIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    pendingOffer = null;
    socket.emit("video-answer", { to: from, answer, callId: activeCallId });
  } catch (error) {
    setStatus(`Could not accept: ${error.message || "Unknown error"}`);
    socket.emit("video-decline", { to: from, callId: callId || activeCallId });
    cleanupCall({ nextState: "failed", redirect: true });
  }
}

function rejectIncoming(reason = "rejected") {
  if (!pendingOffer) return;
  const from = pendingOffer.from;
  const callId = pendingOffer.callId || activeCallId;
  socket.emit("video-decline", { to: from, callId, reason });
  setStatus(`Call from @${from} rejected.`);
  cleanupCall({ nextState: "idle", redirect: true, preserveStatus: true });
}

function endCallByUser() {
  if (!activePeer) {
    cleanupCall({ nextState: "closed", redirect: true });
    return;
  }
  socket.emit("video-end", { to: activePeer, callId: activeCallId, reason: "ended" });
  cleanupCall({ nextState: "closed", redirect: true });
}

async function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  applyTrackState();
}

async function toggleCamera() {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  applyTrackState();
}

function applyTrackState() {
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = !isCameraOff;
    });
  }
  muteBtn.textContent = isMuted ? "Mic Off" : "Mic On";
  cameraBtn.textContent = isCameraOff ? "Cam Off" : "Cam On";
  updateLocalMediaLabel();
}

function fullScreenRemote() {
  const remoteCard = document.querySelector(".video-remote");
  if (!document.fullscreenElement) {
    remoteCard.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function setupSocket() {
  socket.on("connect", () => setDebug("socket", "connected"));
  socket.on("disconnect", () => setDebug("socket", "disconnected"));

  socket.on("video-offer", (payload) => {
    if (!payload || !payload.from || !payload.offer) return;

    const from = String(payload.from).trim().toLowerCase();
    const callId = payload.callId || "";

    if (activePeer || peerConnection || pendingOffer) {
      socket.emit("video-decline", { to: from, callId, reason: "busy" });
      return;
    }

    activePeer = from;
    activeCallId = callId || initialCallId || buildCallId();
    pendingIceCandidates = [];
    pendingOffer = { from, offer: payload.offer, callId: activeCallId };
    persistOffer(pendingOffer);
    updateTargetLabel();
    setCallState("incoming");
    setStatus(`Incoming call from @${from}.`);
    showIncoming(from);
  });

  socket.on("video-answer", async (payload) => {
    if (!peerConnection || !payload?.answer || !payload?.from) return;
    if (payload.from !== activePeer) return;
    if (payload.callId && activeCallId && payload.callId !== activeCallId) return;

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
      await drainIceCandidates();
      setCallState("connecting");
      setStatus(`Call accepted by @${payload.from}. Connecting...`);
      clearRingTimeout();
      setRingingUI(false);
    } catch (error) {
      setStatus(`Answer error: ${error.message || "Unknown error"}`);
      cleanupCall({ nextState: "failed", redirect: true });
    }
  });

  socket.on("video-ice", async (payload) => {
    if (!payload?.candidate || !payload?.from) return;
    if (payload.from !== activePeer) return;
    if (payload.callId && activeCallId && payload.callId !== activeCallId) return;

    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingIceCandidates.push(payload.candidate);
      setDebug("recvIce", Number(debugState.recvIce || 0) + 1);
      return;
    }

    try {
      setDebug("recvIce", Number(debugState.recvIce || 0) + 1);
      await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (_) {
      // Ignore transient ICE failures.
    }
  });

  socket.on("video-decline", (payload) => {
    if (!payload?.from) return;
    if (payload.from !== activePeer) return;
    if (payload.callId && activeCallId && payload.callId !== activeCallId) return;

    const reason = payload.reason || "rejected";
    if (reason === "busy") {
      setStatus(`@${payload.from} is busy.`);
    } else if (reason === "offline") {
      setStatus(`@${payload.from} is offline.`);
    } else {
      setStatus(`@${payload.from} rejected your call.`);
    }
    cleanupCall({ nextState: "idle", redirect: true, preserveStatus: true });
  });

  socket.on("video-end", (payload) => {
    if (!payload?.from) return;
    if (payload.from !== activePeer) return;
    if (payload.callId && activeCallId && payload.callId !== activeCallId) return;

    const reason = payload.reason || "ended";
    if (reason === "no-answer") {
      setStatus(`@${payload.from} did not answer.`);
    } else if (reason === "offline") {
      setStatus(`@${payload.from} went offline.`);
    } else {
      setStatus(`@${payload.from} ended the call.`);
    }
    cleanupCall({ nextState: "closed", redirect: true, preserveStatus: true });
  });
}

function redirectToChat(delayMs = 700) {
  clearTimeout(callEndedRedirectTimer);
  callEndedRedirectTimer = setTimeout(() => {
    window.location.href = "/chat";
  }, delayMs);
}

function bindUI() {
  startCallBtn.addEventListener("click", startCall);
  muteBtn.addEventListener("click", toggleMute);
  cameraBtn.addEventListener("click", toggleCamera);
  endCallBtn.addEventListener("click", endCallByUser);
  fullscreenBtn.addEventListener("click", fullScreenRemote);
  acceptCallBtn.addEventListener("click", acceptIncoming);
  declineCallBtn.addEventListener("click", () => rejectIncoming("rejected"));
}

async function init() {
  me = await requireAuth();
  if (!me) return;

  ensureDebugPanel();
  activePeer = prefilledTarget || "";
  updateTargetLabel();
  setCallState("idle");
  setStatus(activePeer ? `Ready for @${activePeer}` : "No user selected.");
  setInCallUI(false);
  setRingingUI(false);
  updateLocalMediaLabel();

  socket = io({ auth: { token: getToken() } });
  setupSocket();
  bindUI();

  const pendingFromStorage = consumePersistedOffer();
  if (pendingFromStorage && !peerConnection && !pendingOffer) {
    pendingOffer = {
      from: String(pendingFromStorage.from || "").trim().toLowerCase(),
      offer: pendingFromStorage.offer,
      callId: pendingFromStorage.callId || initialCallId || buildCallId()
    };
    activePeer = pendingOffer.from;
    activeCallId = pendingOffer.callId;
    setCallState("incoming");
    setStatus(`Incoming call from @${pendingOffer.from}.`);
    showIncoming(pendingOffer.from);
    updateTargetLabel();

    if (shouldAutoAcceptIncoming) {
      if (socket.connected) {
        await acceptIncoming();
      } else {
        socket.once("connect", () => {
          acceptIncoming().catch(() => {});
        });
      }
      return;
    }
  }

  if (!activePeer) {
    startCallBtn.disabled = true;
  } else {
    startCallBtn.disabled = false;
    if (shouldAutoStart) {
      await startCall();
    }
  }
}

window.addEventListener("beforeunload", () => {
  if (activePeer && socket) {
    socket.emit("video-end", { to: activePeer, callId: activeCallId, reason: "offline" });
  }
});

init();
