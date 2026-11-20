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
    <form id="room-join" ${isPlayer ? 'class="room-option" tabindex="-1" aria-labelledby="join-room-title"' : ""}>
      <h2 id="join-room-title"${isPlayer ? ' class="room-option-title"' : ""}>${isPlayer ? '<span class="room-option-icon" data-icon="↪" aria-hidden="true"></span>' : ""}${t(isPlayer ? "joinMusicQueue" : "joinRoom")}</h2>
      <label>${t("roomNumber")} <input id="room-code" type="text" inputmode="numeric" pattern="[1-9][0-9]{2}" maxlength="3" autocomplete="off" required></label>
      <button type="submit">${t("enterRoom")}</button>
    </form>`;
  panel.innerHTML = `
    <p id="room-error" role="status" aria-live="polite"></p>
    <div id="room-welcome" class="start-card" ${isPlayer ? "" : "hidden"}>
      <img class="start-logo" src="/icons/qp.svg" width="104" height="104" alt="" aria-hidden="true">
      <h1>${t("Event Music System")}</h1>
      <p>${t("Click to start the jukebox.")}</p>
      <button id="start-btn" type="button">${t("▶  Start")}</button>
      <small>${t("Make sure this window's audio goes to the venue's AV system.")}</small>
    </div>
    ${isPlayer ? `
      <section id="room-options" aria-labelledby="room-options-title" hidden>
        <h1 id="room-options-title">${t("chooseRoom")}</h1>
        <div class="room-options-grid">
          ${joinForm}
          ${[1, 2].map((number) => `
            <button class="room-option random-room" id="random-room-${number}" type="button" disabled>
              <span class="room-option-title"><span class="room-option-icon" data-icon="♫" aria-hidden="true"></span>${t("createMusicRoom")}</span>
              <strong id="random-code-${number}">—</strong>
            </button>`).join("")}
          <div id="manual-room" class="room-option" role="group" aria-labelledby="manual-room-title" tabindex="-1">
            <form id="room-create">
              <h2 id="manual-room-title" class="room-option-title"><span class="room-option-icon" data-icon="+" aria-hidden="true"></span>${t("createOrJoinPlayer")}</h2>
              <label>${t("roomNumber")} <input id="entry-code" type="text" inputmode="numeric" pattern="[1-9][0-9]{2}" maxlength="3" autocomplete="off" required></label>
              <button type="submit">${t("createOrJoin")}</button>
            </form>
            <button id="resume-player" class="room-secondary" type="button" hidden></button>
          </div>
        </div>
        <p id="room-options-status" role="status"></p>
        <button id="room-options-refresh" class="room-secondary" type="button" hidden>${t("refreshRoomChoices")}</button>
      </section>` : joinForm}
    <p id="room-retry" role="status" aria-live="polite"></p>`;
  document.body.prepend(panel);
  const node = (id) => document.getElementById(id);
  if (content) content.hidden = true;
  document.body.dataset.roomActive = "false";
  node("room-code").value = params.get("room") || "";
  const key = (id, player) => `music-session:${id}:${player ? "player" : "member"}`;
  const lastPlayerKey = "music-last-player";
  const credentialStorage = (player) => player ? sessionStorage : localStorage;
  function recentPlayer() {
    let previous;
    try { previous = JSON.parse(localStorage.getItem(lastPlayerKey) || "null"); } catch {
      localStorage.removeItem(lastPlayerKey);
      return null;
    }
    if (!previous) return null;
    if (!/^[1-9][0-9]{2}$/.test(previous.code) || typeof previous.sessionId !== "string" || !previous.sessionId ||
        typeof previous.token !== "string" || !previous.token) {
      localStorage.removeItem(lastPlayerKey);
      return null;
    }
    if ((params.get("room") && params.get("room") !== previous.code) ||
        (params.get("session") && params.get("session") !== previous.sessionId)) return null;
    return previous;
  }
  function forgetPlayer(member) {
    let previous;
    try { previous = JSON.parse(localStorage.getItem(lastPlayerKey) || "null"); } catch {
      localStorage.removeItem(lastPlayerKey);
    }
    if (previous?.sessionId === member.sessionId && previous?.token === member.token) localStorage.removeItem(lastPlayerKey);
    if (sessionStorage.getItem(key(member.sessionId, true)) === member.token) sessionStorage.removeItem(key(member.sessionId, true));
  }
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
    if (member.role === "player") localStorage.setItem(lastPlayerKey, JSON.stringify({ code: member.code, sessionId: member.sessionId, token: member.token }));
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
    if (current?.role === "player" && forget) forgetPlayer(current);
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
      node("room-options").hidden = true;
      node("room-welcome").hidden = false;
      node("room-code").value = "";
      node("entry-code").value = "";
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
  const entryButtons = [joinFormNode.querySelector('button[type="submit"]')];
  const randomButtons = isPlayer ? [node("random-room-1"), node("random-room-2")] : [];
  let randomCodes = [];
  let optionsRequest = 0;
  let busy = false;
  let retryUntil = 0;
  function updateEntryButtons() {
    const locked = busy || Date.now() < retryUntil;
    for (const button of entryButtons) button.disabled = locked;
    randomButtons.forEach((button, index) => { button.disabled = locked || !randomCodes[index]; });
  }
  function countdown() {
    updateEntryButtons();
    const remaining = retryUntil - Date.now();
    node("room-retry").textContent = remaining > 0 ? t("entryRetry", { seconds: Math.ceil(remaining / 1000) }) : "";
    if (remaining > 0) setTimeout(countdown, Math.min(1000, remaining));
  }
  async function runEntry(action) {
    if (busy || Date.now() < retryUntil) return;
    busy = true;
    updateEntryButtons();
    node("room-error").textContent = "";
    try { await action(); } catch (error) {
      node("room-error").textContent = error.message;
      if ([400, 401, 410, 429].includes(error.status)) {
        const seconds = Number(error.retryIn);
        const wait = error.status === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
        retryUntil = Date.now() + wait * 1000;
      }
    } finally {
      busy = false;
      countdown();
    }
  }
  function submit(form, action) {
    form.onsubmit = (event) => {
      event.preventDefault();
      return runEntry(action);
    };
  }
  function openPlayer(member) {
    remember(member);
    node("entry-code").value = "";
    applyState({ role: "player" });
    history.replaceState(null, "", url("player"));
    Room.onJoined?.(); // Keep the creation gesture in this document for browser audio.
  }
  async function loadRoomOptions() {
    const request = ++optionsRequest;
    const status = node("room-options-status");
    const refresh = node("room-options-refresh");
    randomCodes = [];
    randomButtons.forEach((_, index) => { node(`random-code-${index + 1}`).textContent = "—"; });
    updateEntryButtons();
    refresh.hidden = true;
    status.textContent = t("loadingRoomChoices");
    try {
      const { codes } = await api("/api/sessions/available");
      if (request !== optionsRequest) return;
      randomCodes = codes;
      randomButtons.forEach((_, index) => { node(`random-code-${index + 1}`).textContent = codes[index] || "—"; });
      status.textContent = codes.length ? "" : t("noRoomChoices");
      refresh.hidden = codes.length > 0;
    } catch (error) {
      if (request !== optionsRequest) return;
      status.textContent = error.status ? error.message : t("networkError");
      refresh.hidden = false;
    } finally {
      if (request === optionsRequest) updateEntryButtons();
    }
  }
  submit(joinFormNode, async () => {
    const code = node("room-code").value;
    remember(await post("/api/sessions/join", { code }, saved(code, null, false)));
    location.replace(url(privileged() ? "admin" : "guest"));
  });
  if (isPlayer) {
    const createForm = node("room-create");
    const resumeButton = node("resume-player");
    entryButtons.push(createForm.querySelector('button[type="submit"]'), resumeButton);
    submit(createForm, async () => {
      const roomNumber = node("entry-code").value;
      const digitSum = [...roomNumber].reduce((sum, digit) => sum + Number(digit), 0);
      openPlayer(await post("/api/sessions", { code: `${roomNumber}${digitSum}` }));
    });
    randomButtons.forEach((button, index) => {
      button.onclick = () => {
        const code = randomCodes[index];
        if (!code) return;
        return runEntry(async () => {
          try { openPlayer(await post("/api/sessions/random", { code })); }
          catch (error) {
            if (error.status === 409) void loadRoomOptions();
            throw error;
          }
        });
      };
    });
    resumeButton.onclick = () => runEntry(async () => {
      const previous = recentPlayer();
      if (!previous) { resumeButton.hidden = true; return; }
      const status = node("room-error");
      status.textContent = t("resumingPlayer");
      try {
        const member = await api("/api/info", {}, previous.token, previous.sessionId);
        if (member.role === "player" && member.code === previous.code && member.sessionId === previous.sessionId) {
          status.textContent = "";
          openPlayer(member);
          return;
        }
        status.textContent = t("roomUnavailable");
      } catch (error) {
        status.textContent = error.status ? error.message : t("networkError");
        if (![401, 403, 410].includes(error.status)) return;
      }
      forgetPlayer(previous);
      resumeButton.hidden = true;
    });
    node("room-options-refresh").onclick = loadRoomOptions;
    node("start-btn").onclick = () => {
      const previous = recentPlayer();
      resumeButton.hidden = !previous;
      if (previous) resumeButton.textContent = t("resumeLatestRoom", { code: previous.code });
      node("room-welcome").hidden = true;
      node("room-options").hidden = false;
      joinFormNode.focus();
      return loadRoomOptions();
    };
    node("start-btn").focus();
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
  return { ready: init(), fetch: api, connect, send, finish: end,
    leave() { end("", true); },
    get connected() { return authenticated && socket?.readyState === WebSocket.OPEN; },
    get sessionId() { return current?.sessionId; },
    get token() { return current?.token; }, get code() { return current?.code; } };
})();
