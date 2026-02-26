(function initPwa() {
  if (!("serviceWorker" in navigator)) return;

  let deferredPrompt = null;
  const installBtn = document.getElementById("installAppBtn");

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function updateInstallButton() {
    if (!installBtn) return;
    installBtn.hidden = isStandalone() || !deferredPrompt;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    updateInstallButton();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    updateInstallButton();
  });

  if (!installBtn) return;

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (_error) {
      // Ignore; button state still gets reset below.
    }
    deferredPrompt = null;
    updateInstallButton();
  });

  updateInstallButton();
})();
