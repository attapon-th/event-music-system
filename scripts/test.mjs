// No external services or test framework: real HTTP/WS against a temporary copy.
import "./test-guest.mjs";
import "./test-host.mjs";
import "./test-sessions.mjs";
import "./test-session-ui.mjs";
import "./test-admin.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import WebSocket from "ws";
import { JukeboxState } from "../src/state.js";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "event-music-test-"));
for (const file of ["server.js", "src", "public", "package.json"]) cpSync(join(root, file), join(temp, file), { recursive: true });
symlinkSync(join(root, "node_modules"), join(temp, "node_modules"));
writeFileSync(join(temp, "clock-offset"), "0");
writeFileSync(join(temp, "mock-youtube.mjs"), `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const clockFile = new URL('./clock-offset', import.meta.url);
const realNow = Date.now;
Date.now = () => realNow() + Number(readFileSync(clockFile, 'utf8'));
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => interval(fn, [30000, 60000].includes(ms) ? 50 : ms, ...args);
const realFetch = globalThis.fetch;
const row = (id, title) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: id },
  flexColumns: [title, 'Artist'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:20' }] } } }]
}});
globalThis.fetch = async (url, options) => {
  if (String(url).includes('youtube.com/oembed')) {
    if (String(url).includes('slow0000001')) {
      writeFileSync(new URL('./request-started', import.meta.url), 'yes');
      await new Promise(resolve => setTimeout(resolve, 200));
    } else await new Promise(resolve => setTimeout(resolve, 15));
    return new Response('{}');
  }
  if (!String(url).includes('youtube.com/youtubei')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  assert.equal(body.context.client.gl, process.env.DEFAULT_REGION || 'TH');
  assert.equal(body.context.client.hl, (process.env.DEFAULT_LOCALE || 'th-TH').split('-')[0]);
  if (String(url).includes('www.youtube.com/youtubei')) {
    assert.equal(body.context.client.clientName, 'WEB');
    assert.equal(body.params, 'EgIQAQ%3D%3D');
    assert.match(body.query, /karaoke|คาราโอเกะ|music video|official mv|วิดีโอเพลง/i);
    const karaoke = /karaoke|คาราโอเกะ/i.test(body.query);
    const video = (id, duration) => ({ videoRenderer: {
      videoId: id, title: { runs: [{text: body.query}] }, ownerText: {runs:[{text:karaoke ? 'Karaoke channel' : 'Official artist'}]},
      ...(duration ? {lengthText: {simpleText: duration}} : {}), thumbnail: {thumbnails:[{url:'https://example.com/thumb.jpg'}]}
    }});
    return Response.json({contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[
      {itemSectionRenderer:{contents:[{channelRenderer:{}}, video('live0000001'), video(karaoke ? 'karaoke0001' : 'mv000000001','3:30'), video(karaoke ? 'karaoke0002' : 'mv000000002','1:20:00')]}}
    ]}}}}});
  }
  if (body.query) {
    assert.equal(body.context.client.clientName, 'WEB_REMIX');
    assert.equal(body.params, 'EgWKAQIIAWoMEA4QChADEAQQCRAF');
    const r = row('song0000001', body.query);
    r.musicResponsiveListItemRenderer.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs.push({text:'3:20'});
    return Response.json({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [r] } }] } } } }] } } });
  }
  if (body.browseId === 'FEmusic_charts') {
    assert.deepEqual(body.formData.selectedValues, [process.env.DEFAULT_REGION || 'TH']);
    return Response.json({ contents: [{ musicTwoRowItemRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'VLPL_TEST_TH' } } } }] });
  }
  assert.equal(body.browseId, 'VLPL_TEST_TH');
  return Response.json({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: [row('chart000001', 'Thailand chart')] } }] } } } }] } } });
};
`);
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
let requestToken;
const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function post(path, body, token, extraHeaders = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...auth(token), ...extraHeaders }, body: JSON.stringify(body) });
}
const sockets = [];
let child;
let logs = "";
function start(password) {
  child = spawn("node", ["--import", join(temp, "mock-youtube.mjs"), join(temp, "server.js")], {
    cwd: temp,
    env: { ...process.env, PORT: String(port), HOST_PASSWORD: password, ENABLE_MODERATION: "false", DEFAULT_REGION: "TH", DEFAULT_LOCALE: "th-TH", PUBLIC_URL: "", LLM_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { logs += data; });
  child.stderr.on("data", (data) => { logs += data; });
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/guest")).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error("Server failed to start: " + logs);
}
async function socket(token, options) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
  ws.messages = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    ws.messages.push(msg);
    if (msg.type === "state") ws.snapshot = msg.state;
  });
  sockets.push(ws);
  await once(ws, "open");
  if (token) {
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => ws.messages.some((msg) => msg.type === "auth" && msg.ok));
  }
  if (token) await waitFor(() => ws.snapshot);
  return ws;
}
async function waitFor(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("Timed out waiting for realtime state");
}
function send(ws, type, values = {}) { ws.send(JSON.stringify({ type, ...values })); }
async function request(videoId, clientId = videoId) {
  const res = await fetch(base + "/api/request", {
    method: "POST", headers: { "Content-Type": "application/json", ...auth(requestToken) },
    body: JSON.stringify({ videoId, title: videoId, channel: "Artist", duration: "3:20", name: "ผู้ฟัง", clientId }),
  });
  return res.json();
}
try {
  start("test-password");
  await ready();
  for (const path of ["/", "/host.html", "/a", "/admin", "/admin.html", "/guest", "/g", "/explore"]) {
    assert.equal((await fetch(base + path)).status, 200, path);
  }
  const oldAdmin = await fetch(base + "/admin?room=123&session=test", { redirect: "manual" });
  assert.equal(oldAdmin.headers.get("location"), "/a?room=123&session=test");
  for (const shortcut of ["/g", "/g/", "/G"]) {
    for (const query of ["", "?room=123&session=test"]) {
      const shortGuest = await fetch(base + shortcut + query, { redirect: "manual" });
      assert.equal(shortGuest.status, 302);
      assert.equal(shortGuest.headers.get("location"), "/guest" + query, "Guest shortcut preserves room and session identity");
    }
  }
  assert.equal((await fetch(base + "/api/host-token")).status, 404);
  assert.equal((await fetch(base + "/api/info")).status, 401);
  assert.equal((await post("/api/sessions", { password: "wrong" })).status, 401);
  const roomA = await (await post("/api/sessions", { password: "test-password" })).json();
  const roomB = await (await post("/api/sessions", { password: "test-password" })).json();
  assert.match(roomA.code, /^[1-9][0-9]{2}$/);
  assert.notEqual(roomA.code, roomB.code);
  const joinMember = async (room, token) => (await post("/api/sessions/join", { code: room.code, sessionId: room.sessionId }, token)).json();
  const memberA = await joinMember(roomA);
  const memberA2 = await joinMember(roomA);
  const memberB = await joinMember(roomB);
  requestToken = memberA.token;
  const claims = await Promise.all([post("/api/sessions/admin/claim", {}, memberA.token), post("/api/sessions/admin/claim", {}, memberA2.token)]);
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 403]);
  const winner = claims[0].ok ? memberA : memberA2;
  const loser = claims[0].ok ? memberA2 : memberA;
  const adminToken = winner.token;
  assert.equal((await joinMember(roomA, adminToken)).role, "admin", "locked room preserves Admin credentials");
  assert.equal((await joinMember(roomB, adminToken)).role, "guest", "cross-room token cannot grant Admin");
  assert.equal((await fetch(base + "/api/info", { headers: { ...auth(adminToken), "X-Session-Id": roomB.sessionId } })).status, 401);
  const info = await (await fetch(base + "/api/info", { headers: auth(roomA.token) })).json();
  assert.equal(new URL(info.guestUrl).searchParams.get("room"), roomA.code);
  assert.equal(new URL(info.guestUrl).searchParams.get("session"), roomA.sessionId);
  assert.match(info.qr, /^data:image\/png;base64,/);
  assert.equal(info.defaultRegion, "TH");
  assert.equal(info.defaultLocale, "th-TH");
  assert.equal((await (await fetch(base + "/api/search?q=Bruno%20Mars")).json()).results[0].title, "Bruno Mars");
  assert.equal((await (await fetch(base + "/api/browse?q=__hits")).json()).results[0].title, "Thailand chart");
  const karaoke = (await (await fetch(base + "/api/search?q=Bruno%20Mars&mode=karaoke")).json()).results;
  assert.equal(karaoke.length, 2, "karaoke excludes live streams and non-video results");
  assert.equal(karaoke[0].title, "Bruno Mars karaoke");
  assert.equal(karaoke[0].channel, "Karaoke channel");
  assert.equal(karaoke[0].duration, "3:30");
  assert.equal((await (await fetch(base + "/api/search?q=test%20karaoke&mode=karaoke")).json()).results[0].title, "test karaoke");
  assert.equal((await (await fetch(base + "/api/search?q=เพลง%20คาราโอเกะ&mode=karaoke")).json()).results[0].title, "เพลง คาราโอเกะ");
  for (const endpoint of ["search", "browse"]) {
    assert.equal((await fetch(base + `/api/${endpoint}?q=test&mode=invalid`)).status, 400);
    assert.equal((await fetch(base + `/api/${endpoint}?q=test&mode[]=karaoke`)).status, 400);
  }
  const karaokeBrowse = (await (await fetch(base + "/api/browse?q=__hits&mode=karaoke")).json()).results;
  assert.equal(karaokeBrowse.length, 1, "browse excludes compilations");
  assert.equal(karaokeBrowse[0].title, "เพลงไทยยอดนิยม karaoke");
  assert.equal((await (await fetch(base + "/api/browse?q=__hits")).json()).results[0].title, "Thailand chart", "mode caches stay separate");
  const videos = (await (await fetch(base + "/api/search?q=Bruno%20Mars&mode=videos")).json()).results;
  assert.equal(videos.length, 2);
  assert.equal(videos[0].title, "Bruno Mars official music video");
  assert.equal(videos[0].channel, "Official artist");
  assert.equal((await (await fetch(base + "/api/search?q=test%20official%20music%20video&mode=videos")).json()).results[0].title, "test official music video");
  assert.equal((await (await fetch(base + "/api/browse?q=Bruno%20Mars&mode=videos")).json()).results.length, 1);
  assert.equal((await (await fetch(base + "/api/browse?q=Bruno%20Mars&mode=songs")).json()).results[0].title, "Bruno Mars", "music-video cache stays separate from audio search");
  assert.equal((await (await fetch(base + "/api/browse?q=__hits&mode=videos")).json()).results[0].title, "Thailand chart");
  const unauthenticated = await socket();
  assert.equal(unauthenticated.snapshot, undefined, "unauthenticated socket receives no queue");
  const guest = await socket(loser.token);
  const admin = await socket(adminToken);
  const player = await socket(roomA.token);
  const otherRoom = await socket(memberB.token);
  const otherPlayer = await socket(roomB.token);
  send(admin, "setParticipantRole", { id: loser.memberId, enabled: true });
  await waitFor(() => guest.messages.at(-1)?.role === "controller");
  assert.equal(admin.messages.at(-1).participants.find(person => person.id === loser.memberId).role, "controller");
  assert.equal(JSON.stringify(admin.messages.at(-1).participants).includes(loser.token), false, "roster does not expose credentials");
  const errorsBefore = guest.messages.filter(m => m.type === "error").length;
  send(guest, "setParticipantRole", { id: winner.memberId, enabled: false });
  await waitFor(() => guest.messages.filter(m => m.type === "error").length > errorsBefore);
  send(guest, "setVolume", { volume: 29 });
  await waitFor(() => admin.snapshot.volume === 29);
  send(admin, "setParticipantRole", { id: loser.memberId, enabled: false });
  await waitFor(() => guest.messages.at(-1)?.role === "guest");
  const ownerErrors = admin.messages.filter(m => m.type === "error").length;
  send(admin, "setParticipantRole", { id: memberB.memberId, enabled: true });
  send(admin, "setParticipantRole", { id: winner.memberId, enabled: false });
  await waitFor(() => admin.messages.filter(m => m.type === "error").length >= ownerErrors + 2);
  assert.equal(otherRoom.messages.at(-1).role, "guest");
  const readOnly = loser;
  send(admin, "setVolume", { volume: 100 });
  assert.equal((await post("/api/sessions/player", { code: roomA.code, password: "test-password" })).status, 404);
  assert.equal((await post("/api/sessions/admin/recover", { password: "test-password" }, readOnly.token)).status, 404);
  send(admin, "setCooldown", { seconds: 0 });
  assert.equal((await request("song0000001")).ok, true);
  const requestInA = requestToken;
  requestToken = memberB.token;
  assert.equal((await request("song0000001")).ok, true, "same song allowed across rooms");
  requestToken = requestInA;
  for (const id of [ "song0000002", "song0000003", "song0000004"]) assert.equal((await request(id)).ok, true);
  await waitFor(() => admin.snapshot.queue.length === 3 && guest.snapshot.queue.length === 3 && player.snapshot.queue.length === 3);
  const sync = async (condition) => {
    await waitFor(() => [guest, admin, player].every((ws) => condition(ws.snapshot)));
    assert.deepEqual(guest.snapshot, admin.snapshot);
    assert.deepEqual(player.snapshot, admin.snapshot);
  };
  assert.equal(otherRoom.messages.at(-1).cooldownSeconds, 15, "settings are room-scoped");
  assert.equal("participants" in otherRoom.messages.at(-1), false, "Guest cannot read the participant roster");
  assert.equal(otherRoom.snapshot.queue.length, 0);
  assert.equal(otherRoom.snapshot.volume, 60);
  assert.equal(otherPlayer.snapshot.nowPlaying.videoId, "song0000001");
  const ids = admin.snapshot.queue.map((s) => s.id).reverse();
  send(admin, "reorder", { ids });
  await sync((s) => s.queue[0].id === ids[0]);
  send(admin, "reorder", { ids: [ids[0], ids[0], ids[2]] });
  await waitFor(() => admin.messages.some((m) => m.type === "error"));
  assert.deepEqual(admin.snapshot.queue.map((s) => s.id), ids);
  send(admin, "remove", { id: ids[1] });
  await sync((s) => s.queue.length === 2);
  send(admin, "playNow", { id: ids[2] });
  await sync((s) => s.nowPlaying.id === ids[2] && s.queue.length === 1);
  send(player, "ended", { videoId: "song0000001" }); // stale player report
  send(admin, "pause");
  await sync((s) => s.paused);
  send(admin, "setVolume", { volume: 37 });
  await sync((s) => s.volume === 37);
  assert.equal(otherRoom.snapshot.volume, 60);
  send(admin, "play");
  await sync((s) => !s.paused);
  const refresh = await socket(adminToken);
  assert.deepEqual(refresh.snapshot, admin.snapshot);
  send(admin, "skip");
  await sync((s) => s.nowPlaying.id === ids[0]);
  assert.equal((await request("song0000005")).ok, true);
  await sync((s) => s.queue.length === 1);
  const before = JSON.stringify(admin.snapshot);
  // Malformed privileged payloads must neither crash the server nor mutate state.
  send(admin, "setEventContext", { context: { toString: 1 } });
  send(admin, "setCooldown", { seconds: { toString: 1 } });
  send(admin, "setFilter", { on: "false" });
  for (const type of ["reorder", "remove", "clear", "playNow", "skip", "pause", "setVolume", "ended"]) {
    send(guest, type, { ids: [], id: admin.snapshot.queue[0].id, volume: 0, videoId: admin.snapshot.nowPlaying.videoId });
  }
  await waitFor(() => guest.messages.filter((m) => m.type === "error").length >= errorsBefore + 9);
  assert.equal(JSON.stringify(admin.snapshot), before);
  send(unauthenticated, "auth", { token: "invalid" });
  await waitFor(() => unauthenticated.messages.some((m) => m.type === "auth" && !m.ok));
  send(admin, "clear");
  await sync((s) => s.queue.length === 0 && s.nowPlaying.id === ids[0]);
  const concurrent = await Promise.all([request("song0000006", "a"), request("song0000006", "b")]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal((await request(karaoke[0].videoId)).ok, true, "karaoke uses the existing request pipeline");
  await sync((s) => s.queue.some((item) => item.videoId === karaoke[0].videoId));
  assert.equal((await request(videos[0].videoId)).ok, true, "music videos use the existing request pipeline");
  await sync((s) => s.queue.some((item) => item.videoId === videos[0].videoId));
  const bad = await fetch(base + "/api/request", { method: "POST", headers: { "Content-Type": "application/json", ...auth(requestToken) }, body: JSON.stringify({ videoId: {}, title: "bad", clientId: { toString: 1 } }) });
  assert.equal(bad.status, 400);
  send(admin, "setFilter", { on: true, mode: "strict" });
  await waitFor(() => admin.messages.at(-1)?.moderationMode === "strict");
  assert.equal(otherRoom.messages.at(-1).filterOn, false);
  send(admin, "setEventContext", { context: "งานแต่งงาน" });
  await waitFor(() => admin.messages.at(-1)?.eventContext === "งานแต่งงาน");
  assert.equal(otherRoom.messages.at(-1).eventContext, "");
  const oldTab = await socket(roomA.token);
  await waitFor(() => player.messages.some(msg => msg.code === "PLAYER_MOVED"));
  assert.deepEqual(oldTab.snapshot, admin.snapshot);
  assert.equal((await post("/api/sessions/close", {}, readOnly.token)).status, 403);
  assert.equal((await post("/api/sessions/close", {}, roomB.token)).status, 200);
  await waitFor(() => otherRoom.messages.some(msg => msg.code === "ROOM_CLOSED"));
  assert.equal((await fetch(base + "/api/info", { headers: auth(roomB.token) })).status, 401);
  send(unauthenticated, "auth", { token: adminToken, sessionId: roomB.sessionId });
  await waitFor(() => unauthenticated.messages.some(msg => msg.type === "auth" && !msg.ok));
  assert.equal(unauthenticated.snapshot, undefined);
  // Ten failed attempts per IP per minute; successful requests do not count.
  for (let i = 0; i < 10; i++) {
    assert.equal((await post("/api/sessions/join", { code: "12" }, undefined, { "X-Forwarded-For": "192.0.2.50" })).status, 400);
  }
  assert.equal((await post("/api/sessions/join", { code: roomA.code }, undefined, { "X-Forwarded-For": "192.0.2.50" })).status, 429);
  assert.equal((await post("/api/sessions/join", { code: roomA.code })).status, 200);
  assert.equal((await post("/api/sessions/join", { code: roomA.code, sessionId: roomB.sessionId })).status, 410);
  assert.equal((await post("/api/sessions", { password: {} })).status, 401);
  const idleRoom = await (await post("/api/sessions", { password: "test-password" })).json();
  const silent = await socket(idleRoom.token, { autoPong: false });
  await waitFor(() => silent.readyState === WebSocket.CLOSED);
  // A dead connection must not pin a room in memory.
  writeFileSync(join(temp, "clock-offset"), String(3600001));
  await waitFor(() => logs.includes(`"event":"deleted"`));
  assert.equal((await post("/api/sessions/join", { code: idleRoom.code, sessionId: idleRoom.sessionId })).status, 410);
  assert.equal((await fetch(base + "/api/info", { headers: auth(adminToken) })).status, 200, "live room survives clock advance");
  // A pending song request cannot resurrect a room after its idle deadline.
  const pendingRoom = await (await post("/api/sessions", { password: "test-password" })).json();
  const pendingRequest = post("/api/request", { videoId: "slow0000001", title: "Slow song" }, pendingRoom.token);
  await waitFor(() => existsSync(join(temp, "request-started")));
  writeFileSync(join(temp, "clock-offset"), String(7200002));
  assert.equal((await pendingRequest).status, 401);
  assert.equal((await post("/api/sessions/join", { code: pendingRoom.code, sessionId: pendingRoom.sessionId })).status, 410);
  await new Promise(resolve => setTimeout(resolve, 30));
  const events = logs.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.event === "created").length, 4);
  assert.equal(events.filter(e => e.event === "deleted").length, 3);
  assert.ok(events.every(e => ["created", "deleted"].includes(e.event)));
  assert.ok(events.every(e => Object.keys(e).sort().join() === "at,event,room,sessionId"));
  for (const ws of sockets) ws.terminate();
  child.kill();
  await once(child, "exit");
  start("test-password");
  await ready();
  assert.equal((await post("/api/sessions/join", { code: roomA.code, sessionId: roomA.sessionId })).status, 410);
  assert.equal((await fetch(base + "/api/info", { headers: auth(adminToken) })).status, 401);
  assert.equal((await fetch(base + "/admin")).status, 200);
  child.kill();
  await once(child, "exit");
  start("");
  await ready();
  for (const path of ["/api/sessions"]) {
    assert.equal((await post(path, { code: roomA.code, password: "test-password" })).status, 503);
  }
  const noPasswordGuest = await socket();
  send(noPasswordGuest, "auth", { token: "" });
  await waitFor(() => noPasswordGuest.messages.some((msg) => msg.type === "auth" && !msg.ok));
  send(noPasswordGuest, "skip");
  await waitFor(() => noPasswordGuest.messages.some((msg) => msg.type === "error"));
  // State edge cases: stale completion after idle, invalid volume, empty permutations.
  const state = new JukeboxState();
  assert.equal(state.snapshot().volume, 60, "new rooms start at 60% volume");
  let changes = 0;
  state.onChange = () => changes++;
  state.advance("stale-video");
  state.setVolume(NaN);
  state.setVolume(101);
  state.setPaused("yes");
  assert.equal(changes, 0);
  assert.equal(state.reorder([]), true);
  console.log("PASS: isolated rooms/queues/settings; primary Admin/Controller grant/revoke; room closing; heartbeat/expiry/in-flight requests; restart; lifecycle logs; rate limits; queue controls; Thailand search; validation.");
} finally {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  rmSync(temp, { recursive: true, force: true });
}
