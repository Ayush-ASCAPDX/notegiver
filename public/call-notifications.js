(function initCallNotifications() {
  if (window.__sovereignCallAlertsInit) return;
  window.__sovereignCallAlertsInit = true;

  if (window.location.pathname === "/video") return;
  if (typeof io !== "function") return;

  const token = getToken();
  if (!token) return;

  const OFFER_STORAGE_KEY = "chat:incoming_offer";
  const alertEl = document.createElement("section");
  alertEl.className = "call-alert hidden";
  alertEl.innerHTML = `
    <div class="call-alert-title" id="callAlertTitle">Incoming call</div>
    <div class="call-alert-sub" id="callAlertSub">Someone is calling you.</div>
    <div class="call-alert-actions">
      <button type="button" id="callAlertAccept" class="chat-send-btn call-alert-btn">Accept</button>
      <button type="button" id="callAlertDecline" class="danger-btn call-alert-btn">Decline</button>
    </div>
  `;
  document.body.appendChild(alertEl);

  const titleEl = alertEl.querySelector("#callAlertTitle");
  const subEl = alertEl.querySelector("#callAlertSub");
  const acceptBtn = alertEl.querySelector("#callAlertAccept");
  const declineBtn = alertEl.querySelector("#callAlertDecline");

  let pendingOffer = null;
  const socket = io({ auth: { token } });

  function persistOffer(offerData) {
    localStorage.setItem(OFFER_STORAGE_KEY, JSON.stringify({
      ...offerData,
      at: Date.now()
    }));
  }

  function clearOffer() {
    pendingOffer = null;
    localStorage.removeItem(OFFER_STORAGE_KEY);
    alertEl.classList.add("hidden");
  }

  function showOffer(from) {
    titleEl.textContent = `Incoming call from @${from}`;
    subEl.textContent = "Accept to join video now.";
    alertEl.classList.remove("hidden");

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const notification = new Notification("Incoming call", {
          body: `@${from} is calling you`,
          tag: "incoming-video-call"
        });
        notification.onclick = () => window.focus();
      } catch (_) {
        // Ignore browser notification failures.
      }
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  socket.on("video-offer", ({ from, offer, callId }) => {
    if (!from || !offer) return;
    pendingOffer = { from, offer, callId: callId || "" };
    persistOffer(pendingOffer);
    showOffer(from);
  });

  socket.on("video-end", ({ from }) => {
    if (!pendingOffer || pendingOffer.from !== from) return;
    clearOffer();
  });

  socket.on("video-decline", ({ from }) => {
    if (!pendingOffer || pendingOffer.from !== from) return;
    clearOffer();
  });

  acceptBtn.addEventListener("click", () => {
    if (!pendingOffer) return;
    persistOffer(pendingOffer);
    const query = new URLSearchParams({
      with: pendingOffer.from,
      incoming: "1",
      callId: pendingOffer.callId || ""
    });
    window.location.href = `/video?${query.toString()}`;
  });

  declineBtn.addEventListener("click", () => {
    if (!pendingOffer) return;
    socket.emit("video-decline", { to: pendingOffer.from, callId: pendingOffer.callId || "" });
    clearOffer();
  });
})();
