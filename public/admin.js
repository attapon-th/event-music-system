// Uses the shared search UI and room-scoped authoritative snapshots.
let adminState = { nowPlaying: null, queue: [], paused: false, volume: 60 };
let adminAuthenticated = false;
let adminRoom = { participants: [], filterOn: false, moderationMode: "default", cooldownSeconds: 5 };
let draggingId = null;
const pendingRemovals = new Map();
const adminFeedback = document.getElementById("admin-feedback");
const adminControls = ["admin-play", "admin-pause", "admin-skip", "admin-volume", "admin-volume-toggle",
  "admin-settings", "admin-auto-queue", "admin-cooldown", "admin-clear"].map(id => document.getElementById(id));
const queueIcons = {
  playNow: '<path d="m8 5 11 7-11 7Z"/>',
  moveUp: '<path d="m5 12 7-7 7 7M12 5v14"/>',
  moveDown: '<path d="m5 12 7 7 7-7M12 5v14"/>',
  remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};

function adminSend(message) {
  if (adminAuthenticated) {
    Room.send(message);
  } else showAdminFeedback(t("offline"));
}

function cancelRemoval(id) {
  clearTimeout(pendingRemovals.get(id)?.timer);
  pendingRemovals.delete(id);
}

function cancelPendingRemovals() {
  for (const id of pendingRemovals.keys()) cancelRemoval(id);
}

window.addEventListener("pageshow", (event) => { if (event.persisted) renderAdmin(); });

function startRemoval(id) {
  if (!adminAuthenticated || pendingRemovals.has(id) || !adminState.queue.some(item => item.id === id)) return;
  const pending = { deadline: Date.now() + 5000 };
  pendingRemovals.set(id, pending);
  function tick() {
    if (pendingRemovals.get(id) !== pending) return;
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    if (!seconds) {
      cancelRemoval(id);
      if (adminAuthenticated && adminState.queue.some(item => item.id === id)) adminSend({ type: "remove", id });
      renderAdmin();
      return;
    }
    if (pending.label) pending.label.textContent = t("removeCountdown", { seconds });
    pending.timer = setTimeout(tick, Math.min(1000, pending.deadline - Date.now()));
  }
  renderAdmin();
  tick();
}

function connectAdmin() {
  setConnectionStatus("connecting");
  Room.connect({
    onAuth(msg) {
      adminRoom.role = msg.role;
      adminAuthenticated = ["admin", "controller"].includes(msg.role);
      setConnectionStatus(adminAuthenticated ? "connected" : "authFailed");
      renderAdmin();
    },
    onState(msg) {
      adminRoom = msg;
      adminAuthenticated = ["admin", "controller"].includes(msg.role);
      adminState = msg.state;
      lastQueueState = msg.state;
      renderAdmin();
    },
    onError(msg) { showAdminFeedback(msg.error); },
    onEnd() { adminAuthenticated = false; draggingId = null; cancelPendingRemovals(); setConnectionStatus("offline"); renderAdmin(); },
    onOffline() {
      adminAuthenticated = false;
      draggingId = null;
      renderAdmin();
      setConnectionStatus("offline");
    },
  });
}

function renderAdmin() {
  for (const id of pendingRemovals.keys()) {
    if (!adminAuthenticated || !adminState.queue.some(item => item.id === id)) cancelRemoval(id);
  }
  document.getElementById("admin-title").textContent = t("adminRoomTitle", { code: adminRoom.code || Room.code });
  document.title = document.getElementById("admin-title").textContent;
  const autoQueueToggle = document.getElementById("admin-auto-queue");
  autoQueueToggle.textContent = t("autoQueue", { state: t(adminState.autoQueue ? "On" : "Off") });
  autoQueueToggle.setAttribute("aria-pressed", String(!!adminState.autoQueue));
  document.getElementById("room-label").textContent = t("roomCode", { code: adminRoom.code || Room.code });
  renderNowPlaying(adminState);
  document.getElementById("admin-cooldown-label").textContent = t("cooldown", { seconds: adminRoom.cooldownSeconds });
  renderParticipants();
  adminControls.forEach((el) => { el.disabled = !adminAuthenticated; });
  const focusedPlayback = document.activeElement?.id;
  document.getElementById("admin-play").hidden = !adminState.paused;
  document.getElementById("admin-pause").hidden = !!adminState.paused;
  document.getElementById("admin-play").disabled = !adminAuthenticated || !adminState.paused;
  document.getElementById("admin-pause").disabled = !adminAuthenticated || adminState.paused;
  if (adminAuthenticated && ["admin-play", "admin-pause"].includes(focusedPlayback)) {
    document.getElementById(adminState.paused ? "admin-play" : "admin-pause").focus();
  }
  document.getElementById("admin-volume").value = adminState.volume;
  document.getElementById("admin-volume-value").textContent = `${adminState.volume}%`;
  if (!adminAuthenticated) {
    closeQueueMenu(false);
    closeVolume();
    if (settingsDrawer.open) settingsDrawer.close();
  }
  // Keep the DOM order during a pointer drag; server validation handles concurrent edits.
  if (draggingId) return;
  document.getElementById("queue-count").textContent = adminState.queue.length;
  const queueEl = document.getElementById("queue");
  const focusedAction = queueEl.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
  queueEl.replaceChildren();
  if (!adminState.queue.length) {
    const li = document.createElement("li");
    li.className = "q-empty";
    li.textContent = t("empty");
    queueEl.append(li);
  }
  for (const item of adminState.queue) {
    const li = document.createElement("li");
    li.dataset.id = item.id;
    const handle = document.createElement("button");
    handle.dataset.queueId = item.id;
    handle.dataset.queueAction = "drag";
    handle.className = "drag-handle";
    handle.innerHTML = '<svg width="18" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
    handle.setAttribute("aria-label", t("drag"));
    handle.disabled = !adminAuthenticated;
    const img = document.createElement("img");
    img.src = item.thumbnail || NO_THUMB;
    img.alt = "";
    const meta = document.createElement("div");
    meta.className = "q-text";
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = item.title;
    const sub = document.createElement("div");
    sub.className = "s";
    sub.textContent = songMeta(item, true);
    sub.title = songMeta(item);
    meta.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "queue-actions";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "queue-more";
    more.dataset.queueId = item.id;
    more.dataset.queueAction = "more";
    more.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
    more.setAttribute("aria-label", t("moreSongActions", { title: item.title }));
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", "queue-menu");
    more.setAttribute("aria-expanded", String(queueMenuId === item.id));
    more.disabled = !adminAuthenticated;
    more.onclick = () => openQueueMenu(item.id);
    actions.append(more);
    li.append(handle, img, meta, actions);
    if (pendingRemovals.has(item.id)) {
      const pending = pendingRemovals.get(item.id);
      const notice = document.createElement("div");
      notice.className = "removal-notice";
      const label = document.createElement("span");
      label.className = "remove-countdown";
      label.setAttribute("role", "status");
      label.setAttribute("aria-live", "polite");
      label.textContent = t("removeCountdown", { seconds: Math.max(1, Math.ceil((pending.deadline - Date.now()) / 1000)) });
      pending.label = label;
      const cancel = document.createElement("button");
      cancel.dataset.queueId = item.id;
      cancel.dataset.queueAction = "remove";
      cancel.className = "cancel-removal";
      cancel.textContent = t("cancelRemoval");
      cancel.onclick = () => { cancelRemoval(item.id); renderAdmin(); queueButton(item.id)?.focus(); };
      notice.append(label, cancel);
      li.append(notice);
    }
    queueEl.append(li);
    handle.onkeydown = (event) => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key) || !adminAuthenticated) return;
      event.preventDefault();
      adminSend({ type: "move", id: item.id, dir: event.key === "ArrowUp" ? "up" : "down" });
    };
    handle.onpointerdown = (event) => {
      if (!adminAuthenticated || event.button !== 0) return;
      closeQueueMenu(false);
      draggingId = item.id;
      handle.setPointerCapture(event.pointerId);
      li.classList.add("dragging");
    };
    handle.onpointermove = (event) => {
      if (draggingId !== item.id) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("#queue li[data-id]");
      if (!target || target === li) return;
      const box = target.getBoundingClientRect();
      queueEl.insertBefore(li, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
      // Moving the handle in the DOM releases pointer capture in browsers.
      handle.setPointerCapture(event.pointerId);
      if (event.clientY < 70) window.scrollBy(0, -18);
      if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
    };
    handle.onpointerup = () => {
      if (draggingId !== item.id) return;
      const ids = [...queueEl.querySelectorAll("li[data-id]")].map((row) => row.dataset.id);
      draggingId = null;
      adminSend({ type: "reorder", ids });
      renderAdmin();
    };
    handle.onpointercancel = () => { draggingId = null; renderAdmin(); };
  }
  if (focusedAction?.queueId) {
    [...queueEl.querySelectorAll("button")].find(button => button.dataset.queueId === focusedAction.queueId &&
      button.dataset.queueAction === focusedAction.queueAction)?.focus();
  }
  updateQueueMenu();
}

for (const action of ["play", "pause", "skip"]) {
  document.getElementById(`admin-${action}`).onclick = () => adminSend({ type: action });
}
document.getElementById("admin-clear").onclick = () => {
  if (confirm(t("clearConfirm"))) adminSend({ type: "clear" });
};
document.getElementById("admin-volume").oninput = (event) => {
  document.getElementById("admin-volume-value").textContent = `${event.target.value}%`;
  adminSend({ type: "setVolume", volume: Number(event.target.value) });
};
function renderParticipants() {
  const list = document.getElementById("participants-list");
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.participantId : null;
  list.replaceChildren();
  const visible = adminAuthenticated && ["admin", "controller"].includes(adminRoom.role);
  setParticipantsVisible(visible);
  if (!visible) return;
  for (const person of adminRoom.participants || []) {
    const row = document.createElement("li");
    const label = document.createElement("div");
    label.className = "participant-meta";
    label.tabIndex = -1;
    label.dataset.participantId = person.id;
    let focusTarget = label;
    const name = document.createElement("div");
    name.className = "participant-name";
    name.textContent = person.name;
    const detail = document.createElement("div");
    detail.className = "participant-detail";
    const dot = document.createElement("span");
    dot.className = `participant-dot${person.online ? " online" : ""}`;
    dot.setAttribute("aria-hidden", "true");
    const description = document.createElement("span");
    const role = person.role === "admin" ? t("primaryAdmin") : person.role === "controller" ? t("controller")
      : t(person.role === "player" ? "playerRole" : "guestRole");
    description.textContent = `${role} · ${t(person.online ? "online" : "participantOffline")}`;
    detail.append(dot, description);
    label.append(name, detail);
    row.append(label);
    if (!["admin", "player"].includes(person.role) &&
        (adminRoom.role === "admin" || (adminRoom.role === "controller" && person.role === "guest"))) {
      const button = document.createElement("button");
      const enabled = person.role !== "controller";
      button.type = "button";
      button.dataset.participantId = person.id;
      focusTarget = button;
      button.title = t(enabled ? "grantControl" : "revokeControl");
      button.setAttribute("aria-label", button.title);
      button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 10h6${enabled ? 'M19 7v6' : ''}"/></svg>`;
      button.onclick = () => adminSend({ type: "setParticipantRole", id: person.id, enabled });
      row.append(button);
    }
    list.append(row);
    if (person.id === focusedId) focusTarget.focus();
  }
}
document.getElementById("admin-cooldown").onclick = () => {
  const steps = [0, 5, 10, 15, 30, 60];
  adminSend({ type: "setCooldown", seconds: steps[(steps.indexOf(adminRoom.cooldownSeconds) + 1) % steps.length] });
};
document.getElementById("admin-auto-queue").onclick = () => adminSend({ type: "setAutoQueue", enabled: !adminState.autoQueue });
const settingsDrawer = document.getElementById("settings-drawer");
const volumePanel = document.getElementById("volume-panel");
const volumeToggle = document.getElementById("admin-volume-toggle");
const queueMenu = document.getElementById("queue-menu");
let queueMenuId = null;
let feedbackTimer;
function showAdminFeedback(message) {
  adminFeedback.textContent = message;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { adminFeedback.textContent = ""; }, 4000);
}
function queueButton(id) {
  return [...document.getElementById("queue").querySelectorAll("button")]
    .find(button => button.dataset.queueId === id && button.dataset.queueAction === "more");
}
function closeQueueMenu(restoreFocus = true) {
  const trigger = queueButton(queueMenuId);
  trigger?.setAttribute("aria-expanded", "false");
  queueMenu.hidden = true;
  queueMenuId = null;
  if (restoreFocus) trigger?.focus();
}
function positionQueueMenu() {
  const trigger = queueButton(queueMenuId);
  if (!trigger) return closeQueueMenu(false);
  const rect = trigger.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const right = left + (viewport?.width || window.innerWidth);
  const bottom = top + (viewport?.height || window.innerHeight);
  queueMenu.style.maxHeight = `${Math.max(44, bottom - top - 16)}px`;
  const width = queueMenu.offsetWidth;
  const height = queueMenu.offsetHeight;
  queueMenu.style.left = `${Math.max(left + 8, Math.min(rect.right - width, right - width - 8))}px`;
  const y = rect.bottom + height + 8 <= bottom ? rect.bottom + 4 : rect.top - height - 4;
  queueMenu.style.top = `${Math.max(top + 8, Math.min(y, bottom - height - 8))}px`;
}
const menuButtons = ["playNow", "moveUp", "moveDown", "remove"].map(key => {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.tabIndex = -1;
  button.dataset.queueAction = key;
  button.className = key === "remove" ? "destructive" : "";
  button.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${queueIcons[key]}</svg><span>${t(key)}</span>`;
  button.onclick = () => {
    const id = queueMenuId;
    closeQueueMenu();
    if (!adminAuthenticated || !adminState.queue.some(item => item.id === id)) return;
    if (key === "remove") {
      startRemoval(id);
      [...document.getElementById("queue").querySelectorAll("button")]
        .find(el => el.dataset.queueId === id && el.className === "cancel-removal")?.focus();
    } else adminSend(key === "playNow" ? { type: "playNow", id }
      : { type: "move", id, dir: key === "moveUp" ? "up" : "down" });
  };
  queueMenu.append(button);
  return button;
});
function updateQueueMenu() {
  if (!queueMenuId) return;
  const index = adminState.queue.findIndex(item => item.id === queueMenuId);
  if (!adminAuthenticated || index < 0) return closeQueueMenu(false);
  menuButtons[1].disabled = index === 0;
  menuButtons[2].disabled = index === adminState.queue.length - 1;
  menuButtons[3].disabled = pendingRemovals.has(queueMenuId);
  if (menuButtons.includes(document.activeElement) && document.activeElement.disabled) menuButtons[0].focus();
  positionQueueMenu();
}
function openQueueMenu(id) {
  if (!adminAuthenticated) return;
  if (queueMenuId === id) return closeQueueMenu();
  closeQueueMenu(false);
  closeVolume();
  queueMenuId = id;
  queueMenu.hidden = false;
  queueButton(id)?.setAttribute("aria-expanded", "true");
  updateQueueMenu();
  menuButtons[0].focus();
}
queueMenu.onkeydown = event => {
  if (event.key === "Tab") return closeQueueMenu();
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const enabled = menuButtons.filter(button => !button.disabled);
  const index = enabled.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
    : (index + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
  enabled[next].focus();
};
function closeVolume() {
  volumePanel.hidden = true;
  volumeToggle.setAttribute("aria-expanded", "false");
}
volumeToggle.onclick = () => {
  closeQueueMenu(false);
  volumePanel.hidden = !volumePanel.hidden;
  volumeToggle.setAttribute("aria-expanded", String(!volumePanel.hidden));
  if (!volumePanel.hidden) document.getElementById("admin-volume").focus();
};
document.getElementById("admin-settings").onclick = () => {
  if (!adminAuthenticated) return;
  closeQueueMenu(false);
  closeVolume();
  settingsDrawer.showModal();
};
settingsDrawer.onclick = event => {
  if (event.target !== settingsDrawer) return;
  const rect = settingsDrawer.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settingsDrawer.close();
};
document.addEventListener("pointerdown", event => {
  if (!queueMenu.hidden && !queueMenu.contains(event.target) && !queueButton(queueMenuId)?.contains(event.target)) closeQueueMenu(false);
  if (!volumePanel.hidden && !volumePanel.contains(event.target) && !volumeToggle.contains(event.target)) closeVolume();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!queueMenu.hidden) { event.preventDefault(); closeQueueMenu(); }
  if (!volumePanel.hidden) { event.preventDefault(); closeVolume(); volumeToggle.focus(); }
});
window.addEventListener("scroll", event => { if (!queueMenu.hidden && !queueMenu.contains(event.target)) closeQueueMenu(false); }, true);
window.addEventListener("resize", () => { if (!queueMenu.hidden) positionQueueMenu(); });
window.visualViewport?.addEventListener("resize", () => { if (!queueMenu.hidden) positionQueueMenu(); });
window.addEventListener("pagehide", () => { cancelPendingRemovals(); closeQueueMenu(false); closeVolume(); if (settingsDrawer.open) settingsDrawer.close(); });

Room.ready.then((joined) => { if (joined) connectAdmin(); });
