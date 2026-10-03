// Installation only: room data and media keep using their existing transports.
(() => {
  const welcome = document.getElementById("room-welcome");
  if (!welcome) return;
  const standalone = matchMedia("(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)");
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let installed = standalone.matches || !!navigator.standalone;
  let pendingPrompt = null;
  const tools = document.createElement("aside");
  tools.className = "install-tools";
  tools.hidden = true;
  tools.innerHTML = `<button id="install-app" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></svg><span></span></button>
    <p id="install-status" role="status" aria-live="polite"></p>
    <dialog id="install-help" aria-labelledby="install-help-title"><h2 id="install-help-title">${t("installHelp")}</h2><p>${t("iosInstallHelp")}</p><form method="dialog"><button type="submit">${t("closeInstallHelp")}</button></form></dialog>`;
  welcome.append(tools);
  const button = document.getElementById("install-app");
  const help = document.getElementById("install-help");
  const status = document.getElementById("install-status");
  function render() {
    tools.hidden = installed || (!pendingPrompt && !isIOS && !status.textContent);
    button.hidden = !pendingPrompt && !isIOS;
    button.querySelector("span").textContent = t(pendingPrompt ? "installApp" : "installHelp");
  }
  addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed) return;
    pendingPrompt = event;
    status.textContent = "";
    render();
  });
  addEventListener("appinstalled", () => {
    installed = true;
    pendingPrompt = null;
    if (help.open) help.close();
    render();
  });
  standalone.addEventListener("change", () => {
    installed = standalone.matches || !!navigator.standalone;
    if (installed && help.open) help.close();
    render();
  });
  button.onclick = async () => {
    if (installed) return;
    if (!pendingPrompt) { if (isIOS) help.showModal(); return; }
    const event = pendingPrompt;
    pendingPrompt = null;
    button.disabled = true;
    try { await event.prompt(); await event.userChoice; }
    catch { status.textContent = t("installFailed"); }
    finally { button.disabled = false; render(); }
  };
  render();
})();
