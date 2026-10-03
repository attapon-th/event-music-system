// Shared entry forms, room credentials, role redirects and authenticated reconnects.
const Room = (() => {
  const params = new URLSearchParams(location.search);
  const screen = document.body.dataset.screen || (document.body.dataset.admin === "true" ? "admin" : "guest");
  const content = document.getElementById("room-content");
  let current = null;
  let socket = null;
  let handlers = null;
  let retry = null;
  let stopped = false;
  let authenticated = false;
  const panel = document.createElement("section");
  panel.className = `session-panel${screen === "player" ? " player-entry" : ""}`;
  panel.innerHTML = `
    <p id="room-error" role="status" aria-live="polite"></p>
    <div id="room-welcome" class="start-card" ${screen === "player" ? "" : "hidden"}>
      <img class="start-logo" src="/icons/qp.svg" width="104" height="104" alt="" aria-hidden="true">
      <h1>${t("Event Music System")}</h1>
      <p id="start-prompt">${t("Click to start the jukebox.")}</p>
      <button id="start-btn" type="button">${t("▶  Start")}</button>
      <form id="room-create" hidden>
        <input id="entry-code" type="text" inputmode="numeric" pattern="[0-9]+" placeholder="${t("entryCredential")}" aria-label="${t("entryCredential")}" autocomplete="off" required>
        <button type="submit" title="${t("next")}" aria-label="${t("next")}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12h16m-7-7 7 7-7 7"/></svg></button>
      </form>
      <small>${t("Make sure this window's audio goes to the venue's AV system.")}</small>
    </div>
    <form id="room-join" ${screen === "player" ? "hidden" : ""}>
      <h2>${t("joinRoom")}</h2>
      <label>${t("roomNumber")} <input id="room-code" type="text" inputmode="numeric" pattern="[1-9][0-9]{2}" maxlength="3" autocomplete="off" required></label>
      <button type="submit">${t("enterRoom")}</button>
    </form>
    <p id="room-retry" role="status" aria-live="polite"></p>`;
  document.body.prepend(panel);
  const node = (id) => document.getElementById(id);
  if (screen === "player") {
    node("start-btn").onclick = () => {
      node("start-btn").hidden = true;
      node("start-prompt").hidden = true;
      node("room-create").hidden = false;
      node("entry-code").focus();
    };
    node("start-btn").focus();
  }
  if (content) content.hidden = true;
  document.body.dataset.roomActive = "false";
  node("room-code").value = params.get("room") || "";
  const key = (id, player) => `music-session:${id}:${player ? "player" : "member"}`;
  function saved(code, id, player) {
    const knownId = id || localStorage.getItem(`music-room:${code}`);
    return knownId ? localStorage.getItem(key(knownId, player)) : null;
  }
  function remember(member) {
    current = member;
    clearTimeout(retry);
    stopped = false;
    localStorage.setItem(key(member.sessionId, member.role === "player"), member.token);
    localStorage.setItem(`music-room:${member.code}`, member.sessionId);
  }
  function url(target) {
    return `${target === "player" ? "/" : target === "admin" ? "/a" : "/guest"}?room=${current.code}&session=${current.sessionId}`;
  }
  const privileged = () => ["admin", "controller"].includes(current?.role);
  function routeForRole() {
    if ((screen === "guest" && privileged()) || (screen === "admin" && !privileged())) {
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
    const claim = node("claim-admin");
    if (claim) claim.hidden = current.role !== "guest" || !!state.primaryAdminId;
    return true;
  }
  function end(message, forget = true) {
    stopped = true;
    authenticated = false;
    clearTimeout(retry);
    if (current && forget && localStorage.getItem(key(current.sessionId, current.role === "player")) === current.token) {
      localStorage.removeItem(key(current.sessionId, current.role === "player"));
    }
    current = null;
    handlers?.onEnd?.();
    socket?.close();
    panel.hidden = false;
    document.body.dataset.roomActive = "false";
    if (content) content.hidden = true;
    if (screen === "player") {
      node("room-create").hidden = true;
      node("entry-code").value = "";
      node("start-btn").hidden = false;
      node("start-prompt").hidden = false;
      node("start-btn").focus();
    }
    const claim = node("claim-admin");
    if (claim) claim.hidden = true;
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
      if (data.code === "SESSION_INVALID") unavailable(data.error);
      const error = new Error(data.error || t("roomActionFailed"));
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
        end(msg.error || t("roomUnavailable"), msg.code !== "PLAYER_MOVED");
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
  function submit(form, action) {
    const button = form.querySelector('button[type="submit"]');
    let busy = false;
    let retryUntil = 0;
    function countdown() {
      const left = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      button.disabled = busy || left > 0;
      node("room-retry").textContent = left ? t("entryRetry", { seconds: left }) : "";
      if (left) setTimeout(countdown, Math.min(1000, retryUntil - Date.now()));
    }
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || Date.now() < retryUntil) return;
      busy = true;
      button.disabled = true;
      node("room-error").textContent = "";
      try { await action(); } catch (error) {
        node("room-error").textContent = error.message;
        if ([400, 401, 410, 429].includes(error.status)) {
          const seconds = Number(error.retryIn);
          const wait = error.status === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
          retryUntil = Date.now() + wait * 1000;
        }
      }
      finally { busy = false; countdown(); }
    };
  }
  submit(node("room-create"), async () => {
    const credential = node("entry-code").value;
    const code = credential.trim();
    if (/^[1-9][0-9]{2}$/.test(code)) {
      remember(await post("/api/sessions/join", { code }, saved(code, null, false)));
      location.replace(url(privileged() ? "admin" : "guest"));
      return;
    }
    remember(await post("/api/sessions", { password: credential }));
    node("entry-code").value = "";
    applyState({ role: "player" });
    history.replaceState(null, "", url("player"));
    Room.onJoined?.(); // Keep the creation gesture in this document for browser audio.
  });
  submit(node("room-join"), async () => {
    const code = node("room-code").value;
    remember(await post("/api/sessions/join", { code }, saved(code, null, false)));
    location.replace(url(privileged() ? "admin" : "guest"));
  });
  const claim = node("claim-admin");
  if (claim) claim.onclick = async () => {
    claim.disabled = true;
    node("claim-error").hidden = true;
    try {
      remember(await post("/api/sessions/admin/claim", {}));
      location.replace(url("admin"));
    } catch (error) {
      node("claim-error").textContent = error.message;
      node("claim-error").hidden = false;
    }
    finally { claim.disabled = false; }
  };
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
      // Owner identity arrives with the first WS snapshot; hide claim until then.
      if (!applyState({ role: current.role, primaryAdminId: true })) return false;
      history.replaceState(null, "", url(screen));
      return true;
    } catch (error) {
      node("room-error").textContent = error.message;
      if (!error.status) retry = setTimeout(() => location.reload(), 3000);
      return false;
    }
  }
  return { ready: init(), fetch: api, connect, send, finish: end,
    async close() { if (!stopped) await post("/api/sessions/close", {}); end("", true); },
    get connected() { return authenticated && socket?.readyState === WebSocket.OPEN; },
    get sessionId() { return current?.sessionId; },
    get token() { return current?.token; }, get code() { return current?.code; } };
})();
