// Guest (mobile) page: search YouTube, request a song, watch the live queue.

const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const toastsEl = document.getElementById("toasts");
const qEl = document.getElementById("q");
const sugSection = document.getElementById("suggestions-section");
const backToExploreBtn = document.getElementById("back-to-explore");

// Shared tabs keep both panels mounted so search and live queue survive switching.
const pageTabs = [document.getElementById("search-tab"), document.getElementById("queue-tab")];
const pagePanels = ["search-panel", "queue-panel"];
let activePageTab = document.body.dataset.admin === "true" ? 1 : 0;
if (document.body.dataset.admin === "true") {
  pageTabs.push(document.getElementById("participants-tab"));
  pagePanels.push("participants-panel");
}
function selectPageTab(index) {
  if (!pageTabs[index] || pageTabs[index].hidden) return;
  activePageTab = index;
  pageTabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    document.getElementById(pagePanels[i]).hidden = i !== index;
  });
}
function setParticipantsVisible(visible) {
  const tab = document.getElementById("participants-tab");
  tab.hidden = !visible;
  if (!visible) {
    document.getElementById("participants-panel").hidden = true;
    if (activePageTab === 2) {
      selectPageTab(0);
      pageTabs[0].focus();
    }
  }
}
pageTabs.forEach((tab, index) => {
  tab.onclick = () => selectPageTab(index);
  tab.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const order = document.body.dataset.admin === "true" ? [1, 0, 2] : [0, 1];
    const visible = order.filter(i => !pageTabs[i].hidden);
    const next = event.key === "Home" ? visible[0] : event.key === "End" ? visible.at(-1)
      : visible[(visible.indexOf(index) + (event.key === "ArrowLeft" ? -1 : 1) + visible.length) % visible.length];
    selectPageTab(next);
    pageTabs[next].focus();
  };
});

selectPageTab(activePageTab);

let searchMode = "videos";
const searchModes = ["videos", "karaoke", "songs"];
function selectSearchMode(mode) {
  if (mode === searchMode) return;
  searchMode = mode;
  searchModes.forEach((value) => {
    document.getElementById(`mode-${value}`).setAttribute("aria-pressed", String(value === mode));
  });
  return qEl.value.trim() ? doSearch(qEl.value.trim()) : backToExplore();
}
searchModes.forEach((mode) => {
  document.getElementById(`mode-${mode}`).onclick = () => selectSearchMode(mode);
});

const clearSearchBtn = document.getElementById("clear-search");
function updateClearSearch() { clearSearchBtn.hidden = !qEl.value; }
qEl.addEventListener("input", updateClearSearch);
clearSearchBtn.onclick = () => { backToExplore(); qEl.focus(); };
// Native search-field clearing restores Explore as well.
qEl.addEventListener("search", () => { if (!qEl.value) backToExplore(); });

// ---- Explore (country chart) -----------------------------------------
const moreBtn = document.getElementById("more");
const browse = { pending: [], gen: 0 };

// Shuffle cached chart results so Explore can offer a fresh order.
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function startBrowse() {
  const gen = ++browse.gen;
  browse.pending = [];
  resultsEl.innerHTML = "";
  moreBtn.classList.add("hidden");
  moreBtn.disabled = true;
  resultsEl.setAttribute("aria-busy", "true");
  setStatus(t("Loading songs…"));
  try {
    const res = await fetch("/api/browse?q=__hits");
    const data = await res.json();
    if (browse.gen !== gen) return;
    if (!res.ok) throw new Error(data.error || t("Couldn't load songs."));
    const seen = new Set();
    const songs = (data.results || []).filter(song => {
      if (!song.videoId || seen.has(song.videoId)) return false;
      seen.add(song.videoId);
      return true;
    });
    browse.pending = shuffleArray(songs);
    setStatus(songs.length ? "" : t("No chart songs found — try searching."));
    showMoreResults();
  } catch (err) {
    if (browse.gen === gen) setStatus("😕 " + err.message);
  } finally {
    if (browse.gen === gen) { moreBtn.disabled = false; resultsEl.setAttribute("aria-busy", "false"); }
  }
}

moreBtn.onclick = showMoreResults;
document.getElementById("shuffle").onclick = startBrowse;

// ---- Search -----------------------------------------------------------
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(qEl.value.trim());
});

async function doSearch(q) {
  if (!q) return backToExplore(); // empty submit restores explore

  qEl.blur();
  const gen = ++browse.gen;
  browse.pending = [];
  resultsEl.innerHTML = "";
  sugSection.classList.add("hidden"); // hide explore once searching
  moreBtn.classList.add("hidden");
  backToExploreBtn.classList.remove("hidden");
  updateClearSearch();
  resultsEl.setAttribute("aria-busy", "true");
  setStatus(t("Searching…"));
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q) + "&mode=" + searchMode);
    const data = await res.json();
    if (browse.gen !== gen) return;
    if (!res.ok) throw new Error(data.error || t("Search failed"));
    renderResults(data.results || []);
  } catch (err) {
    if (browse.gen === gen) setStatus("😕 " + err.message);
  } finally {
    if (browse.gen === gen) { moreBtn.disabled = false; resultsEl.setAttribute("aria-busy", "false"); }
  }
}

// Restore the country chart after a search.
function backToExplore() {
  browse.gen++;
  browse.pending = [];
  moreBtn.classList.add("hidden");
  qEl.value = "";
  updateClearSearch();
  resultsEl.innerHTML = "";
  setStatus("");
  backToExploreBtn.classList.add("hidden");
  sugSection.classList.remove("hidden");
  return startBrowse();
}

backToExploreBtn.onclick = backToExplore;

function setStatus(text) {
  if (!text) return statusEl.classList.add("hidden");
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

// Placeholder for missing thumbnails — a bare <img src=""> would otherwise
// request the current page URL. Same pattern as host.js's queue rendering.
const NO_THUMB = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';

function resultCard(r) {
  const li = document.createElement("li");
  li.innerHTML = `
    <img src="${NO_THUMB}" alt="" loading="lazy" />
    <div class="r-meta">
      <div class="r-title"></div>
      <div class="r-sub"></div>
    </div>
    <button class="add-btn" title="${t("Add")}">+</button>`;
  li.querySelector("img").src = r.thumbnail || NO_THUMB;
  li.querySelector(".r-title").textContent = r.title;
  li.querySelector(".r-sub").textContent = (r.channel || "") + (r.duration ? ` · ${r.duration}` : "");
  const btn = li.querySelector(".add-btn");
  btn.setAttribute("aria-label", t("addSong", { title: r.title }));
  btn.dataset.videoId = r.videoId;
  if (pendingRequests.has(r.videoId)) { btn.disabled = true; btn.textContent = "…"; }
  btn.onclick = () => requestSong(r, btn);
  return li;
}

function appendResults(results) {
  for (const r of results) resultsEl.appendChild(resultCard(r));
}

function showMoreResults() {
  appendResults(browse.pending.splice(0, 5));
  moreBtn.classList.toggle("hidden", browse.pending.length === 0);
}

function renderResults(results) {
  if (results.length === 0) return setStatus(t("No results — try a different search."));
  setStatus("");
  resultsEl.innerHTML = "";
  browse.pending = results.slice();
  showMoreResults();
}

// ---- Guest identity -----------------------------------------------------
// Persistent random id sent with requests so the server's cooldown is
// per-phone, not per-IP (guests on the venue Wi-Fi share one public IP).
const clientId =
  localStorage.getItem("clientId") ||
  (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    localStorage.setItem("clientId", id);
    return id;
  })();

// Guest/Admin share a nickname within a room, including refresh and reconnect.
const NICKNAMES = [
  "กุ้ง", "ก้อง", "แก้ม", "กิ๊ฟ", "เก่ง", "ไก่", "ข้าว", "ขวัญ", "ไข่มุก", "เข็ม",
  "ครีม", "เค้ก", "คิม", "คิว", "แคท", "จอย", "จูน", "จ๋า", "เจี๊ยบ", "แจน",
  "ชมพู่", "ชะเอม", "เชอร์รี่", "โซ่", "ดิว", "ดาว", "โดนัท", "ตาล", "ต้น", "เต้",
  "แตงโม", "ตุ๊ก", "เตย", "ตูน", "ถั่ว", "ท็อป", "ทิว", "เทียน", "นัท", "น้ำ",
  "นุ่น", "นิว", "นิ่ม", "น้อย", "เนย", "บี", "บัว", "บอย", "บาส", "เบล",
  "ใบเตย", "โบว์", "ปอ", "ป่าน", "ปาล์ม", "ปุ้ย", "ปลา", "เป้", "แป้ง", "ปิง",
  "ฝน", "ฝ้าย", "ฟ้า", "เฟิร์น", "ฟาง", "ฟิล์ม", "พิม", "แพร", "พลอย", "พีช",
  "พัด", "เพชร", "เพลง", "ภู", "มายด์", "มิ้นท์", "มุก", "เมย์", "มด", "หมิว",
  "โม", "แยม", "ยุ้ย", "ยู", "ริบบิ้น", "รุ้ง", "โรส", "ลิลลี่", "ลูกแก้ว", "เล็ก",
  "ว่าน", "วิว", "ส้ม", "ทราย", "ออม", "อาย", "อิง", "เอม", "โอ๊ต", "ไอซ์",
];
let nickname;
function initNickname() {
  const key = Room.sessionId ? `music-nickname:${Room.sessionId}` : "guestNickname";
  const savedNickname = localStorage.getItem(key);
  const choices = NICKNAMES.filter(name => name !== localStorage.getItem("guestNickname"));
  nickname = NICKNAMES.includes(savedNickname)
    ? savedNickname : choices[Math.floor(Math.random() * choices.length)];
  localStorage.setItem(key, nickname);
  localStorage.setItem("guestNickname", nickname);
  document.getElementById("nickname-credit").textContent = t("nicknameCredit", { nickname });
  document.title = t("addSongBy", { nickname });
  document.getElementById("room-label").textContent = t("roomCode", { code: Room.code });
}

// ---- Own requests (for the "YOU" badge in the queue) -------------------
function loadMyRequestIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("myRequestIds") || "[]"));
  } catch {
    return new Set();
  }
}
function rememberMyRequest(id) {
  const ids = [...loadMyRequestIds(), id].slice(-50); // cap so it can't grow unbounded
  localStorage.setItem("myRequestIds", JSON.stringify(ids));
}

// ---- Request a song ---------------------------------------------------
const pendingRequests = new Set();
async function requestSong(song, btn) {
  if (btn.disabled || pendingRequests.has(song.videoId)) return;
  pendingRequests.add(song.videoId);
  let added = false;
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  btn.textContent = "…";
  const notice = toast("info", "🔎", t("Checking song…"), { persist: true, sub: song.title, checking: true });
  try {
    const data = await Room.fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...song, name: nickname, clientId }),
    });
    if (data.ok) {
      added = true;
      const main = data.position === 0 ? t("Added — now playing") : t("position", { position: data.position });
      notice.set("ok", "✓", main, { sub: song.title });
      btn.textContent = "✓";
      if (data.id) {
        rememberMyRequest(data.id);
        // The queue broadcast usually lands before this response does, so the
        // row was rendered without knowing it's ours — re-render for the badge.
        if (lastQueueState) {
          if (document.body.dataset.admin === "true") renderAdmin();
          else renderQueue(lastQueueState);
        }
      }
    } else {
      if (data.retryIn) {
        notice.dismiss();
        cooldownToast(data.retryIn);
      } else notice.set("bad", "🚫", data.reason || t("Couldn't add that song."));
      btn.disabled = false;
      btn.textContent = "+";
    }
  } catch (err) {
    if (err.retryIn) { notice.dismiss(); cooldownToast(err.retryIn); }
    else notice.set("bad", "!", err.status ? err.message : t("Network error. Please try again."));
    btn.disabled = false;
    btn.textContent = "+";
  } finally {
    pendingRequests.delete(song.videoId);
    btn.setAttribute("aria-busy", "false");
    // A shuffle or new search may have replaced the button during its request.
    for (const button of resultsEl.querySelectorAll(".add-btn")) {
      if (button.dataset.videoId !== song.videoId) continue;
      button.disabled = added;
      button.textContent = added ? "✓" : "+";
      button.setAttribute("aria-busy", "false");
    }
  }
}

// Each request keeps its own checking/result notice, capped at three cards.
const MAX_TOASTS = 3;

function toast(kind, icon, main, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  toastsEl.appendChild(el);
  while (toastsEl.children.length > MAX_TOASTS) toastsEl.firstElementChild.remove();
  void el.offsetHeight; // flush styles so adding .show below animates the entry
  let timer;
  const h = {
    el,
    set(kind2, icon2, main2, { persist = false, sub = "", checking = false } = {}) {
      el.className = `toast show ${kind2}${checking ? " checking" : ""}`;
      el.innerHTML = `
        <span class="toast-ico"></span>
        <div><div class="toast-main"></div><div class="toast-sub"></div></div>`;
      const glyph = kind2 === "ok" ? '<path d="m5 12 4 4L19 6"/>'
        : kind2 === "bad" ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>'
        : '<path d="M21 12a9 9 0 1 1-9-9"/>';
      el.querySelector(".toast-ico").innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
      el.querySelector(".toast-main").textContent = main2;
      const subEl = el.querySelector(".toast-sub");
      if (sub) subEl.textContent = sub;
      else subEl.remove();
      clearTimeout(timer);
      if (!persist) timer = setTimeout(h.dismiss, 3800);
    },
    dismiss() {
      clearTimeout(timer);
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300); // let the exit transition play
    },
  };
  h.set(kind, icon, main, opts);
  return h;
}

// Live countdown shown when the server rejects a request for coming too soon
// (retryIn = seconds left). Singleton card: retrying mid-cooldown restarts the
// countdown on the same card instead of stacking duplicates.
function cooldownToast(seconds) {
  clearInterval(cooldownToast._i);
  if (!cooldownToast._h?.el.isConnected) {
    cooldownToast._h = toast("bad", "⏳", "", { persist: true });
  }
  const notice = cooldownToast._h;
  let left = seconds;
  const draw = () =>
    notice.set("bad", "⏳", t("wait", { seconds: left }), { persist: true });
  draw();
  cooldownToast._i = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(cooldownToast._i);
      notice.dismiss();
    } else draw();
  }, 1000);
}

// ---- Live queue (WebSocket) ------------------------------------------
let lastQueueState = null; // kept so the You badge can re-render after an add

function connectWs() {
  setConnectionStatus("connecting");
  Room.connect({
    onAuth() { setConnectionStatus("connected"); },
    onState(msg) { lastQueueState = msg.state; renderQueue(msg.state); },
    onOffline() { setConnectionStatus("offline"); },
    onEnd() { setConnectionStatus("offline"); },
  });
}

function setConnectionStatus(status) {
  const el = document.getElementById("connection");
  el.dataset.status = status;
  el.title = t(status);
  el.setAttribute("aria-label", t(status));
  el.innerHTML = '<span class="sr-only"></span>';
  el.querySelector("span").textContent = t(status);
}

function songMeta(item, requesterFirst = false) {
  const requester = [item.autoQueued && t("autoQueued"), item.addedBy && t("requester", { name: item.addedBy })].filter(Boolean).join(" · ");
  return (requesterFirst ? [requester, item.channel, item.duration] : [item.channel, item.duration, requester]).filter(Boolean).join(" · ");
}

function renderAutoQueue(state) {
  const items = state.autoQueue ? state.autoQueueItems || [] : [];
  document.getElementById("queue-panel").classList.toggle("has-auto-queue", items.length > 0);
  document.getElementById("auto-queue-section").hidden = items.length === 0;
  document.getElementById("auto-queue-count").textContent = items.length;
  const list = document.getElementById("auto-queue-list");
  list.innerHTML = "";
  items.forEach((item, index) => {
    const row = document.createElement("li");
    row.innerHTML = `<span class="q-num">${index + 1}</span><img src="${NO_THUMB}" alt="" loading="lazy" /><div class="q-text"><div class="t"></div><div class="s"></div></div>`;
    row.querySelector("img").src = item.thumbnail || NO_THUMB;
    row.querySelector(".t").textContent = item.title;
    row.querySelector(".s").textContent = songMeta(item);
    list.appendChild(row);
  });
}

function renderNowPlaying(state) {
  renderAutoQueue(state);
  const autoQueueStatus = document.getElementById("auto-queue-status");
  autoQueueStatus.textContent = document.body.dataset.admin === "true"
    ? [state.autoQueue && t("autoQueueEnabled"), autoQueueMessage(state)].filter(Boolean).join(" · ")
    : [t("autoQueue", { state: t(state.autoQueue ? "On" : "Off") }), autoQueueMessage(state)].filter(Boolean).join(" · ");
  const np = state.nowPlaying;
  const npEl = document.getElementById("now-playing");
  npEl.classList.remove("hidden");
  npEl.classList.toggle("paused", !!state.paused);
  if (!np) { npEl.textContent = t("idle"); return; }
  npEl.innerHTML = `
    <img src="${NO_THUMB}" alt="" />
    <div class="np-body">
      <div class="np-label">
        <span class="eq" aria-hidden="true"><span></span><span></span><span></span></span>
        ${t(state.paused ? "pause" : "nowPlaying")}
      </div>
      <div class="np-title"></div>
      <div class="np-sub"><span class="np-channel"></span> <span class="np-requester"></span></div>
    </div>`;
  npEl.querySelector("img").src = np.thumbnail || NO_THUMB;
  npEl.querySelector(".np-title").textContent = np.title;
  npEl.querySelector(".np-title").title = np.title;
  npEl.querySelector(".np-channel").textContent = [np.channel, np.duration].filter(Boolean).join(" · ");
  npEl.querySelector(".np-requester").textContent = [np.autoQueued && t("autoQueued"), np.addedBy && t("requester", { name: np.addedBy })].filter(Boolean).join(" · ");
  npEl.querySelector(".np-sub").title = songMeta(np);
}

function renderQueue(state) {
  renderNowPlaying(state);
  const queue = state.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  const ul = document.getElementById("queue");
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = `<li class="q-empty">${t("Nothing queued yet — be the first!")}</li>`;
    return;
  }
  const myIds = loadMyRequestIds();
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <img src="${NO_THUMB}" alt="" loading="lazy" />
      <div class="q-text"><div class="t-row"><span class="t"></span></div><div class="s"></div></div>`;
    li.querySelector("img").src = item.thumbnail || NO_THUMB;
    li.querySelector(".t").textContent = item.title;
    li.querySelector(".s").textContent = songMeta(item, true);
    li.querySelector(".s").title = songMeta(item);
    if (myIds.has(item.id)) {
      const chip = document.createElement("span");
      chip.className = "q-you";
      chip.textContent = t("You");
      li.querySelector(".t-row").appendChild(chip);
    }
    ul.appendChild(li);
  });
}

Room.ready.then((joined) => {
  if (!joined) return;
  initNickname();
  startBrowse();
  if (document.body.dataset.admin !== "true") connectWs();
});
