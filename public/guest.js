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
if (document.body.dataset.admin === "true") {
  pageTabs.push(document.getElementById("participants-tab"));
  pagePanels.push("participants-panel");
}
function selectPageTab(index) {
  pageTabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    document.getElementById(pagePanels[i]).hidden = i !== index;
  });
}
pageTabs.forEach((tab, index) => {
  tab.onclick = () => selectPageTab(index);
  tab.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? pageTabs.length - 1
      : (index + (event.key === "ArrowLeft" ? -1 : 1) + pageTabs.length) % pageTabs.length;
    selectPageTab(next);
    pageTabs[next].focus();
  };
});

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

// ---- Explore (KTV-style browse) ----------------------------------------
// Genre tabs and singer chips run canned YouTube queries via /api/browse
// (cached server-side), so the songs shown are real and current — not a
// hardcoded list. "More songs" walks through the query variants.
// Queries are plain genre/artist phrases: the source is YouTube Music's
// "Songs" search (music-only singles), so no "Official MV" suffix is needed
// to steer away from compilations — the ≤10 min server filter is the backstop.
const THIS_YEAR = new Date().getFullYear();
const GENRE_QUERIES = {
  // The first load uses the configured country's actual YouTube chart.
  All: ["__hits", `เพลงไทยยอดนิยม ${THIS_YEAR}`, `K-pop ${THIS_YEAR}`, "party anthems"],
  // No singer chips for this tab on purpose — graduation songs are a theme,
  // not an artist roster (no GENRE_SLUG entry, so the singer row stays empty).
  Graduation: ["เพลงปัจฉิม", "เพลงมิตรภาพ", "graduation songs"],
  Thai: [`เพลงไทย ${THIS_YEAR}`, "T-pop", "เพลงไทยยอดนิยม"],
  "K-pop": [`K-pop ${THIS_YEAR}`, "K-pop dance hits", "K-pop girl group hits"],
  Cantopop: [`Cantopop ${THIS_YEAR}`, "Hong Kong new songs", "Cantopop hits"],
  Mandopop: ["Mandopop new songs", `Mandopop ${THIS_YEAR}`, "Mandarin classics"],
  Western: ["top pop hits", `pop hits ${THIS_YEAR}`, "classic pop anthems"],
  Party: ["party dance hits", "EDM anthems", "dancefloor classics"],
  Classics: ["Beyond classics", "Leslie Cheung", "Priscilla Chan", "Cantopop 90s"],
};
// Display: Thai label + inline icon per genre (keys stay English — they
// index GENRE_QUERIES and the singer-filter slugs).
const GENRE_LABEL = { Thai: t("Thai"), All: t("All"), Graduation: t("Graduation songs"), "K-pop": "K-pop", Cantopop: t("Cantopop"), Mandopop: t("Mandopop"), Western: t("Western"), Party: t("Party"), Classics: t("Classics") };
const GENRE_ICON = { Thai: "♫",
  All: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="7" r="2.6"/><circle cx="7" cy="17" r="2.6"/><circle cx="17" cy="17" r="2.6"/></svg>',
  Graduation: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.8v4.2c0 1.1 2.5 2.5 5.5 2.5s5.5-1.4 5.5-2.5v-4.2"/><path d="M21.5 9.5v5"/></svg>',
  "K-pop": '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.2-4.4-9.7-9.1A5 5 0 0112 5.6a5 5 0 019.7 5.3C19.2 15.6 12 20 12 20z"/></svg>',
  Cantopop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9.3" y="2.8" width="5.4" height="10.5" rx="2.7"/><path d="M6.3 11a5.7 5.7 0 0011.4 0"/><path d="M12 16.7v3.3M9.3 20h5.4"/></svg>',
  Mandopop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4v9.6a3.4 3.4 0 101.6 2.9V8.6l5.9-1.4V4l-7.5 2z"/></svg>',
  Western: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.6 2.2 2.6 14.2 0 16.4c-2.6-2.2-2.6-14.2 0-16.4z"/></svg>',
  Party: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2 6.2h6.4l-5.2 3.9 2 6.4-5.2-4-5.2 4 2-6.4-5.2-3.9h6.4z"/></svg>',
  Classics: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
};
const GENRE_SLUG = { Thai: "thai", "K-pop": "kpop", Cantopop: "canto", Mandopop: "mando", Western: "western", Party: "party", Classics: "classics" };

const SINGERS = [
  ...["BOWKYLION", "นนท์ ธนนท์", "Tilly Birds", "Three Man Down", "Jeff Satur", "โจอี้ ภูวศิษฐ์", "Bodyslam", "LISA"].map((n) => ({ n, q: n, g: "thai" })),
  { n: "Eason Chan", q: "Eason Chan", g: "canto" },
  { n: "Terence Lam", q: "Terence Lam", g: "canto" },
  { n: "Keung To", q: "Keung To", g: "canto" },
  { n: "MC Cheung", q: "MC Cheung", g: "canto" },
  { n: "Hins Cheung", q: "Hins Cheung", g: "canto" },
  { n: "COLLAR", q: "COLLAR", g: "canto" },
  { n: "Janice Vidal", q: "Janice Vidal", g: "canto" },
  { n: "Joyce Cheng", q: "Joyce Cheng", g: "canto" },
  { n: "Gin Lee", q: "Gin Lee", g: "canto" },
  { n: "Dear Jane", q: "Dear Jane", g: "canto" },
  { n: "Kaho Hung", q: "Kaho Hung", g: "canto" },
  { n: "Mike Tsang", q: "Mike Tsang", g: "canto" },
  { n: "MIRROR", q: "MIRROR Hong Kong", g: "canto" },
  { n: "Edan", q: "Edan", g: "canto" },
  { n: "Panther Chan", q: "Panther Chan", g: "canto" },
  { n: "AGA", q: "AGA", g: "canto" },
  { n: "Phil Lam", q: "Phil Lam", g: "canto" },
  { n: "Serrini", q: "Serrini", g: "canto" },
  { n: "Jay Chou", q: "Jay Chou", g: "mando" },
  { n: "G.E.M.", q: "G.E.M.", g: "mando" },
  { n: "JJ Lin", q: "JJ Lin", g: "mando" },
  { n: "Mayday", q: "Mayday", g: "mando" },
  { n: "Jolin Tsai", q: "Jolin Tsai", g: "mando" },
  { n: "Hebe Tien", q: "Hebe Tien", g: "mando" },
  { n: "Eric Chou", q: "Eric Chou", g: "mando" },
  { n: "Accusefive", q: "Accusefive", g: "mando" },
  { n: "Yoga Lin", q: "Yoga Lin", g: "mando" },
  { n: "LaLa Hsu", q: "LaLa Hsu", g: "mando" },
  { n: "Sodagreen", q: "Sodagreen", g: "mando" },
  { n: "Rainie Yang", q: "Rainie Yang", g: "mando" },
  { n: "Joker Xue", q: "Joker Xue", g: "mando" },
  { n: "Cyndi Wang", q: "Cyndi Wang", g: "mando" },
  { n: "NewJeans", q: "NewJeans", g: "kpop" },
  { n: "BTS", q: "BTS", g: "kpop" },
  { n: "BLACKPINK", q: "BLACKPINK", g: "kpop" },
  { n: "aespa", q: "aespa", g: "kpop" },
  { n: "TWICE", q: "TWICE", g: "kpop" },
  { n: "SEVENTEEN", q: "SEVENTEEN 세븐틴", g: "kpop" },
  { n: "Stray Kids", q: "Stray Kids", g: "kpop" },
  { n: "IVE", q: "IVE 아이브", g: "kpop" },
  { n: "LE SSERAFIM", q: "LE SSERAFIM", g: "kpop" },
  { n: "IU", q: "IU 아이유", g: "kpop" },
  { n: "(G)I-DLE", q: "(G)I-DLE", g: "kpop" },
  { n: "ITZY", q: "ITZY", g: "kpop" },
  { n: "ENHYPEN", q: "ENHYPEN", g: "kpop" },
  { n: "TXT", q: "TOMORROW X TOGETHER", g: "kpop" },
  { n: "BABYMONSTER", q: "BABYMONSTER", g: "kpop" },
  { n: "ILLIT", q: "ILLIT", g: "kpop" },
  { n: "Taylor Swift", q: "Taylor Swift", g: "western" },
  { n: "Bruno Mars", q: "Bruno Mars", g: "western" },
  { n: "Ed Sheeran", q: "Ed Sheeran", g: "western" },
  { n: "The Weeknd", q: "The Weeknd", g: "western" },
  { n: "Billie Eilish", q: "Billie Eilish", g: "western" },
  { n: "Dua Lipa", q: "Dua Lipa", g: "western" },
  { n: "Adele", q: "Adele", g: "western" },
  { n: "Olivia Rodrigo", q: "Olivia Rodrigo", g: "western" },
  { n: "Ariana Grande", q: "Ariana Grande", g: "western" },
  { n: "Justin Bieber", q: "Justin Bieber", g: "western" },
  { n: "Coldplay", q: "Coldplay", g: "western" },
  { n: "Maroon 5", q: "Maroon 5", g: "western" },
  { n: "Sabrina Carpenter", q: "Sabrina Carpenter", g: "western" },
  { n: "Charlie Puth", q: "Charlie Puth", g: "western" },
  { n: "Calvin Harris", q: "Calvin Harris", g: "party" },
  { n: "David Guetta", q: "David Guetta", g: "party" },
  { n: "Avicii", q: "Avicii", g: "party" },
  { n: "Black Eyed Peas", q: "Black Eyed Peas", g: "party" },
  { n: "The Chainsmokers", q: "The Chainsmokers", g: "party" },
  { n: "Marshmello", q: "Marshmello", g: "party" },
  { n: "Alan Walker", q: "Alan Walker", g: "party" },
  { n: "Kygo", q: "Kygo", g: "party" },
  { n: "Pitbull", q: "Pitbull", g: "party" },
  { n: "Zedd", q: "Zedd", g: "party" },
  { n: "Beyond", q: "Beyond", g: "classics" },
  { n: "Leslie Cheung", q: "Leslie Cheung", g: "classics" },
  { n: "Priscilla Chan", q: "Priscilla Chan", g: "classics" },
  { n: "Alan Tam", q: "Alan Tam", g: "classics" },
  { n: "Anita Mui", q: "Anita Mui", g: "classics" },
  { n: "Jacky Cheung", q: "Jacky Cheung", g: "classics" },
  { n: "Faye Wong", q: "Faye Wong", g: "classics" },
  { n: "Teresa Teng", q: "Teresa Teng", g: "classics" },
  { n: "Andy Lau", q: "Andy Lau", g: "classics" },
  { n: "Sandy Lam", q: "Sandy Lam", g: "classics" },
  { n: "Sally Yeh", q: "Sally Yeh", g: "classics" },
];

const moreBtn = document.getElementById("more");
let activeGenre = "All"; // which tab is selected — also filters the singer row
let activeKey = "genre:All"; // "genre:<name>" or "singer:<name>" (highlight)
const browse = { queries: [], idx: 0, seen: new Set(), pending: [], gen: 0 };

// Fisher-Yates — used both for the query-variant reorder (shuffle button) and
// to shuffle fetched results client-side, since the server cache returns the
// same array every time for a given query.
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderGenreTabs() {
  const bar = document.getElementById("genre-tabs");
  bar.innerHTML = "";
  for (const g of Object.keys(GENRE_QUERIES)) {
    const btn = document.createElement("button");
    btn.className = "genre-tab" + (activeKey === `genre:${g}` ? " active" : "");
    btn.innerHTML = `${GENRE_ICON[g]}<span></span>`;
    btn.querySelector("span").textContent = GENRE_LABEL[g];
    btn.onclick = () => selectGenre(g);
    bar.appendChild(btn);
  }
}

function renderSingers() {
  const row = document.getElementById("singers");
  row.innerHTML = "";
  const list =
    activeGenre === "All" ? SINGERS : SINGERS.filter((s) => s.g === GENRE_SLUG[activeGenre]);
  // Genres without a GENRE_SLUG entry (e.g. Graduation) have no singer roster —
  // hide the row instead of leaving an empty strip.
  row.classList.toggle("hidden", list.length === 0);
  for (const s of list) {
    const btn = document.createElement("button");
    btn.className = `singer-chip${activeKey === `singer:${s.n}` ? " active" : ""}`;
    btn.innerHTML = `<span class="singer-avatar g-${s.g}"></span><span class="singer-name"></span>`;
    btn.querySelector(".singer-avatar").textContent = [...s.n][0];
    btn.querySelector(".singer-name").textContent = s.n;
    btn.onclick = () => selectSinger(s);
    row.appendChild(btn);
  }
}

function selectGenre(g) {
  activeGenre = g;
  activeKey = `genre:${g}`;
  renderGenreTabs();
  renderSingers();
  startBrowse(GENRE_QUERIES[g]);
}

function selectSinger(s) {
  activeKey = `singer:${s.n}`;
  renderGenreTabs();
  renderSingers();
  startBrowse([s.q, `${s.q} popular songs`, `${s.q} hits`]);
}

async function startBrowse(queries) {
  browse.queries = queries;
  browse.idx = 0;
  browse.seen = new Set();
  browse.pending = [];
  browse.gen++; // invalidate any in-flight loadMoreSongs from the previous tab/search
  resultsEl.innerHTML = "";
  moreBtn.classList.add("hidden");
  await loadMoreSongs();
}

// Walks through query variants (one /api/browse call per variant) until it
// finds at least one song not already shown, or runs out of variants — so a
// variant whose results are all dupes doesn't silently add nothing (D3).
async function loadMoreSongs() {
  const gen = browse.gen;
  moreBtn.disabled = true;
  setStatus(t("Loading songs…"));
  try {
    while (browse.pending.length === 0 && browse.idx < browse.queries.length) {
      const q = browse.queries[browse.idx++];
      const res = await fetch("/api/browse?q=" + encodeURIComponent(q) + "&mode=" + searchMode);
      if (browse.gen !== gen) return; // stale — a newer tab/search/shuffle took over
      const data = await res.json();
      if (browse.gen !== gen) return;
      if (!res.ok) throw new Error(data.error || t("Couldn't load songs."));
      const fresh = (data.results || []).filter((r) => r.videoId && !browse.seen.has(r.videoId));
      if (fresh.length === 0) continue; // this variant was all dupes — try the next one
      for (const r of fresh) browse.seen.add(r.videoId);
      browse.pending = shuffleArray(fresh); // don't show the same order every time (A4)
      break;
    }
    setStatus("");
    showMoreResults();
    if (browse.seen.size === 0 && resultsEl.children.length === 0) {
      setStatus(t("No songs found — try another tab."));
    }
  } catch (err) {
    if (browse.gen === gen) setStatus("😕 " + err.message);
  } finally {
    if (browse.gen === gen) {
      moreBtn.disabled = false;
      moreBtn.classList.toggle("hidden", browse.pending.length === 0 && browse.idx >= browse.queries.length);
    }
  }
}

moreBtn.onclick = loadMoreSongs;

document.getElementById("shuffle").onclick = () => {
  // Re-run the current selection with its query variants in a fresh order.
  startBrowse(shuffleArray(browse.queries));
};

// ---- Search -----------------------------------------------------------
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(qEl.value.trim());
});

async function doSearch(q) {
  if (!q) return backToExplore(); // empty submit restores explore

  qEl.blur();
  const gen = ++browse.gen;
  browse.idx = browse.queries.length;
  browse.pending = [];
  resultsEl.innerHTML = "";
  sugSection.classList.add("hidden"); // hide explore once searching
  moreBtn.classList.add("hidden");
  backToExploreBtn.classList.remove("hidden");
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
    if (browse.gen === gen) moreBtn.disabled = false;
  }
}

// Restore the explore section after a search — re-runs whatever browse
// selection (genre/singer) was active before the guest searched.
function backToExplore() {
  browse.gen++;
  browse.pending = [];
  moreBtn.classList.add("hidden");
  qEl.value = "";
  resultsEl.innerHTML = "";
  setStatus("");
  backToExploreBtn.classList.add("hidden");
  sugSection.classList.remove("hidden");
  return startBrowse(browse.queries);
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
    <img src="${r.thumbnail || NO_THUMB}" alt="" loading="lazy" />
    <div class="r-meta">
      <div class="r-title"></div>
      <div class="r-sub"></div>
    </div>
    <button class="add-btn" title="${t("Add")}">+</button>`;
  li.querySelector(".r-title").textContent = r.title;
  li.querySelector(".r-sub").textContent = r.channel + (r.duration ? ` · ${r.duration}` : "");
  const btn = li.querySelector(".add-btn");
  btn.onclick = () => requestSong(r, btn);
  return li;
}

function appendResults(results) {
  for (const r of results) resultsEl.appendChild(resultCard(r));
}

function showMoreResults() {
  appendResults(browse.pending.splice(0, 5));
  moreBtn.classList.toggle("hidden", browse.pending.length === 0 && browse.idx >= browse.queries.length);
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

// Shared nickname on Guest/Admin, kept across refreshes on this browser.
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
const savedNickname = localStorage.getItem("guestNickname");
const nickname = NICKNAMES.includes(savedNickname)
  ? savedNickname : NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)];
localStorage.setItem("guestNickname", nickname);
document.getElementById("request-title").textContent = t("addSongBy", { nickname });
document.title = t("addSongBy", { nickname });

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
async function requestSong(song, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  // Persistent, animated "checking" card — with the web-searching filter a
  // verdict can take 5–20s, so it must read as activity, not a frozen toast.
  // Subline names the song: several checks can be in flight at once.
  const notice = toast("info", "🔎", t("Checking song…"), { persist: true, sub: song.title, checking: true });
  try {
    const data = await Room.fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...song, name: nickname, clientId }),
    });
    if (data.ok) {
      const main = data.position === 0 ? t("Added — now playing") : t("position", { position: data.position });
      const sub = data.position === 0 ? t("Added — playing now!") : t("position", { position: data.position });
      notice.set("ok", "✓", main, { sub });
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
    notice.set("bad", "⚠️", t("Network error. Please try again."), { sub: t("Network error. Try again.") });
    btn.disabled = false;
    btn.textContent = "+";
  }
}

// Stacking toasts: each card is its own element (icon circle + Thai main
// line + smaller English subline). toast() returns a handle whose set() morphs
// the card in place — a request's "checking…" card becomes its own verdict —
// so parallel requests never clobber each other's feedback.
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
      el.querySelector(".toast-ico").textContent = icon2;
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
    notice.set("bad", "⏳", t("wait", { seconds: left }), { persist: true, sub: t("wait", { seconds: left }) });
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
  Room.connect({ onState(msg) {
    lastQueueState = msg.state;
    renderQueue(msg.state);
  } });
}

function renderQueue(state) {
  const np = state.nowPlaying;
  const npEl = document.getElementById("now-playing");
  if (np) {
    npEl.classList.remove("hidden");
    npEl.innerHTML = `
      <img src="${np.thumbnail || NO_THUMB}" alt="" />
      <div class="np-body">
        <div class="np-label">
          <span class="eq"><span></span><span></span><span></span></span>
          ${t("nowPlaying")}
        </div>
        <div class="np-title"></div>
        <div class="np-sub"></div>
      </div>`;
    npEl.querySelector(".np-title").textContent = np.title;
    npEl.querySelector(".np-sub").textContent =
      (np.channel || "") + (np.addedBy ? ` · ${t("requester", { name: np.addedBy })}` : "");
  } else {
    npEl.classList.add("hidden");
  }

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
      <img src="${item.thumbnail || NO_THUMB}" alt="" loading="lazy" />
      <div class="q-text"><div class="t-row"><span class="t"></span></div><div class="s"></div></div>`;
    li.querySelector(".t").textContent = item.title;
    li.querySelector(".s").textContent = item.channel;
    if (myIds.has(item.id)) {
      const chip = document.createElement("span");
      chip.className = "q-you";
      chip.textContent = t("You");
      li.querySelector(".t-row").appendChild(chip);
    }
    ul.appendChild(li);
  });
}

renderSingers();
Room.ready.then((joined) => {
  if (!joined) return;
  selectGenre("All");
  if (document.body.dataset.admin !== "true") connectWs();
});
