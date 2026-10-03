// Replay both API load orders through the scripts in the actual Host page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const publicDir = new URL("../public/", import.meta.url);
const html = readFileSync(new URL("host.html", publicDir), "utf8");
assert.equal(html.includes('href="/admin"'), false, "Admin link belongs on Guest only");
assert.equal(readFileSync(new URL("guest.html", publicDir), "utf8").includes('href="/admin"'), false);

for (const earlyReady of [false, true]) {
  const nodes = new Map();
  const calls = [];
  let state = -1;
  let apiReady;
  let playerEvents;
  const messages = [];
  const timers = [];
  const listeners = {};
  const historyStates = [{ previousPage: true }, null];
  let historyIndex = 1;
  let nativeBackExitsFirst = false;
  const settleFullscreen = () => new Promise(resolve => setImmediate(resolve));
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        const attributes = new Map();
        nodes.set(id, {
        id, tagName: id === "player-wrap" ? "DIV" : id.includes("input") || id === "volume" ? "INPUT" : "BUTTON", dataset: {},
        children: [], handlers: {},
        set innerHTML(value) { this.children = []; this.markup = value; },
        get innerHTML() { return this.markup; },
        appendChild(child) { this.children.push(child); },
        querySelectorAll() { return this.children.map((child) => child.querySelector(".q-remove")); },
        value: "100", style: { setProperty() {} },
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, force) { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); },
        focus() { document.activeElement = this; },
        click() { return this.onclick?.(); },
        matches() { return id === "context-input"; },
        getClientRects() { return this.visible ? [this.getBoundingClientRect()] : []; },
        getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 44, height: 44 }; },
        addEventListener(type, handler) { this.handlers[type] = handler; },
      });
      }
      return nodes.get(id);
    },
    createElement() {
      const parts = new Map();
      return { querySelector(selector) {
        if (!parts.has(selector)) parts.set(selector, document.getElementById(`queue-part-${nodes.size}`));
        return parts.get(selector);
      } };
    },
    querySelectorAll: (selector) => selector === "button, input" ? [...nodes.values()] : [],
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const context = createContext({
    document, location: { protocol: "http:", host: "localhost" },
    addEventListener(type, handler) { listeners[type] = handler; },
    history: {
      get state() { return historyStates[historyIndex]; },
      pushState(value) { historyStates.splice(++historyIndex); historyStates.push(value); },
      replaceState(value, _title, url) { historyStates[historyIndex] = value; this.url = url; },
      back() { queueMicrotask(() => {
        if (!historyIndex) return;
        if (nativeBackExitsFirst && document.fullscreenElement) {
          document.fullscreenElement = null;
          listeners.fullscreenchange();
        }
        historyIndex--;
        listeners.popstate?.({ state: historyStates[historyIndex] });
      }); },
    },
    setTimeout: (fn, delay) => { timers.push(fn); if (delay === 0) queueMicrotask(fn); return timers.length; }, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ token: "test-token", guestUrl: "http://localhost/guest" }) }),
    WebSocket: class { readyState = 1; send(data) { messages.push(JSON.parse(data)); } },
  });
  context.Room = {
    ready: Promise.resolve(true), token: "test-token",
    fetch: async () => ({ code: "123", guestUrl: "http://localhost/guest", filterOn: false, moderationMode: "default" }),
    send: (message) => messages.push(message),
    connect(handlers) {
      return { onmessage({ data }) {
        const msg = JSON.parse(data);
        if (msg.type === "state") handlers.onState({ filterOn: false, moderationMode: "default", cooldownSeconds: 15, eventContext: "", ...msg });
        if (msg.type === "sessionEnded") handlers.onEnd();
      } };
    },
  };
  context.window = context;
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
    if (src.startsWith("https://www.youtube.com/")) {
      context.YT = {
        PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 },
        Player: function (id, options) {
          calls.push(["init", id]);
          playerEvents = options.events;
          this.loadVideoById = (videoId) => calls.push(["load", videoId]);
          this.setVolume = (volume) => calls.push(["volume", volume]);
          this.playVideo = () => { state = 1; calls.push(["play"]); };
          this.pauseVideo = () => { state = 2; calls.push(["pause"]); };
          this.stopVideo = () => { state = -1; };
          this.getPlayerState = () => state;
          this.getIframe = () => document.getElementById("player");
          queueMicrotask(() => options.events.onReady());
        },
      };
      apiReady = () => context.onYouTubeIframeAPIReady?.();
      if (earlyReady) apiReady();
    } else if (src !== "/session.js") {
      runInContext(readFileSync(new URL(src.slice(1), publicDir), "utf8"), context);
    }
  }
  if (!earlyReady) apiReady();
  await Promise.resolve();
  const press = (key, extra = {}) => {
    const event = { key, target: document.activeElement, preventDefault() { this.defaultPrevented = true; }, ...extra };
    event.target?.handlers.keydown?.(event);
    listeners.keydown(event);
    return event;
  };
  assert.equal(document.activeElement.id, "playpause", "Player opens without a start screen");
  runInContext(`ws.onmessage({ data: JSON.stringify({ type: "state", state: {
    nowPlaying: { videoId: "song0000001", title: "Test", channel: "Artist" },
    queue: [], paused: false, volume: 37
  } }) });`, context);
  assert.equal(document.activeElement.id, "playpause");
  assert.equal(calls.filter(([action]) => action === "init").length, 1, `API ready ${earlyReady ? "before" : "after"} Host script: initialize one player`);
  assert.ok(calls.some(([action, id]) => action === "load" && id === "song0000001"), "Auto start must load the current song");
  const firstLoad = calls.findIndex(([action]) => action === "load");
  assert.deepEqual(calls[firstLoad - 1], ["volume", 37], "Apply room volume before loading its first song");
  assert.equal(state, 1, "Auto start must play the current song");
  runInContext("latestState.paused = true; syncPlayer();", context);
  assert.equal(state, 2);
  runInContext("latestState.paused = false; syncPlayer();", context);
  assert.equal(state, 1);
  assert.ok(calls.some(([action, volume]) => action === "volume" && volume === 37));
  assert.equal(document.getElementById("player").getAttribute("tabindex"), "-1");
  const autoQueueToggle = document.getElementById("auto-queue-toggle");
  assert.equal(autoQueueToggle.getAttribute("aria-pressed"), "false");
  autoQueueToggle.click();
  assert.equal(messages.at(-1).type, "setAutoQueue");
  assert.equal(messages.at(-1).enabled, true);
  runInContext('latestState.autoQueue = true; latestState.autoQueueStatus = "loading"; latestState.nowPlaying.autoQueued = true; render();', context);
  assert.equal(autoQueueToggle.getAttribute("aria-pressed"), "true");
  assert.equal(autoQueueToggle.classList.contains("on"), true);
  assert.match(document.getElementById("now-channel").textContent, /เพลงอัตโนมัติ/);
  assert.equal(document.getElementById("auto-queue-status").textContent, "กำลังหาเพลงแนะนำ…");
  autoQueueToggle.click();
  assert.equal(messages.at(-1).enabled, false);
  runInContext('latestState.autoQueue = false; latestState.autoQueueStatus = "idle"; render();', context);
  const play = document.getElementById("playpause");
  state = -1;
  playerEvents.onAutoplayBlocked();
  const blockedMessages = messages.length;
  timers.at(-1)();
  assert.equal(messages.length, blockedMessages, "Autoplay blocking does not skip the song");
  assert.equal(runInContext("autoplayBlocked", context), true);
  const beforeBlockedClick = messages.length;
  play.click();
  assert.equal(state, 1, "Existing play button unlocks blocked audio");
  assert.equal(messages.length, beforeBlockedClick, "Unlocking audio must not pause the server queue");
  document.getElementById("qr-toggle").click();
  assert.equal(document.getElementById("qr-card").hidden, true);
  document.getElementById("qr-toggle").click();
  assert.equal(document.getElementById("qr-card").hidden, false);
  const skip = document.getElementById("skip");
  const volume = document.getElementById("volume");
  for (const [index, node] of [play, skip, volume].entries()) {
    node.visible = true;
    node.rect = { left: index * 70, top: 100, width: 44, height: 44 };
  }
  press("ArrowRight");
  assert.equal(document.activeElement, skip, "D-pad moves to next control");
  const before = messages.length;
  press("Enter");
  assert.equal(messages.at(-1).type, "skip");
  press("Enter", { repeat: true });
  assert.equal(messages.length, before + 1, "Holding OK must not skip repeatedly");
  press("ArrowRight");
  assert.equal(document.activeElement, volume);
  assert.equal(press("ArrowLeft").defaultPrevented, undefined, "Slider retains native volume keys");
  document.getElementById("context-input").focus();
  const typingBefore = messages.length;
  press("n"); press("f"); press(" ");
  assert.equal(messages.length, typingBefore, "Text entry must not trigger shortcuts");
  press("Enter");
  assert.equal(messages.at(-1).type, "setEventContext");
  assert.equal(document.getElementById("context-row").classList.contains("hidden"), true, "Saving with Enter must not reopen editor through bubbling");
  assert.equal(document.activeElement.id, "context-toggle");
  play.focus();
  const keyboardBefore = messages.length;
  press("b", { keyCode: 66 });
  assert.equal(messages.length, keyboardBefore, "Normal keyboard B must not be treated as remote OK");
  press("MediaPlayPause");
  assert.equal(messages.at(-1).type, "pause");
  const wrap = document.getElementById("player-wrap");
  const fullscreen = document.getElementById("fullscreen");
  await fullscreen.click();
  assert.equal(wrap.classList.contains("video-fullscreen"), true, "No Fullscreen API: expand video within page");
  assert.equal(fullscreen.getAttribute("aria-pressed"), "true");
  assert.equal(fullscreen.hidden, true, "Fullscreen hides its icon");
  press("ArrowDown");
  assert.equal(document.activeElement, wrap, "Fullscreen must not focus a hidden control");
  const fullscreenMessages = messages.length;
  press("Enter");
  assert.equal(wrap.classList.contains("video-fullscreen"), true, "OK does not click the hidden fullscreen button");
  context.history.back();
  await settleFullscreen();
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "Browser Back restores Player without leaving the page");
  assert.equal(fullscreen.hidden, false);
  assert.equal(document.activeElement, fullscreen);
  assert.equal(historyIndex, 1);
  assert.equal(state, 1, "Leaving fullscreen keeps playback running");
  assert.equal(messages.length, fullscreenMessages, "Back must not close the room or change the queue");
  await fullscreen.click();
  assert.equal(press("Unidentified", { keyCode: 4 }).defaultPrevented, true);
  await settleFullscreen();
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "Remote Back restores original layout");
  wrap.requestFullscreen = async () => { document.fullscreenElement = wrap; listeners.fullscreenchange(); };
  document.exitFullscreen = async () => { document.fullscreenElement = null; listeners.fullscreenchange(); };
  await fullscreen.click();
  assert.equal(document.fullscreenElement, wrap, "Fullscreen targets video wrapper, keeping exit reachable");
  press("Escape");
  await settleFullscreen();
  assert.equal(document.fullscreenElement, null);
  assert.equal(fullscreen.getAttribute("aria-pressed"), "false");
  assert.equal(fullscreen.hidden, false);
  assert.equal(historyIndex, 1, "Escape consumes the fullscreen history entry");
  await fullscreen.click();
  context.history.back();
  await settleFullscreen();
  assert.equal(document.fullscreenElement, null, "Browser Back also exits native fullscreen");
  await fullscreen.click();
  document.fullscreenElement = null;
  listeners.fullscreenchange();
  await settleFullscreen();
  assert.equal(historyIndex, 1, "Browser-native fullscreen exits do not leave extra history entries");
  await fullscreen.click();
  nativeBackExitsFirst = true;
  context.history.back();
  await settleFullscreen();
  nativeBackExitsFirst = false;
  assert.equal(historyIndex, 1, "Native exit before popstate must not navigate back twice and leave Player");
  wrap.requestFullscreen = async () => { throw new Error("Unsupported TV browser"); };
  await fullscreen.click();
  assert.equal(wrap.classList.contains("video-fullscreen"), true, "Rejected native fullscreen also falls back");
  assert.equal(fullscreen.hidden, true);
  assert.equal(press("Back", { keyCode: 10009 }).defaultPrevented, true);
  await settleFullscreen();
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "TV Back exits fullscreen without mouse");
  assert.equal(fullscreen.hidden, false);
  runInContext('latestState.queue = [{ id: "queued-1", title: "Queued", channel: "Artist" }]; render();', context);
  document.getElementById("queue").querySelectorAll()[0].focus();
  runInContext("render();", context);
  assert.equal(document.activeElement.dataset.queueId, "queued-1", "Queue broadcasts preserve remote selection");
  runInContext("latestState.queue = []; render();", context);
  assert.equal(document.activeElement, skip, "Removing focused track returns focus to a visible control");
  await fullscreen.click();
  context.Room.token = null;
  runInContext('ws.onmessage({data: JSON.stringify({type: "sessionEnded"})})', context);
  context.history.replaceState(null, "", "/"); // Room.close resets the entry URL before the deferred exit.
  await settleFullscreen();
  assert.equal(state, -1, "Revoked Player stops audio");
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "Ended room exits fullscreen");
  assert.equal(historyIndex, 1);
  assert.equal(context.history.url, "/", "Room closure does not restore an obsolete room URL");
}
console.log("PASS: Host playback load orders, remote focus/OK/media keys, native/fallback fullscreen. YouTube and browser simulated.");
