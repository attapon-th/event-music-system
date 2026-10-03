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
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
  };
}
const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
let handlers;
const sent = [];
const context = createContext({
  document: { getElementById: node, createElement: () => element(), querySelectorAll: () => [], querySelector: () => element() },
  Room: { code: "123", ready: Promise.resolve(true), connect(value) { handlers = value; }, send: value => sent.push(JSON.parse(JSON.stringify(value))) },
  renderQueue() {}, NO_THUMB: "", confirm: () => true,
  setParticipantsVisible(visible) { node("participants-tab").hidden = !visible; if (!visible) node("participants-panel").hidden = true; },
});
const source = ["i18n.js", "admin.js"].map(file => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")).join("\n");
runInContext(source, context);
await Promise.resolve();
const state = { nowPlaying: null, queue: [], paused: false, volume: 100 };
const participants = [
  { id: "player", name: "Player", role: "player", online: true },
  { id: "owner", name: "ผู้ดูแล", role: "admin", online: true },
  { id: "guest", name: "ผู้ฟัง", role: "guest", online: false },
  { id: "helper", name: "ผู้ช่วย", role: "controller", online: true },
];
handlers.onAuth({ role: "admin" });
handlers.onState({ state, code: "123", memberId: "owner", primaryAdminId: "owner", role: "admin", participants,
  filterOn: false, moderationMode: "default", cooldownSeconds: 15 });
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
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 15 วินาที");
assert.equal(node("admin-auto-queue").getAttribute("aria-pressed"), "false");
node("admin-auto-queue").onclick();
assert.deepEqual(sent.at(-1), { type: "setAutoQueue", enabled: true });
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
assert.equal(list.children.length, 0, "Controller has no participant list");
assert.equal(node("participants-tab").hidden, true);
assert.equal(node("participants-panel").hidden, true);
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 30 วินาที", "button label follows the authoritative room snapshot");
handlers.onState({ state, code: "123", memberId: "helper", primaryAdminId: "owner", role: "controller", participants,
  cooldownSeconds: 60 });
node("admin-cooldown").onclick();
assert.deepEqual(sent.at(-1), { type: "setCooldown", seconds: 0 });
handlers.onState({ state, code: "123", memberId: "helper", primaryAdminId: "owner", role: "controller", participants,
  cooldownSeconds: 0 });
assert.equal(node("admin-cooldown-label").textContent, "เวลารอ: 0 วินาที");
console.log("PASS: Admin/Controller roster, online/offline names, primary-only role controls, cooldown button labels (DOM simulated).");
