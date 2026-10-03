// Run the shared Guest/Admin script with a tiny DOM to check request identity and paging.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

function element() {
  const classes = new Set();
  const selectors = new Map();
  return {
    children: [], value: "", disabled: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    set innerHTML(value) { this.children = []; },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, element());
      return selectors.get(selector);
    },
    setAttribute(name, value) { this[name] = value; },
    addEventListener() {}, blur() {}, focus() { this.focused = true; },
  };
}
const elements = new Map();
const storage = new Map([["guestName", "ชื่อเดิม"]]);
const document = {
  body: { dataset: { admin: "true" } },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  createElement: element,
  querySelectorAll: () => [],
};
const initialRequests = [];
const context = createContext({
  fetch: async (url) => { initialRequests.push(url); return { ok: true, json: async () => ({ results: [] }) }; },
  document, crypto: { randomUUID: () => "test-client" },
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
});
context.Room = { ready: Promise.resolve(true), fetch: async (...args) => (await context.fetch(...args)).json() };
const source = ["i18n.js", "guest.js"].map((file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")).join("\n");
runInContext(source, context);
await Promise.resolve();
const run = (code) => runInContext(code, context);
assert.equal(run("searchMode"), "videos", "Guest and Admin default to videos");
assert.equal(new URL(initialRequests[0], "http://localhost").searchParams.get("mode"), "videos", "Initial recommendations use video mode");
const publicDir = new URL("../public/", import.meta.url);
for (const file of readdirSync(publicDir).filter((name) => /\.(html|js|css)$/.test(name))) {
  const text = readFileSync(new URL(file, publicDir), "utf8");
  assert.equal(/\p{Script=Han}/u.test(text), false, `${file}: no Chinese UI text or keys`);
  for (const match of text.matchAll(/(?:\bt\("|data-i18n(?:-placeholder|-title|-aria-label|-alt)?=")([^"]+)"/g)) {
    assert.equal(run(`Object.hasOwn(UI_MESSAGES.th, ${JSON.stringify(match[1])})`), true, `${file}: missing translation for ${match[1]}`);
  }
}
assert.equal(run('t("nowPlaying")'), "กำลังเล่น");
assert.equal(run('t("Now Playing")'), "Now Playing");
assert.equal(run('t("Explore")'), "Explore");
assert.equal(run('t("Up Next")'), "Up Next");
assert.equal(run('t("videos")'), "วีดีโอ");
run('document.body.dataset.admin = "false"; renderQueue({autoQueue:true, autoQueueStatus:"unavailable", nowPlaying:{videoId:"auto0000001", title:"Auto", channel:"Artist", autoQueued:true}, queue:[]});');
assert.match(document.getElementById("now-playing").querySelector(".np-sub").textContent, /เพลงอัตโนมัติ/);
assert.match(document.getElementById("auto-queue-status").textContent, /เล่นต่ออัตโนมัติ: เปิด.*หาเพลงต่อไม่ได้/);
run('document.body.dataset.admin = "true";');
const results = document.getElementById("results");
const more = document.getElementById("more");
const songs = (start, count) => Array.from({ length: count }, (_, i) => ({ videoId: `song${start + i}`, title: `Song ${start + i}`, channel: "Artist" }));
const response = (items) => ({ ok: true, json: async () => ({ results: items }) });

assert.equal(run("NICKNAMES.length"), 100);
assert.equal(run("new Set(NICKNAMES).size"), 100);
const nickname = storage.get("guestNickname");
assert.equal(run("NICKNAMES.includes(nickname)"), true);
assert.equal(document.getElementById("request-title").textContent, `Music by ${nickname}`);
assert.equal(document.title, `Music by ${nickname}`);
const reloadElements = new Map();
const reloadDocument = { ...document, getElementById(id) {
  if (!reloadElements.has(id)) reloadElements.set(id, element());
  return reloadElements.get(id);
} };
runInContext(source, createContext({ ...context, document: reloadDocument, localStorage: context.localStorage }));
assert.equal(storage.get("guestNickname"), nickname, "nickname survives reload and is shared by both pages");

run("selectPageTab(1)");
assert.equal(document.getElementById("search-panel").hidden, true);
assert.equal(document.getElementById("queue-panel").hidden, false);
assert.equal(document.getElementById("queue-tab")["aria-selected"], "true");
assert.equal(document.getElementById("search-tab").tabIndex, -1);
document.getElementById("queue-tab").onkeydown({ key: "Home", preventDefault() {} });
assert.equal(document.getElementById("search-panel").hidden, false);
assert.equal(document.getElementById("queue-panel").hidden, true);
assert.equal(document.getElementById("search-tab").focused, true);
run("selectPageTab(2)");
assert.equal(document.getElementById("participants-panel").hidden, false);
assert.equal(document.getElementById("search-panel").hidden, true);
run("selectPageTab(0)");
for (const page of ["guest", "admin"]) {
  const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8");
  assert.match(html, /id="search-panel" role="tabpanel"/);
  assert.match(html, /id="queue-panel"[^>]+hidden/);
  for (const mode of ["songs", "karaoke", "videos"]) {
    assert.match(html, new RegExp(`id="mode-${mode}" type="button" aria-pressed="${mode === "videos"}"`));
  }
  assert.doesNotMatch(html, /<select/);
  assert.deepEqual([...html.matchAll(/id="mode-(\w+)"/g)].map((match) => match[1]), ["videos", "karaoke", "songs"]);
  assert.match(html, /id="mode-videos"[^>]+data-i18n="videos"/, `${page}: video button uses the shared label`);
  assert.match(html, /<section id="suggestions-section">/);
  assert.match(html, /id="shuffle" class="shuffle"/);
  assert.match(html, /id="singers" class="singers"/);
  assert.match(html, /id="genre-tabs" class="genre-tabs"/);
}

let calls = 0;
const searchResults = songs(0, 12).reverse();
const resultTitles = () => results.children.map((card) => card.querySelector(".r-title").textContent);
context.fetch = async (url) => {
  calls++;
  const request = new URL(url, "http://localhost");
  assert.equal(request.searchParams.get("mode"), "videos", "First search uses default video mode");
  assert.equal(request.searchParams.get("q"), "test", "search passes the user's query unchanged");
  return response(searchResults);
};
await run("doSearch('test')");
assert.equal(results.children.length, 5);
assert.deepEqual(resultTitles(), searchResults.slice(0, 5).map((item) => item.title));
await run("loadMoreSongs()");
assert.equal(results.children.length, 10);
assert.deepEqual(resultTitles(), searchResults.slice(0, 10).map((item) => item.title));
await run("loadMoreSongs()");
assert.equal(results.children.length, 12);
assert.deepEqual(resultTitles(), searchResults.map((item) => item.title), "paging preserves YouTube order");
assert.equal(more.classList.contains("hidden"), true);
assert.equal(calls, 1, "search pages reuse fetched results");

const batches = [songs(0, 12), songs(0, 12), songs(10, 5)];
context.fetch = async () => { calls++; return response(batches.shift()); };
await run("startBrowse(['first', 'duplicates', 'overlap'])");
assert.equal(results.children.length, 5);
await run("loadMoreSongs()");
assert.equal(results.children.length, 10);
await run("loadMoreSongs()");
assert.equal(results.children.length, 12);
assert.equal(more.classList.contains("hidden"), false, "more query variants remain");
await run("loadMoreSongs()");
assert.equal(results.children.length, 15);
assert.equal(run("browse.seen.size"), 15, "skip duplicate variants and overlapping songs");
assert.equal(more.classList.contains("hidden"), true);

context.fetch = async (url) => {
  assert.equal(new URL(url, "http://localhost").searchParams.get("mode"), "karaoke");
  return response(songs(50, 6));
};
document.getElementById("q").value = "ร้องเพลง";
await document.getElementById("mode-karaoke").onclick();
assert.equal(document.getElementById("mode-karaoke")["aria-pressed"], "true");
assert.equal(document.getElementById("mode-songs")["aria-pressed"], "false");
run("selectPageTab(1)");
assert.equal(results.children.length, 5, "switching tabs preserves search results");
run("renderQueue({ nowPlaying: null, queue: [{ id: 'live', title: 'Live queue', channel: 'Artist' }] })");
assert.equal(document.getElementById("queue-count").textContent, 1);
run("selectPageTab(0)");
assert.equal(document.getElementById("queue-count").textContent, 1, "live queue survives tab switching");
await run("startBrowse(['karaoke browse'])");
let videoCalls = 0;
context.fetch = async (url) => {
  videoCalls++;
  const request = new URL(url, "http://localhost");
  assert.equal(request.searchParams.get("mode"), "videos");
  assert.equal(request.searchParams.get("q"), "ร้องเพลง");
  return response(songs(70, 7));
};
await document.getElementById("mode-videos").onclick();
assert.equal(document.getElementById("mode-videos")["aria-pressed"], "true");
assert.equal(document.getElementById("mode-karaoke")["aria-pressed"], "false");
assert.equal(results.children.length, 5);
await document.getElementById("mode-videos").onclick();
assert.equal(videoCalls, 1, "selected mode button does not repeat search");
context.fetch = async () => response(songs(80, 1));
await document.getElementById("mode-songs").onclick();

let finishOld;
context.fetch = () => new Promise((resolve) => { finishOld = resolve; });
const oldBrowse = run("startBrowse(['slow'])");
context.fetch = async () => response(songs(100, 8));
await run("doSearch('new')");
finishOld(response(songs(200, 20)));
await oldBrowse;
assert.equal(results.children.length, 5, "stale browse cannot overwrite search");
assert.equal(run("browse.pending.length"), 3);

context.fetch = () => new Promise((resolve) => { finishOld = resolve; });
const oldSearch = run("doSearch('slow')");
context.fetch = async () => response(songs(300, 2));
await run("doSearch('latest')");
finishOld(response(songs(400, 20)));
await oldSearch;
assert.equal(results.children.length, 2, "stale search cannot overwrite latest results");
let exploreCalls = 0;
context.fetch = async (url) => {
  exploreCalls++;
  assert.equal(new URL(url, "http://localhost").pathname, "/api/browse");
  return response(songs(500, 8));
};
await run("backToExplore()");
assert.equal(results.children.length, 5, "Admin restores recommendations after search");
assert.equal(document.getElementById("suggestions-section").classList.contains("hidden"), false);
assert.equal(document.getElementById("back-to-explore").classList.contains("hidden"), true);
assert.equal(exploreCalls, 1);
assert.equal(document.getElementById("genre-tabs").children.length, run("Object.keys(GENRE_QUERIES).length"));
assert.ok(document.getElementById("singers").children.length > 0);

run("toast = () => ({ set() {}, dismiss() {} })");
context.fetch = async (url, options) => {
  assert.equal(url, "/api/request");
  assert.equal(JSON.parse(options.body).name, nickname);
  return { json: async () => ({ ok: true, position: 1 }) };
};
await run("requestSong({ videoId: 'song1', title: 'Test' }, document.createElement('button'))");
console.log("PASS: Thai/English UI without Chinese or missing translations; nickname persistence/request attribution; five-song batches in search order; deduplication; stale responses; search/queue tabs; songs/karaoke/video buttons.");
