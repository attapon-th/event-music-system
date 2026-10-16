// Run the shared Guest/Admin script with a tiny DOM to check request identity and paging.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

function element() {
  const classes = new Set();
  const selectors = new Map();
  return {
    children: [], value: "", disabled: false, dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    set innerHTML(value) { this.children = []; },
    appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; },
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
    if (!elements.has(id)) {
      const node = element();
      node.hidden = id === "participants-tab";
      elements.set(id, node);
    }
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
assert.equal(document.getElementById("queue-panel").hidden, false, "Admin opens directly on Queue");
assert.equal(document.getElementById("search-panel").hidden, true);
assert.equal(run("searchMode"), "videos", "Guest and Admin default to videos");
assert.equal(initialRequests[0], "/api/browse?q=__hits", "Initial recommendations use only the country chart");
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
assert.match(document.getElementById("now-playing").querySelector(".np-requester").textContent, /เพลงอัตโนมัติ/);
assert.match(document.getElementById("auto-queue-status").textContent, /เล่นต่ออัตโนมัติ: เปิด.*หาเพลงต่อไม่ได้/);
run('renderQueue({autoQueue:true, nowPlaying:null, queue:[], autoQueueItems:[{videoId:"auto0000002",title:"Upcoming",channel:"Artist",autoQueued:true}]});');
assert.equal(document.getElementById("auto-queue-count").textContent, 1);
assert.equal(document.getElementById("auto-queue-section").hidden, false);
assert.equal(document.getElementById("auto-queue-list").children[0].querySelector(".t").textContent, "Upcoming");
run('renderQueue({autoQueue:false, nowPlaying:null, queue:[], autoQueueItems:[]});');
assert.equal(document.getElementById("auto-queue-section").hidden, true);
run('document.body.dataset.admin = "true";');
const results = document.getElementById("results");
const more = document.getElementById("more");
const songs = (start, count) => Array.from({ length: count }, (_, i) => ({ videoId: `song${start + i}`, title: `Song ${start + i}`, channel: "Artist" }));
const response = (items) => ({ ok: true, json: async () => ({ results: items }) });

assert.equal(run("NICKNAMES.length"), 100);
assert.equal(run("new Set(NICKNAMES).size"), 100);
const nickname = storage.get("guestNickname");
assert.equal(run("NICKNAMES.includes(nickname)"), true);
assert.equal(document.getElementById("nickname-credit").textContent, `by "${nickname}"`);
assert.equal(document.title, `คิวเพลิน by "${nickname}"`);
const reloadElements = new Map();
const reloadDocument = { ...document, getElementById(id) {
  if (!reloadElements.has(id)) reloadElements.set(id, element());
  return reloadElements.get(id);
} };
runInContext(source, createContext({ ...context, document: reloadDocument, localStorage: context.localStorage }));
await Promise.resolve();
assert.equal(storage.get("guestNickname"), nickname, "nickname survives reload and is shared by both pages");

run("Room.sessionId = 'first-room'; initNickname();");
const firstRoomNickname = run("nickname");
assert.notEqual(firstRoomNickname, nickname, "Entering a new room picks a different nickname");
run("initNickname();");
assert.equal(run("nickname"), firstRoomNickname, "Reconnecting to the same room keeps the nickname");
run("Room.sessionId = 'second-room'; initNickname();");
assert.notEqual(run("nickname"), firstRoomNickname, "A different session gets a new nickname even if its room number is reused");
run("Room.sessionId = 'first-room'; initNickname();");
assert.equal(run("nickname"), firstRoomNickname, "Returning to a live room restores its participant nickname");
// Keep the existing request-attribution checks on their original nickname.
run("Room.sessionId = undefined; initNickname();");
storage.set("guestNickname", nickname);
run("initNickname();");

run("selectPageTab(1)");
assert.equal(document.getElementById("search-panel").hidden, true);
assert.equal(document.getElementById("queue-panel").hidden, false);
assert.equal(document.getElementById("queue-tab")["aria-selected"], "true");
assert.equal(document.getElementById("search-tab").tabIndex, -1);
document.getElementById("queue-tab").onkeydown({ key: "Home", preventDefault() {} });
assert.equal(document.getElementById("search-panel").hidden, true);
assert.equal(document.getElementById("queue-panel").hidden, false);
assert.equal(document.getElementById("queue-tab").focused, true, "Home selects first visual Admin tab");
run("setParticipantsVisible(true); selectPageTab(2)");
assert.equal(document.getElementById("participants-panel").hidden, false);
assert.equal(document.getElementById("search-panel").hidden, true);
run("setParticipantsVisible(false)");
assert.equal(document.getElementById("participants-panel").hidden, true, "Revocation hides an open participant panel");
assert.equal(document.getElementById("search-panel").hidden, false);
assert.equal(document.getElementById("search-tab").focused, true);
run("selectPageTab(2)");
assert.equal(document.getElementById("participants-panel").hidden, true, "Hidden tabs cannot be opened programmatically");
document.getElementById("queue-tab").onkeydown({ key: "End", preventDefault() {} });
assert.equal(document.getElementById("search-tab").focused, true, "End follows visual Admin order and skips hidden participants");
document.getElementById("queue-tab").onkeydown({ key: "ArrowRight", preventDefault() {} });
assert.equal(document.getElementById("search-tab").focused, true, "Arrow navigation follows visible Admin tabs");
run("selectPageTab(0)");
for (const page of ["guest", "admin"]) {
  const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8");
  assert.match(html, /id="search-panel" role="tabpanel"/);
  assert.equal(/id="queue-panel"[^>]+hidden/.test(html), page === "guest", "Guest opens Search; Admin opens Queue");
  assert.equal(/id="search-panel"[^>]+hidden/.test(html), page === "admin");
  assert.match(html, /music-ui\.css\?v=/, "Shared styles have a cache-busting version");
  for (const mode of ["songs", "karaoke", "videos"]) {
    assert.match(html, new RegExp(`id="mode-${mode}" type="button" aria-pressed="${mode === "videos"}"`));
  }
  assert.doesNotMatch(html, /<select/);
  assert.deepEqual([...html.matchAll(/id="mode-(\w+)"/g)].map((match) => match[1]), ["songs", "videos", "karaoke"]);
  for (const mode of ["songs", "videos", "karaoke"]) {
    const button = html.match(new RegExp(`<button id="mode-${mode}"[^>]*>([\\s\\S]*?)</button>`))[1];
    assert.match(button, /<svg[^>]+aria-hidden="true"/, `${page}: decorative mode icon`);
    assert.match(button, new RegExp(`<span data-i18n="${mode}">`), `${page}: mode label survives translation`);
  }
  assert.match(html, /<h1 id="request-title">[\s\S]*?id="nickname-credit"/);
  assert.doesNotMatch(html, /<p id="request-title"/);
  assert.match(html, /<section id="suggestions-section">/);
  assert.match(html, /id="shuffle" class="shuffle"/);
  assert.doesNotMatch(html, /id="browse-all"|data-i18n="All"/);
  assert.doesNotMatch(html, /id="singers"|id="genre-tabs"/);
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
more.onclick();
assert.equal(results.children.length, 10);
assert.deepEqual(resultTitles(), searchResults.slice(0, 10).map((item) => item.title));
more.onclick();
assert.equal(results.children.length, 12);
assert.deepEqual(resultTitles(), searchResults.map((item) => item.title), "paging preserves YouTube order");
assert.equal(more.classList.contains("hidden"), true);
assert.equal(calls, 1, "search pages reuse fetched results");

calls = 0;
context.fetch = async url => {
  calls++;
  assert.equal(url, "/api/browse?q=__hits");
  return response([...songs(0, 12), ...songs(0, 3), { title: "No video ID" }]);
};
await run("startBrowse()");
assert.equal(results.children.length, 5);
more.onclick();
assert.equal(results.children.length, 10);
more.onclick();
assert.equal(results.children.length, 12);
assert.equal(more.classList.contains("hidden"), true);
assert.equal(new Set(resultTitles()).size, 12, "chart results exclude duplicate videos and missing IDs");
assert.equal(calls, 1, "chart pages use one fetched result set");
await document.getElementById("shuffle").onclick();
assert.equal(calls, 2, "shuffle reloads only the country chart");
assert.equal(results.children.length, 5);

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
context.fetch = async url => {
  assert.equal(url, "/api/browse?q=__hits", "karaoke mode still browses the country chart");
  return response(songs(60, 6));
};
await run("startBrowse()");
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
const oldBrowse = run("startBrowse()");
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
  assert.equal(url, "/api/browse?q=__hits", "songs mode still browses the country chart");
  return response(songs(500, 8));
};
await run("backToExplore()");
assert.equal(results.children.length, 5, "Admin restores recommendations after search");
assert.equal(document.getElementById("suggestions-section").classList.contains("hidden"), false);
assert.equal(document.getElementById("back-to-explore").classList.contains("hidden"), true);
assert.equal(exploreCalls, 1);
context.fetch = async () => response([]);
await run("startBrowse()");
assert.equal(document.getElementById("status").textContent, "ไม่พบเพลงในชาร์ต ลองค้นหาเพลง");
assert.equal(more.classList.contains("hidden"), true);
context.fetch = async () => ({ ok: false, json: async () => ({ error: "โหลดชาร์ตไม่ได้" }) });
await run("startBrowse()");
assert.match(document.getElementById("status").textContent, /โหลดชาร์ตไม่ได้/);
assert.equal(more.disabled, false, "chart failure leaves controls usable for retry");

run("toast = () => ({ set() {}, dismiss() {} })");
context.fetch = async (url, options) => {
  assert.equal(url, "/api/request");
  assert.equal(JSON.parse(options.body).name, nickname);
  return { json: async () => ({ ok: true, position: 1 }) };
};
await run("requestSong({ videoId: 'song1', title: 'Test' }, document.createElement('button'))");
// Request feedback keeps server validation intact, including thrown HTTP errors.
const notices = [];
context.notices = notices;
run('toast = () => ({ set(...args) { notices.push(args); }, dismiss() {} }); cooldownToast = seconds => { globalThis.cooldownSeconds = seconds; }');
let requestCalls = 0;
let finishRequest;
context.Room.fetch = () => { requestCalls++; return new Promise(resolve => { finishRequest = resolve; }); };
const requestButton = element();
context.requestButton = requestButton;
const pendingRequest = run('requestSong({videoId:"pending",title:"Pending"}, requestButton)');
assert.equal(requestButton.disabled, true);
assert.equal(requestButton["aria-busy"], "true");
await run('requestSong({videoId:"pending",title:"Pending"}, document.createElement("button"))');
assert.equal(requestCalls, 1, "Repeated taps, even after list replacement, send one pending request");
finishRequest({ok:true,position:1});
await pendingRequest;
assert.equal(requestButton.textContent, "✓");
assert.equal(requestButton["aria-busy"], "false");
assert.equal(run('pendingRequests.size'), 0);
context.Room.fetch = async () => ({ok:false,reason:"เพลงนี้อยู่ในคิวแล้ว"});
context.rejectedButton = element();
await run('requestSong({videoId:"duplicate",title:"Duplicate"}, rejectedButton)');
assert.equal(context.rejectedButton.disabled, false);
assert.equal(notices.at(-1)[2], "เพลงนี้อยู่ในคิวแล้ว", "Duplicate reasons from server are shown");
context.Room.fetch = async () => { throw Object.assign(new Error("รออีกสักครู่"), {status:429,retryIn:5}); };
await run('requestSong({videoId:"cooldown",title:"Cooldown"}, rejectedButton)');
assert.equal(context.cooldownSeconds, 5, "HTTP cooldown errors retain server retry time");
context.Room.fetch = async () => { throw Object.assign(new Error("ไม่มีสิทธิ์เพิ่มเพลง"), {status:403}); };
await run('requestSong({videoId:"forbidden",title:"Forbidden"}, rejectedButton)');
assert.equal(notices.at(-1)[2], "ไม่มีสิทธิ์เพิ่มเพลง", "HTTP server errors are not replaced with a network error");
context.Room.fetch = async () => { throw new Error("Failed to fetch"); };
await run('requestSong({videoId:"offline",title:"Offline"}, rejectedButton)');
assert.equal(notices.at(-1)[2], "การเชื่อมต่อขัดข้อง กรุณาลองใหม่");
assert.equal(context.rejectedButton.disabled, false);
console.log("PASS: Thai/English UI without Chinese or missing translations; nickname persistence/request attribution; five-song batches in search order; country chart in every mode without category buttons; chart paging/deduplication/retry; stale responses; search/queue tabs; songs/karaoke/video buttons.");
