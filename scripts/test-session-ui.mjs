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
let wrongPassword = true;
const entry = page("player", "", new Map(), (path, body) => {
  assert.equal(path, "/api/sessions");
  assert.equal(body.password, "001234");
  if (wrongPassword) return { status: 401, data: { error: "รหัสสร้างไม่ถูกต้อง", retryIn: 5 } };
  return { data: { ...member, role: "player", token: "player-token" } };
});
assert.equal(await entry.run("Room.ready"), false);
assert.equal(entry.nodes.get("room-join").hidden, true);
assert.equal(entry.nodes.get("room-create").hidden, true);
assert.equal(entry.nodes.get("room-welcome").hidden, false);
assert.equal(entry.nodes.get("start-btn").focused, true);
assert.equal(entry.nodes.get("entry-code").type, "text", "The credential is displayed openly without a password input");
assert.equal(entry.nodes.get("entry-code").inputmode, "numeric");
assert.equal(entry.nodes.get("entry-code").pattern, "[0-9]+");
assert.equal(entry.nodes.get("entry-code").autocomplete, "off");
assert.equal(entry.nodes.get("entry-code")["aria-label"], "รหัสสร้างห้องหรือเลขห้อง");
entry.nodes.get("start-btn").onclick();
assert.equal(entry.requests.length, 0, "Start reveals the password field without creating a room");
assert.equal(entry.nodes.get("room-create").hidden, false);
assert.equal(entry.nodes.get("entry-code").focused, true);
assert.equal(entry.nodes.get("start-btn").hidden, true);
entry.run("Room.onJoined = () => { globalThis.opened = true; }");
entry.nodes.get("entry-code").value = "001234";
await entry.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(entry.nodes.get("room-error").textContent, "รหัสสร้างไม่ถูกต้อง");
assert.equal(entry.nodes.get("room-create").hidden, false, "wrong passwords keep the entry field available for retry");
assert.equal(entry.nodes.get("room-content").hidden, true);
assert.equal(entry.nodes.get("room-create").querySelector().disabled, true);
assert.equal(entry.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 5 วินาที");
await entry.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(entry.requests.length, 1, "Enter cannot bypass the retry countdown");
entry.advance(1000);
assert.equal(entry.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 4 วินาที");
entry.advance(4000);
assert.equal(entry.nodes.get("room-create").querySelector().disabled, false);
assert.equal(entry.nodes.get("room-retry").textContent, "");
wrongPassword = false;
await entry.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(entry.run("opened"), true, "Creation immediately opens the Player in the same document");
assert.equal(entry.location.href, undefined, "Creation does not navigate away from its user gesture");
assert.match(entry.history.url, /^\/\?room=123&session=room-id$/);
assert.equal(entry.nodes.get("room-content").hidden, false);
assert.equal(entry.nodes.get("entry-code").value, "", "Successful creation clears the credential");

for (const role of ["guest", "admin", "controller"]) {
  const remembered = new Map([["music-room:123", "room-id"], ["music-session:room-id:member", member.token]]);
  const joined = page("player", "", remembered, (path, body, headers) => {
    assert.equal(path, "/api/sessions/join");
    assert.equal(body.code, "123");
    assert.equal(headers.Authorization, `Bearer ${member.token}`);
    return { data: { ...member, role } };
  });
  await joined.run("Room.ready");
  joined.run("Room.onJoined = () => { throw new Error('Joining a room must not open Player'); }");
  joined.nodes.get("start-btn").onclick();
  joined.nodes.get("entry-code").value = "123";
  await joined.nodes.get("room-create").onsubmit({ preventDefault() {} });
  assert.equal(joined.location.href, `${role === "guest" ? "/guest" : "/a"}?room=123&session=room-id`);
  assert.equal(joined.nodes.get("room-content").hidden, true);
}
const rateLimited = page("player", "", new Map(), () => ({ status: 429, data: { error: "รอก่อน", retryIn: 60 } }));
await rateLimited.run("Room.ready");
rateLimited.nodes.get("entry-code").value = "9999";
await rateLimited.nodes.get("room-create").onsubmit({ preventDefault() {} });
rateLimited.advance(5000);
assert.equal(rateLimited.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 55 วินาที");
await rateLimited.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(rateLimited.requests.length, 1);
rateLimited.advance(55000);
assert.equal(rateLimited.nodes.get("room-create").querySelector().disabled, false);
const expiringLimit = page("player", "", new Map(), () => ({ status: 429, data: { error: "รอก่อน", retryIn: 2 } }));
await expiringLimit.run("Room.ready");
expiringLimit.nodes.get("entry-code").value = "9999";
await expiringLimit.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(expiringLimit.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 2 วินาที", "HTTP 429 shows the remaining time even below five seconds");
expiringLimit.advance(2000);
assert.equal(expiringLimit.nodes.get("room-create").querySelector().disabled, false);
const failedJoin = page("player", "", new Map(), () => ({ status: 410, data: { error: "ไม่พบห้อง", retryIn: 5 } }));
await failedJoin.run("Room.ready");
failedJoin.nodes.get("entry-code").value = "123";
await failedJoin.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(failedJoin.nodes.get("room-retry").textContent, "ลองใหม่ได้ใน 5 วินาที");
const networkError = page("player", "", new Map(), () => { throw new Error("offline"); });
await networkError.run("Room.ready");
networkError.nodes.get("entry-code").value = "001234";
await networkError.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(networkError.nodes.get("room-create").querySelector().disabled, false);
assert.equal(networkError.nodes.get("room-retry").textContent, "");
let resolvePending;
const submitting = page("player", "", new Map(), () => new Promise(resolve => { resolvePending = resolve; }));
await submitting.run("Room.ready");
submitting.nodes.get("entry-code").value = "001234";
const pendingSubmit = submitting.nodes.get("room-create").onsubmit({ preventDefault() {} });
await submitting.nodes.get("room-create").onsubmit({ preventDefault() {} });
assert.equal(submitting.requests.length, 1, "An in-flight submission cannot create duplicate rooms");
resolvePending({ data: { ...member, role: "player" } });
await pendingSubmit;

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
assert.equal(player.history.url, "/");

for (const viaHttp of [false, true]) {
  const lostStorage = new Map([[playerKey, "player-token"]]);
  const lost = page("player", "?room=123&session=room-id", lostStorage, path => path === "/api/state"
    ? { status: 401, data: { code: "SESSION_INVALID", error: "ห้องหาย" } }
    : { data: { ...member, token: "player-token", role: "player" } });
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

const movedStorage = new Map([[playerKey, "player-token"]]);
const moved = page("player", "?room=123&session=room-id", movedStorage,
  () => ({ data: { ...member, token: "player-token", role: "player" } }));
await moved.run("Room.ready");
moved.run("Room.connect({onUnavailable() { throw new Error('Player takeover must stop immediately'); }, onEnd() { globalThis.ended = true; }})");
moved.sockets[0].onmessage({ data: JSON.stringify({ type: "sessionEnded", code: "PLAYER_MOVED" }) });
assert.equal(moved.run("ended"), true);
assert.equal(movedStorage.get(playerKey), "player-token", "Moving Player tabs retains refresh credentials");
console.log("PASS: Player welcome/password/retry/startup, automatic Admin via QR/manual join/refresh, later Guest admission, /a promotion/revocation redirects, reconnect, room close (DOM simulated).");
