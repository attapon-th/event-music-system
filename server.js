// Event Music System — projector QR jukebox.
//
//   /        -> host page (project this; shows QR + player + queue)
//   /guest   -> guest page (phones open this via the QR code)
//
// Flow when a guest requests a song:
//   1. guardrails       — cooldown, duplicate, queue cap
//   2. checkPlayable()  — reject deleted/private/nonexistent videos
//   3. moderate()       — optional LLM verdict for this event (fail-open)
//   4. state.add()      — enqueue; broadcast to all clients over WebSocket

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import { searchYouTube, fetchChartHits, checkPlayable, fetchVideoDetails } from "./src/youtube.js";
import { moderate, moderationConfigured } from "./src/moderation.js";
import { JukeboxState } from "./src/state.js";
import { detectLanIp } from "./src/net.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Minimal .env loader (no dependency) ---------------------------------
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const DEFAULT_REGION = /^[A-Za-z]{2}$/.test(process.env.DEFAULT_REGION || "") ? process.env.DEFAULT_REGION.toUpperCase() : "TH";
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || "th-TH";
const youtubeOptions = { region: DEFAULT_REGION, locale: DEFAULT_LOCALE };

const PORT = parseInt(process.env.PORT || "45416", 10);
const LAN_IP = detectLanIp(process.env.HOST_IP);
// PUBLIC_URL (e.g. https://grad-din-music.hangton.net) takes precedence when the
// app runs behind a reverse proxy. Otherwise fall back to LAN IP + port.
const PUBLIC_BASE = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const GUEST_URL = PUBLIC_BASE ? `${PUBLIC_BASE}/guest` : `http://${LAN_IP}:${PORT}/guest`;
// --- Persistent host settings ---------------------------------------------
// Filter on/off, moderation mode, cooldown, and event context are all editable
// live from the host page and survive restarts in data/settings.json (docker-
// compose mounts ./data as a volume). The .env values only seed the first boot.
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
let savedSettings = {};
try {
  savedSettings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch {
  /* first boot — fall back to .env below */
}

// Filter (LLM moderation): when ON but no API key is configured, moderation
// fails open (accepts everything) — harmless.
let filterOn =
  savedSettings.filterOn ?? String(process.env.ENABLE_MODERATION || "").toLowerCase() === "true";
// "strict" = family-friendly only; "default" = block non-music/explicit/unfit.
let moderationMode =
  savedSettings.moderationMode ??
  ((process.env.MODERATION_MODE || "").toLowerCase() === "strict" ? "strict" : "default");
// Event context for the moderation LLM ("what kind of event is this?") — one
// deployment serves different venues. Empty = moderation.js's built-in default.
let eventContext = savedSettings.eventContext ?? (process.env.EVENT_CONTEXT || "");
// Per-guest request cooldown (seconds, 0 = off).
let cooldownSeconds = savedSettings.cooldownSeconds ?? 15;

function saveSettings() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({ filterOn, moderationMode, eventContext, cooldownSeconds }, null, 2)
    );
  } catch (err) {
    console.warn(`[settings] could not save: ${err.message}`);
  }
}

const app = express();
app.set("trust proxy", true); // behind a reverse proxy — req.ip should read X-Forwarded-For
app.use(express.json());

// --- Host/Admin authentication ---------------------------------------
// HOST_PASSWORD in .env gates the projector page (Basic Auth) and its controls
// (a per-boot token the host page carries onto its WebSocket). Guests never
// need it. Unset disables privileged pages and controls.
const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const hostToken = randomUUID();
function requireHostAuth(req, res, next) {
  if (!HOST_PASSWORD) return res.status(503).send("กรุณาตั้งค่า HOST_PASSWORD เพื่อใช้งาน Player และ Admin");
  const b64 = (req.headers.authorization || "").match(/^Basic ([A-Za-z0-9+/=]+)$/i)?.[1] || "";
  const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
  if (pass === HOST_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Event Music Host"').status(401).send("กรุณาเข้าสู่ระบบด้วยรหัสผ่านผู้ดูแล");
}
app.use(["/host.html", "/admin.html"], requireHostAuth); // the static copy must not bypass "/"

app.use(
  express.static(path.join(__dirname, "public"), {
    // Force revalidation on every load (cheap 304s via ETag). Without this,
    // iOS Safari holds onto stale JS/CSS across deploys.
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

const state = new JukeboxState();

// --- HTTP API ------------------------------------------------------------

// Host page bootstrap: guest URL + a QR code pointing at it.
app.get("/api/info", async (_req, res) => {
  try {
    const qr = await QRCode.toDataURL(GUEST_URL, { width: 480, margin: 1 });
    res.json({ guestUrl: GUEST_URL, qr, filterOn, moderationMode, moderationConfigured: moderationConfigured(), defaultRegion: DEFAULT_REGION, defaultLocale: DEFAULT_LOCALE });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Explore/browse: same YouTube search, but cached. The guest page's genre tabs
// and singer chips all hit the same canned queries, so one scrape serves every
// guest for the TTL instead of hammering YouTube per tap.
const browseCache = new Map(); // query -> { at, results }
const BROWSE_TTL_MS = 30 * 60 * 1000;

// Browse is for singles only: hour-long "100 songs" compilation videos pass
// YouTube's videos-only search filter, but no single track runs this long.
const MAX_SINGLE_SECONDS = 10 * 60;
function durationSeconds(d) {
  if (!d || !/^[\d:]+$/.test(d)) return Infinity; // "LIVE"/unknown → not a single
  return d.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

app.get("/api/browse", async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  const mode = req.query.mode || "songs";
  if (!["songs", "karaoke", "videos"].includes(mode)) return res.status(400).json({ error: "โหมดค้นหาไม่ถูกต้อง" });
  const cacheKey = `${mode}:${q}`;
  const hit = browseCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return res.json({ results: hit.results });
  try {
    // Chart sentinels use popular-song search in karaoke mode.
    const isChart = ["__hits", "__hk_hits"].includes(q);
    const fetched = mode !== "karaoke" && isChart
      ? await fetchChartHits({ ...youtubeOptions, limit: 40 })
      : await searchYouTube(isChart ? "เพลงไทยยอดนิยม" : q, { ...youtubeOptions, limit: 40, mode });
    const results = fetched
      .filter((r) => durationSeconds(r.duration) <= MAX_SINGLE_SECONDS)
      .slice(0, 20);
    browseCache.set(cacheKey, { at: Date.now(), results });
    if (browseCache.size > 200) browseCache.delete(browseCache.keys().next().value);
    res.json({ results });
  } catch (err) {
    console.error("[browse]", err.message);
    res.status(502).json({ error: "โหลดเพลงไม่สำเร็จ กรุณาลองใหม่" });
  }
});

// Flood control: one request per cooldown window (cooldownSeconds) per guest.
// Keyed on IP + the guest page's persistent clientId — at an event most guests
// sit behind the venue Wi-Fi's single NAT'd IP, so IP alone would give the
// whole party one shared cooldown. (clientId is client-chosen, so a determined
// prankster can rotate it — the host's remove button is the backstop.)
const lastRequestAt = new Map(); // "ip|clientId" -> timestamp of last attempt
function pruneLastRequestAt() {
  if (lastRequestAt.size <= 500) return;
  const cutoff = Date.now() - cooldownSeconds * 1000;
  for (const [key, at] of lastRequestAt) {
    if (at < cutoff) lastRequestAt.delete(key);
  }
}

const MAX_QUEUE_LENGTH = 50;

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ results: [] });
  try {
    const mode = req.query.mode || "songs";
    if (!["songs", "karaoke", "videos"].includes(mode)) return res.status(400).json({ error: "โหมดค้นหาไม่ถูกต้อง" });
    const results = await searchYouTube(q, { ...youtubeOptions, mode });
    res.json({ results });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(502).json({ error: "ค้นหาไม่สำเร็จ กรุณาลองใหม่" });
  }
});

// Host page bootstrap, part 2: the WS control token (Basic-Auth-gated, so
// only an authenticated host page can obtain it).
app.get("/api/host-token", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-store").json({ token: hostToken });
});

// Guest requests a song.
app.post("/api/request", async (req, res) => {
  const { videoId, title, channel, duration, thumbnail, name, clientId } = req.body || {};
  if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      typeof title !== "string" || !title.trim() || title.length > 500 ||
      [channel, duration, thumbnail, name, clientId].some((v) => v !== undefined && v !== null && typeof v !== "string") ||
      (thumbnail && !/^https:\/\/[^\s"<>]+$/.test(thumbnail))) {
    return res.status(400).json({ ok: false, reason: "ข้อมูลเพลงไม่ถูกต้อง" });
  }

  const floodKey = `${req.ip}|${(clientId || "").toString().slice(0, 64)}`;
  const last = lastRequestAt.get(floodKey);
  if (cooldownSeconds > 0 && last) {
    const waitMs = cooldownSeconds * 1000 - (Date.now() - last);
    if (waitMs > 0) {
      const retryIn = Math.ceil(waitMs / 1000);
      // retryIn lets the guest page show a live countdown.
      return res.json({ ok: false, reason: `กรุณารอ ${retryIn} วินาที แล้วลองใหม่`, retryIn });
    }
  }


  if (state.queue.length >= MAX_QUEUE_LENGTH) {
    return res.json({ ok: false, reason: "คิวเพลงเต็ม กรุณาลองใหม่ภายหลัง" });
  }

  // Reject re-adding a song that's already playing or queued.
  if (state.has(videoId)) {
    return res.json({ ok: false, reason: "เพลงนี้อยู่ในคิวแล้ว" });
  }

  // Start the cooldown only now: the checks above are free and shouldn't lock
  // a guest out (e.g. after tapping a duplicate), but everything below hits
  // YouTube and possibly the LLM — that's what the cooldown protects.
  lastRequestAt.set(floodKey, Date.now());
  pruneLastRequestAt();

  // 1. Is the video actually playable?
  const playable = await checkPlayable(videoId);
  if (!playable.ok) {
    return res.json({ ok: false, reason: playable.reason });
  }

  // 2. Filter (LLM moderation) — only when toggled on. Enriches with the video's
  //    category / isFamilySafe / description, then asks the LLM. Fails open.
  if (filterOn) {
    const details = await fetchVideoDetails(videoId); // best-effort, may be null
    const verdict = await moderate({ title, channel }, details, {
      strict: moderationMode === "strict",
      ...(eventContext ? { eventContext } : {}),
    });
    if (!verdict.approved) {
      return res.json({ ok: false, reason: verdict.reason });
    }
  }

  // Recheck after network work: simultaneous requests can otherwise bypass guardrails.
  if (state.has(videoId)) return res.json({ ok: false, reason: "เพลงนี้อยู่ในคิวแล้ว" });
  if (state.queue.length >= MAX_QUEUE_LENGTH) return res.json({ ok: false, reason: "คิวเพลงเต็ม กรุณาลองใหม่ภายหลัง" });

  // 3. Enqueue.
  const { item, position } = state.add({ videoId, title, channel, duration, thumbnail, addedBy: name });
  res.json({ ok: true, reason: "เพิ่มเข้าคิวแล้ว", position, id: item.id });
});

// Cloudflare overrides our no-cache with a 4h browser TTL on .js/.css, which
// left open pages running stale scripts after a deploy. Versioning the asset
// URLs busts that: each boot (= each deploy) points the HTML at fresh URLs.
const BOOT_ID = Date.now().toString(36);
function versionedPage(name) {
  return readFileSync(path.join(__dirname, "public", name), "utf8").replace(
    /(href|src)="\/((?:guest|host|admin|i18n)\.(?:css|js))"/g,
    `$1="/$2?v=${BOOT_ID}"`
  );
}
const HOST_PAGE = versionedPage("host.html");
const GUEST_PAGE = versionedPage("guest.html");
const ADMIN_PAGE = versionedPage("admin.html");
app.get("/admin", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(ADMIN_PAGE);
});

// Host page lives at "/".
app.get("/", requireHostAuth, (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(HOST_PAGE);
});

// Guest page — the QR code points here (extensionless, so static won't serve it).
app.get(["/guest", "/explore"], (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(GUEST_PAGE);
});

// --- WebSocket: real-time queue sync + host controls ---------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function stateMessage() {
  return JSON.stringify({
    type: "state",
    state: state.snapshot(),
    filterOn,
    moderationMode,
    cooldownSeconds,
    eventContext,
  });
}
function broadcastState() {
  const msg = stateMessage();
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
state.onChange = broadcastState;

wss.on("connection", (ws) => {
  // All sockets start read-only; only the protected token grants controls.
  ws.isHost = false;

  // Send current state immediately on connect.
  ws.send(stateMessage());

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.type === "auth") {
      ws.isHost = !!HOST_PASSWORD && msg.token === hostToken;
      ws.send(JSON.stringify({ type: "auth", ok: ws.isHost }));
      return;
    }
    if (!ws.isHost) {
      ws.send(JSON.stringify({ type: "error", error: "ไม่มีสิทธิ์ควบคุมเพลง" }));
      return;
    } // every other message type is a host control
    switch (msg.type) {
      case "ended": // host player finished a track
      case "error": // host player couldn't play (embed-disabled/region-locked)
        if (msg.type === "error") {
          console.warn(`[host] playback error code ${msg.code} on ${msg.videoId} — skipping`);
        } else {
          console.log(`[host] ended ${msg.videoId}`);
        }
        if (typeof msg.videoId === "string") state.advance(msg.videoId);
        break;
      case "skip":
        state.skip();
        break;
      case "remove":
        state.remove(msg.id);
        break;
      case "move":
        state.move(msg.id, msg.dir);
        break;
      case "clear":
        state.clear();
        break;
      case "reorder":
        if (!state.reorder(msg.ids)) {
          ws.send(JSON.stringify({ type: "error", error: "คิวเปลี่ยนแล้ว กรุณาจัดลำดับใหม่" }));
          ws.send(stateMessage());
        }
        break;
      case "playNow":
        state.playNow(msg.id);
        break;
      case "play":
      case "pause":
        state.setPaused(msg.type === "pause");
        break;
      case "setVolume":
        state.setVolume(msg.volume);
        break;
      case "setFilter": // host cycled the content filter: off / on / strict
        if (typeof msg.on !== "boolean") break;
        filterOn = msg.on;
        if (msg.mode === "strict" || msg.mode === "default") moderationMode = msg.mode;
        console.log(`[host] filter ${filterOn ? `ON (${moderationMode})` : "OFF"}`);
        saveSettings();
        broadcastState();
        break;
      case "setCooldown": {
        // host adjusted the per-guest request cooldown (0 = off)
        if (typeof msg.seconds !== "number") break;
        const s = Math.round(msg.seconds);
        if (Number.isFinite(s) && s >= 0 && s <= 300) {
          cooldownSeconds = s;
          console.log(`[host] request cooldown set to ${s ? s + "s" : "OFF"}`);
          saveSettings();
          broadcastState();
        }
        break;
      }
      case "setEventContext": // host described the venue/occasion for the filter
        if (typeof msg.context !== "string") break;
        eventContext = msg.context.slice(0, 300);
        console.log(`[host] event context set to: ${eventContext || "(default)"}`);
        saveSettings();
        broadcastState();
        break;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  🎶  Event Music System running\n");
  console.log(`  Projector (host) : http://localhost:${PORT}/`);
  console.log(`  Guests scan QR   : ${GUEST_URL}`);
  console.log(
    `  Filter           : ${filterOn ? `ON (${moderationMode})` : "OFF"} (change from host page) · ` +
      `LLM ${moderationConfigured() ? "configured" : "NOT configured — filter accepts all"}`
  );
  console.log(
    `  Host password    : ${HOST_PASSWORD ? "SET — host page requires login" : "NOT SET — Player/Admin disabled"}\n`
  );
  if (LAN_IP === "127.0.0.1") {
    console.warn("  ⚠  Could not detect a LAN IP — guests on other devices won't reach you.\n");
  }
});
