// Uses the shared search UI and room-scoped authoritative snapshots.
let adminState = { nowPlaying: null, queue: [], paused: false, volume: 60 };
let adminAuthenticated = false;
let adminRoom = { participants: [], filterOn: false, moderationMode: "default", cooldownSeconds: 15 };
let draggingId = null;
const adminFeedback = document.getElementById("admin-feedback");
const adminControls = document.querySelectorAll(".admin-controls button, .admin-controls input");
const queueIcons = {
  playNow: '<path d="m8 5 11 7-11 7Z"/>',
  moveUp: '<path d="m6 14 6-6 6 6"/>',
  moveDown: '<path d="m6 10 6 6 6-6"/>',
  remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};

function adminSend(message) {
  if (adminAuthenticated) {
    Room.send(message);
  } else adminFeedback.textContent = t("offline");
}

function connectAdmin() {
  Room.connect({
    onAuth(msg) {
      adminRoom.role = msg.role;
      adminAuthenticated = ["admin", "controller"].includes(msg.role);
      document.getElementById("connection").textContent = t(adminAuthenticated ? "connected" : "authFailed");
      renderAdmin();
    },
    onState(msg) {
      adminRoom = msg;
      adminAuthenticated = ["admin", "controller"].includes(msg.role);
      adminState = msg.state;
      lastQueueState = msg.state;
      renderAdmin();
    },
    onError(msg) { adminFeedback.textContent = msg.error; },
    onOffline() {
      adminAuthenticated = false;
      draggingId = null;
      renderAdmin();
      document.getElementById("connection").textContent = t("offline");
    },
  });
}

function renderAdmin() {
  document.getElementById("admin-title").textContent = t("adminRoomTitle", { code: adminRoom.code || Room.code });
  document.title = document.getElementById("admin-title").textContent;
  const autoQueueToggle = document.getElementById("admin-auto-queue");
  autoQueueToggle.textContent = t("autoQueue", { state: t(adminState.autoQueue ? "On" : "Off") });
  autoQueueToggle.setAttribute("aria-pressed", String(!!adminState.autoQueue));
  document.getElementById("auto-queue-status").textContent = autoQueueMessage(adminState);
  document.getElementById("admin-cooldown-label").textContent = t("cooldown", { seconds: adminRoom.cooldownSeconds });
  renderParticipants();
  adminControls.forEach((el) => { el.disabled = !adminAuthenticated; });
  document.getElementById("admin-play").disabled = !adminAuthenticated || !adminState.paused;
  document.getElementById("admin-pause").disabled = !adminAuthenticated || adminState.paused;
  document.getElementById("admin-volume").value = adminState.volume;
  document.getElementById("admin-volume-value").textContent = `${adminState.volume}%`;
  // Keep the DOM order during a pointer drag; server validation handles concurrent edits.
  if (draggingId) return;
  renderQueue(adminState); // shared Guest renderer for Now Playing
  const np = adminState.nowPlaying;
  if (np) document.querySelector("#now-playing .np-sub").textContent = songMeta(np);
  else {
    const now = document.getElementById("now-playing");
    now.classList.remove("hidden");
    now.textContent = t("idle");
  }
  const queueEl = document.getElementById("queue");
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
    handle.className = "drag-handle";
    handle.textContent = "☰";
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
    sub.textContent = songMeta(item);
    meta.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "queue-actions";
    for (const [key, message] of [
      ["playNow", { type: "playNow", id: item.id }],
      ["moveUp", { type: "move", id: item.id, dir: "up" }],
      ["moveDown", { type: "move", id: item.id, dir: "down" }],
      ["remove", { type: "remove", id: item.id }],
    ]) {
      const button = document.createElement("button");
      button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${queueIcons[key]}</svg>`;
      button.title = t(key);
      button.setAttribute("aria-label", t(key));
      button.disabled = !adminAuthenticated;
      button.onclick = () => adminSend(message);
      actions.append(button);
    }
    li.append(handle, img, meta, actions);
    queueEl.append(li);
    handle.onpointerdown = (event) => {
      if (!adminAuthenticated || event.button !== 0) return;
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
}

function songMeta(item) {
  return [item.channel, item.duration, item.autoQueued && t("autoQueued"), item.addedBy && t("requester", { name: item.addedBy })].filter(Boolean).join(" · ");
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
  list.replaceChildren();
  const visible = adminAuthenticated && adminRoom.role === "admin";
  setParticipantsVisible(visible);
  if (!visible) return;
  for (const person of adminRoom.participants || []) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    const role = person.role === "admin" ? t("primaryAdmin") : person.role === "controller" ? t("controller")
      : person.role === "player" ? "Player" : "Guest";
    label.textContent = `${person.name} · ${role} · ${t(person.online ? "online" : "participantOffline")}`;
    row.append(label);
    if (adminAuthenticated && adminRoom.memberId === adminRoom.primaryAdminId && !["admin", "player"].includes(person.role)) {
      const button = document.createElement("button");
      const enabled = person.role !== "controller";
      button.type = "button";
      button.title = t(enabled ? "grantControl" : "revokeControl");
      button.setAttribute("aria-label", button.title);
      button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 10h6${enabled ? 'M19 7v6' : ''}"/></svg>`;
      button.onclick = () => adminSend({ type: "setParticipantRole", id: person.id, enabled });
      row.append(button);
    }
    list.append(row);
  }
}
document.getElementById("admin-cooldown").onclick = () => {
  const steps = [0, 5, 10, 15, 30, 60];
  adminSend({ type: "setCooldown", seconds: steps[(steps.indexOf(adminRoom.cooldownSeconds) + 1) % steps.length] });
};
document.getElementById("admin-auto-queue").onclick = () => adminSend({ type: "setAutoQueue", enabled: !adminState.autoQueue });
Room.ready.then((joined) => { if (joined) connectAdmin(); });
