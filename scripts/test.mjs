// No external services or test framework: real HTTP/WS against a temporary copy.
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
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
writeFileSync(join(temp, "mock-youtube.mjs"), `
import assert from 'node:assert/strict';
const realFetch = globalThis.fetch;
const row = (id, title) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: id },
  flexColumns: [title, 'Artist'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:20' }] } } }]
}});
globalThis.fetch = async (url, options) => {
  if (String(url).includes('youtube.com/oembed')) {
    await new Promise(resolve => setTimeout(resolve, 15));
    return new Response('{}');
  }
  if (!String(url).includes('music.youtube.com/youtubei')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  assert.equal(body.context.client.gl, process.env.DEFAULT_REGION || 'TH');
  assert.equal(body.context.client.hl, (process.env.DEFAULT_LOCALE || 'th-TH').split('-')[0]);
  if (body.query) {
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
const headers = { Authorization: `Basic ${Buffer.from("host:test-password").toString("base64")}` };
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
async function socket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.messages = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    ws.messages.push(msg);
    if (msg.type === "state") ws.snapshot = msg.state;
  });
  sockets.push(ws);
  await once(ws, "open");
  await waitFor(() => ws.snapshot);
  if (token) {
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => ws.messages.some((msg) => msg.type === "auth" && msg.ok));
  }
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, title: videoId, channel: "Artist", duration: "3:20", name: "ผู้ฟัง", clientId }),
  });
  return res.json();
}
try {
  start("test-password");
  await ready();
  for (const path of ["/", "/host.html", "/admin", "/admin.html", "/api/host-token"]) {
    assert.equal((await fetch(base + path)).status, 401, path);
    assert.equal((await fetch(base + path, { headers })).status, 200, path);
  }
  assert.equal((await fetch(base + "/explore")).status, 200);
  const info = await (await fetch(base + "/api/info")).json();
  assert.equal(info.defaultRegion, "TH");
  assert.equal(info.defaultLocale, "th-TH");
  assert.equal((await (await fetch(base + "/api/search?q=Bruno%20Mars")).json()).results[0].title, "Bruno Mars");
  assert.equal((await (await fetch(base + "/api/browse?q=__hits")).json()).results[0].title, "Thailand chart");
  const token = (await (await fetch(base + "/api/host-token", { headers })).json()).token;
  const guest = await socket();
  const admin = await socket(token);
  const player = await socket(token);
  send(admin, "setCooldown", { seconds: 0 });
  for (const id of ["song0000001", "song0000002", "song0000003", "song0000004"]) assert.equal((await request(id)).ok, true);
  await waitFor(() => admin.snapshot.queue.length === 3 && guest.snapshot.queue.length === 3 && player.snapshot.queue.length === 3);
  const sync = async (condition) => {
    await waitFor(() => [guest, admin, player].every((ws) => condition(ws.snapshot)));
    assert.deepEqual(guest.snapshot, admin.snapshot);
    assert.deepEqual(player.snapshot, admin.snapshot);
  };
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
  send(admin, "play");
  await sync((s) => !s.paused);
  const refresh = await socket(token);
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
  await waitFor(() => guest.messages.filter((m) => m.type === "error").length === 8);
  assert.equal(JSON.stringify(admin.snapshot), before);
  send(guest, "auth", { token: "invalid" });
  await waitFor(() => guest.messages.some((m) => m.type === "auth" && !m.ok));
  send(admin, "clear");
  await sync((s) => s.queue.length === 0 && s.nowPlaying.id === ids[0]);
  const concurrent = await Promise.all([request("song0000006", "a"), request("song0000006", "b")]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  const bad = await fetch(base + "/api/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId: {}, title: "bad", clientId: { toString: 1 } }) });
  assert.equal(bad.status, 400);
  for (const ws of sockets) ws.terminate();
  child.kill();
  await once(child, "exit");
  start("");
  await ready();
  assert.equal((await fetch(base + "/admin")).status, 503);
  assert.equal((await fetch(base + "/api/host-token")).status, 503);
  const noPasswordGuest = await socket();
  send(noPasswordGuest, "auth", { token: "" });
  await waitFor(() => noPasswordGuest.messages.some((m) => m.type === "auth" && !m.ok));
  send(noPasswordGuest, "skip");
  await waitFor(() => noPasswordGuest.messages.some((m) => m.type === "error"));
  // State edge cases: stale completion after idle, invalid volume, empty permutations.
  const state = new JukeboxState();
  let changes = 0;
  state.onChange = () => changes++;
  state.advance("stale-video");
  state.setVolume(NaN);
  state.setVolume(101);
  state.setPaused("yes");
  assert.equal(changes, 0);
  assert.equal(state.reorder([]), true);
  console.log("PASS: Guest requests; realtime Admin/Player/Guest sync; reorder/delete/clear/play-now/play/pause/skip/volume; refresh; unauthorized and no-password controls; concurrent duplicates; Thailand charts/search; input validation.");
} finally {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  rmSync(temp, { recursive: true, force: true });
}
