// Host (projector) page: drives the YouTube player from the server's queue and
// reports playback events back so the server can advance the queue.

let player = null;
let playerReady = false;
let started = false;
let autoplayBlocked = false;
let currentVideoId = null;
let playbackTarget = null;
let appliedPaused = null;
let latestState = { nowPlaying: null, queue: [] };
let eventContext = "";
let ws = null;

// ---- WebSocket --------------------------------------------------------
function stopLocalPlayer() {
  clearTimeout(playbackWatchdog);
  if (playerReady && player?.stopVideo) player.stopVideo();
  currentVideoId = null;
  appliedPaused = null;
  playbackTarget = null;
  if (!Room.token && isVideoFullscreen()) toggleFullscreen();
}

function reportIfEnded() {
  if (playerReady && currentVideoId && player.getPlayerState?.() === YT.PlayerState.ENDED) {
    send({ type: "ended", videoId: currentVideoId });
  }
}

function connectWs() {
  ws = Room.connect({
    onAuth() { reportIfEnded(); },
    onState(msg) {
      latestState = msg.state;
      eventContext = msg.eventContext;
      render(); renderContext(); syncPlayer();
    },
    onOffline: stopLocalPlayer,
    onEnd: stopLocalPlayer,
  });
}
function send(obj) { Room.send(obj); }

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
          send({ type: "ended", videoId: currentVideoId });
        }
        if (started && [YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(e.data)) {
          const paused = e.data === YT.PlayerState.PAUSED;
          if (playbackTarget !== null) {
            if (paused === playbackTarget) playbackTarget = null;
            else if (playbackTarget) player.pauseVideo();
            else player.playVideo();
          } else if (paused !== latestState.paused) send({ type: paused ? "pause" : "play" });
        }
        updatePlayPauseIcon();
      },
      onError: (e) => {
        // 101/150 = embedding disabled by owner; 100 = removed; 2 = bad id.
        console.warn("Player error", e.data, "on", currentVideoId);
        send({ type: "error", videoId: currentVideoId, code: e.data });
      },
    },
  });
};

// Make the player match whatever the server says is now playing.
function syncPlayer() {
  if (!started || !playerReady) return;
  const np = latestState.nowPlaying;
  const idle = document.getElementById("idle");

  if (!np) {
    currentVideoId = null;
    playbackTarget = null;
    appliedPaused = null;
    if (player.stopVideo) player.stopVideo();
    idle.classList.remove("hidden");
    return;
  }
  idle.classList.add("hidden");
  if (np.videoId !== currentVideoId) {
    currentVideoId = np.videoId;
    appliedPaused = null;
    playbackTarget = !!latestState.paused;
    player.loadVideoById(np.videoId);
    armPlaybackWatchdog(np.videoId);
  }
  player.setVolume(latestState.volume ?? 100);
  document.getElementById("volume").value = latestState.volume ?? 100;
  document.getElementById("volume").style.setProperty("--vol", `${latestState.volume ?? 100}%`);
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
    send({ type: "error", videoId, code: "watchdog" });
  }, 20000);
}

window.addEventListener("pageshow", (e) => {
  if (e.persisted && Room.token) syncPlayer();
});

// ---- Rendering --------------------------------------------------------
function render() {
  const np = latestState.nowPlaying;
  document.getElementById("now-label").classList.toggle("hidden", !np);
  document.getElementById("now-title").textContent = np ? np.title : "—";
  document.getElementById("now-channel").textContent = np
    ? np.channel + (np.addedBy ? ` · ${t("requester", { name: np.addedBy })}` : "")
    : "";

  const queue = latestState.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  const ul = document.getElementById("queue");
  const focusedId = document.activeElement?.dataset.queueId;
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = `<li class="q-empty">${t("Queue is empty — scan the QR to add a song.")}</li>`;
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

function renderContext() {
  const input = document.getElementById("context-input");
  // Don't clobber the host's typing with a broadcast echo.
  if (document.activeElement !== input) input.value = eventContext;
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
function isVideoFullscreen() {
  return document.fullscreenElement === playerWrap || document.webkitFullscreenElement === playerWrap || playerWrap.classList.contains("video-fullscreen");
}
function updateFullscreen() {
  const active = isVideoFullscreen();
  fullscreenButton.setAttribute("aria-pressed", String(active));
  fullscreenButton.title = t(active ? "Exit video fullscreen (Back / Esc)" : "Video fullscreen (f)");
  fullscreenButton.setAttribute("aria-label", fullscreenButton.title);
  fullscreenButton.focus();
}
async function toggleFullscreen() {
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

function handleHostKey(e) {
  if (!Room.token) return;
  const key = e.key && e.key !== "Unidentified" ? e.key : ({ 4: "BrowserBack", 19: "ArrowUp", 20: "ArrowDown", 21: "ArrowLeft", 22: "ArrowRight", 23: "Enter", 66: "Enter", 85: "MediaPlayPause", 87: "MediaTrackNext", 10009: "BrowserBack" })[e.keyCode] || "";
  const target = document.activeElement;
  const textInput = target?.matches('input:not([type="range"]), textarea, [contenteditable="true"]');
  if (["Escape", "BrowserBack", "GoBack", "Backspace"].includes(key) && isVideoFullscreen()) {
    e.preventDefault();
    if (!e.repeat) toggleFullscreen();
    return;
  }
  if (e.defaultPrevented || textInput) return;
  if (key.startsWith("Arrow")) {
    if (target?.id === "volume" && ["ArrowLeft", "ArrowRight"].includes(key)) return;
    e.preventDefault();
    const controls = isVideoFullscreen() ? [fullscreenButton] : [...document.querySelectorAll("button, input")].filter((el) => !el.disabled && el.getClientRects().length);
    if (!controls.length) return;
    const from = target?.getBoundingClientRect();
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    const axis = vertical ? "y" : "x";
    const cross = vertical ? "x" : "y";
    const center = (rect, dimension) => dimension === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const candidates = controls.filter((el) => el !== target).map((el) => {
      const rect = el.getBoundingClientRect();
      const distance = from ? direction * (center(rect, axis) - center(from, axis)) : 0;
      return { el, distance, score: from ? distance + 2 * Math.abs(center(rect, cross) - center(from, cross)) : 0 };
    }).filter(({ distance }) => distance > 1).sort((a, b) => a.score - b.score);
    (candidates[0]?.el || (controls.includes(target) ? target : controls[0])).focus();
    return;
  }
  if (["Enter", "Select", "Accept"].includes(key) && target?.tagName === "BUTTON") {
    e.preventDefault();
    if (!e.repeat) target.click();
    return;
  }
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
  document.getElementById("qr-toggle").onclick = () => {
    const card = document.getElementById("qr-card");
    card.hidden = !card.hidden;
    document.getElementById("qr-toggle").textContent = t(card.hidden ? "showQR" : "hideQR");
    document.getElementById("qr-toggle").setAttribute("aria-pressed", String(card.hidden));
  };
  document.getElementById("exit-room").onclick = async () => {
    try { await Room.close(); }
    catch { document.getElementById("guest-url").textContent = t("roomActionFailed"); }
  };
  const volEl = document.getElementById("volume");
  const paintVol = () => volEl.style.setProperty("--vol", `${volEl.value}%`);
  paintVol();
  volEl.oninput = () => {
    paintVol();
    send({ type: "setVolume", volume: Number(volEl.value) });
  };
  // Event-context editor: the Event context pill reveals an input; Save sends it.
  const ctxRow = document.getElementById("context-row");
  const ctxInput = document.getElementById("context-input");
  document.getElementById("context-toggle").onclick = () => {
    ctxRow.classList.toggle("hidden");
    if (!ctxRow.classList.contains("hidden")) ctxInput.focus();
  };
  document.getElementById("context-save").onclick = () => {
    send({ type: "setEventContext", context: ctxInput.value.trim() });
    ctxRow.classList.add("hidden");
    document.getElementById("context-toggle").focus();
  };
  ctxInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("context-save").click();
    }
  });

  document.addEventListener("keydown", handleHostKey);
}

// ---- Bootstrap --------------------------------------------------------
async function loadInfo() {
  try {
    const info = await Room.fetch("/api/info");
    document.getElementById("qr").src = info.qr;
    document.getElementById("guest-url").textContent = `ห้อง ${info.code} · yt1.lkzlab.uk/guest`;
  } catch {
    document.getElementById("guest-url").textContent = t("Could not load guest link");
  }
}
function openPlayer() {
  started = true;
  autoplayBlocked = false;
  document.getElementById("playpause").classList.remove("needs-play");
  document.getElementById("qr-card").hidden = false;
  document.getElementById("qr-toggle").textContent = t("hideQR");
  document.getElementById("qr-toggle").setAttribute("aria-pressed", "false");
  currentVideoId = null;
  appliedPaused = null;
  latestState = { nowPlaying: null, queue: [], paused: false, volume: 100 };
  loadInfo();
  connectWs();
  document.getElementById("playpause").focus();
}
wireControls();
Room.onJoined = openPlayer;
Room.ready.then((joined) => { if (joined) openPlayer(); });
