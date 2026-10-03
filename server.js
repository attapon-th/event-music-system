// Event Music System — projector QR jukebox.
//
//   /        -> host page (project this; shows QR + player + queue)
//   /guest   -> guest page (phones open this via the QR code)
//
// Flow when a guest requests a song:
//   1. guardrails       — cooldown, duplicate, queue cap
//   2. checkPlayable()  — reject deleted/private/nonexistent videos
//   3. state.add()      — enqueue; broadcast to all clients over WebSocket

import { readFileSync, existsSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import { searchYouTube, fetchChartHits, checkPlayable, durationSeconds } from "./src/youtube.js";
import { updateAutoQueue } from "./src/auto-queue.js";
import { Sessions } from "./src/sessions.js";
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

const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
if (HOST_PASSWORD.length < 4 || /[^0-9]/.test(HOST_PASSWORD)) {
  console.error("HOST_PASSWORD ต้องเป็นตัวเลข 0–9 อย่างน้อย 4 หลัก จึงจะเริ่ม server ได้");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "45416", 10);
const LAN_IP = detectLanIp(process.env.HOST_IP);
// PUBLIC_URL (e.g. https://grad-din-music.hangton.net) takes precedence when the
// app runs behind a reverse proxy. Otherwise fall back to LAN IP + port.
const PUBLIC_BASE = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const GUEST_URL = PUBLIC_BASE ? `${PUBLIC_BASE}/guest` : `http://${LAN_IP}:${PORT}/guest`;
const sessions = new Sessions({
  // AI is paused; retain legacy snapshot fields for existing clients.
  filterOn: false,
  moderationMode: "default",
  eventContext: "",
  cooldownSeconds: 15,
});

const app = express();
app.set("trust proxy", true); // behind a reverse proxy — req.ip should read X-Forwarded-For
app.use(express.json());

// The creation password authorizes new rooms only.
const failedAttempts = new Map();
const hash = (value) => createHash("sha256").update(value).digest();
function tokenFrom(req) {
  return (req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9-]+)$/)?.[1];
}
function fail(req, res, status, error) {
  const now = Date.now();
  let entry = failedAttempts.get(req.ip);
  if (!entry || now - entry.at >= 60000) entry = { at: now, count: 0 };
  entry.count++;
  failedAttempts.set(req.ip, entry);
  return res.status(status).json({ error, retryIn: 5 });
}
function checkAttempts(req, res, next) {
  const entry = failedAttempts.get(req.ip);
  if (entry && Date.now() - entry.at < 60000 && entry.count >= 10) {
    const retryIn = Math.ceil((60000 - (Date.now() - entry.at)) / 1000);
    return res.status(429).set("Retry-After", String(retryIn))
      .json({ error: "ลองไม่สำเร็จหลายครั้ง กรุณารอก่อนลองใหม่", retryIn });
  }
  next();
}
function requirePassword(req, res, next) {
  const password = req.body?.password;
  if (typeof password !== "string" || !timingSafeEqual(hash(password), hash(HOST_PASSWORD))) {
    return fail(req, res, 401, "รหัสสร้างไม่ถูกต้อง");
  }
  next();
}
function findRoom(req, res, next) {
  const { code, sessionId } = req.body || {};
  if (typeof code !== "string" || !/^[1-9][0-9]{2}$/.test(code) ||
      (sessionId !== undefined && typeof sessionId !== "string")) {
    return fail(req, res, 400, "กรุณากรอกเลขห้อง 3 หลัก");
  }
  req.room = sessions.get(code, sessionId);
  if (!req.room) return fail(req, res, 410, "ห้องหมดอายุหรือไม่พบห้อง");
  next();
}
function requireMember(req, res, next) {
  req.member = sessions.authenticate(tokenFrom(req), req.headers["x-session-id"]);
  if (!req.member) return res.status(401).json({ code: "SESSION_INVALID", error: "ห้องหมดอายุหรือไม่มีสิทธิ์เข้าห้อง" });
  next();
}
function memberInfo(member) {
  return { code: member.room.code, sessionId: member.room.id, token: member.token, role: member.role, memberId: member.id };
}
app.post("/api/sessions", checkAttempts, requirePassword, (_req, res) => {
  const room = sessions.create();
  if (!room) return res.status(409).json({ error: "ห้องเต็ม กรุณาลองใหม่ภายหลัง" });
  room.onMembersChange = () => broadcastState(room);
  room.state.onChange = () => {
    broadcastState(room);
    updateAutoQueue(room, () => sessions.get(room.code, room.id) === room, youtubeOptions);
  };
  res.set("Cache-Control", "no-store").json(memberInfo(sessions.issue(room, "player")));
});
app.post("/api/sessions/join", checkAttempts, findRoom, (req, res) => {
  const saved = sessions.authenticate(tokenFrom(req), req.room.id);
  const member = saved?.room === req.room && saved.role !== "player" ? saved : sessions.issue(req.room, "guest");
  if (typeof req.body.name === "string" && req.body.name.trim()) member.name = req.body.name.trim().slice(0, 40);
  res.set("Cache-Control", "no-store").json(memberInfo(member));
});
app.post("/api/sessions/admin/claim", requireMember, (req, res) => {
  const { member } = req;
  if (member.role === "player") return res.status(403).json({ error: "กรุณาเข้าผ่านหน้า Guest เพื่อรับสิทธิ์ผู้ดูแล" });
  if (member.role !== "admin") {
    if (member.room.primaryAdminId) return res.status(403).json({ error: "ห้องนี้มีผู้ดูแลหลักแล้ว" });
    member.role = "admin";
    member.room.primaryAdminId = member.id;
    broadcastState(member.room);
  }
  res.json(memberInfo(member));
});
app.post("/api/sessions/close", requireMember, (req, res) => {
  if (req.member.role !== "player") return res.status(403).json({ error: "เฉพาะ Player เท่านั้นที่ปิดห้องได้" });
  sessions.delete(req.member.room);
  res.json({ ok: true });
});

// --- HTTP API ------------------------------------------------------------

// Host page bootstrap: guest URL + a QR code pointing at it.
app.get("/api/info", requireMember, async (req, res) => {
  try {
    const room = req.member.room;
    const guestUrl = `${GUEST_URL}?room=${room.code}&session=${room.id}`;
    const qr = await QRCode.toDataURL(guestUrl, { width: 480, margin: 1 });
    res.set("Cache-Control", "no-store").json({ ...memberInfo(req.member), guestUrl, qr,
      filterOn: room.filterOn, moderationMode: room.moderationMode, primaryAdminId: room.primaryAdminId,
      moderationConfigured: false, defaultRegion: DEFAULT_REGION, defaultLocale: DEFAULT_LOCALE });
  } catch {
    res.status(500).json({ error: "สร้าง QR ไม่สำเร็จ กรุณาลองใหม่" });
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
    res.status(502).json({ error: "โหลดเพลงไม่สำเร็จ กรุณาลองใหม่" });
  }
});

// Cooldown belongs to each room, including independent requests behind venue NAT.
function pruneLastRequestAt(room) {
  if (room.lastRequestAt.size <= 500) return;
  const cutoff = Date.now() - room.cooldownSeconds * 1000;
  for (const [key, at] of room.lastRequestAt) {
    if (at < cutoff) room.lastRequestAt.delete(key);
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
    res.status(502).json({ error: "ค้นหาไม่สำเร็จ กรุณาลองใหม่" });
  }
});

// Guest requests a song.
app.post("/api/request", requireMember, async (req, res) => {
  const room = req.member.room;
  const { state, cooldownSeconds, lastRequestAt } = room;
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
  // YouTube — that's what the cooldown protects.
  lastRequestAt.set(floodKey, Date.now());
  pruneLastRequestAt(room);

  // 1. Is the video actually playable?
  const playable = await checkPlayable(videoId);
  if (!playable.ok) {
    return res.json({ ok: false, reason: playable.reason });
  }

  if (sessions.authenticate(req.member.token) !== req.member) {
    return res.status(401).json({ code: "SESSION_INVALID", error: "ห้องหมดอายุหรือไม่มีสิทธิ์เข้าห้อง" });
  }

  // Recheck after network work: simultaneous requests can otherwise bypass guardrails.
  if (state.has(videoId)) return res.json({ ok: false, reason: "เพลงนี้อยู่ในคิวแล้ว" });
  if (state.queue.length >= MAX_QUEUE_LENGTH) return res.json({ ok: false, reason: "คิวเพลงเต็ม กรุณาลองใหม่ภายหลัง" });

  // 2. Enqueue.
  const { item, position } = state.add({ videoId, title, channel, duration, thumbnail, addedBy: name });
  res.json({ ok: true, reason: "เพิ่มเข้าคิวแล้ว", position, id: item.id });
});

// Cloudflare overrides our no-cache with a 4h browser TTL on .js/.css, which
// left open pages running stale scripts after a deploy. Versioning the asset
// URLs busts that: each boot (= each deploy) points the HTML at fresh URLs.
const BOOT_ID = Date.now().toString(36);
function versionedPage(name) {
  return readFileSync(path.join(__dirname, "public", name), "utf8").replace(
    /(href|src)="\/((?:guest|host|admin|i18n|session|pwa)\.(?:css|js))"/g,
    `$1="/$2?v=${BOOT_ID}"`
  );
}
const HOST_PAGE = versionedPage("host.html");
const GUEST_PAGE = versionedPage("guest.html");
const ADMIN_PAGE = versionedPage("admin.html");
app.get("/a", (_req, res) => res.set("Cache-Control", "no-cache").type("html").send(ADMIN_PAGE));
app.get(["/admin", "/admin.html"], (req, res) => res.redirect(302, req.originalUrl.replace(/^\/admin(?:\.html)?/, "/a")));
app.get(["/", "/host.html"], (_req, res) => res.set("Cache-Control", "no-cache").type("html").send(HOST_PAGE));
app.get("/g", (req, res) => res.redirect(302, req.originalUrl.replace(/^\/g\/?(?=\?|$)/i, "/guest")));
app.get(["/guest", "/guest.html", "/explore"], (_req, res) => res.set("Cache-Control", "no-cache").type("html").send(GUEST_PAGE));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

// --- WebSocket: real-time queue sync + host controls ---------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function stateMessage(room, member) {
  const online = new Set([...room.clients].map(client => client.member?.id));
  return JSON.stringify({
    type: "state", state: room.state.snapshot(), sessionId: room.id, code: room.code,
    filterOn: room.filterOn, moderationMode: room.moderationMode,
    cooldownSeconds: room.cooldownSeconds, eventContext: room.eventContext,
    primaryAdminId: room.primaryAdminId, memberId: member.id, role: member.role,
    ...(member.role === "admin" ? { participants: [...room.members.values()].map(person => ({
      id: person.id, name: person.name, role: person.role, online: online.has(person.id),
    })) } : {}),
  });
}
function broadcastState(room) {
  for (const client of room.clients) {
    if (client.readyState === 1 && sessions.authenticate(client.member?.token) === client.member) {
      client.send(stateMessage(room, client.member));
    }
  }
}

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });
  ws.on("close", () => sessions.detach(ws));
  ws.on("error", () => sessions.detach(ws));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.type === "auth") {
      const member = sessions.authenticate(msg.token, msg.sessionId);
      sessions.detach(ws);
      if (!member) {
        ws.send(JSON.stringify({ type: "auth", ok: false, error: "ห้องหมดอายุหรือไม่มีสิทธิ์เข้าห้อง" }));
        return;
      }
      // A second tab on the same Player must not become a second audio source.
      if (member.role === "player") {
        for (const other of [...member.room.clients]) {
          if (other.member?.token === member.token) {
            other.send(JSON.stringify({ type: "sessionEnded", code: "PLAYER_MOVED", error: "เปิด Player ในหน้าใหม่แล้ว" }));
            sessions.detach(other);
            other.close(4001, "Player replaced");
          }
        }
      }
      if (member.role !== "player" && typeof msg.name === "string" && msg.name.trim()) member.name = msg.name.trim().slice(0, 40);
      // Reconcile tracks consumed from the Player's last snapshot while offline.
      // Item IDs prevent replay from skipping a later request for the same video.
      if (member.role === "player" && Array.isArray(msg.completed) && msg.completed.length <= 51) {
        for (const item of msg.completed) {
          if (item && typeof item.id === "string" && typeof item.videoId === "string" &&
              typeof item.failed === "boolean" && member.room.state.nowPlaying?.id === item.id &&
              member.room.state.nowPlaying.videoId === item.videoId) {
            member.room.state.advance(item.videoId, item.failed);
          }
        }
      }
      sessions.attach(ws, member);
      ws.send(JSON.stringify({ type: "auth", ok: true, role: member.role }));
      broadcastState(member.room);
      return;
    }
    const member = sessions.authenticate(ws.member?.token);
    if (!member || member !== ws.member || member.role === "guest" ||
        (["ended", "error"].includes(msg.type) && member.role !== "player") ||
        (["setParticipantRole", "setFilter", "setCooldown"].includes(msg.type) &&
          (msg.type === "setParticipantRole" ? member.role !== "admin" : !["admin", "controller"].includes(member.role)))) {
      ws.send(JSON.stringify({ type: "error", error: "ไม่มีสิทธิ์ควบคุมเพลง" }));
      return;
    }
    const room = member.room;
    const state = room.state;
    switch (msg.type) {
      case "ended": // host player finished a track
      case "error": // host player couldn't play (embed-disabled/region-locked)
        if (typeof msg.videoId === "string") state.advance(msg.videoId, msg.type === "error");
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
          ws.send(stateMessage(room, member));
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
      case "setAutoQueue":
        state.setAutoQueue(msg.enabled);
        break;
      case "setParticipantRole": {
        const target = room.members.get(msg.id);
        if (typeof msg.enabled !== "boolean" || !target || target.role === "player" || target.id === room.primaryAdminId) {
          ws.send(JSON.stringify({ type: "error", error: "ไม่สามารถเปลี่ยนสิทธิ์ผู้เข้าร่วมนี้ได้" }));
          break;
        }
        target.role = msg.enabled ? "controller" : "guest";
        broadcastState(room);
        break;
      }
      case "setFilter":
        if (typeof msg.on !== "boolean") break;
        // Legacy clients receive the disabled state; AI stays paused.
        broadcastState(room);
        break;
      case "setCooldown": {
        if (typeof msg.seconds !== "number") break;
        const seconds = Math.round(msg.seconds);
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 300) {
          room.cooldownSeconds = seconds;
          broadcastState(room);
        }
        break;
      }
      case "setEventContext":
        if (typeof msg.context !== "string") break;
        room.eventContext = msg.context.slice(0, 300);
        broadcastState(room);
        break;
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      sessions.detach(ws);
      ws.terminate();
    } else {
      ws.alive = false;
      ws.ping();
    }
  }
}, 30000).unref();
setInterval(() => {
  sessions.prune();
  for (const [ip, entry] of failedAttempts) {
    if (Date.now() - entry.at >= 60000) failedAttempts.delete(ip);
  }
}, 60000).unref();

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: "คำขอไม่ถูกต้องหรือระบบขัดข้อง กรุณาลองใหม่" });
});
server.listen(PORT, "0.0.0.0");
