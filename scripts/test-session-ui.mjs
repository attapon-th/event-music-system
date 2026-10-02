// Exercise the actual shared entry script with a minimal DOM and transport.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const source = ["i18n.js", "session.js"].map(file => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")).join("\n");

function page(screen, search, storage, respond) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const submit = { disabled: false };
      nodes.set(id, { id, value: "", hidden: false, disabled: false, textContent: "",
        focus() { this.focused = true; },
        querySelector: () => submit, setAttribute(name, value) { this[name] = value; },
        set innerHTML(html) {
          for (const tag of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) node(tag[1]).hidden = /\bhidden\b/.test(tag[0]);
        },
      });
    }
    return nodes.get(id);
  }
  const requests = [];
  const timers = [];
  const sockets = [];
  const context = createContext({
    URLSearchParams, location: { search, protocol: "http:", host: "localhost", reload() {}, replace(url) { this.href = url; } },
    history: { replaceState(_state, _title, url) { this.url = url; } },
    document: { body: { dataset: { screen }, prepend() {}, append() {} }, getElementById: node, createElement: () => node("panel"), querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body, headers: options.headers });
      const result = respond(path, body, options.headers);
      return { ok: !result.status || result.status < 400, status: result.status || 200, json: async () => JSON.parse(JSON.stringify(result.data)) };
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      sent = [];
      constructor() { sockets.push(this); }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.onclose?.(); }
    },
  });
  runInContext(source, context);
  return { run: (code) => runInContext(code, context), nodes, requests, timers, sockets, location: context.location, history: context.history };
}
const member = { code: "123", sessionId: "room-id", token: "member-token", memberId: "guest-id", role: "guest" };
let wrongPassword = true;
const entry = page("player", "", new Map(), (path, body) => {
  assert.equal(path, "/api/sessions");
  assert.equal(body.password, "room-password");
  if (wrongPassword) return { status: 401, data: { error: "รหัสสร้างไม่ถูกต้อง" } };
  return { data: { ...member, role: "player", token: "player-token" } };
});
assert.equal(await entry.run("Room.ready"), false);
assert.equal(entry.nodes.get("room-join").hidden, true);
assert.equal(entry.nodes.get("room-create").hidden, true);
assert.equal(entry.nodes.get("room-welcome").hidden, false);
assert.equal(entry.nodes.get("start-btn").focused, true);
entry.nodes.get("start-btn").onclick();
assert.equal(entry.requests.length, 0, "Start reveals the password field without creating a room");
assert.equal(entry.nodes.get("room-create").hidden, false);
assert.equal(entry.nodes.get("create-password").focused, true);
assert.equal(entry.nodes.get("start-btn").hidden, true);
entry.run("Room.onJoined = () => { globalThis.opened = true; }");
entry.nodes.get("create-password").value = "room-password";
await entry.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(entry.nodes.get("room-error").textContent, "รหัสสร้างไม่ถูกต้อง");
assert.equal(entry.nodes.get("room-create").hidden, false, "wrong passwords keep the entry field available for retry");
assert.equal(entry.nodes.get("room-content").hidden, true);
wrongPassword = false;
await entry.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(entry.run("opened"), true, "Creation immediately opens the Player in the same document");
assert.equal(entry.location.href, undefined, "Creation does not navigate away from its user gesture");
assert.match(entry.history.url, /^\/\?room=123&session=room-id$/);
assert.equal(entry.nodes.get("room-content").hidden, false);

const storage = new Map([["guestNickname", "ผู้ฟังเอ"]]);
let claimFails = true;
const guest = page("guest", "?room=123&session=room-id", storage, (path) => path.endsWith("claim") && claimFails
  ? { status: 403, data: { error: "ห้องนี้มีผู้ดูแลหลักแล้ว" } }
  : { data: { ...member, role: path.endsWith("claim") ? "admin" : "guest" } });
assert.equal(await guest.run("Room.ready"), true);
assert.equal(guest.requests[0].body.sessionId, "room-id");
assert.equal(storage.get("music-session:room-id:member"), member.token);
assert.equal(guest.nodes.get("panel").hidden, true, "Joined pages have no membership card");
guest.run("Room.connect({})");
const first = guest.sockets[0];
first.onopen();
assert.equal(first.sent[0].name, "ผู้ฟังเอ");
first.onmessage({ data: JSON.stringify({ type: "auth", ok: true, role: "guest" }) });
first.onmessage({ data: JSON.stringify({ type: "state", role: "guest", primaryAdminId: null }) });
assert.equal(guest.nodes.get("claim-admin").hidden, false);
await guest.nodes.get("claim-admin").onclick();
assert.equal(guest.nodes.get("claim-error").hidden, false, "failed claims show feedback inside the active Guest page");
assert.equal(guest.nodes.get("panel").hidden, true);
claimFails = false;
await guest.nodes.get("claim-admin").onclick();
assert.match(guest.location.href, /^\/a\?room=123&session=room-id$/);

const promoted = page("guest", "?room=123&session=room-id", storage, () => ({ data: member }));
await promoted.run("Room.ready");
promoted.run("Room.connect({})");
promoted.sockets[0].onmessage({ data: JSON.stringify({ type: "state", role: "controller", primaryAdminId: "owner" }) });
assert.match(promoted.location.href, /^\/a\?room=123/);
const controller = page("admin", "?room=123&session=room-id", storage, () => ({ data: { ...member, role: "controller" } }));
assert.equal(await controller.run("Room.ready"), true);
assert.equal(controller.requests[0].headers.Authorization, `Bearer ${member.token}`);
controller.run("Room.connect({})");
const controllerSocket = controller.sockets[0];
controllerSocket.onopen();
controllerSocket.close();
controller.timers.at(-1)();
controller.sockets[1].onopen();
assert.equal(controller.sockets[1].sent[0].token, member.token, "network reconnect preserves the credential");
controller.sockets[1].onmessage({ data: JSON.stringify({ type: "state", role: "guest", primaryAdminId: "owner" }) });
assert.match(controller.location.href, /^\/guest\?room=123/);

const expired = page("guest", "?room=123&session=old-id", new Map(), (_path, body) => body.sessionId
  ? { status: 410, data: { error: "ห้องหมดอายุ" } } : { data: member });
assert.equal(await expired.run("Room.ready"), false);
assert.equal(expired.nodes.get("panel").hidden, false);
expired.nodes.get("room-code").value = "123";
await expired.nodes.get("room-join").onsubmit({ preventDefault() {} });
assert.equal(expired.requests.at(-1).body.sessionId, undefined);
assert.match(expired.location.href, /^\/guest\?room=123&session=room-id$/);

const playerKey = "music-session:room-id:player";
const playerStorage = new Map([[playerKey, "player-token"]]);
const player = page("player", "?room=123&session=room-id", playerStorage, () => ({ data: { ...member, token: "player-token", role: "player" } }));
assert.equal(await player.run("Room.ready"), true);
player.run("Room.connect({ onEnd() { globalThis.ended = true; } })");
player.sockets[0].onmessage({ data: JSON.stringify({ type: "sessionEnded", code: "ROOM_CLOSED", error: "ห้องปิดแล้ว" }) });
assert.equal(player.run("ended"), true);
assert.equal(playerStorage.has(playerKey), false);
assert.equal(player.nodes.get("room-content").hidden, true);
assert.equal(player.nodes.get("room-create").hidden, true);
assert.equal(player.nodes.get("start-btn").hidden, false);
assert.equal(player.nodes.get("start-btn").focused, true);
assert.equal(player.timers.length, 0);
console.log("PASS: Player welcome/password/retry/startup, Guest join/claim, /a promotion/revocation redirects, reconnect, room close (DOM simulated).");
