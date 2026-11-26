// Exercise the actual shared entry script with a minimal DOM and transport.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const source = ["i18n.js", "session.js"].map(file => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")).join("\n");

function page(screen, search, storage, respond, tabStorage = new Map()) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const submit = { disabled: false };
      nodes.set(id, { id, value: "", hidden: false, disabled: false, textContent: "",
        focus() { this.focused = true; },
        querySelector: () => submit, setAttribute(name, value) { this[name] = value; },
        set innerHTML(html) {
          for (const tag of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
            const element = node(tag[1]);
            element.hidden = /\bhidden\b/.test(tag[0]);
            for (const attr of tag[0].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attr[1], attr[2]);
          }
        },
      });
    }
    return nodes.get(id);
  }
  const requests = [];
  const timers = [];
  const pendingTimers = new Map();
  let time = 0;
  const sockets = [];
  const context = createContext({
    URLSearchParams, location: { search, protocol: "http:", host: "localhost", reload() {}, replace(url) { this.href = url; } },
    history: { replaceState(_state, _title, url) { this.url = url; } },
    document: { body: { dataset: { screen }, prepend() {}, append() {} }, getElementById: node, createElement: () => node("panel"), querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: key => tabStorage.get(key), setItem: (key, value) => tabStorage.set(key, value), removeItem: key => tabStorage.delete(key) },
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body, headers: options.headers });
      const result = await respond(path, body, options.headers);
      return { ok: !result.status || result.status < 400, status: result.status || 200, json: async () => JSON.parse(JSON.stringify(result.data)) };
    },
    Date: class extends Date { static now() { return time; } },
    setTimeout: (fn, delay = 0) => {
      const id = timers.length + 1;
      const run = () => { pendingTimers.delete(id); fn(); };
      timers.push(run);
      pendingTimers.set(id, { at: time + delay, run });
      return id;
    },
    clearTimeout: id => pendingTimers.delete(id),
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
  return { run: (code) => runInContext(code, context), nodes, requests, timers, sockets, location: context.location, history: context.history,
    advance(ms) {
      time += ms;
      for (const timer of [...pendingTimers.values()]) if (timer.at <= time) timer.run();
    },
  };
}
const member = { code: "123", sessionId: "room-id", token: "member-token", memberId: "guest-id", role: "guest" };
const playerMember = { ...member, role: "player", token: "player-token" };
const submit = page => page.nodes.get("room-join").onsubmit({ preventDefault() {} });
const openEntry = (page, mode) => page.nodes.get(`open-${mode}-entry`).onclick();
const enterNumber = (page, mode) => {
  openEntry(page, mode);
  page.nodes.get("room-code").value = "123";
  return submit(page);
};

const entry = page("player", "", new Map(), (path, body) => {
  assert.equal(path, "/api/sessions");
  assert.equal(body.code, "1236");
  return { data: playerMember };
});
assert.equal(await entry.run("Room.ready"), false);
assert.equal(entry.nodes.get("room-welcome").hidden, false);
assert.equal(entry.nodes.get("room-join").hidden, true);
assert.equal(entry.nodes.get("start-btn").focused, true);
assert.equal(entry.nodes.get("room-code").inputmode, "numeric");
assert.equal(entry.nodes.get("room-code").pattern, "[1-9][0-9]{2}");
assert.equal(entry.nodes.get("room-code").maxlength, "3");
assert.equal(entry.nodes.has("room-options"), false);
entry.run("Room.onJoined = () => { globalThis.opened = true; }");
await enterNumber(entry, "player");
assert.equal(entry.run("globalThis.opened"), true);
assert.equal(entry.history.url, "/?room=123&session=room-id");
assert.equal(entry.nodes.get("room-content").hidden, false);

for (const role of ["guest", "admin", "controller"]) {
  const stored = new Map([["music-room:123", member.sessionId], [`music-session:${member.sessionId}:member`, member.token]]);
  const joining = page("player", "", stored, (path, body, headers) => {
    assert.equal(path, "/api/sessions/join");
    assert.deepEqual(body, { code: "123" });
    assert.equal(headers.Authorization, "Bearer member-token");
    return { data: { ...member, role } };
  });
  await enterNumber(joining, "queue");
  assert.equal(joining.location.href, `${role === "guest" ? "/guest" : "/a"}?room=123&session=room-id`);
}

const missing = page("player", "", new Map(), () => ({ status: 410, data: { error: "ไม่มีห้องนี้", retryIn: 5 } }));
await enterNumber(missing, "queue");
assert.equal(missing.nodes.get("room-error").textContent, "ไม่มีห้องนี้");
assert.equal(missing.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 10 วินาที");
assert.equal(missing.nodes.get("start-btn").disabled, false);
assert.equal(missing.nodes.get("open-player-entry").disabled, false);
assert.equal(missing.run("Room.closeEntry()"), true);
openEntry(missing, "player");
assert.equal(missing.nodes.get("room-join").querySelector().disabled, false);
openEntry(missing, "queue");
missing.advance(9999);
await submit(missing);
assert.equal(missing.requests.length, 1);
missing.advance(1);
await submit(missing);
assert.equal(missing.requests.length, 2);

const limited = page("player", "", new Map(), () => ({ status: 429, data: { error: "รอก่อน", retryIn: 60 } }));
await enterNumber(limited, "player");
assert.equal(limited.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 60 วินาที");
await submit(limited);
assert.equal(limited.requests.length, 1);
limited.advance(60000);
assert.equal(limited.nodes.get("room-join").querySelector().disabled, false);

const networkError = page("player", "", new Map(), () => { throw new Error("offline"); });
await enterNumber(networkError, "player");
assert.match(networkError.nodes.get("room-error").textContent, /การเชื่อมต่อ/);
assert.equal(networkError.nodes.get("room-join").querySelector().disabled, false);

let resolvePending;
const oldRecord = new Map([["music-last-player", JSON.stringify(playerMember)]]);
const random = page("player", "", oldRecord, (path, body) => {
  assert.equal(path, "/api/sessions/random");
  assert.deepEqual(body, {});
  return new Promise(resolve => { resolvePending = resolve; });
});
const start = random.nodes.get("start-btn");
const starting = start.onclick();
assert.equal(start.disabled, true);
await start.onclick();
assert.equal(random.requests.length, 1);
assert.equal(oldRecord.has("music-last-player"), false);
resolvePending({ data: playerMember });
await starting;
assert.equal(random.history.url, "/?room=123&session=room-id");
assert.equal(random.nodes.get("room-content").hidden, false);
const full = page("player", "", new Map(), () => ({ status: 409, data: { error: "ห้องเต็ม กรุณาลองใหม่ภายหลัง" } }));
await full.nodes.get("start-btn").onclick();
assert.match(full.nodes.get("room-error").textContent, /ห้องเต็ม/);
assert.equal(full.nodes.get("start-btn").disabled, false);

const storage = new Map([["guestNickname", "ผู้ฟังเอ"]]);
const firstAdmin = page("guest", "?room=123&session=room-id", storage, path => {
  assert.equal(path, "/api/sessions/join");
  return { data: { ...member, role: "admin" } };
});
assert.equal(await firstAdmin.run("Room.ready"), false, "first QR participant redirects before opening Guest content");
assert.equal(firstAdmin.location.href, "/a?room=123&session=room-id");
assert.equal(firstAdmin.requests.length, 1, "Admin admission requires only the join request");
assert.equal(storage.get("music-session:room-id:member"), member.token, "automatic Admin credentials survive the redirect");
const admin = page("admin", "?room=123&session=room-id", storage, (_path, _body, headers) => {
  assert.equal(headers.Authorization, `Bearer ${member.token}`);
  return { data: { ...member, role: "admin" } };
});
assert.equal(await admin.run("Room.ready"), true, "automatic Admin opens /a and survives refresh");
assert.equal(admin.nodes.get("room-content").hidden, false);
for (const screen of ["guest", "admin"]) {
  const joined = page(screen, "", new Map(), path => {
    assert.equal(path, "/api/sessions/join");
    return { data: { ...member, role: "admin" } };
  });
  assert.equal(await joined.run("Room.ready"), false);
  joined.nodes.get("room-code").value = "123";
  await joined.nodes.get("room-join").onsubmit({ preventDefault() {} });
  assert.equal(joined.location.href, "/a?room=123&session=room-id", "first manual participant goes straight to Admin");
}
assert.doesNotMatch(readFileSync(new URL("../public/guest.html", import.meta.url), "utf8"), /claim-admin|claim-error|claimAdmin/);
const guest = page("guest", "?room=123&session=room-id", storage, () => ({ data: member }));
assert.equal(await guest.run("Room.ready"), true);
assert.equal(guest.requests[0].body.sessionId, "room-id");
assert.equal(storage.get("music-session:room-id:member"), member.token);
assert.equal(guest.nodes.get("panel").hidden, true, "Joined pages have no membership card");
guest.run("Room.connect({})");
const first = guest.sockets[0];
first.onopen();
assert.equal(first.sent[0].name, "ผู้ฟังเอ");
first.onmessage({ data: JSON.stringify({ type: "auth", ok: true, role: "guest" }) });
first.onmessage({ data: JSON.stringify({ type: "state", role: "guest", primaryAdminId: "owner" }) });
assert.equal(guest.location.href, undefined, "later participants stay on Guest");

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
assert.equal(controller.sockets[1].sent[0].sessionId, member.sessionId);
assert.equal(controller.run("Room.send({type:'pause'})"), false, "Do not send controls before reconnect authentication");
controller.sockets[1].onmessage({ data: JSON.stringify({ type: "auth", ok: true, role: "controller" }) });
assert.equal(controller.run("Room.connected"), true);
assert.equal(controller.run("Room.send({type:'pause'})"), true);
controller.sockets[1].onmessage({ data: JSON.stringify({ type: "state", role: "guest", primaryAdminId: "owner" }) });
assert.match(controller.location.href, /^\/guest\?room=123/);

const rejectedRequest = page("guest", "?room=123&session=room-id", new Map(), path => path === "/api/request"
  ? { status: 400, data: { ok: false, reason: "ข้อมูลเพลงไม่ถูกต้อง" } } : { data: member });
await rejectedRequest.run("Room.ready");
await assert.rejects(rejectedRequest.run("Room.fetch('/api/request', {method:'POST',body:'{}'})"), /ข้อมูลเพลงไม่ถูกต้อง/, "Request validation reasons survive the shared HTTP error handler");

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
const player = page("player", "?room=123&session=room-id", new Map(), () => ({ data: { ...member, token: "player-token", role: "player" } }), playerStorage);
assert.equal(await player.run("Room.ready"), true);
player.run("Room.connect({ onEnd() { globalThis.ended = true; } })");
player.sockets[0].onmessage({ data: JSON.stringify({ type: "sessionEnded", code: "ROOM_CLOSED", error: "ห้องปิดแล้ว" }) });
assert.equal(player.run("ended"), true);
assert.equal(playerStorage.has(playerKey), false);
assert.equal(player.nodes.get("room-content").hidden, true);
assert.equal(player.nodes.get("room-join").hidden, true);
assert.equal(player.nodes.get("room-welcome").hidden, false);
assert.equal(player.nodes.get("start-btn").focused, true);
assert.equal(player.timers.length, 0);
assert.equal(player.history.url, "/");

for (const viaHttp of [false, true]) {
  const lostStorage = new Map([[playerKey, "player-token"]]);
  const lost = page("player", "?room=123&session=room-id", new Map(), path => path === "/api/state"
    ? { status: 401, data: { code: "SESSION_INVALID", error: "ห้องหาย" } }
    : { data: { ...member, token: "player-token", role: "player" } }, lostStorage);
  await lost.run("Room.ready");
  lost.run("Room.connect({ authData: () => ({completed:[{id:'song-id',videoId:'song0000001',failed:false}]}), onUnavailable(message) { globalThis.lostMessage = message; return true; }, onEnd() { globalThis.ended = true; } })");
  lost.sockets[0].onopen();
  assert.equal(lost.sockets[0].sent[0].completed[0].id, "song-id", "Reconnect authenticates with offline progress");
  if (viaHttp) await assert.rejects(lost.run("Room.fetch('/api/state')"));
  else lost.sockets[0].onmessage({ data: JSON.stringify({ type: "auth", ok: false, error: "ห้องหาย" }) });
  assert.equal(lost.run("lostMessage"), "ห้องหาย");
  assert.equal(lost.run("typeof ended"), "undefined");
  assert.equal(lost.nodes.get("room-content").hidden, false, "Missing-room recovery keeps Player visible until its queue drains");
  assert.equal(lost.run("Room.connected"), false);
  assert.equal(lost.run("Room.send({type:'ended'})"), false);
  assert.equal(lost.timers.length, 0, "Do not keep retrying a room confirmed missing");
  lost.run("Room.finish(lostMessage)");
  assert.equal(lost.run("ended"), true);
  assert.equal(lostStorage.has(playerKey), false);
  assert.equal(lost.nodes.get("room-content").hidden, true);
  assert.equal(lost.history.url, "/");
}

// Player tabs use independent storage, and leaving is entirely local.
const sharedStorage = new Map();
const tabs = [new Map(), new Map()];
const players = tabs.map((tabStorage, index) => page("player", "", sharedStorage,
  (path, body) => {
    assert.equal(path, "/api/sessions");
    assert.equal(body.code, "1236");
    return { data: { ...member, role: "player", token: `player-${index}` } };
  }, tabStorage));
for (const tab of players) {
  await tab.run("Room.ready");
  await enterNumber(tab, "player");
  tab.run("Room.connect({onEnd() { globalThis.ended = true; }})");
}
assert.equal(sharedStorage.has(playerKey), false, "Active Player credentials remain in tab storage");
assert.equal(tabs[0].get(playerKey), "player-0");
assert.equal(tabs[1].get(playerKey), "player-1");
const refreshed = page("player", "?room=123&session=room-id", sharedStorage, (_path, _body, headers) => {
  assert.equal(headers.Authorization, "Bearer player-1");
  return { data: { ...member, role: "player", token: "player-1" } };
}, tabs[1]);
assert.equal(await refreshed.run("Room.ready"), true, "Player credentials survive refresh in the same tab");
players[0].run("Room.leave()");
assert.equal(players[0].run("ended"), true);
assert.equal(players[0].sockets[0].readyState, 3);
assert.equal(players[0].requests.length, 1, "Leave makes no close-room HTTP request");
assert.equal(tabs[0].has(playerKey), false);
assert.equal(tabs[1].get(playerKey), "player-1", "Leaving one tab retains other Player credentials");
assert.equal(players[1].sockets[0].readyState, 1);
assert.equal(players[0].history.url, "/");
assert.equal(players[0].nodes.get("start-btn").hidden, false);
console.log("PASS: Player entry, retry, tab credentials, Admin and Guest admission, redirects and reconnect (DOM simulated).");
