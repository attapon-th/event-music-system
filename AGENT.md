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
| `src/youtube.js` | YouTube Music search/country charts, oEmbed checks, watch-page metadata |
| `src/moderation.js` | Optional event-aware LLM content filter |
| `public/host.*` | Player at `/`: YouTube IFrame, direct startup, QR visibility and room exit |
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
- Recheck duplicate and queue-cap conditions after asynchronous YouTube/moderation
  work. The request limit is 50 upcoming tracks; history is capped at 100 items.
- Playback state and volume belong to the server snapshot. Player applies them
  through the IFrame API; Admin remains a controller rather than an audio source.
- `HOST_PASSWORD` authorizes room creation only. The root page only creates rooms;
  Guest entry uses a room number. Empty password disables creation.
- Every WebSocket authenticates a room credential before receiving a snapshot.
  Check membership on every command; only Player reports completion/errors, and
  only the primary Admin grants/revokes Controller rights. Controllers manage playback
  and settings, but cannot change roles. State messages trigger role redirects.
- All room data is in memory. Last-disconnect starts the 60-minute idle deadline;
  live connections cancel it, heartbeat removes dead ones, and restart clears all rooms.
  Seed each room's settings from environment defaults. stdout logs only create/delete.
- Room numbers may be reused; internal session IDs and credentials must prevent old
  links or credentials entering a replacement room. Player exit deletes the room immediately.

## Integration and UI details

- Keep the request sequence: validation/cooldown/duplicate/cap checks → playability
  check → optional moderation → final duplicate/cap checks → enqueue/broadcast.
  Cooldown uses IP plus a client-chosen device ID, not authenticated guest identity.
- YouTube search uses the internal InnerTube Songs endpoint without an API key.
  Chart discovery uses the configured country, with `TH`/`th-TH` defaults.
  Both `__hits` and the legacy `__hk_hits` browse sentinel use that country.
  Keep international searches available. Browse caches results for 30 minutes
  and excludes unknown/live durations and tracks longer than 10 minutes.
- Preserve moderation failure behavior: approve on missing key, HTTP or network
  failure; reject with a retryable message on timeout; reject provider content
  filtering or replies without an explicit boolean verdict. OpenRouter web
  search stays opt-in. Provider configuration lives in environment variables.
- Keep user-facing UI Thai through the dictionary; preserve YouTube titles and
  artist names. Icon buttons retain Thai `title`/`aria-label`, keyboard access,
  and touch targets. Reacquire pointer capture after moving a dragged row in the DOM.
- Player opens after creation without a start overlay. Handle autoplay blocking with
  the existing play button without skipping tracks. Preserve playback-error handling,
  the watchdog's hidden-tab/buffering exceptions, and reconnect authentication.
- Keep static-asset revalidation and versioned page asset URLs; open clients and
  mobile browsers otherwise retain outdated scripts after deployment.

## Verification and deployment

Use `bun install`, `bun start`, and `bun run test`. Test code launches Node,
binds temporary localhost ports, copies source into a temporary directory, and
mocks YouTube responses; it does not exercise actual IFrame audio or UI drag/drop.
For Player/UI changes, follow the browser/TV checklist in README, including Guest
requests, Admin controls, queue synchronization, refresh, and unauthenticated access.
Use `bun run check-llm` only when intentionally checking a configured provider.

For deployment changes, check `docker compose config --quiet`, build the image,
and verify startup in an isolated container. Keep `.env` secrets out of commits.
The Compose setup uses the external `reverseproxy` network, `PUBLIC_URL` for the QR destination; the proxy must forward WebSocket upgrades.

The deployment workflow uses a self-hosted runner and triggers on pushes to
`main` or manual dispatch. Preserve that trigger restriction: adding
`pull_request` execution would let public contributions run on the home server.
Keep the original Hangton/Hangton-Code credit in README and the MIT copyright
notice in LICENSE when modifying or distributing this fork.
