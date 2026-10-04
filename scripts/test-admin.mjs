// Run the actual Admin script to check the roster and settings controls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const nodes = new Map();
function element(id = "") {
  const selectors = new Map();
  const attrs = new Map();
  return { id, children: [], dataset: {}, disabled: false, value: "100", textContent: "",
    classList: { add() {}, remove() {} },
    setAttribute(key, value) { attrs.set(key, value); },
    getAttribute: key => attrs.get(key),
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    set innerHTML(value) { this.children = []; this.markup = value; },
    setPointerCapture() {},
    getBoundingClientRect() { return { top: 100, height: 44 }; },
    closest() { return this; },
    focus() { context.document.activeElement = this; },
    insertBefore(child, before) { this.children = this.children.filter(item => item !== child); const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); },
    querySelectorAll(selector) {
      if (selector === "button") return this.children.flatMap(row => [row.children[0], ...row.children[3].children]).filter(child => child.dataset.queueAction);
      return this.children.filter(child => child.dataset.id);
    },
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
  };
}
const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
let handlers;
const sent = [];
let time = 0;
let timerId = 0;
const timers = new Map();
const pageEvents = {};
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
  document: { getElementById: node, createElement: () => element(), querySelectorAll: () => [], querySelector: () => element() },
  Room: { code: "123", ready: Promise.resolve(true), connect(value) { handlers = value; }, send: value => sent.push(JSON.parse(JSON.stringify(value))) },
  Date: class extends Date { static now() { return time; } },
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  window: { innerHeight: 800, scrollBy() {}, addEventListener(type, handler) { pageEvents[type] = handler; } },
  renderQueue() {}, NO_THUMB: "", confirm: () => true,
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
assert.match(list.children[2].children[0].textContent, /ผู้ฟัง.*ออฟไลน์/);
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
assert.equal(node("auto-queue-status").textContent, "กำลังหาเพลงแนะนำ…");
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
const actions = id => node("queue").children.find(row => row.dataset.id === id).children[3].children;
const remove = id => { const button = actions(id).find(button => button.title === "ลบ"); button.focus(); button.onclick(); };
const cancel = id => { const button = actions(id).find(button => button.className === "cancel-removal"); button.focus(); button.onclick(); };
const countdown = id => actions(id).find(label => label.className === "remove-countdown").textContent;
const deletions = () => sent.filter(message => message.type === "remove");
snapshot();
assert.deepEqual(actions("queue-1").map(button => button.title), ["เล่นตอนนี้", "ลบ"], "Up/down actions are removed");
actions("queue-1")[0].onclick();
assert.deepEqual(sent.at(-1), { type: "playNow", id: "queue-1" });
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
assert.equal(context.document.activeElement.title, "ลบ", "Cancellation returns focus to the delete action");
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
assert.equal(actions("queue-1").some(button => button.className === "cancel-removal"), false, "Back from browser cache does not restore pending deletion");
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
console.log("PASS: Admin/Controller roster and grant-only permissions; cancellable independent five-second removals; snapshots/role loss/disconnect/drag; queue actions and settings (DOM simulated).");
