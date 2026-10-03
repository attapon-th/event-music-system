# Agent guide

Maintain independent temporary jukebox rooms: each has one designated TV/TV Box
Player, guests requesting songs, and authorized admins managing playback.
Extend the existing implementation and preserve that workflow.

Read [CONTEXT.md](CONTEXT.md) when naming or changing domain concepts. Read
[README.md](README.md) for configuration, HTTP/WebSocket payloads, and the
manual test procedure.

## Working sequence

1. Inspect the relevant page, server handler, state method, and their callers
   before choosing a change. Check the working tree and preserve unrelated edits.
2. Reuse the existing state, request pipeline, and broadcasts. Prefer native
   browser features and installed dependencies; keep changes within the current
   Vanilla JS/Express architecture.
3. Run the checks below that exercise the changed behavior. Report results and
   distinguish simulated YouTube behavior from real playback verification.
4. Update the glossary when terminology changes, and README/configuration
   examples when user-visible behavior, settings, or protocol changes.

## Architecture and change locations

The app uses JavaScript ES modules, Express, `ws`, and `qrcode`, with plain
HTML/CSS/browser scripts. Bun is the deployment runtime; package scripts use Node.
There is no frontend bundler or compilation step.

| Location | Responsibility |
| --- | --- |
| `server.js` | Environment loading, authentication, HTTP request pipeline, room-scoped WebSocket dispatch/broadcast |
| `src/sessions.js` | Room lifecycle, membership and roles and in-memory credentials |
| `src/state.js` | `JukeboxState`: authoritative queue, current track, history, pause state, volume |
| `src/youtube.js` | YouTube search/video recommendations, country charts, oEmbed checks, watch-page metadata |
| `src/moderation.js` | Retained LLM content filter; paused and outside current development |
| `public/host.*` | Player at `/`: YouTube IFrame, welcome entry, QR visibility and room exit |
| `public/guest.*` | Public search, Explore, song requests, queue display at `/guest` and `/explore` |
| `public/admin.*` | Authorized remote controls and queue editing at `/a`; reuses Guest search/request scripts |
| `public/i18n.js` | Shared UI dictionary and `t()` interpolation |
| `scripts/test.mjs` | Isolated HTTP/WebSocket integration checks using Node assertions |

## State and authorization invariants

- Each live Session owns a `JukeboxState`. Browser snapshots are views; queue changes
  go through its methods and `onChange` broadcasts a full snapshot to all clients.
- `queue` contains upcoming tracks only. `clear()` leaves the current track
  playing; `playNow(id)` replaces it with the selected queued item and retains
  the relative order of the other queued items.
- Reorder accepts a complete permutation of the current queue item IDs. Reject
  incomplete, duplicate, or obsolete ID sets so concurrent requests cannot disappear.
- Use queue item `id` for editing and YouTube `videoId` for duplicate detection
  and completion reports. Preserve the stale `ended`/`error` guard.
- Recheck duplicate and queue-cap conditions after asynchronous YouTube
  work. The request limit is 50 upcoming tracks; history is capped at 100 items.
- Playback state and volume belong to the server snapshot. Player applies them
  through the IFrame API; Admin remains a controller rather than an audio source.
  New rooms start at 60% volume, applied before loading the first video, with
  Auto Queue enabled and a five-second request cooldown.
- `HOST_PASSWORD` authorizes room creation and contains only ASCII digits, at least
  four digits; invalid configuration exits before listening. Existing nonnumeric
  passwords must be replaced before restarting. Root entry displays digits openly
  in a text input with a numeric keyboard hint and accepts either this password or
  a three-digit room number using the existing join API. Keep credentials as strings
  to preserve leading zeros. Failed entry
  locks browser submission for five seconds; HTTP 429 carries the remaining retry time.
- Every WebSocket authenticates a room credential before receiving a snapshot.
  The first participant joining by room number or QR becomes the primary Admin
  atomically during admission and opens `/a`. Later participants are Guests;
  re-entry preserves existing roles, including an offline Admin's authority.
  Check membership on every command; only Player reports completion/errors, and
  only the primary Admin grants/revokes Controller rights. Controllers manage playback
  and settings. Only the primary Admin receives the participant roster and tab.
  Role changes update keyboard tab navigation and trigger role redirects.
- All room data is in memory. Last-disconnect starts the 60-minute idle deadline;
  live connections cancel it, heartbeat removes dead ones, and restart clears all rooms.
  Seed each room's settings from environment defaults. stdout logs only create/delete.
- Room numbers may be reused; internal session IDs and credentials must prevent old
  links or credentials entering a replacement room. Player exit deletes the room immediately.

## Integration and UI details

- Keep the request sequence: validation/cooldown/duplicate/cap checks → playability
  check → final duplicate/cap checks → enqueue/broadcast.
  Cooldown uses IP plus a client-chosen device ID, not authenticated guest identity.
- Songs use the internal YouTube Music InnerTube Songs endpoint without an API key.
  Video search uses regular YouTube with unchanged queries and preserves result
  order, including live and long videos. Karaoke still adds its keyword and excludes live results.
  Chart discovery uses the configured country, with `TH`/`th-TH` defaults.
  Both `__hits` and the legacy `__hk_hits` browse sentinel use that country in
  every search mode and share one chart cache.
  Keep international searches available. Browse caches results for 30 minutes
  and excludes unknown/live durations and tracks longer than 10 minutes.
- AI is paused and outside current development. Keep the retained moderation
  module dormant, request processing free of AI/metadata calls, and legacy API
  fields compatible with the disabled state. Environment settings and `setFilter`
  must leave AI disabled.
- Keep user-facing UI Thai through the dictionary; preserve YouTube titles and
  artist names. Icon buttons retain Thai `title`/`aria-label`, keyboard access,
  and touch targets. Reacquire pointer capture after moving a dragged row in the DOM.
- Keep the `คิวเพลิน by "{nickname}"` heading with Thai nicknames, icon search/queue tabs,
  and 16px search inputs. Wrap long result metadata inside its shrinking flex column.
  Player event context and Admin clear are hidden; the filter button is removed.
  Admin cooldown shows its value in the button. `/g` redirects to `/guest` with queries intact.
- Explore shows a shuffled country chart without category buttons, paged from one response in
  five-song batches. Search mode buttons control specific searches.
  Auto Queue uses regular YouTube WEB watch recommendations based on the latest
  video, preserving recommendation order and the 10-minute duration limit.
  Room nicknames survive refresh/reconnect within the same session.
- Player entry shows the welcome screen first. Start reveals the shared credential
  field with an accessible name and icon-only next button; successful creation opens
  Player, and closing the room restores welcome. Handle autoplay blocking with
  the existing play button without skipping tracks. Preserve playback-error handling,
  the watchdog's hidden-tab/buffering exceptions, and reconnect authentication.
- Disconnect keeps cached playback running. Player reconciles finished item IDs
  before accepting a reconnect snapshot; a missing room drains its cached queue
  before returning to welcome. Explicit close and Player takeover stop immediately.
- All pages share the install manifest and qp assets. Install UI belongs to the
  welcome screen only and hides while a room is active. Installation uses
  native browser prompts or iOS home-screen instructions, without a service worker.
- Keep static-asset revalidation and versioned page asset URLs; open clients and
  mobile browsers otherwise retain outdated scripts after deployment.

## Verification and deployment

Use `bun install`, `bun start`, and `bun run test`. Test code launches Node,
binds temporary localhost ports, copies source into a temporary directory, and
mocks YouTube responses; it does not exercise actual IFrame audio or UI drag/drop.
For Player/UI changes, follow the browser/TV checklist in README, including Guest
requests, Admin controls, queue synchronization, refresh, and unauthenticated access.
The standalone `check-llm` script is retained for future AI work.

For deployment changes, check `docker compose config --quiet`, build the image,
and verify startup in an isolated container. Keep `.env` secrets out of commits.
The Compose setup uses the external `reverseproxy` network, `PUBLIC_URL` for the QR destination; the proxy must forward WebSocket upgrades.

The deployment workflow uses a self-hosted runner and triggers on pushes to
`main` or manual dispatch. Preserve that trigger restriction: adding
`pull_request` execution would let public contributions run on the home server.
Keep the original Hangton/Hangton-Code credit in README and the MIT copyright
notice in LICENSE when modifying or distributing this fork.
