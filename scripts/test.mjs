// No external services or test framework: real HTTP/WS against a temporary copy.
import "./test-guest.mjs";
import "./test-host.mjs";
import "./test-sessions.mjs";
import "./test-session-ui.mjs";
import "./test-admin.mjs";
import "./test-pwa.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import WebSocket from "ws";
import { JukeboxState } from "../src/state.js";

await import("./test-auto-queue.mjs");

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
  if (String(url).startsWith('https://moderation.invalid/') || String(url).startsWith('https://www.youtube.com/watch?')) {
    writeFileSync(new URL('./unexpected-ai-request', import.meta.url), String(url));
    throw new Error('AI and moderation metadata requests must stay disabled');
  }
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
  if (String(url).includes('/next?')) {
    assert.equal(new URL(url).origin, 'https://www.youtube.com');
    assert.equal(body.context.client.clientName, 'WEB');
    assert.equal(body.isAudioOnly, undefined);
    assert.equal(body.playlistId, undefined);
    if (body.videoId === 'wait0000001') {
      writeFileSync(new URL('./recommendations-started', import.meta.url), 'yes');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const results = [body.videoId, 'auto0000001', 'auto0000002', 'auto0000003'].map(videoId => ({
      compactVideoRenderer: { videoId, title: {simpleText: 'Recommended ' + videoId},
        shortBylineText: {runs:[{text:'Artist'}]}, lengthText: {simpleText:'3:20'} }
    }));
    return Response.json({contents:{twoColumnWatchNextResults:{secondaryResults:{secondaryResults:{results}}}}});
  }
  if (String(url).includes('www.youtube.com/youtubei')) {
    assert.equal(body.context.client.clientName, 'WEB');
    assert.equal(body.params, 'EgIQAQ%3D%3D');
    const karaoke = /karaoke|คาราโอเกะ/i.test(body.query);
    const video = (id, duration) => ({ videoRenderer: {
      videoId: id, title: { runs: [{text: body.query}] }, ownerText: {runs:[{text:karaoke ? 'Karaoke channel' : 'Video channel'}]},
      ...(duration ? {lengthText: {simpleText: duration}} : {}), thumbnail: {thumbnails:[{url:'https://example.com/thumb.jpg'}]}
    }});
    return Response.json({contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[
      {itemSectionRenderer:{contents:[{channelRenderer:{}}, {playlistRenderer:{}}, video('live0000001'), video(karaoke ? 'karaoke0001' : 'mv000000001','3:30'), video(karaoke ? 'karaoke0002' : 'mv000000002','1:20:00')]}}
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
    env: { ...process.env, PORT: String(port), HOST_PASSWORD: password, ENABLE_MODERATION: "true", MODERATION_MODE: "strict", EVENT_CONTEXT: "Legacy AI context", DEFAULT_REGION: "TH", DEFAULT_LOCALE: "th-TH", PUBLIC_URL: "", LLM_API_KEY: "test-key", LLM_BASE_URL: "https://moderation.invalid/v1" },
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
async function socket(token, options, authValues = {}) {
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
    ws.send(JSON.stringify({ type: "auth", token, ...authValues }));
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
  start("482691");
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
  const wrongPassword = await post("/api/sessions", { password: "9999" });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongPassword.json()).retryIn, 5);
  const roomA = await (await post("/api/sessions", { password: "482691" })).json();
  const roomB = await (await post("/api/sessions", { password: "482691" })).json();
  assert.match(roomA.code, /^[1-9][0-9]{2}$/);
  assert.notEqual(roomA.code, roomB.code);
  const joinMember = async (room, token) => (await post("/api/sessions/join", { code: room.code, sessionId: room.sessionId }, token)).json();
  const [memberA, memberA2] = await Promise.all([joinMember(roomA), joinMember(roomA)]);
  assert.deepEqual([memberA.role, memberA2.role].sort(), ["admin", "guest"], "concurrent joins assign exactly one automatic Admin");
  const adminB = await joinMember(roomB);
  assert.equal(adminB.role, "admin", "each room's first participant becomes its own Admin");
  const memberB = await joinMember(roomB);
  assert.equal(memberB.role, "guest");
  requestToken = memberA.token;
  const winner = [memberA, memberA2].find(member => member.role === "admin");
  const loser = [memberA, memberA2].find(member => member.role === "guest");
  const adminToken = winner.token;
  assert.equal((await post("/api/sessions/admin/claim", {}, loser.token)).status, 404, "manual Admin claiming has been removed");
  const ownerInfo = await (await fetch(base + "/api/info", { headers: auth(adminToken) })).json();
  assert.equal(ownerInfo.primaryAdminId, winner.memberId);
  assert.equal((await joinMember(roomA, roomA.token)).role, "guest", "a Player token cannot replace the first Admin");
  assert.equal((await joinMember(roomA, adminToken)).role, "admin", "locked room preserves Admin credentials");
  assert.equal((await joinMember(roomB, adminToken)).role, "guest", "cross-room token cannot grant Admin");
  assert.equal((await fetch(base + "/api/info", { headers: { ...auth(adminToken), "X-Session-Id": roomB.sessionId } })).status, 401);
  const info = await (await fetch(base + "/api/info", { headers: auth(roomA.token) })).json();
  assert.equal(new URL(info.guestUrl).searchParams.get("room"), roomA.code);
  assert.equal(new URL(info.guestUrl).searchParams.get("session"), roomA.sessionId);
  assert.match(info.qr, /^data:image\/png;base64,/);
  assert.equal(info.defaultRegion, "TH");
  assert.equal(info.defaultLocale, "th-TH");
  assert.equal(info.filterOn, false, "legacy environment settings cannot enable AI");
  assert.equal(info.moderationConfigured, false, "AI reports disabled even with a configured key");
  assert.equal(info.moderationMode, "default");
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
  assert.equal(karaokeBrowse[0].title, "Thailand chart", "recommendations use the country chart even in karaoke mode");
  for (const mode of ["songs", "karaoke", "videos"]) {
    const chart = (await (await fetch(base + `/api/browse?q=__hk_hits&mode=${mode}`)).json()).results;
    assert.deepEqual(chart, karaokeBrowse, "both chart sentinels use the same chart in every mode");
  }
  const videos = (await (await fetch(base + "/api/search?q=Bruno%20Mars&mode=videos")).json()).results;
  assert.deepEqual(videos.map(({ videoId, duration }) => ({ videoId, duration })), [
    { videoId: "live0000001", duration: "" },
    { videoId: "mv000000001", duration: "3:30" },
    { videoId: "mv000000002", duration: "1:20:00" },
  ], "video search keeps live, short and long videos in YouTube order; excludes channels/playlists");
  assert.ok(videos.every((video) => video.title === "Bruno Mars"), "video query has no suffix");
  assert.equal(videos[0].channel, "Video channel");
  assert.equal((await (await fetch(base + "/api/search?q=" + encodeURIComponent("สอนทำอาหาร") + "&mode=videos")).json()).results[0].title, "สอนทำอาหาร", "non-music Thai query is unchanged");
  assert.equal((await (await fetch(base + "/api/search?q=test%20official%20music%20video&mode=videos")).json()).results[0].title, "test official music video");
  assert.deepEqual((await (await fetch(base + "/api/browse?q=Bruno%20Mars&mode=videos")).json()).results.map((video) => video.videoId), ["mv000000001"], "browse still excludes unknown/live durations and compilations");
  assert.equal((await (await fetch(base + "/api/browse?q=Bruno%20Mars&mode=songs")).json()).results[0].title, "Bruno Mars", "video cache stays separate from audio search");
  assert.equal((await (await fetch(base + "/api/browse?q=__hits&mode=videos")).json()).results[0].title, "Thailand chart");
  const unauthenticated = await socket();
  assert.equal(unauthenticated.snapshot, undefined, "unauthenticated socket receives no queue");
  const guest = await socket(loser.token);
  const admin = await socket(adminToken);
  const player = await socket(roomA.token);
  const otherRoom = await socket(memberB.token);
  const otherPlayer = await socket(roomB.token);
  assert.equal(player.snapshot.autoQueue, true, "new rooms enable Auto Queue by default");
  assert.equal(otherPlayer.snapshot.autoQueue, true, "every new room starts with Auto Queue enabled");
  assert.equal(admin.messages.at(-1).cooldownSeconds, 5, "new rooms wait five seconds between requests");
  send(otherPlayer, "setAutoQueue", { enabled: false });
  await waitFor(() => !otherPlayer.snapshot.autoQueue && !otherRoom.snapshot.autoQueue);
  send(admin, "setParticipantRole", { id: loser.memberId, enabled: true });
  await waitFor(() => guest.messages.at(-1)?.role === "controller");
  assert.equal("participants" in guest.messages.at(-1), false, "Controllers receive no participant roster");
  assert.equal(admin.messages.at(-1).participants.find(person => person.id === loser.memberId).role, "controller");
  assert.equal(JSON.stringify(admin.messages.at(-1).participants).includes(loser.token), false, "roster does not expose credentials");
  const errorsBefore = guest.messages.filter(m => m.type === "error").length;
  send(guest, "setParticipantRole", { id: winner.memberId, enabled: false });
  await waitFor(() => guest.messages.filter(m => m.type === "error").length > errorsBefore);
  send(guest, "setVolume", { volume: 29 });
  await waitFor(() => admin.snapshot.volume === 29);
  send(guest, "setAutoQueue", { enabled: false });
  await waitFor(() => !admin.snapshot.autoQueue && !player.snapshot.autoQueue);
  send(guest, "setAutoQueue", { enabled: true });
  await waitFor(() => admin.snapshot.autoQueue && player.snapshot.autoQueue);
  send(admin, "setAutoQueue", { enabled: false });
  await waitFor(() => !admin.snapshot.autoQueue && !player.snapshot.autoQueue);
  send(admin, "setParticipantRole", { id: loser.memberId, enabled: false });
  await waitFor(() => guest.messages.at(-1)?.role === "guest");
  const ownerErrors = admin.messages.filter(m => m.type === "error").length;
  send(admin, "setParticipantRole", { id: memberB.memberId, enabled: true });
  send(admin, "setParticipantRole", { id: winner.memberId, enabled: false });
  await waitFor(() => admin.messages.filter(m => m.type === "error").length >= ownerErrors + 2);
  assert.equal(otherRoom.messages.at(-1).role, "guest");
  const readOnly = loser;
  send(admin, "setVolume", { volume: 100 });
  assert.equal((await post("/api/sessions/player", { code: roomA.code, password: "482691" })).status, 404);
  assert.equal((await post("/api/sessions/admin/recover", { password: "482691" }, readOnly.token)).status, 404);
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
  assert.equal(otherRoom.messages.at(-1).cooldownSeconds, 5, "settings are room-scoped");
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
  assert.equal((await request(videos[0].videoId)).ok, true, "videos use the existing request pipeline");
  await sync((s) => s.queue.some((item) => item.videoId === videos[0].videoId));
  const bad = await fetch(base + "/api/request", { method: "POST", headers: { "Content-Type": "application/json", ...auth(requestToken) }, body: JSON.stringify({ videoId: {}, title: "bad", clientId: { toString: 1 } }) });
  assert.equal(bad.status, 400);
  const messagesBeforeFilter = admin.messages.length;
  send(admin, "setFilter", { on: true, mode: "strict" });
  await waitFor(() => admin.messages.length > messagesBeforeFilter);
  assert.equal(admin.messages.at(-1).filterOn, false, "legacy WebSocket command cannot enable AI");
  assert.equal(admin.messages.at(-1).moderationMode, "default");
  assert.equal(otherRoom.messages.at(-1).filterOn, false);
  send(admin, "setEventContext", { context: "งานแต่งงาน" });
  await waitFor(() => admin.messages.at(-1)?.eventContext === "งานแต่งงาน");
  assert.equal(otherRoom.messages.at(-1).eventContext, "");
  assert.equal((await request(videos[2].videoId)).ok, true, "long videos still enqueue after an attempted AI enable");
  await sync((s) => s.queue.some((item) => item.videoId === videos[2].videoId));
  const oldTab = await socket(roomA.token);
  await waitFor(() => player.messages.some(msg => msg.code === "PLAYER_MOVED"));
  assert.deepEqual(oldTab.snapshot, admin.snapshot);
  // A transport outage retains membership and room state. The Player consumes
  // its cached running order, then authenticates with item IDs already finished.
  const disconnected = structuredClone(admin.snapshot);
  const completed = [disconnected.nowPlaying, disconnected.queue[0]].map((item, i) => ({
    id: item.id, videoId: item.videoId, failed: i === 1,
  }));
  oldTab.terminate();
  await once(oldTab, "close");
  assert.equal((await request("resume00001")).ok, true, "Guests can add requests while Player is disconnected");
  const resumed = await socket(roomA.token, undefined, { sessionId: roomA.sessionId, completed });
  assert.equal(resumed.snapshot.nowPlaying.id, disconnected.queue[1].id);
  assert.equal(resumed.snapshot.historyCount, disconnected.historyCount + 2);
  assert.equal(resumed.snapshot.queue.at(-1).videoId, "resume00001", "Recovery retains new requests");
  assert.ok(resumed.messages.filter(msg => msg.type === "state").every(msg => msg.state.nowPlaying.id === disconnected.queue[1].id),
    "The reconnecting Player must never receive a snapshot that replays completed songs");
  const afterRecovery = JSON.stringify(resumed.snapshot);
  let received = resumed.messages.length;
  send(resumed, "auth", { token: roomA.token, sessionId: roomA.sessionId, completed });
  await waitFor(() => resumed.messages.length > received && resumed.messages.at(-1)?.type === "state");
  assert.equal(JSON.stringify(resumed.snapshot), afterRecovery, "Replaying offline progress cannot advance twice");
  const reconnectMember = await joinMember(roomA, adminToken);
  assert.equal(reconnectMember.memberId, winner.memberId);
  assert.equal(reconnectMember.token, adminToken);
  assert.equal(reconnectMember.role, "admin", "Room re-entry preserves Admin authority");
  const readOnlyReconnect = await socket(loser.token, undefined, {
    sessionId: roomA.sessionId, completed: [{ id: resumed.snapshot.nowPlaying.id, videoId: resumed.snapshot.nowPlaying.videoId, failed: false }],
  });
  assert.equal(JSON.stringify(readOnlyReconnect.snapshot), afterRecovery, "Guests cannot replay Player completion reports");
  const playedAgain = await request(completed[0].videoId);
  assert.equal(playedAgain.ok, true);
  await waitFor(() => resumed.snapshot.queue.some(item => item.id === playedAgain.id));
  send(admin, "playNow", { id: playedAgain.id });
  await waitFor(() => resumed.snapshot.nowPlaying.id === playedAgain.id);
  received = resumed.messages.length;
  send(resumed, "auth", { token: roomA.token, sessionId: roomA.sessionId,
    completed: [...completed, null, { id: playedAgain.id, videoId: completed[0].videoId, failed: "false" }] });
  await waitFor(() => resumed.messages.length > received && resumed.messages.at(-1)?.type === "state");
  assert.equal(resumed.snapshot.nowPlaying.id, playedAgain.id, "Old/malformed progress cannot skip a later request for the same video");
  assert.equal((await post("/api/sessions/close", {}, readOnly.token)).status, 403);
  const autoErrors = otherRoom.messages.filter(msg => msg.type === "error").length;
  send(otherRoom, "setAutoQueue", { enabled: true });
  await waitFor(() => otherRoom.messages.filter(msg => msg.type === "error").length > autoErrors);
  assert.equal(otherPlayer.snapshot.autoQueue, false, "Guest cannot toggle Auto Queue");
  send(otherPlayer, "setAutoQueue", { enabled: "true" });
  send(otherPlayer, "setVolume", { volume: 40 });
  await waitFor(() => otherPlayer.snapshot.volume === 40);
  assert.equal(otherPlayer.snapshot.autoQueue, false, "malformed toggles leave settings unchanged");
  send(otherPlayer, "setAutoQueue", { enabled: true });
  await waitFor(() => otherRoom.snapshot.autoQueueStatus === "ready");
  assert.equal(admin.snapshot.autoQueue, false, "Auto Queue stays within its room");
  const autoRefresh = await socket(memberB.token);
  assert.equal(autoRefresh.snapshot.autoQueue, true, "refresh gets the authoritative toggle");
  assert.equal(autoRefresh.snapshot.queue.length, 0, "prefetch does not add to the main queue");
  send(otherPlayer, "ended", { videoId: "song0000001" });
  await waitFor(() => otherRoom.snapshot.nowPlaying?.videoId === "auto0000001" && otherRoom.snapshot.autoQueueStatus === "ready");
  assert.equal(otherRoom.snapshot.nowPlaying.autoQueued, true);
  send(otherPlayer, "ended", { videoId: "song0000001" });
  send(otherPlayer, "setAutoQueue", { enabled: false });
  await waitFor(() => !otherRoom.snapshot.autoQueue);
  assert.equal(otherRoom.snapshot.nowPlaying.videoId, "auto0000001", "disable/stale ended preserves the current song");
  send(otherPlayer, "setAutoQueue", { enabled: true });
  await waitFor(() => otherRoom.snapshot.autoQueueStatus === "ready");
  requestToken = memberB.token;
  assert.equal((await request("main0000001")).ok, true);
  requestToken = requestInA;
  await waitFor(() => otherRoom.snapshot.queue.length === 1);
  assert.equal(otherRoom.snapshot.nowPlaying.videoId, "auto0000001");
  send(otherPlayer, "ended", { videoId: "auto0000001" });
  await waitFor(() => otherRoom.snapshot.nowPlaying?.videoId === "main0000001" && otherRoom.snapshot.autoQueueStatus === "ready");
  send(otherPlayer, "ended", { videoId: "main0000001" });
  await waitFor(() => otherRoom.snapshot.nowPlaying?.videoId === "auto0000002");
  // Close the room with a recommendation response in flight; no late reply can recreate it.
  assert.equal((await post("/api/request", { videoId: "wait0000001", title: "Pending recommendations", clientId: "recommendations-close" }, memberB.token)).status, 200);
  await waitFor(() => otherRoom.snapshot.queue.some(item => item.videoId === "wait0000001"));
  send(otherPlayer, "playNow", { id: otherRoom.snapshot.queue[0].id });
  await waitFor(() => existsSync(join(temp, "recommendations-started")));
  assert.equal((await post("/api/sessions/close", {}, roomB.token)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 250));
  await waitFor(() => otherRoom.messages.some(msg => msg.code === "ROOM_CLOSED"));
  assert.equal((await fetch(base + "/api/info", { headers: auth(roomB.token) })).status, 401);
  send(unauthenticated, "auth", { token: adminToken, sessionId: roomB.sessionId });
  await waitFor(() => unauthenticated.messages.some(msg => msg.type === "auth" && !msg.ok));
  assert.equal(unauthenticated.snapshot, undefined);
  // Ten failed attempts per IP per minute; successful requests do not count.
  for (let i = 0; i < 10; i++) {
    assert.equal((await post("/api/sessions/join", { code: "12" }, undefined, { "X-Forwarded-For": "192.0.2.50" })).status, 400);
  }
  const blockedAdmission = await post("/api/sessions/join", { code: roomA.code }, undefined, { "X-Forwarded-For": "192.0.2.50" });
  assert.equal(blockedAdmission.status, 429);
  const admissionRetry = (await blockedAdmission.json()).retryIn;
  assert.ok(admissionRetry > 0 && admissionRetry <= 60);
  assert.equal(blockedAdmission.headers.get("retry-after"), String(admissionRetry));
  assert.equal((await post("/api/sessions/join", { code: roomA.code })).status, 200);
  assert.equal((await post("/api/sessions/join", { code: roomA.code, sessionId: roomB.sessionId })).status, 410);
  assert.equal((await post("/api/sessions", { password: {} })).status, 401);
  const idleRoom = await (await post("/api/sessions", { password: "482691" })).json();
  const silent = await socket(idleRoom.token, { autoPong: false });
  await waitFor(() => silent.readyState === WebSocket.CLOSED);
  // A dead connection must not pin a room in memory.
  writeFileSync(join(temp, "clock-offset"), String(3600001));
  await waitFor(() => logs.includes(`"event":"deleted"`));
  assert.equal((await post("/api/sessions/join", { code: idleRoom.code, sessionId: idleRoom.sessionId })).status, 410);
  assert.equal((await fetch(base + "/api/info", { headers: auth(adminToken) })).status, 200, "live room survives clock advance");
  // A pending song request cannot resurrect a room after its idle deadline.
  const pendingRoom = await (await post("/api/sessions", { password: "482691" })).json();
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
  start("482691");
  await ready();
  assert.equal((await post("/api/sessions/join", { code: roomA.code, sessionId: roomA.sessionId })).status, 410);
  assert.equal((await fetch(base + "/api/info", { headers: auth(adminToken) })).status, 401);
  const lostAfterRestart = await socket();
  send(lostAfterRestart, "auth", { token: roomA.token, sessionId: roomA.sessionId, completed });
  await waitFor(() => lostAfterRestart.messages.some(msg => msg.type === "auth" && !msg.ok));
  assert.equal(lostAfterRestart.snapshot, undefined, "Restarted server cannot restore an in-memory room");
  assert.equal((await fetch(base + "/admin")).status, 200);
  child.kill();
  await once(child, "exit");
  for (const password of ["", "1", "12", "123", "abcd", "12a4", "๑๒๓๔", "１２３４", "1234 5", " 1234", "1234 ", "1234\n", "12.34", "+1234", "-1234", "1e04", "😀😀😀😀"]) {
    const logStart = logs.length;
    start(password);
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 1, "Creation passwords must contain only ASCII digits and have at least four digits");
    const output = logs.slice(logStart);
    assert.match(output, /HOST_PASSWORD.*4/);
    assert.match(output, /ตัวเลข 0–9/);
    if (password) assert.equal(output.includes(password), false, "Startup errors never print the configured secret");
    await assert.rejects(fetch(base + "/guest"), "Invalid startup must not open the HTTP port");
  }
  for (const password of ["1234", "001234", "0".repeat(128)]) {
    start(password);
    await ready();
    assert.equal((await post("/api/sessions", { password })).status, 200, "Digit strings of at least four digits support startup and creation");
    assert.equal((await post("/api/sessions", { password: Number(password) })).status, 401, "Credentials remain strings");
    if (password.startsWith("0")) {
      assert.equal((await post("/api/sessions", { password: String(Number(password)) })).status, 401, "Leading zeros are significant");
    }
    child.kill();
    await once(child, "exit");
    child = null;
  }
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
  assert.equal(existsSync(join(temp, "unexpected-ai-request")), false, "requests never call AI or fetch moderation metadata");
  console.log("PASS: concurrent joins assign one automatic Admin per room; isolated rooms/queues/settings; primary Admin/Controller grant/revoke; Auto Queue authorization/sync/refresh/priority/closing; heartbeat/expiry/in-flight requests; restart; lifecycle logs; rate limits; queue controls; Thailand search; unmodified video queries/order; AI disabled; validation.");
} finally {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  rmSync(temp, { recursive: true, force: true });
}
