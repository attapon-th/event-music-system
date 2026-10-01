// Uses the same request/search UI, host token, and authoritative WS snapshots.
let adminSocket;
let adminState = { nowPlaying: null, queue: [], paused: false, volume: 100 };
let adminAuthenticated = false;
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
  if (adminAuthenticated && adminSocket?.readyState === WebSocket.OPEN) {
    adminSocket.send(JSON.stringify(message));
  } else adminFeedback.textContent = t("offline");
}

async function connectAdmin() {
  adminAuthenticated = false;
  adminControls.forEach((el) => { el.disabled = true; });
  document.getElementById("connection").textContent = t("connecting");
  try {
    const response = await fetch("/api/host-token", { cache: "no-store" });
    if (!response.ok) throw new Error(t("authFailed"));
    const { token } = await response.json();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    adminSocket = new WebSocket(`${proto}://${location.host}`);
    adminSocket.onopen = () => adminSocket.send(JSON.stringify({ type: "auth", token }));
    adminSocket.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "auth") {
        adminAuthenticated = msg.ok;
        document.getElementById("connection").textContent = t(msg.ok ? "connected" : "authFailed");
        renderAdmin();
      }
      if (msg.type === "state") {
        adminState = msg.state;
        lastQueueState = msg.state;
        renderAdmin();
      }
      if (msg.type === "error") adminFeedback.textContent = msg.error;
    };
    adminSocket.onclose = () => {
      adminAuthenticated = false;
      draggingId = null;
      renderAdmin();
      document.getElementById("connection").textContent = t("offline");
      setTimeout(connectAdmin, 1500);
    };
  } catch (err) {
    document.getElementById("connection").textContent = err.message;
    setTimeout(connectAdmin, 3000);
  }
}

function renderAdmin() {
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
  return [item.channel, item.duration, item.addedBy && t("requester", { name: item.addedBy })].filter(Boolean).join(" · ");
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
connectAdmin();
