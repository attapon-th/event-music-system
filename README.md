<div align="center">

# 🎶 Event Music System

**Turn any projector into a crowd-powered jukebox.**

Guests scan a QR code, search YouTube from their phones, and queue songs.
The music plays on the big screen — with an optional AI DJ that keeps requests
fit for the occasion, whatever the occasion is.

[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![No API keys required](https://img.shields.io/badge/YouTube%20API%20key-not%20needed-red)](#how-it-works)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker-blue?logo=docker&logoColor=white)](#run-on-a-home-server-docker--reverse-proxy)

<img src="docs/host.png" alt="Projector screen — now playing with QR code and live queue" width="100%" />

<em>The projected host screen: player, scan-to-add QR, live queue with requester credits.</em>

</div>

## Why this exists

Party playlists die in one of two ways: one person DJs all night, or an
unmoderated queue fills with memes and worse. This is the middle path — every
guest can add songs from their own phone in seconds (no app, no account), while
the host keeps light-touch control: skip, remove, rate-limit, and an optional
LLM filter that understands *"this is a school dinner"* vs *"this is a
nightclub"* and judges requests accordingly.

Built for a real graduation dinner in Hong Kong; designed to work for any event.

## Features

- 📱 **Zero-friction requests** — scan QR → search → tap. No app, no login.
- 🔑 **No YouTube API key** — search scrapes the public results page; playback
  uses the standard embedded player.
- 🎤 **KTV-style explore** — genre tabs (K-pop, Cantopop, Mandopop, Western,
  party, Thai pop, classics) — Thailand charts load first (TH/th-TH) and singer chips with live, real results — guests who
  don't know what to pick just tap.
- 🤖 **AI content filter (optional)** — any OpenAI-compatible LLM judges each
  request against *your event*, enriched with the video's YouTube category,
  family-safe flag, and description. Three modes cycled from the host page:
  **off / on / strict**. Fails open on outages — moderation can never stop the
  music.
- 🎛 **Host controls, live** — play/pause/skip, volume, remove tracks, per-guest
  request cooldown, filter mode, and the event description fed to the AI — all
  from the projected page. Each room has independent settings, queue and playback, held only in memory.
- 🔒 **Rooms** — three-digit codes and direct QR entry. `HOST_PASSWORD` creates rooms, only. The first Admin assigns/revokes Controller rights. Guest/Admin join by room number.
- 🛡 **Queue guardrails** — duplicate rejection, per-phone cooldown (works
  behind venue NAT), 50-song cap, playability pre-check, and a watchdog that
  skips videos that fail to start.
- ⚡ **Live everything** — room-scoped WebSocket broadcasts keep each projector and its
  phones in sync; guests see a "คุณ" badge on their own songs.

<div align="center">
<img src="docs/guest.png" alt="Guest phone page — explore, search, and queue" width="330" />

<em>The guest page on a phone: Thai nickname, search, singer chips, one-tap requests.</em>
</div>

## Quick start

```bash
git clone https://github.com/attapon-th/event-music-system.git
cd event-music-system
bun install
cp .env.example .env      # set HOST_PASSWORD; the AI filter is off
bun start
```

Open **http://localhost:45416/** on the machine, drag it to the projector, and
create a room using **รหัสสร้าง** (`HOST_PASSWORD`); the Player opens immediately. If the browser blocks audio, use its existing play button. Guests scan the on-screen QR or enter its three-digit code.

> Node ≥ 20 works too (`npm install && npm start`), but Bun is what the Docker
> image and scripts use.

## How it works

```
   Projector (laptop / server)        Guests' phones
  ┌────────────────────┐             ┌──────────────┐
  │  ▶ Now Playing     │   scan QR   │  🔍 search   │
  │  [ YouTube video ] │  ◀───────▶  │  + add song  │
  │  ▣ QR   Up Next ▤▤ │   Wi-Fi     │  live queue  │
  └────────────────────┘             └──────────────┘
            │ audio out → venue AV system
```

| Path | Purpose |
|------|---------|
| `/` | Create a new room only, then show its Player immediately |
| `/guest` | Mobile page guests open via the QR |
| `/explore` | Alias of the Guest page with Thailand charts on first load |
| `/a` | Admin/Controller controls, queue editing and participant roster |
| `POST /api/sessions` | `{ password }` → new room and Player credential |
| `POST /api/sessions/join` | `{ code, sessionId? }` → Guest membership; reuses a valid member credential |
| `POST /api/sessions/admin/claim` | First Guest claimant becomes the primary Admin |
| `POST /api/sessions/close` | Player credential → delete room and disconnect everyone |
| `GET /api/search?q=&mode=songs\|karaoke\|videos` | YouTube Music songs, karaoke or music videos (no API key) |
| `GET /api/browse?q=` | Cached, singles-only search behind the explore tabs |
| `POST /api/request` | Room member credential → guardrails → playability check → (optional AI filter) → enqueue |
| WebSocket `/` | Authenticate first; room-scoped state and authorized controls |

The **server owns a queue per room** (`src/state.js`, `src/sessions.js`). The
Player reports completion/errors so that its room advances and broadcasts.
Everything is in memory: queue, history, settings, admission and credentials.
Rooms expire after the last connection has been gone for 60 minutes. A connected
idle page keeps its room alive; heartbeat detects dead connections. A restart
clears every room. Run one server process, with at most 900 concurrent rooms.

Application stdout contains only JSON `created` / `deleted` records with `at`,
`room`, and `sessionId`. The app writes no session or log files. Existing
`data/settings.json` is ignored and the Compose settings volume is removed.

Request pipeline: flood control → duplicate/cap checks → oEmbed playability
check → optional LLM verdict → enqueue. Embed-disabled or region-locked videos
that slip through are auto-skipped by the player (iframe error codes + a 20s
never-started watchdog).

## The AI filter

Off by default; cycle it from the host page (🛡 過濾 pill): **off → on →
strict**. It works with any **OpenAI-compatible** chat API — OpenRouter,
Kimi/Moonshot, DeepSeek, GLM… swap providers by changing three `.env` values,
no code changes:

```ini
LLM_API_KEY=sk-...
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=deepseek/deepseek-v4-flash
```

Verify a key and list models with `bun run check-llm`.

**Context-aware, not puritanical.** Tell it what the event is (場景 button on
the host page — e.g. *"a wedding banquet"*, *"a nightclub party"*) and it sets
the bar accordingly: explicit mainstream tracks pass at a club but not at a
school dinner; national anthems and protest songs get caught at ordinary social
events. **Strict** mode ignores the venue and allows family-friendly music only.

Failure design worth knowing:

- **Fails open** on infrastructure problems (no key, HTTP error, network error) — an
  outage never stops the party.
- **Fails closed on timeout** with a retryable Thai message.
- **Fails closed** when the model answers but dodges the question (provider
  content-filter, no structured verdict) — evasion is treated as a rejection.

> The filter reads title, channel, category, and description — not the audio.
> By default it catches non-music and explicit metadata, not explicit lyrics
> hidden under a clean title. On OpenRouter, set `LLM_WEB_SEARCH=true` to close
> that gap: the model web-searches each song and judges the actual lyrics
> (~$0.005 per moderated request, a few seconds slower).

## Run on a home server (Docker + reverse proxy)

The server builds the image itself from source — no registry, no logins:

```bash
git clone https://github.com/attapon-th/event-music-system.git
cd event-music-system
cp .env.example .env          # set PUBLIC_URL to your domain, HOST_PASSWORD too
docker compose up -d --build
```

The container joins the external `reverseproxy` Docker network and exposes port
`45416`. Point your reverse proxy at `event-music:45416`, set `PUBLIC_URL` to
your domain (the QR code guests scan uses it), and make sure the proxy forwards
**WebSocket upgrades**. All rooms and settings are temporary; no data volume is needed.

> The `reverseproxy` network must already exist (it does if your proxy created
> it). If not: `docker network create reverseproxy`.

### Keeping it updated

**Push-to-deploy (recommended)** — a self-hosted GitHub Actions runner rebuilds
on every push to `main` (`.github/workflows/deploy.yml`). One-time setup:

1. **Register the runner** — repo → **Settings → Actions → Runners → New
   self-hosted runner**, pick Linux, run the shown commands on the home server
   as the user that owns your clone, then `sudo ./svc.sh install <youruser> &&
   sudo ./svc.sh start`.
2. **Docker access** — `sudo usermod -aG docker <youruser>` (re-login after).
3. **Clone location** — the workflow deploys `~/event-music-system` by default;
   set a repo Variable `DEPLOY_DIR` if yours lives elsewhere.

**Manual** — `git pull && docker compose up -d --build` whenever you like.
**Cron** — `update.sh` pulls and rebuilds only when something changed (use the
runner *or* cron, not both).

> **Security note:** self-hosted runners + a public repo need care. This
> workflow triggers only on direct pushes to `main` and manual dispatch — never
> on `pull_request` — so forks can't execute code on your runner. Keep it that
> way.

## ⚠️ The #1 thing that breaks at events: the network

Guests' phones must be able to reach the server. Many **venue/guest Wi-Fi
networks block device-to-device traffic** ("client isolation"), so the QR code
loads nothing even though everything is configured correctly.

Reliable fixes (pick one):

- **Host it publicly** behind a domain (the Docker setup above) — phones use
  their own data; nothing to debug at the venue.
- **Run your own hotspot** and have guests join it.
- **Bring a travel router** and put everyone on its network.

The host machine always needs internet for YouTube playback.

## Configuration

Everything lives in `.env` (see [`.env.example`](.env.example) for the full,
commented list). The highlights:

| Variable | What it does |
|----------|--------------|
| `PUBLIC_URL` | Public address the QR code points to (behind a reverse proxy) |
| `HOST_PASSWORD` | Creation password; empty disables new rooms |
| `DEFAULT_REGION` | YouTube search/chart country, fallback `TH` |
| `DEFAULT_LOCALE` | YouTube language/locale, fallback `th-TH` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | Any OpenAI-compatible provider for the filter |
| `EVENT_CONTEXT` | Initial event description for the AI (editable live) |
| `PORT` | Listen port (default `45416`) |

Filter state, moderation mode, and cooldown are editable from Admin/Controller;
event context is editable from Player. `.env` seeds each new room; changes last
only for that Session.

## Project layout

```
server.js                  Express + room-scoped WebSocket API and request pipeline
src/youtube.js             No-key search scraping, oEmbed check, watch-page details
src/moderation.js          LLM content filter (OpenAI-compatible, fail-open)
src/state.js               Authoritative in-memory queue
src/sessions.js            Room lifecycle and credentials
src/net.js                 LAN IP detection
public/host.*              Projector page (player, QR, controls)
public/guest.*             Mobile page (search, explore, live queue)
public/admin.*             Authorized room controls and queue drag/drop
public/session.*           Shared entry forms, credentials and reconnects
public/i18n.js             Shared Thai UI dictionary + interpolation
scripts/test.mjs           HTTP/WebSocket integration checks (isolated temporary server)
scripts/check-llm.mjs      Verify LLM key + list models
Dockerfile                 Bun-based image
docker-compose.yml         Home-server deployment (builds locally)
update.sh                  Cron alternative: pull + rebuild if changed
```

No frameworks, no build step, three dependencies (`express`, `ws`, `qrcode`).


## ใช้งานระบบเพลงส่วนกลาง

ตั้งค่าใน `.env` ก่อนเปิด Player/Admin:

```ini
HOST_PASSWORD=your-password
DEFAULT_REGION=TH
DEFAULT_LOCALE=th-TH
```

เปิด `/` บน TV/TV Box กรอก **รหัสสร้าง** (`HOST_PASSWORD`) เพื่อสร้างห้องใหม่เท่านั้น
เมื่อสร้างสำเร็จ Player เปิดและเริ่มเล่นอัตโนมัติ ไม่มีหน้าเริ่มเล่นแยก
หาก browser บล็อกเสียง ให้กดปุ่มเล่นเดิม; ระบบไม่ข้ามเพลงเพราะถูกบล็อก autoplay
ห้องมีเลข 3 หลัก (`100–999`) และ QR ผู้ฟัง scan QR เข้าห้องทันที
หรือเปิด `/guest` กรอกเลขห้องโดยไม่ต้องเลือกบทบาท ไม่มีการรับช่วง Player ห้องเดิม

Guest คนที่กด **รับสิทธิ์ Admin** ก่อนสำเร็จเป็น **ผู้ดูแลหลัก** และเข้าหน้า `/a`
เฉพาะผู้ดูแลหลักเท่านั้นที่ให้หรือถอนสิทธิ์ **ผู้ช่วยควบคุม (Controller)** ผ่านแท็บผู้เข้าร่วม
Controller ควบคุมเพลงและการตั้งค่าได้ แต่เปลี่ยนสิทธิ์คนอื่นไม่ได้
เมื่อได้รับสิทธิ์ browser เปลี่ยนไป `/a` ทันที; เมื่อถูกถอนกลับ `/guest` ทันที
รายชื่อเก็บทุกคนที่เคยเข้าห้องจนห้องจบ พร้อมสถานะออนไลน์/ออฟไลน์
ชื่อเล่นใช้แสดงผลเท่านั้น สิทธิ์ตรวจด้วยกุญแจที่ server ออกให้

Player ซ่อน/แสดงการ์ด QR ได้ และแสดงใต้ QR เป็น `ห้อง {rn} · yt1.lkzlab.uk/guest`
ตัวกรองกับเวลารออยู่ในหน้า `/a` ปุ่ม **ออก** ถัดจากประเภทงานปิดห้องทันที
และพาทุกคนกลับฟอร์มเลขห้อง (Player กลับฟอร์มสร้างห้องใหม่)

ข้อมูลทุกห้องอยู่ใน memory ของ server ลบหลังไม่มีอุปกรณ์เชื่อมต่อครบ 60 นาที
หรือหายเมื่อ restart หน้า Guest/Admin จะแสดงฟอร์มเลขห้องเมื่อห้องหมดอายุ
หากเพียงเน็ตหลุดจะเชื่อมต่อห้องเดิมใหม่ Browser เก็บกุญแจเฉพาะห้องไว้กลับเข้า
กุญแจและ QR ของ session เก่าใช้เข้าห้องใหม่ที่ได้เลขซ้ำไม่ได้

หน้า Host ใช้ลูกศรรีโมตเลือกปุ่มและกด **OK/Enter** ได้ (ปุ่มเล่น/หยุดถูกเลือกไว้แล้ว)
ปรับเสียงด้วยซ้าย/ขวาขณะเลือกแถบเสียง ใช้ขึ้น/ลงเพื่อออกจากแถบเสียง
ปุ่มมุมขวาบนวิดีโอหรือ **F** เปิดวิดีโอเต็มจอ กด **OK** ที่ปุ่มเดิมหรือ **Back/Esc** เพื่อกลับ layout เดิม
Browser ที่ไม่มี Fullscreen API จะขยายวิดีโอเต็มพื้นที่หน้าเว็บแทน รองรับปุ่มสื่อเล่น/หยุดและข้ามเพลงด้วย
Guest แยก **ค้นหาเพลง** และ **คิวเพลง** เป็นคนละแท็บ; หน้า `/a` เพิ่มแท็บผู้เข้าร่วม โดยคิวยังอัปเดตสดขณะอยู่แท็บค้นหา
กดปุ่มโหมด **วิดีโอเพลง / คาราโอเกะ / เพลง** ได้ในแท็บค้นหา โดย Guest/Admin เริ่มต้นที่ **วิดีโอเพลง**: เพลงใช้ YouTube Music หมวด Songs
ส่วนคาราโอเกะใช้วิดีโอ YouTube และเติมคำว่า `karaoke` หากคำค้นยังไม่มีคำนี้หรือ “คาราโอเกะ”
วิดีโอเพลงค้นหาวิดีโอ YouTube โดยเติม `official music video` หากยังไม่ได้ระบุในคำค้น
Guest และ Admin มีเพลงแนะนำ หมวดเพลง ปุ่มศิลปิน และปุ่มสุ่มเหมือนกัน ใช้โหมดที่เลือกด้วย ทุกโหมดเพิ่มเข้าคิวของห้องเดียวกันและเล่นบน Player ของห้องนั้น
`/api/search` และ `/api/browse` รองรับ `mode=songs` (ค่าเริ่มต้น) หรือ `mode=karaoke` / `mode=videos`

Guest/Admin สุ่มชื่อเล่นภาษาไทยจาก 100 ชื่อ เก็บไว้ใน browser และแสดง “เพิ่มเพลง โดย {nickname}”
ชื่อเล่นนี้ส่งเป็นชื่อผู้เพิ่มเพลงโดยไม่ต้องกรอกเอง ผลค้นหาและเพลงแนะนำแสดงครั้งละ 5 เพลง
กด **เพลงเพิ่มเติม** เพื่อแสดงเพิ่มอีกไม่เกิน 5 เพลง คิวเพลงยังแสดงครบ
ค้นหาเพลงต่างประเทศได้ตามปกติ ชาร์ตประเทศเลือกจาก YouTube ตาม `DEFAULT_REGION`
UI ใช้ภาษาไทยเป็นหลักและอังกฤษเป็นคำรอง ไม่มีข้อความจีนใน UI ที่กำหนดไว้
ข้อความอยู่ใน `public/i18n.js` และใช้ชื่อศิลปินอังกฤษในปุ่มแนะนำ
ชื่อเพลงและข้อมูลศิลปินจาก YouTube แสดงตามต้นฉบับ

Admin แสดงชื่อเพลง รูป ระยะเวลาและชื่อผู้เพิ่ม รองรับลากจัดลำดับด้วยเมาส์/สัมผัส
และมีปุ่มเลื่อนขึ้น/ลงสำหรับคีย์บอร์ด **ล้างคิว** ลบเฉพาะเพลงที่รอ
**เล่นตอนนี้** เปลี่ยนเพลงปัจจุบันเป็นเพลงที่เลือก และเก็บเพลงที่เหลือไว้ตามลำดับเดิม
รีเฟรชหน้าแล้วรับ snapshot ปัจจุบันจาก server ทันที แต่ restart server จะล้าง queue
รวมถึงข้อมูลห้องและการตั้งค่าทั้งหมด แต่ละห้องใช้ Player หนึ่งเครื่องเป็นแหล่งเสียง

### API และ WebSocket

ใช้ HTTP API เดิมสำหรับค้นหา/เพิ่มเพลง ไม่มี Admin queue REST API แยกชุด
`/api/info` เพิ่ม `defaultRegion` และ `defaultLocale` ส่วน `/api/browse?q=__hits`
โหลดชาร์ตประเทศ (`__hk_hits` ยังรองรับสำหรับ client เดิมและใช้ประเทศที่ตั้งค่า)

Room APIs คืน `{ code, sessionId, token, role, memberId }` โดยไม่ใช้ `/api/host-token` หรือ Basic Auth
ส่ง `Authorization: Bearer TOKEN` สำหรับ `/api/info`, `/api/request`, การรับ Admin และการปิดห้อง
ส่ง `X-Session-Id` เพิ่มได้เพื่อยืนยันว่ากุญแจตรงกับห้องที่ต้องการ
การกรอกเลขหรือรหัสผิดรวม 10 ครั้งต่อนาทีต่อ IP จะถูกปฏิเสธชั่วคราวด้วย HTTP 429

WebSocket `/` ต้องส่ง `{ "type": "auth", "token": "...", "sessionId": "..." }`
ก่อนอ่านคิวหรือควบคุม server ตอบ `{ "type": "auth", "ok": true, "role": "guest|admin|controller|player" }`
แล้วส่ง snapshot ของห้อง ทุกคำสั่งตรวจสิทธิ์บน server; Guest อ่านคิวได้อย่างเดียว
Admin/Controller/Player ควบคุมคิวได้ แต่ `ended`/`error` จาก client ใช้ได้เฉพาะ Player

| Event | Payload / ผลลัพธ์ |
| --- | --- |
| `state` | `{ state, code, sessionId, role, memberId, primaryAdminId, filterOn, moderationMode, cooldownSeconds, eventContext }`; Admin/Controller มี `participants` |
| `setParticipantRole` | ผู้ดูแลหลักส่ง `{ id: participantId, enabled: true/false }` เพื่อให้/ถอนสิทธิ์ Controller |
| `sessionEnded` | ปิดห้อง (`ROOM_CLOSED`) หรือย้าย Player ไปแท็บใหม่ (`PLAYER_MOVED`) |
| `reorder` | `{ ids: [queueItemId, ...] }` ต้องเป็น ID ครบทุกเพลง ห้ามซ้ำ; stale order ถูกปฏิเสธ |
| `clear` | ล้างเพลงที่รอทั้งหมด |
| `playNow` | `{ id }` เปลี่ยนไปเล่นเพลงในคิวทันที |
| `play` / `pause` | เปลี่ยนสถานะการเล่น แล้ว Player ใช้ IFrame API ตาม snapshot |
| `setVolume` | `{ volume: 0–100 }` ปรับเสียง Player ของห้องผ่าน snapshot |
| `skip`, `remove`, `move` | Event เดิม; `remove` ใช้ `{ id }`, `move` ใช้ `{ id, dir: "up"/"down" }` |
| `ended`, `error` | Event เดิมจาก Player; ข้ามเฉพาะเมื่อ `videoId` ตรงกับเพลงปัจจุบัน |
| `error` (server → client) | `{ error: "ข้อความ" }` เมื่อไม่มีสิทธิ์หรือ reorder จาก queue เก่า |

### ทดสอบ

```bash
bun install
bun run test
```

ใช้ Node assertions และ HTTP/WebSocket จริงใน directory ชั่วคราว จำลองเฉพาะ YouTube
ตรวจลำดับโหลด YouTube API ของ Host ด้วย: ลงทะเบียน callback ก่อนโหลด API
เพื่อให้ Player เริ่มเล่นได้แม้ API โหลดเร็วจาก cache (ทดสอบนี้จำลอง Player)
รวมการเลือกปุ่มด้วยรีโมต, OK, ปุ่มสื่อ และเต็มจอแบบ native/fallback โดยจำลอง DOM และ Fullscreen API
ไม่แตะ `.env`, queue หรือ settings ของระบบที่กำลังใช้งาน ครอบคลุมการเพิ่มเพลง, sync
Admin/Player/Guest, reorder, ลบ, clear, play now, play/pause/skip/volume,
refresh/reconnect, สิทธิ์ผู้ใช้/กรณีไม่ตั้ง password, input validation,
คำขอเพลงซ้ำพร้อมกัน และ country/locale ที่ส่งไป YouTube
รวมหลายห้อง รับ Admin พร้อมกัน ให้/ถอน Controller กลับเข้า ปิดห้อง เลขซ้ำ ห้องเต็ม
หมดอายุ connection ที่ไม่ตอบ heartbeat คำขอที่ค้างตอนหมดอายุ และ log เฉพาะสร้าง/ลบห้อง

ตรวจบน browser/TV จริงหลังตั้งค่า:

1. สร้างสองห้อง ตรวจ Player เปิดทันที Scan QR และรับสิทธิ์ Admin ในแต่ละห้อง ตรวจว่าคิวไม่ปะปน
2. Guest ค้นหาและเพิ่ม 4 เพลง: เพลงแรกเริ่มเล่น และ Admin เห็นเพลงที่เหลือทันที
3. ลาก queue บน Admin แล้วตรวจ Guest/Player ว่าแสดงลำดับเดียวกัน
4. ลบเพลงหนึ่งรายการ แล้วกดเล่นตอนนี้กับเพลงที่รอ: Player ต้องเปลี่ยนเพลง
5. กดหยุดชั่วคราว/เล่น/ข้าม และปรับเสียง: ตรวจเสียงกับภาพที่ TV
6. รีเฟรช Admin: เพลง คิว สถานะ pause และ volume ต้องเหมือนเดิม
7. ล้างคิว: Guest เห็นคิวว่าง โดยเพลงปัจจุบันยังเล่นต่อ
8. เปิด Guest/Admin โดยไม่มีห้องต้องเห็นฟอร์มเลขห้อง; WebSocket ไม่มี token ต้องไม่เห็นคิวหรือควบคุมได้
   ผู้ดูแลหลักให้/ถอน Controller ผ่านรายชื่อ ตรวจ redirect และ Controller ให้สิทธิ์คนอื่นไม่ได้
9. เข้า `/explore` ของห้อง: โหลดชาร์ตประเทศไทยก่อน และยังค้นหาเพลงสากลได้
   กดออกบน Player ตรวจว่าห้องถูกปิด ทุก Guest/Controller กลับฟอร์มเลขห้อง และ Player กลับฟอร์มสร้าง
10. ตรวจ Docker ในเครื่องทดสอบ: `docker compose config --quiet` และ
    `docker compose up -d --build` (ต้องมี network `reverseproxy` เดิม)
11. บน TV Box ตรวจเริ่มเล่นอัตโนมัติ; หาก browser บล็อกเสียง ใช้ปุ่มเล่นเดิม
    เลื่อนด้วยลูกศรไปเล่น/ข้าม/เสียง/ลบเพลง
    กรอบโฟกัสต้องเห็นชัดและยังอยู่เมื่อคิวอัปเดต เข้าเต็มจอแล้วกด Back หรือ OK เพื่อออก
    ตรวจว่าภาพกับเสียงเล่นต่อและ layout ปกติกลับมาเหมือนเดิม

YouTube IFrame อาจจำกัด autoplay/การฝังหรือการเล่นตามประเทศ ต้องตรวจเสียงจริงบน TV/TV Box
เมื่อใช้งาน Browser automation ที่จำลอง IFrame จะยืนยันได้เฉพาะคำสั่งที่ส่งให้ Player

## เครดิตผู้สร้าง

โปรเจกต์นี้พัฒนาต่อจาก [Event Music System](https://github.com/Hangton-Code/event-music-system)
โดย [Hangton (Hangton-Code)](https://github.com/Hangton-Code) ผู้สร้างต้นฉบับ
ขอขอบคุณสำหรับ source code และระบบพื้นฐานที่เผยแพร่ภายใต้ MIT License

Repository ของเวอร์ชันนี้: [attapon-th/event-music-system](https://github.com/attapon-th/event-music-system)

## License

[MIT](LICENSE) — party responsibly. 🎉
