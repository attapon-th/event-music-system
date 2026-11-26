// Host (projector) page: drives the YouTube player from the server's queue and
// reports playback events back so the server can advance the queue.

let player = null;
let playerReady = false;
let started = false;
let autoplayBlocked = false;
let currentVideoId = null;
let currentItemId = null;
let playbackTarget = null;
let appliedPaused = null;
let latestState = { nowPlaying: null, queue: [] };
let qrReady = false;
let ws = null;
let completedOffline = [];
let completedSentCount = 0;
let recovering = false;
let pendingCompletion = null;
let roomLostMessage = null;

// ---- WebSocket --------------------------------------------------------
function stopLocalPlayer() {
  if (exitDialog.open) exitDialog.close();
  clearTimeout(playbackWatchdog);
  if (playerReady && player?.stopVideo) player.stopVideo();
  currentVideoId = null;
  currentItemId = null;
  appliedPaused = null;
  playbackTarget = null;
  completedOffline = [];
  completedSentCount = 0;
  recovering = false;
  pendingCompletion = null;
  roomLostMessage = null;
  if (!Room.token && isVideoFullscreen()) toggleFullscreen();
}

function reportIfEnded() {
  if (pendingCompletion) finishTrack(pendingCompletion.type, pendingCompletion.code);
  else if (playerReady && currentVideoId && player.getPlayerState?.() === YT.PlayerState.ENDED) finishTrack("ended");
}

function finishTrack(type, code) {
  const track = latestState.nowPlaying;
  if (!track || track.id !== currentItemId || track.videoId !== currentVideoId) return;
  const report = { type, id: track.id, videoId: track.videoId, code };
  if (!recovering && Room.send(report)) {
    pendingCompletion = report;
    return;
  }
  pendingCompletion = null;
  completedOffline.push({ id: track.id, videoId: track.videoId, failed: type === "error" });
  const queue = [...latestState.queue];
  if (latestState.keepQueue && !roomLostMessage && type !== "error" && !track.autoQueued) {
    // Match the server's next occurrence ID so offline completions can reconcile in order.
    const [id, cycle = "0"] = track.id.split(":");
    queue.push({ ...track, id: `${id}:${Number(cycle) + 1}` });
  }
  latestState = { ...latestState, nowPlaying: queue.shift() || null, queue, paused: false };
  render(); syncPlayer();
  if (roomLostMessage && !latestState.nowPlaying) Room.finish(roomLostMessage);
}

function connectWs() {
  function authData() {
    recovering = true;
    const completed = completedOffline.slice(0, 51);
    completedSentCount = completed.length;
    return { completed };
  }
  ws = Room.connect({
    authData,
    onAuth() {
      completedOffline.splice(0, completedSentCount);
      pendingCompletion = null;
      // A song can finish while authentication is in flight. Reconcile it too
      // before accepting a snapshot that would replay that song.
      if (completedOffline.length) {
        send({ type: "auth", token: Room.token, sessionId: Room.sessionId, ...authData() });
        return;
      }
      recovering = false;
      document.getElementById("player-status").textContent = "";
      loadInfo();
    },
    onState(msg) {
      if (recovering) return;
      if (pendingCompletion && (pendingCompletion.id !== msg.state.nowPlaying?.id ||
          pendingCompletion.videoId !== msg.state.nowPlaying?.videoId)) pendingCompletion = null;
      latestState = msg.state;
      render(); syncPlayer();
    },
    onOffline() {
      document.getElementById("player-status").textContent = t("offlinePlayback");
      reportIfEnded();
    },
    onUnavailable(message) {
      if (!latestState.nowPlaying && !latestState.queue.length) return false;
      roomLostMessage = message;
      document.getElementById("player-status").textContent = t("roomLostPlayback");
      reportIfEnded();
      return true;
    },
    onEnd: stopLocalPlayer,
  });
}
function send(obj) { return Room.send(obj); }

// ---- YouTube IFrame API ----------------------------------------------
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("player", {
    height: "100%",
    width: "100%",
    playerVars: { autoplay: 1, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        player.getIframe().setAttribute("allow", "autoplay; fullscreen");
        // Keep D-pad navigation in our controls rather than the cross-origin iframe.
        player.getIframe().setAttribute("tabindex", "-1");
        syncPlayer();
      },
      onAutoplayBlocked: () => {
        autoplayBlocked = true;
        clearTimeout(playbackWatchdog);
        document.getElementById("playpause").title = t("tapToPlay");
        document.getElementById("playpause").classList.add("needs-play");
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          autoplayBlocked = false;
          document.getElementById("playpause").classList.remove("needs-play");
          document.getElementById("playpause").title = t("Play / Pause (space)");
        }
        if (e.data === YT.PlayerState.ENDED) {
          finishTrack("ended");
        }
        if (started && [YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(e.data)) {
          const paused = e.data === YT.PlayerState.PAUSED;
          if (playbackTarget !== null) {
            if (paused === playbackTarget) playbackTarget = null;
            else if (playbackTarget) player.pauseVideo();
            else player.playVideo();
          } else if (paused !== latestState.paused) {
            if (!send({ type: paused ? "pause" : "play" })) latestState.paused = paused;
          }
        }
        updatePlayPauseIcon();
      },
      onError: (e) => {
        // 101/150 = embedding disabled by owner; 100 = removed; 2 = bad id.
        console.warn("Player error", e.data, "on", currentVideoId);
        finishTrack("error", e.data);
      },
    },
  });
};

// Make the player match whatever the server says is now playing.
function syncPlayer() {
  if (!started || !playerReady) return;
  player.setVolume(latestState.volume ?? 60);
  document.getElementById("volume").value = latestState.volume ?? 60;
  document.getElementById("volume").style.setProperty("--vol", `${latestState.volume ?? 60}%`);
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");

  if (!np) {
    currentVideoId = null;
    currentItemId = null;
    playbackTarget = null;
    appliedPaused = null;
    if (player.stopVideo) player.stopVideo();
    idle.classList.remove("hidden");
    return;
  }
  idle.classList.add("hidden");
  if (np.id !== currentItemId || np.videoId !== currentVideoId) {
    currentVideoId = np.videoId;
    currentItemId = np.id;
    appliedPaused = null;
    playbackTarget = !!latestState.paused;
    player.loadVideoById(np.videoId);
    armPlaybackWatchdog(np.videoId);
  }
  if (appliedPaused !== !!latestState.paused) {
    appliedPaused = !!latestState.paused;
    playbackTarget = appliedPaused;
    if (appliedPaused) player.pauseVideo();
    else player.playVideo();
  }
  updatePlayPauseIcon();
}

// Some broken embeds render a black frame without ever firing onError. If a
// freshly loaded video hasn't produced any playback after 20s (and isn't
// simply paused), report it as an error so the server skips to the next song.
let playbackWatchdog = null;
function armPlaybackWatchdog(videoId) {
  clearTimeout(playbackWatchdog);
  playbackWatchdog = setTimeout(() => {
    if (autoplayBlocked || currentVideoId !== videoId || !playerReady || latestState.paused) return;
    const t = player.getCurrentTime ? player.getCurrentTime() : 0;
    const s = player.getPlayerState ? player.getPlayerState() : -1;
    if (t >= 1 || s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED) return;
    // A hidden tab can't be the projector — browsers block its autoplay, so
    // its player sits UNSTARTED forever. Reporting that as an error would skip
    // the song for everyone. Likewise BUFFERING just means a slow network.
    // Either way, wait another round instead of skipping.
    if (document.hidden || s === YT.PlayerState.BUFFERING) {
      armPlaybackWatchdog(videoId);
      return;
    }
    console.warn(`[watchdog] ${videoId} never started (state ${s}) — skipping`);
    finishTrack("error", "watchdog");
  }, 20000);
}

window.addEventListener("pageshow", (e) => {
  if (e.persisted && Room.token) syncPlayer();
});

// ---- Rendering --------------------------------------------------------
function render() {
  renderPlayerPanels();
  const np = latestState.nowPlaying;
  document.getElementById("now-title").textContent = np ? np.title : "—";
  document.getElementById("now-channel").textContent = np
    ? [np.channel, np.autoQueued && t("autoQueued"), np.addedBy && t("requester", { name: np.addedBy })].filter(Boolean).join(" · ")
    : "";

  if (latestState.showPlayerQueue === false) return;
  const queue = latestState.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  const ul = document.getElementById("queue");
  const focusedId = document.activeElement?.dataset.queueId;
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = `<li class="q-empty">${t("empty")}</li>`;
    if (focusedId) document.getElementById("skip").focus();
    return;
  }
  for (const item of queue) {
    const li = document.createElement("li");
    const thumb = item.thumbnail
      ? `<img src="${item.thumbnail}" alt="" />`
      : '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" alt="" />';
    li.innerHTML = `
      ${thumb}
      <div class="q-meta">
        <div class="q-title"></div>
        <div class="q-sub"></div>
      </div>
      <button class="q-remove" title="${t("Remove")}">✕</button>`;
    li.querySelector(".q-title").textContent = item.title;
    li.querySelector(".q-sub").textContent = item.addedBy ? t("requester", { name: item.addedBy }) : item.channel;
    const remove = li.querySelector(".q-remove");
    remove.dataset.queueId = item.id;
    remove.onclick = () => send({ type: "remove", id: item.id });
    ul.appendChild(li);
  }
  if (focusedId) {
    const buttons = [...ul.querySelectorAll("button")];
    (buttons.find((button) => button.dataset.queueId === focusedId) || document.getElementById("skip")).focus();
  }
}

function renderPlayerPanels() {
  const sidebar = document.getElementById("player-sidebar");
  const qrCard = document.getElementById("qr-card");
  const queueCard = document.getElementById("player-queue-card");
  const showQr = latestState.showPlayerQr !== false;
  if (latestState.showPlayerQueue === false && queueCard.contains(document.activeElement)) {
    document.getElementById("skip").focus();
  }
  qrCard.hidden = !showQr || !qrReady;
  queueCard.hidden = latestState.showPlayerQueue === false;
  sidebar.hidden = qrCard.hidden && queueCard.hidden;
  document.getElementById("stage").classList.toggle("no-sidebar", sidebar.hidden);
  document.getElementById("request-hint").textContent =
    t(qrCard.hidden ? "requestFromQueue" : "Scan the QR code to add the first song!");
}

const PAUSE_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5"/></svg>';
const PLAY_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function updatePlayPauseIcon() {
  if (!playerReady) return;
  const playing = player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING;
  document.getElementById("playpause").innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

// ---- Controls ---------------------------------------------------------
const playerWrap = document.getElementById("player-wrap");
const fullscreenButton = document.getElementById("fullscreen");
const exitButton = document.getElementById("exit-room");
const exitDialog = document.getElementById("exit-dialog");
function cancelExit() {
  exitDialog.close();
  exitButton.focus();
}
let fullscreenActive = false;
let fullscreenHistory = false;
function isVideoFullscreen() {
  return document.fullscreenElement === playerWrap || document.webkitFullscreenElement === playerWrap || playerWrap.classList.contains("video-fullscreen");
}
function updateFullscreen() {
  const active = isVideoFullscreen();
  if (active !== fullscreenActive) {
    fullscreenActive = active;
    if (active) {
      history.pushState({ ...history.state, videoFullscreen: true }, "");
      fullscreenHistory = true;
    } else if (fullscreenHistory) {
      // Native Back may exit fullscreen before popstate; let that traversal finish.
      setTimeout(() => {
        if (fullscreenHistory && !isVideoFullscreen()) history.back();
      }, 0);
    }
  }
  fullscreenButton.hidden = active;
  fullscreenButton.setAttribute("aria-pressed", String(active));
  fullscreenButton.title = t(active ? "Exit video fullscreen (Back / Esc)" : "Video fullscreen (f)");
  fullscreenButton.setAttribute("aria-label", fullscreenButton.title);
  if (active) playerWrap.focus();
  else if (Room.token) fullscreenButton.focus();
}
window.addEventListener("popstate", () => {
  const owned = fullscreenHistory;
  fullscreenHistory = false;
  if (isVideoFullscreen()) toggleFullscreen();
  if (owned && !Room.token) history.replaceState(null, "", "/");
});
async function toggleFullscreen() {
  if (!isVideoFullscreen() && fullscreenHistory) return; // Wait for the exit's history traversal.
  if (isVideoFullscreen()) {
    if (playerWrap.classList.contains("video-fullscreen")) {
      playerWrap.classList.remove("video-fullscreen");
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { await exit.call(document); } catch (err) { console.warn("Fullscreen exit failed", err); }
    }
  } else {
    const enter = playerWrap.requestFullscreen || playerWrap.webkitRequestFullscreen;
    try {
      if (!enter) throw new Error("Fullscreen API unavailable");
      await enter.call(playerWrap);
    } catch {
      // Older TV browsers can still expand the video within the page.
      playerWrap.classList.add("video-fullscreen");
    }
  }
  updateFullscreen();
}

const visibleControls = (controls) => [...controls].filter((el) => !el.disabled && el.getClientRects().length);

function focusInDirection(key, from, controls) {
  if (!from) return false;
  const origin = from.getBoundingClientRect();
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
  const axis = vertical ? "y" : "x";
  const cross = vertical ? "x" : "y";
  const center = (rect, dimension) => dimension === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  const candidates = controls.filter((el) => el !== from).map((el) => {
    const rect = el.getBoundingClientRect();
    const distance = direction * (center(rect, axis) - center(origin, axis));
    return { el, distance, score: distance + 2 * Math.abs(center(rect, cross) - center(origin, cross)) };
  }).filter(({ distance }) => distance > 1).sort((a, b) => a.score - b.score);
  if (!candidates.length) return false;
  candidates[0].el.focus();
  return true;
}

function handleEntryKey(e, key, target) {
  const entry = document.querySelector(".player-entry:not([hidden])");
  if (!entry || e.defaultPrevented || target?.closest("dialog[open]")) return;
  const input = target?.tagName === "INPUT";
  if (key.startsWith("Arrow")) {
    if (input && ["ArrowLeft", "ArrowRight"].includes(key)) return;
    e.preventDefault();
    const controls = visibleControls(entry.querySelectorAll("button, input"));
    if (!focusInDirection(key, target, controls) && !controls.includes(target)) controls[0]?.focus();
    return;
  }
  if (["Escape", "Back", "BrowserBack", "GoBack"].includes(key) && Room.closeEntry()) {
    e.preventDefault();
    return;
  }
  if (!["Enter", "Select", "Accept", "OK"].includes(key) || !entry.contains(target)) return;
  if (input && e.key === "Enter") return; // Native form submission handles Enter.
  e.preventDefault();
  if (e.repeat) return;
  if (target.tagName === "BUTTON") target.click();
  else if (input) target.form.requestSubmit();
}

function handleHostKey(e) {
  const key = e.key && e.key !== "Unidentified" ? e.key : ({ 4: "BrowserBack", 19: "ArrowUp", 20: "ArrowDown", 21: "ArrowLeft", 22: "ArrowRight", 23: "Enter", 66: "Enter", 85: "MediaPlayPause", 87: "MediaTrackNext", 10009: "BrowserBack" })[e.keyCode] || "";
  const target = document.activeElement;
  if (!Room.token) {
    handleEntryKey(e, key, target);
    return;
  }
  const textInput = target?.matches('input:not([type="range"]), textarea, [contenteditable="true"]');
  if (["Escape", "Back", "BrowserBack", "GoBack", "Backspace"].includes(key) && (exitDialog.open || isVideoFullscreen())) {
    e.preventDefault();
    if (!e.repeat) {
      if (exitDialog.open) cancelExit();
      else toggleFullscreen();
    }
    return;
  }
  if (e.defaultPrevented || textInput) return;
  if (key.startsWith("Arrow")) {
    if (target?.id === "volume" && ["ArrowLeft", "ArrowRight"].includes(key)) return;
    e.preventDefault();
    const controls = exitDialog.open ? visibleControls(exitDialog.querySelectorAll("button"))
      : isVideoFullscreen() ? [playerWrap] : visibleControls(document.querySelectorAll("button, input"));
    if (!focusInDirection(key, target, controls) && !controls.includes(target)) controls[0]?.focus();
    return;
  }
  if (["Enter", "Select", "Accept", "OK"].includes(key) && target?.tagName === "BUTTON") {
    e.preventDefault();
    if (!e.repeat) target.click();
    return;
  }
  if (exitDialog.open) return;
  const action = key === " " || e.code === "Space" || key === "MediaPlayPause" ? "playpause"
    : key.toLowerCase() === "n" || key === "MediaTrackNext" ? "skip"
    : key.toLowerCase() === "f" ? "fullscreen" : null;
  if (started && action) {
    e.preventDefault();
    if (!e.repeat) document.getElementById(action).click();
  }
}

function wireControls() {
  fullscreenButton.onclick = toggleFullscreen;
  document.addEventListener("fullscreenchange", updateFullscreen);
  document.addEventListener("webkitfullscreenchange", updateFullscreen);
  document.getElementById("playpause").onclick = () => {
    if (autoplayBlocked) {
      autoplayBlocked = false;
      player.playVideo();
      if (currentVideoId) armPlaybackWatchdog(currentVideoId);
      return;
    }
    send({ type: latestState.paused ? "play" : "pause" });
  };
  document.getElementById("skip").onclick = () => send({ type: "skip" });
  exitButton.onclick = () => {
    if (typeof exitDialog.showModal === "function") exitDialog.showModal();
    else if (window.confirm(t("confirmExitPlayer"))) Room.leave();
  };
  exitDialog.oncancel = (event) => {
    event.preventDefault();
    cancelExit();
  };
  document.getElementById("cancel-exit").onclick = cancelExit;
  document.getElementById("confirm-exit").onclick = () => {
    exitDialog.close();
    Room.leave();
  };
  const volEl = document.getElementById("volume");
  const paintVol = () => volEl.style.setProperty("--vol", `${volEl.value}%`);
  paintVol();
  volEl.oninput = () => {
    paintVol();
    send({ type: "setVolume", volume: Number(volEl.value) });
  };
  document.addEventListener("keydown", handleHostKey);
}

// ---- Bootstrap --------------------------------------------------------
async function loadInfo() {
  const sessionId = Room.sessionId;
  try {
    const info = await Room.fetch("/api/info");
    if (sessionId !== Room.sessionId) return;
    const guestUrl = new URL(info.guestUrl);
    document.getElementById("qr").src = info.qr;
    document.getElementById("guest-url").textContent = guestUrl.host + guestUrl.pathname;
    qrReady = true;
    renderPlayerPanels();
  } catch {
    if (sessionId === Room.sessionId && !qrReady) {
      document.getElementById("player-status").textContent = t("Could not load guest link");
    }
  }
}
function openPlayer() {
  started = true;
  autoplayBlocked = false;
  document.getElementById("playpause").classList.remove("needs-play");
  qrReady = false;
  document.getElementById("player-status").textContent = "";
  document.getElementById("player-room-label").textContent = t("roomCode", { code: Room.code });
  currentVideoId = null;
  currentItemId = null;
  appliedPaused = null;
  latestState = { nowPlaying: null, queue: [], paused: false, volume: 60 };
  completedOffline = [];
  completedSentCount = 0;
  recovering = false;
  pendingCompletion = null;
  roomLostMessage = null;
  render();
  connectWs();
  document.getElementById("playpause").focus();
}
wireControls();
Room.onJoined = openPlayer;
Room.ready.then((joined) => { if (joined) openPlayer(); });
