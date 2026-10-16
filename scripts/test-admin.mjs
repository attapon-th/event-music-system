// Run the actual Admin script to check the roster and settings controls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const nodes = new Map();
function element(id = "", tagName = "div") {
  const selectors = new Map();
  const attrs = new Map();
  return { id, tagName, style: {}, offsetWidth: 208, offsetHeight: 196, hidden: false, children: [], dataset: {}, disabled: false, value: "100", textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { attrs.set(key, value); },
    getAttribute: key => attrs.get(key),
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    set innerHTML(value) { this.children = []; this.markup = value; },
    setPointerCapture() {},
    getBoundingClientRect() { return { top: 100, bottom: 144, left: 180, right: 224, height: 44 }; },
    contains(node) { return this === node || this.children.some(child => child.contains(node)); },
    showModal() { this.open = true; }, close() { this.open = false; },
    closest() { return this; },
    focus() { context.document.activeElement = this; },
    insertBefore(child, before) { this.children = this.children.filter(item => item !== child); const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); },
    querySelectorAll(selector) {
      if (selector === "button") return this.children.flatMap(child => [ ...(child.tagName === "button" ? [child] : []), ...child.querySelectorAll("button") ]);
      return this.children.filter(child => child.dataset.id);
    },
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
  };
}
const node = id => { if (!nodes.has(id)) { const el = element(id); el.hidden = ["queue-menu", "volume-panel"].includes(id); nodes.set(id, el); } return nodes.get(id); };
let handlers;
const sent = [];
let time = 0;
let timerId = 0;
const timers = new Map();
const pageEvents = {};
const documentEvents = {};
function advance(ms) {
  const until = time + ms;
  while (true) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > until) break;
    time = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
  }
  time = until;
}
const context = createContext({
  document: { getElementById: node, createElement: tag => element("", tag), addEventListener(type, handler) { documentEvents[type] = handler; }, querySelectorAll: () => [], querySelector: () => element() },
  Room: { code: "123", ready: Promise.resolve(true), connect(value) { handlers = value; }, send: value => sent.push(JSON.parse(JSON.stringify(value))) },
  Date: class extends Date { static now() { return time; } },
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  window: { innerHeight: 800, innerWidth: 320, scrollBy() {}, addEventListener(type, handler) { pageEvents[type] = handler; } },
  setConnectionStatus(status) { node("connection").dataset.status = status; },
  renderNowPlaying(state) { node("auto-queue-status").textContent = [state.autoQueue && "เล่นต่ออัตโนมัติเปิดอยู่", state.autoQueueStatus === "loading" && "กำลังหาเพลงแนะนำ…"].filter(Boolean).join(" · "); },
  songMeta: item => item.channel, NO_THUMB: "", confirm: () => true,
  setParticipantsVisible(visible) { node("participants-tab").hidden = !visible; if (!visible) node("participants-panel").hidden = true; },
});
const source = ["i18n.js", "admin.js"].map(file => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")).join("\n");
runInContext(source, context);
await Promise.resolve();
const state = { nowPlaying: null, queue: [], paused: false, volume: 100, autoQueue: true };
const participants = [
  { id: "player", name: "Player", role: "player", online: true },
  { id: "owner", name: "ผู้ดูแล", role: "admin", online: true },
  { id: "guest", name: "ผู้ฟัง", role: "guest", online: false },
  { id: "helper", name: "ผู้ช่วย", role: "controller", online: true },
];
handlers.onAuth({ role: "admin" });
handlers.onState({ state, code: "123", memberId: "owner", primaryAdminId: "owner", role: "admin", participants,
  filterOn: false, moderationMode: "default", cooldownSeconds: 5 });
assert.equal(node("admin-title").textContent, "ผู้ดูแลเพลง · ห้อง 123");
const list = node("participants-list");
assert.equal(list.children.length, 4, "roster includes online and offline members");
assert.equal(node("participants-tab").hidden, false);
assert.equal(list.children[0].children.length, 1, "Player rights cannot be assigned");
assert.equal(list.children[1].children.length, 1, "primary Admin cannot revoke their own role");
assert.equal(list.children[2].children[0].children[0].textContent, "ผู้ฟัง");
assert.match(list.children[2].children[0].children[1].children[1].textContent, /ออฟไลน์/);
list.children[2].children[1].onclick();
assert.deepEqual(sent.at(-1), { type: "setParticipantRole", id: "guest", enabled: true });
list.children[3].children[1].onclick();
assert.deepEqual(sent.at(-1), { type: "setParticipantRole", id: "helper", enabled: false });
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 5 วินาที");
assert.equal(node("admin-auto-queue").getAttribute("aria-pressed"), "true");
node("admin-auto-queue").onclick();
assert.deepEqual(sent.at(-1), { type: "setAutoQueue", enabled: false });
state.autoQueue = true;
state.autoQueueStatus = "loading";
handlers.onState({ state, role: "admin", participants });
assert.equal(node("admin-auto-queue").getAttribute("aria-pressed"), "true");
assert.equal(node("admin-auto-queue").textContent, "เล่นต่ออัตโนมัติ: เปิด");
assert.equal(node("auto-queue-status").textContent, "เล่นต่ออัตโนมัติเปิดอยู่ · กำลังหาเพลงแนะนำ…");
node("admin-auto-queue").onclick();
assert.deepEqual(sent.at(-1), { type: "setAutoQueue", enabled: false });
handlers.onState({ state, role: "admin", participants, cooldownSeconds: 15 });
node("admin-cooldown").onclick();
assert.deepEqual(sent.at(-1), { type: "setCooldown", seconds: 30 });
handlers.onState({ state, code: "123", memberId: "helper", primaryAdminId: "owner", role: "controller", participants,
  filterOn: true, moderationMode: "default", cooldownSeconds: 30 });
assert.equal(list.children.length, 4, "Controller sees the participant roster");
assert.equal(node("participants-tab").hidden, false);
assert.equal(list.children[0].children.length, 1, "Controller cannot edit Player");
assert.equal(list.children[1].children.length, 1, "Controller cannot edit Admin");
assert.equal(list.children[3].children.length, 1, "Controller cannot revoke Controller");
list.children[2].children[1].onclick();
assert.deepEqual(sent.at(-1), { type: "setParticipantRole", id: "guest", enabled: true });
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 30 วินาที", "button label follows the authoritative room snapshot");
handlers.onState({ state, code: "123", memberId: "helper", primaryAdminId: "owner", role: "controller", participants,
  cooldownSeconds: 60 });
node("admin-cooldown").onclick();
assert.deepEqual(sent.at(-1), { type: "setCooldown", seconds: 0 });
handlers.onState({ state, code: "123", memberId: "helper", primaryAdminId: "owner", role: "controller", participants,
  cooldownSeconds: 0 });
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 0 วินาที");
// Fake time exercises real queue buttons and transport calls.
const items = [1, 2, 3].map(n => ({ id: `queue-${n}`, title: `Song ${n}`, channel: "Artist" }));
const snapshot = (queue = items, role = "controller") => handlers.onState({
  state: { ...state, queue }, code: "123", role, participants,
});
const rowFor = id => node("queue").children.find(row => row.dataset.id === id);
const more = id => rowFor(id).children[3].children[0];
const actions = id => { more(id).onclick(); return node("queue-menu").children; };
const remove = id => { actions(id).find(button => button.dataset.queueAction === "remove").onclick(); };
const cancel = id => { const button = rowFor(id).children[4].children[1]; button.focus(); button.onclick(); };
const countdown = id => rowFor(id).children[4].children[0].textContent;
const deletions = () => sent.filter(message => message.type === "remove");
snapshot();
assert.equal(rowFor("queue-1").children[3].children.length, 1, "Rows expose a single More action");
assert.deepEqual(actions("queue-1").map(button => button.dataset.queueAction), ["playNow", "moveUp", "moveDown", "remove"]);
assert.equal(node("queue-menu").children[1].disabled, true, "First item cannot move up");
assert.equal(more("queue-1").getAttribute("aria-expanded"), "true");
node("queue-menu").children[0].onclick();
assert.deepEqual(sent.at(-1), { type: "playNow", id: "queue-1" });
assert.equal(node("queue-menu").hidden, true);
actions("queue-2")[1].onclick();
assert.deepEqual(sent.at(-1), { type: "move", id: "queue-2", dir: "up" });
actions("queue-2")[2].onclick();
assert.deepEqual(sent.at(-1), { type: "move", id: "queue-2", dir: "down" });
remove("queue-1");
assert.equal(countdown("queue-1"), "ลบใน 5 วินาที");
assert.equal(context.document.activeElement.className, "cancel-removal", "Deletion keeps keyboard focus on cancellation");
assert.equal(deletions().length, 0);
advance(2000);
assert.equal(countdown("queue-1"), "ลบใน 3 วินาที");
snapshot();
assert.equal(countdown("queue-1"), "ลบใน 3 วินาที", "Snapshots retain the deadline");
assert.equal(context.document.activeElement.className, "cancel-removal", "Queue updates retain cancellation focus");
runInContext('startRemoval("queue-1")', context);
remove("queue-2");
assert.equal(countdown("queue-2"), "ลบใน 5 วินาที");
advance(1000);
cancel("queue-2");
assert.equal(context.document.activeElement.className, "queue-more", "Cancellation returns focus to More");
advance(1999);
assert.equal(deletions().length, 0, "Deletion is not sent before five seconds");
advance(1);
assert.deepEqual(deletions(), [{ type: "remove", id: "queue-1" }]);
advance(5000);
assert.equal(deletions().length, 1, "Cancelled deletion is never sent");
// Queue removal and promotion both remove the item from the upcoming queue.
for (const disappeared of ["removed", "promoted"]) {
  snapshot();
  remove("queue-1");
  snapshot(items.slice(1));
  advance(5000);
  assert.equal(deletions().length, 1, `${disappeared} item cancels its pending deletion`);
}
for (const stop of [() => handlers.onOffline(), () => snapshot(items, "guest"), () => handlers.onEnd(), () => pageEvents.pagehide()]) {
  snapshot();
  remove("queue-1");
  stop();
  advance(5000);
  assert.equal(deletions().length, 1, "Disconnect, lost role, exit, and page navigation cancel pending deletion");
}
pageEvents.pageshow({ persisted: true });
assert.equal(rowFor("queue-1").children.length, 4, "Back from browser cache does not restore pending deletion");
snapshot(items, "guest");
assert.equal(list.children.length, 0);
assert.equal(node("participants-tab").hidden, true);
// Multiple deadlines fire independently, even during a drag.
snapshot();
remove("queue-1");
advance(1000);
remove("queue-2");
const rows = node("queue").children;
const handle = rows[0].children[0];
context.document.elementFromPoint = () => rows[2];
handle.onpointerdown({ button: 0, pointerId: 1 });
advance(4000);
assert.equal(deletions().length, 2);
handle.onpointermove({ clientX: 0, clientY: 150, pointerId: 1 });
handle.onpointerup();
assert.deepEqual(sent.at(-1), { type: "reorder", ids: ["queue-2", "queue-3", "queue-1"] }, "Drag reorder still sends every queue ID");
advance(1000);
assert.equal(deletions().length, 3);
assert.equal(timers.size, 0);
snapshot();
actions("queue-1");
node("queue-menu").onkeydown({ key: "ArrowDown", preventDefault() {} });
assert.equal(context.document.activeElement.dataset.queueAction, "moveDown", "Arrow navigation skips disabled menu items");
documentEvents.keydown({ key: "Escape", preventDefault() {} });
assert.equal(node("queue-menu").hidden, true);
assert.equal(context.document.activeElement, more("queue-1"), "Escape restores trigger focus");
actions("queue-2");
documentEvents.pointerdown({ target: node("outside") });
assert.equal(node("queue-menu").hidden, true, "Outside pointer closes the menu");
actions("queue-1");
actions("queue-2");
assert.equal(more("queue-1").getAttribute("aria-expanded"), "false", "Only one menu is open");
assert.equal(more("queue-2").getAttribute("aria-expanded"), "true");
assert.ok(parseFloat(node("queue-menu").style.left) >= 8);
assert.ok(parseFloat(node("queue-menu").style.left) + 208 <= 312, "Menu is clamped inside 320px viewport");
pageEvents.scroll({ target: node("outside") });
assert.equal(node("queue-menu").hidden, true);
for (const [paused, visible, type] of [[true, "admin-play", "play"], [false, "admin-pause", "pause"]]) {
  handlers.onState({ state: { ...state, paused }, role: "admin", participants });
  assert.equal(node(visible).hidden, false);
  assert.equal(node(paused ? "admin-pause" : "admin-play").hidden, true);
  node(visible).onclick();
  assert.equal(sent.at(-1).type, type);
}
node("admin-skip").onclick();
assert.equal(sent.at(-1).type, "skip");
node("admin-volume-toggle").onclick();
assert.equal(node("volume-panel").hidden, false);
node("admin-volume").oninput({ target: { value: "35" } });
assert.deepEqual(sent.at(-1), { type: "setVolume", volume: 35 });
documentEvents.keydown({ key: "Escape", preventDefault() {} });
assert.equal(node("volume-panel").hidden, true);
node("admin-settings").onclick();
assert.equal(node("settings-drawer").open, true);
handlers.onOffline();
assert.equal(node("settings-drawer").open, false, "Disconnect closes privileged settings");
assert.equal(node("admin-settings").disabled, true);
handlers.onAuth({ role: "admin" });
node("admin-clear").onclick();
assert.equal(sent.at(-1).type, "clear", "Retained clear handler confirms before sending");
context.confirm = () => false;
const beforeClear = sent.length;
node("admin-clear").onclick();
assert.equal(sent.length, beforeClear, "Cancelling clear sends no command");
assert.match(readFileSync(new URL("../public/admin.html", import.meta.url), "utf8"), /id="admin-clear"[^>]*hidden/, "Clear remains hidden as before");
console.log("PASS: Admin/Controller roster and grant-only permissions; cancellable independent five-second removals; snapshots/role loss/disconnect/drag; queue actions and settings (DOM simulated).");
