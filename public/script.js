let socket;
let currentUser;
let selectedUser = "";
let usersPresence = {};
let unreadCounts = {};
let userSearchTerm = "";
let isAtBottom = true;
let pendingIncomingCall = null;

const usersListEl = document.getElementById("usersList");
const currentUserEl = document.getElementById("currentUser");
const chatWithEl = document.getElementById("chatWith");
const messagesEl = document.getElementById("messages");
const presenceTextEl = document.getElementById("presenceText");
const videoCallBtn = document.getElementById("videoCallBtn");
const deleteConversationBtn = document.getElementById("deleteConversationBtn");
const chatMenuBtn = document.getElementById("chatMenuBtn");
const chatMenu = document.getElementById("chatMenu");
const backToChatsBtn = document.getElementById("backToChatsBtn");
const mobileTabletQuery = window.matchMedia("(max-width: 1024px)");
const sendBtn = document.getElementById("sendBtn");
const attachBtn = document.getElementById("attachBtn");
const fileInputEl = document.getElementById("fileInput");
const fileLoaderEl = document.getElementById("fileLoader");
const userSearchInput = document.getElementById("userSearchInput");
const messageInputEl = document.getElementById("messageInput");
const composerMetaEl = document.getElementById("composerMeta");
const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
const incomingCallStorageKey = "chat:incoming_offer";
let isSendingFile = false;

async function init() {
  const me = await requireAuth();
  if (!me) return;

  currentUser = me.username;
  currentUserEl.innerText = `Logged in: @${me.username}`;

  socket = io({ auth: { token: getToken() } });
  setupIncomingCallUI();
  setupIncomingCallHandlers();

  socket.on("presence", (presence) => {
    mergePresenceUpdate(presence);
    renderUsers();
    updatePresenceIndicator();
  });

  socket.on("chatHistory", (messages) => {
    messagesEl.innerHTML = "";
    if (!messages.length) {
      renderEmptyState("No messages yet", "Start the conversation with a quick hello.");
    } else {
      messages.forEach((message) => renderMessage(message));
      scrollToBottom();
    }
  });

  socket.on("privateMessage", (message) => {
    const inOpenChat =
      (message.from === selectedUser && message.to === currentUser) ||
      (message.from === currentUser && message.to === selectedUser);

    if (inOpenChat) {
      removeEmptyState();
      renderMessage(message);
      scrollToBottom();
    } else if (message.from !== currentUser && message.to === currentUser) {
      unreadCounts[message.from] = (unreadCounts[message.from] || 0) + 1;
      renderUsers();
    }

    if (message.from === currentUser && (message.type === "image" || message.type === "video")) {
      setFileSendingState(false);
    }
  });

  socket.on("messageEdited", (message) => {
    const bubble = document.querySelector(`[data-mid='${message._id}'] .message-content`);
    if (!bubble) return;
    bubble.textContent = `${message.message} (edited)`;
  });

  socket.on("messageDeleted", ({ messageId }) => {
    const row = document.querySelector(`[data-mid='${messageId}']`);
    if (row) row.remove();
  });

  socket.on("conversationDeleted", ({ withUser }) => {
    if (withUser === selectedUser) {
      messagesEl.innerHTML = "";
      renderEmptyState("No messages yet", "Start the conversation with a quick hello.");
    }
  });

  sendBtn.addEventListener("click", sendTextMessage);
  messageInputEl.addEventListener("input", onComposerInput);
  messageInputEl.addEventListener("keydown", onComposerKeydown);
  userSearchInput.addEventListener("input", onUserSearchInput);
  scrollToBottomBtn.addEventListener("click", () => scrollToBottom(true));
  messagesEl.addEventListener("scroll", updateScrollToBottomVisibility);
  document.getElementById("settingsBtn").addEventListener("click", () => {
    window.location.href = "/settings";
  });
  document.getElementById("logoutBtn").addEventListener("click", logout);

  attachBtn.addEventListener("click", () => {
    if (isSendingFile) return;
    if (!selectedUser) {
      alert("Select a user first");
      return;
    }
    fileInputEl.click();
  });

  fileInputEl.addEventListener("change", sendMediaMessage);

  videoCallBtn.addEventListener("click", () => {
    if (!selectedUser) return;
    window.location.href = `/video?with=${encodeURIComponent(selectedUser)}&autostart=1`;
  });

  deleteConversationBtn.addEventListener("click", deleteConversation);
  chatMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    chatMenu.classList.toggle("hidden");
  });
  backToChatsBtn.addEventListener("click", returnToChatsList);
  if (mobileTabletQuery.addEventListener) {
    mobileTabletQuery.addEventListener("change", applyResponsiveShellState);
  } else if (mobileTabletQuery.addListener) {
    mobileTabletQuery.addListener(applyResponsiveShellState);
  }

  await loadUsersFromApi();
  applyResponsiveShellState();
  updateComposerMeta();
  restoreLastChat();
  restorePendingIncomingCall();

  document.addEventListener("click", () => {
    chatMenu.classList.add("hidden");
    closeAllMessageMenus();
  });
}

  Object.keys(usersPresence).forEach((username) => {
    if (onlineUsernames.has(username)) return;
    usersPresence[username] = {
      ...usersPresence[username],
      online: false
    };
  });

  Object.entries(nextPresence).forEach(([username, user]) => {
    usersPresence[username] = {
      ...(usersPresence[username] || {}),
      ...user,
      online: !!user?.online
    };
  });
}

async function loadUsersFromApi() {
  const res = await authFetch("/api/users");
  if (!res.ok) return;
  const users = await res.json();

  users.forEach((u) => {
    if (!usersPresence[u.username]) {
      usersPresence[u.username] = {
        username: u.username,
        name: u.name,
        online: false
      };
    } else if (!usersPresence[u.username].name) {
      usersPresence[u.username].name = u.name;
    }
  });

  renderUsers();
}

function renderUsers() {
  usersListEl.innerHTML = "";

  const usernames = Object.keys(usersPresence)
    .filter((u) => u !== currentUser)
    .filter((u) => {
      if (!userSearchTerm) return true;
      const name = usersPresence[u]?.name || "";
      const haystack = `${u} ${name}`.toLowerCase();
      return haystack.includes(userSearchTerm);
    })
    .sort();

  if (!usernames.length) {
    usersListEl.innerHTML = "<div class='empty-state'>No chats match your search.</div>";
    return;
  }

  usernames.forEach((username) => {
    const user = usersPresence[username];
    const div = document.createElement("div");
    div.className = `session-item ${selectedUser === username ? "active" : ""}`;

    const nameText = user?.name ? `${user.name} (@${username})` : `@${username}`;
    const status = user?.online ? "Online" : "Offline";
    const unreadCount = unreadCounts[username] || 0;
    const unreadBadge = unreadCount ? `<span class="unread-badge">${unreadCount > 99 ? "99+" : unreadCount}</span>` : "";
    const presenceClass = user?.online ? "presence-dot online" : "presence-dot";

    div.innerHTML = `
      <div class="session-title">${nameText}</div>
      <div class="${presenceClass}" aria-hidden="true"></div>
      <div class="session-sub">${status}</div>
      ${unreadBadge}
    `;

    div.onclick = () => {
      openConversation(username, nameText);
    };

    usersListEl.appendChild(div);
  });
}

function updatePresenceIndicator() {
  if (!selectedUser) {
    presenceTextEl.textContent = "Offline";
    videoCallBtn.disabled = true;
    deleteConversationBtn.disabled = true;
    chatMenuBtn.disabled = true;
    return;
  }

  const isOnline = !!usersPresence[selectedUser]?.online;
  presenceTextEl.textContent = isOnline ? "Online" : "Offline";
  videoCallBtn.disabled = !isOnline;
  deleteConversationBtn.disabled = false;
  chatMenuBtn.disabled = false;
}

function openChatOnMobileIfNeeded() {
  if (!mobileTabletQuery.matches) return;
  document.body.classList.add("mobile-chat-open");
}

function returnToChatsList() {
  if (!mobileTabletQuery.matches) return;
  document.body.classList.remove("mobile-chat-open");
}

function applyResponsiveShellState() {
  if (!mobileTabletQuery.matches) {
    document.body.classList.remove("mobile-chat-open");
    updateComposerMeta();
    return;
  }

  if (selectedUser) {
    document.body.classList.add("mobile-chat-open");
  } else {
    document.body.classList.remove("mobile-chat-open");
  }
  updateComposerMeta();
}

async function deleteConversation() {
  if (!selectedUser) return;
  chatMenu.classList.add("hidden");

  const ok = confirm(`Delete all messages with @${selectedUser}?`);
  if (!ok) return;

  const res = await authFetch(`/api/conversations/${selectedUser}`, { method: "DELETE" });
  if (!res.ok) {
    alert("Failed to delete conversation");
    return;
  }

  messagesEl.innerHTML = "";
  renderEmptyState("Conversation deleted", "You can still send a new message anytime.");
  socket.emit("deleteConversation", { withUser: selectedUser });
}

function sendTextMessage() {
  if (isSendingFile) return;

  const msg = messageInputEl.value.trim();

  if (!selectedUser) {
    alert("Select a user first");
    return;
  }

  if (!msg) return;

  socket.emit("privateMessage", {
    to: selectedUser,
    message: msg,
    type: "text"
  });

  messageInputEl.value = "";
  storeDraft("");
  onComposerInput();
}

async function sendMediaMessage(event) {
  const file = event.target.files[0];
  event.target.value = "";

  if (!file || !selectedUser) return;
  if (isSendingFile) return;

  setFileSendingState(true);

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const isVideo = file.type.startsWith("video/");

    socket.emit("privateMessage", {
      to: selectedUser,
      type: isVideo ? "video" : "image",
      mediaUrl: dataUrl,
      message: file.name
    });

    // Fallback in case echo is delayed.
    setTimeout(() => setFileSendingState(false), 2500);
  };

  reader.onerror = () => {
    setFileSendingState(false);
    alert("Failed to read file.");
  };

  reader.onabort = () => {
    setFileSendingState(false);
  };

  reader.readAsDataURL(file);
}

function renderMessage(message) {
  const row = document.createElement("div");
  row.className = `message-row ${message.from === currentUser ? "message-user-row" : "message-assistant-row"}`;
  row.dataset.mid = message._id;

  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${message.from === currentUser ? "message-user" : "message-assistant"}`;

  const content = document.createElement("div");
  content.className = "message-content";

  if (message.type === "image") {
    const img = document.createElement("img");
    img.src = message.mediaUrl;
    img.className = "chat-media";
    content.appendChild(img);
  } else if (message.type === "video") {
    const video = document.createElement("video");
    video.src = message.mediaUrl;
    video.className = "chat-media";
    video.controls = true;
    content.appendChild(video);
  } else {
    content.textContent = message.edited ? `${message.message} (edited)` : message.message;
  }

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = formatTime(message.timestamp);

  bubble.appendChild(content);
  bubble.appendChild(meta);

  if (message.from === currentUser && message.type === "text") {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const menuBtn = document.createElement("button");
    menuBtn.textContent = "\u22EE";
    menuBtn.className = "tiny-menu-btn";
    menuBtn.onclick = (event) => {
      event.stopPropagation();
      closeAllMessageMenus();
      menu.classList.toggle("hidden");
    };

    const menu = document.createElement("div");
    menu.className = "message-menu hidden";

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "menu-item danger-item";
    deleteBtn.onclick = (event) => {
      event.stopPropagation();
      menu.classList.add("hidden");
      socket.emit("deleteMessage", { messageId: message._id });
    };

    actions.appendChild(menuBtn);
    menu.appendChild(deleteBtn);
    actions.appendChild(menu);
    bubble.appendChild(actions);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
}

function scrollToBottom() {
  isAtBottom = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateScrollToBottomVisibility();
}

init();

function closeAllMessageMenus() {
  document.querySelectorAll(".message-menu").forEach((menu) => {
    menu.classList.add("hidden");
  });
}

function setFileSendingState(isSending) {
  isSendingFile = isSending;
  fileLoaderEl.classList.toggle("hidden", !isSending);
  attachBtn.disabled = isSending;
  sendBtn.disabled = isSending;
}

function onUserSearchInput(event) {
  userSearchTerm = event.target.value.trim().toLowerCase();
  renderUsers();
}

function onComposerInput() {
  autoResizeComposer();
  const messageLength = messageInputEl.value.trim().length;
  const helperText = mobileTabletQuery.matches
    ? `${messageLength} chars`
    : `Enter to send, Shift+Enter for new line - ${messageLength} chars`;
  composerMetaEl.textContent = helperText;
  storeDraft(messageInputEl.value);
}

function onComposerKeydown(event) {
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  if (mobileTabletQuery.matches) return;
  event.preventDefault();
  sendTextMessage();
}

function autoResizeComposer() {
  messageInputEl.style.height = "auto";
  const nextHeight = Math.min(messageInputEl.scrollHeight, 150);
  messageInputEl.style.height = `${nextHeight}px`;
}

function openConversation(username, nameText) {
  if (selectedUser && selectedUser !== username) {
    storeDraft(messageInputEl.value);
  }

  selectedUser = username;
  unreadCounts[username] = 0;
  chatWithEl.innerText = `Chat with ${nameText}`;
  messagesEl.innerHTML = "";
  socket.emit("loadMessages", { withUser: username });
  openChatOnMobileIfNeeded();
  renderUsers();
  updatePresenceIndicator();
  restoreDraft();
  persistLastChat();
}

function renderEmptyState(title, subtitle) {
  messagesEl.innerHTML = `
    <div class="empty-state">
      <div>${title}</div>
      <div class="session-sub">${subtitle}</div>
    </div>
  `;
}

function removeEmptyState() {
  const state = messagesEl.querySelector(".empty-state");
  if (state) state.remove();
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateScrollToBottomVisibility() {
  const threshold = 64;
  const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  isAtBottom = distance < threshold;
  scrollToBottomBtn.classList.toggle("hidden", isAtBottom);
}

function updateComposerMeta() {
  onComposerInput();
}

function draftStorageKey() {
  return `chat:draft:${currentUser || "anon"}:${selectedUser || "none"}`;
}

function storeDraft(value) {
  if (!selectedUser) return;
  localStorage.setItem(draftStorageKey(), value || "");
}

function restoreDraft() {
  if (!selectedUser) return;
  const draft = localStorage.getItem(draftStorageKey()) || "";
  messageInputEl.value = draft;
  onComposerInput();
}

function persistLastChat() {
  if (!selectedUser) return;
  localStorage.setItem(`chat:last:${currentUser}`, selectedUser);
}

function restoreLastChat() {
  const previous = localStorage.getItem(`chat:last:${currentUser}`);
  if (!previous || !usersPresence[previous]) {
    renderEmptyState("Select a chat", "Pick a user from the list to begin.");
    return;
  }
  const name = usersPresence[previous]?.name ? `${usersPresence[previous].name} (@${previous})` : `@${previous}`;
  openConversation(previous, name);
}

function setupIncomingCallHandlers() {
  socket.on("video-offer", ({ from, offer, callId }) => {
    if (!from || !offer) return;
    pendingIncomingCall = { from, offer, callId: callId || "" };
    persistPendingIncomingCall();
    showIncomingCallAlert();
  });

  socket.on("video-end", ({ from }) => {
    if (!pendingIncomingCall || pendingIncomingCall.from !== from) return;
    clearPendingIncomingCall();
  });

  socket.on("video-decline", ({ from }) => {
    if (!pendingIncomingCall || pendingIncomingCall.from !== from) return;
    clearPendingIncomingCall();
  });
}

function setupIncomingCallUI() {
  if (document.getElementById("incomingCallAlert")) return;

  const el = document.createElement("section");
  el.id = "incomingCallAlert";
  el.className = "call-alert hidden";
  el.innerHTML = `
    <div class="call-alert-title" id="incomingCallTitle">Incoming call</div>
    <div class="call-alert-sub" id="incomingCallSub">Someone is calling you.</div>
    <div class="call-alert-actions">
      <button type="button" id="incomingCallAccept" class="chat-send-btn call-alert-btn">Accept</button>
      <button type="button" id="incomingCallDecline" class="danger-btn call-alert-btn">Decline</button>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById("incomingCallAccept").addEventListener("click", acceptPendingIncomingCall);
  document.getElementById("incomingCallDecline").addEventListener("click", declinePendingIncomingCall);
}

function showIncomingCallAlert() {
  const alertEl = document.getElementById("incomingCallAlert");
  const titleEl = document.getElementById("incomingCallTitle");
  const subEl = document.getElementById("incomingCallSub");
  if (!alertEl || !titleEl || !subEl || !pendingIncomingCall) return;

  titleEl.textContent = `Incoming call from @${pendingIncomingCall.from}`;
  subEl.textContent = "Accept to open video call.";
  alertEl.classList.remove("hidden");

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const notification = new Notification("Incoming call", {
        body: `@${pendingIncomingCall.from} is calling you`,
        tag: "incoming-video-call"
      });
      notification.onclick = () => window.focus();
    } catch (_) {
      // Ignore notification errors.
    }
  } else if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function hideIncomingCallAlert() {
  const alertEl = document.getElementById("incomingCallAlert");
  if (alertEl) alertEl.classList.add("hidden");
}

function persistPendingIncomingCall() {
  if (!pendingIncomingCall) return;
  localStorage.setItem(incomingCallStorageKey, JSON.stringify({
    ...pendingIncomingCall,
    at: Date.now()
  }));
}

function restorePendingIncomingCall() {
  const raw = localStorage.getItem(incomingCallStorageKey);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.from || !parsed?.offer) return;
    if (Date.now() - Number(parsed.at || 0) > 1000 * 60 * 2) return;
    pendingIncomingCall = parsed;
    showIncomingCallAlert();
  } catch (_) {
    // Ignore malformed localStorage value.
  }
}

function clearPendingIncomingCall() {
  pendingIncomingCall = null;
  localStorage.removeItem(incomingCallStorageKey);
  hideIncomingCallAlert();
}

function acceptPendingIncomingCall() {
  if (!pendingIncomingCall) return;
  persistPendingIncomingCall();
  const query = new URLSearchParams({
    with: pendingIncomingCall.from,
    incoming: "1",
    callId: pendingIncomingCall.callId || ""
  });
  window.location.href = `/video?${query.toString()}`;
}

function declinePendingIncomingCall() {
  if (!pendingIncomingCall) return;
  socket.emit("video-decline", {
    to: pendingIncomingCall.from,
    callId: pendingIncomingCall.callId || "",
    reason: "rejected"
  });
  clearPendingIncomingCall();
}
