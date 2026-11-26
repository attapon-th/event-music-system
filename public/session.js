// Shared entry forms, room credentials, role redirects and authenticated reconnects.
const Room = (() => {
  const params = new URLSearchParams(location.search);
  const screen = document.body.dataset.screen || (document.body.dataset.admin === "true" ? "admin" : "guest");
  const isPlayer = screen === "player";
  const content = document.getElementById("room-content");
  let current = null;
  let socket = null;
  let handlers = null;
  let retry = null;
  let stopped = false;
  let authenticated = false;
  const panel = document.createElement("section");
  panel.className = `session-panel${isPlayer ? " player-entry" : ""}`;
  const joinForm = `
    <form id="room-join"${isPlayer ? " hidden" : ""} aria-labelledby="join-room-title">
      <h2 id="join-room-title">${t("joinRoom")}</h2>
      <label>${t("roomNumber")} <input id="room-code" type="text" inputmode="numeric" pattern="[1-9][0-9]{2}" maxlength="3" autocomplete="off" required></label>
      <button type="submit">${t("enterRoom")}</button>
    </form>`;
  panel.innerHTML = `
    <p id="room-error" role="status" aria-live="polite"></p>
    ${isPlayer ? `
      <div id="room-welcome" class="start-card">
        <img class="start-logo" src="/icons/qp.svg" width="104" height="104" alt="">
        <h1>${t("Event Music System")}</h1>
        <button id="start-btn" type="button">${t("▶  Start")}</button>
        ${joinForm}
        <div class="entry-actions">
          <button id="open-player-entry" type="button" aria-controls="room-join" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-2-14 5 3.5-5 3.5Z"/></svg>${t("playerEntry")}</button>
          <button id="open-queue-entry" type="button" aria-controls="room-join" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h8m7 0v6m-3-3h6"/></svg>${t("queueEntry")}</button>
        </div>
      </div>` : joinForm}
    <p id="room-retry" role="status" aria-live="polite"></p>`;
  document.body.prepend(panel);
  const node = (id) => document.getElementById(id);
  if (content) content.hidden = true;
  document.body.dataset.roomActive = "false";
  node("room-code").value = params.get("room") || "";
  const key = (id, player) => `music-session:${id}:${player ? "player" : "member"}`;
  const credentialStorage = (player) => player ? sessionStorage : localStorage;
  if (isPlayer) localStorage.removeItem("music-last-player");
  function saved(code, id, player) {
    const knownId = id || localStorage.getItem(`music-room:${code}`);
    return knownId ? credentialStorage(player).getItem(key(knownId, player)) : null;
  }
  function remember(member) {
    current = member;
    clearTimeout(retry);
    stopped = false;
    credentialStorage(member.role === "player").setItem(key(member.sessionId, member.role === "player"), member.token);
    localStorage.setItem(`music-room:${member.code}`, member.sessionId);
  }
  function url(target) {
    return `${target === "player" ? "/" : target === "admin" ? "/a" : "/guest"}?room=${current.code}&session=${current.sessionId}`;
  }
  const privileged = () => ["admin", "controller"].includes(current?.role);
  function routeForRole() {
    if ((screen === "guest" && privileged()) || (screen === "admin" && !privileged())) {
      handlers?.onEnd?.();
      location.replace(url(privileged() ? "admin" : "guest"));
      return false;
    }
    return true;
  }
  function applyState(state) {
    if (state.role) current.role = state.role;
    if (!routeForRole()) return false;
    panel.hidden = true;
    document.body.dataset.roomActive = "true";
    if (content) content.hidden = false;
    return true;
  }
  function end(message, forget = true) {
    stopped = true;
    authenticated = false;
    clearTimeout(retry);
    if (current && forget && credentialStorage(current.role === "player").getItem(key(current.sessionId, current.role === "player")) === current.token) {
      credentialStorage(current.role === "player").removeItem(key(current.sessionId, current.role === "player"));
    }
    current = null;
    handlers?.onEnd?.();
    socket?.close();
    panel.hidden = false;
    document.body.dataset.roomActive = "false";
    if (content) content.hidden = true;
    if (isPlayer) {
      setEntryMode(null);
      node("room-code").value = "";
      node("start-btn").focus();
    }
    node("room-error").textContent = message;
    if (screen === "player") history.replaceState(null, "", "/");
  }
  function unavailable(message) {
    authenticated = false;
    if (screen === "player" && current && handlers?.onUnavailable) {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
      if (handlers.onUnavailable(message)) return;
    }
    end(message);
  }
  async function api(path, options = {}, token = current?.token, sessionId = current?.sessionId) {
    const response = await fetch(path, { ...options, cache: "no-store", headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "X-Session-Id": sessionId } : {}), ...options.headers,
    } });
    const data = await response.json();
    if (!response.ok) {
      if (data.code === "SESSION_INVALID" && current) unavailable(data.error);
      const error = new Error(data.error || data.reason || t("roomActionFailed"));
      error.status = response.status;
      error.retryIn = data.retryIn;
      throw error;
    }
    return data;
  }
  const post = (path, body, token, id) => api(path, { method: "POST", body: JSON.stringify(body) }, token, id);
  function connect(callbacks) {
    if (!current || stopped) return null;
    handlers = callbacks;
    authenticated = false;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    socket = ws;
    ws.onopen = () => {
      if (ws !== socket || !current) return;
      ws.send(JSON.stringify({ type: "auth", token: current.token, sessionId: current.sessionId,
        name: localStorage.getItem(`music-nickname:${current.sessionId}`) || localStorage.getItem("guestNickname") || "ผู้เข้าร่วม",
        ...callbacks.authData?.() }));
    };
    ws.onmessage = ({ data }) => {
      if (ws !== socket || stopped) return;
      const msg = JSON.parse(data);
      if (msg.type === "auth" && !msg.ok) {
        unavailable(msg.error || t("roomUnavailable"));
        return;
      }
      if (msg.type === "sessionEnded") {
        end(msg.error || t("roomUnavailable"));
        return;
      }
      if (msg.type === "auth") {
        authenticated = true;
        current.role = msg.role;
        if (routeForRole()) callbacks.onAuth?.(msg);
      }
      if (msg.type === "state" && applyState(msg)) callbacks.onState?.(msg);
      if (msg.type === "error") callbacks.onError?.(msg);
    };
    ws.onclose = () => {
      if (ws !== socket || stopped) return;
      authenticated = false;
      callbacks.onOffline?.();
      retry = setTimeout(() => connect(callbacks), 1500);
    };
    return ws;
  }
  function send(message) {
    if (!stopped && authenticated && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  const joinFormNode = node("room-join");
  const joinSubmit = joinFormNode.querySelector('button[type="submit"]');
  const playerEntry = isPlayer ? node("open-player-entry") : null;
  const queueEntry = isPlayer ? node("open-queue-entry") : null;
  let entryMode = null;
  let busy = false;
  let retryUntil = 0;
  let queueRetryUntil = 0;
  let countdownTimer;
  let missingRoomMessage = "";

  function countdown() {
    clearTimeout(countdownTimer);
    const remaining = Math.max(retryUntil, entryMode === "queue" ? queueRetryUntil : 0) - Date.now();
    joinSubmit.disabled = busy || remaining > 0;
    if (isPlayer) {
      playerEntry.disabled = queueEntry.disabled = busy;
      node("start-btn").disabled = busy || Date.now() < retryUntil;
    }
    node("room-retry").textContent = remaining > 0 ? t("entryRetry", { seconds: Math.ceil(remaining / 1000) }) : "";
    if (remaining > 0) countdownTimer = setTimeout(countdown, Math.min(1000, remaining));
  }
  function setEntryMode(mode) {
    entryMode = mode;
    joinFormNode.hidden = !mode;
    playerEntry.setAttribute("aria-expanded", String(mode === "player"));
    queueEntry.setAttribute("aria-expanded", String(mode === "queue"));
    node("join-room-title").textContent = t(mode === "player" ? "playerEntry" : "queueEntry");
    joinSubmit.textContent = t(mode === "player" ? "createOrJoin" : "enterRoom");
    node("room-error").textContent = mode === "queue" && Date.now() < queueRetryUntil ? missingRoomMessage : "";
    countdown();
    if (mode) node("room-code").focus();
  }
  async function runEntry(action, mode) {
    if (busy || Date.now() < Math.max(retryUntil, mode === "queue" ? queueRetryUntil : 0)) return;
    busy = true;
    countdown();
    node("room-error").textContent = "";
    try { await action(); } catch (error) {
      node("room-error").textContent = error.status ? error.message : t("networkError");
      if (mode === "queue" && error.status === 410) {
        missingRoomMessage = error.message;
        queueRetryUntil = Date.now() + 10000;
      } else if ([400, 401, 410, 429].includes(error.status)) {
        const seconds = Number(error.retryIn);
        const wait = error.status === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
        retryUntil = Date.now() + wait * 1000;
      }
    } finally {
      busy = false;
      countdown();
    }
  }
  function openPlayer(member) {
    remember(member);
    setEntryMode(null);
    node("room-code").value = "";
    applyState({ role: "player" });
    history.replaceState(null, "", url("player"));
    Room.onJoined?.(); // Keep the creation gesture in this document for browser audio.
  }
  joinFormNode.onsubmit = (event) => {
    event.preventDefault();
    if (isPlayer && !entryMode) return;
    return runEntry(async () => {
      const code = node("room-code").value;
      if (entryMode === "player") {
        const sum = [...code].reduce((total, digit) => total + Number(digit), 0);
        openPlayer(await post("/api/sessions", { code: `${code}${sum}` }));
        return;
      }
      remember(await post("/api/sessions/join", { code }, saved(code, null, false)));
      location.replace(url(privileged() ? "admin" : "guest"));
    }, entryMode);
  };
  if (isPlayer) {
    playerEntry.onclick = () => setEntryMode("player");
    queueEntry.onclick = () => setEntryMode("queue");
    node("start-btn").onclick = () => runEntry(async () => openPlayer(await post("/api/sessions/random", {})));
    node("start-btn").focus();
  }
  function closeEntry() {
    if (!entryMode || busy) return false;
    const trigger = entryMode === "player" ? playerEntry : queueEntry;
    setEntryMode(null);
    trigger.focus();
    return true;
  }
  async function init() {
    const code = params.get("room");
    if (!code) return false;
    const id = params.get("session") || undefined;
    const token = saved(code, id, screen === "player");
    try {
      if (screen === "player") {
        if (!token) return false;
        const member = await api("/api/info", {}, token, id);
        if (member.code !== code || member.role !== "player") return false;
        remember(member);
      } else {
        remember(await post("/api/sessions/join", { code, ...(id ? { sessionId: id } : {}) }, token, id));
      }
      if (!applyState({ role: current.role })) return false;
      history.replaceState(null, "", url(screen));
      return true;
    } catch (error) {
      node("room-error").textContent = error.message;
      if (!error.status) retry = setTimeout(() => location.reload(), 3000);
      return false;
    }
  }
  return { ready: init(), fetch: api, connect, send, finish: end, closeEntry,
    leave() { end("", true); },
    get connected() { return authenticated && socket?.readyState === WebSocket.OPEN; },
    get sessionId() { return current?.sessionId; },
    get token() { return current?.token; }, get code() { return current?.code; } };
})();
