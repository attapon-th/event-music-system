// Replay both API load orders through the scripts in the actual Host page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const publicDir = new URL("../public/", import.meta.url);
const html = readFileSync(new URL("host.html", publicDir), "utf8");
assert.equal(html.includes('href="/admin"'), false, "Admin link belongs on Guest only");
assert.equal(readFileSync(new URL("guest.html", publicDir), "utf8").includes('href="/admin"'), true);

for (const earlyReady of [false, true]) {
  const nodes = new Map();
  const calls = [];
  let state = -1;
  let apiReady;
  const messages = [];
  const listeners = {};
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        const attributes = new Map();
        nodes.set(id, {
        id, tagName: id.includes("input") || id === "volume" ? "INPUT" : "BUTTON", dataset: {},
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
    addEventListener() {}, setTimeout: () => 1, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ token: "test-token", guestUrl: "http://localhost/guest" }) }),
    WebSocket: class { readyState = 1; send(data) { messages.push(JSON.parse(data)); } },
  });
  context.window = context;
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
    if (src.startsWith("https://www.youtube.com/")) {
      context.YT = {
        PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 },
        Player: function (id, options) {
          calls.push(["init", id]);
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
    } else {
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
  assert.equal(document.activeElement.id, "start-btn", "Remote can start without a mouse");
  runInContext(`ws.onmessage({ data: JSON.stringify({ type: "state", state: {
    nowPlaying: { videoId: "song0000001", title: "Test", channel: "Artist" },
    queue: [], paused: false, volume: 37
  } }) });`, context);
  press("Unidentified", { keyCode: 23 });
  assert.equal(document.activeElement.id, "playpause");
  assert.equal(calls.filter(([action]) => action === "init").length, 1, `API ready ${earlyReady ? "before" : "after"} Host script: initialize one player`);
  assert.ok(calls.some(([action, id]) => action === "load" && id === "song0000001"), "Start must load the current song");
  assert.equal(state, 1, "Start must play the current song");
  runInContext("latestState.paused = true; syncPlayer();", context);
  assert.equal(state, 2);
  runInContext("latestState.paused = false; syncPlayer();", context);
  assert.equal(state, 1);
  assert.ok(calls.some(([action, volume]) => action === "volume" && volume === 37));
  assert.equal(document.getElementById("player").getAttribute("tabindex"), "-1");
  const play = document.getElementById("playpause");
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
  press("ArrowDown");
  assert.equal(document.activeElement, fullscreen, "Fullscreen focus stays on its visible exit control");
  press("Unidentified", { keyCode: 4 });
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "Remote Back restores original layout");
  wrap.requestFullscreen = async () => { document.fullscreenElement = wrap; listeners.fullscreenchange(); };
  document.exitFullscreen = async () => { document.fullscreenElement = null; listeners.fullscreenchange(); };
  await fullscreen.click();
  assert.equal(document.fullscreenElement, wrap, "Fullscreen targets video wrapper, keeping exit reachable");
  press("Escape");
  await Promise.resolve();
  assert.equal(document.fullscreenElement, null);
  assert.equal(fullscreen.getAttribute("aria-pressed"), "false");
  wrap.requestFullscreen = async () => { throw new Error("Unsupported TV browser"); };
  await fullscreen.click();
  assert.equal(wrap.classList.contains("video-fullscreen"), true, "Rejected native fullscreen also falls back");
  press("Enter");
  assert.equal(wrap.classList.contains("video-fullscreen"), false, "OK exits fullscreen without mouse");
  runInContext('latestState.queue = [{ id: "queued-1", title: "Queued", channel: "Artist" }]; render();', context);
  document.getElementById("queue").querySelectorAll()[0].focus();
  runInContext("render();", context);
  assert.equal(document.activeElement.dataset.queueId, "queued-1", "Queue broadcasts preserve remote selection");
  runInContext("latestState.queue = []; render();", context);
  assert.equal(document.activeElement, skip, "Removing focused track returns focus to a visible control");
}
console.log("PASS: Host playback load orders, remote focus/OK/media keys, native/fallback fullscreen. YouTube and browser simulated.");
