# Agent guide

Maintain Event Music System as a shared jukebox: one TV/TV Box plays music,
guests request songs from phones, and an authenticated admin manages playback.
Extend the existing implementation and preserve that workflow.

Read [CONTEXT.md](CONTEXT.md) when naming or changing domain concepts. Read
[README.md](README.md) for configuration, HTTP/WebSocket payloads, and the
manual test procedure. `CLAUDE.md` describes an older version; its statements
about authentication, charts, and available tests need checking against current code.

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
| `server.js` | Environment loading, authentication, HTTP request pipeline, WebSocket dispatch/broadcast, persisted settings |
| `src/state.js` | `JukeboxState`: authoritative queue, current track, history, pause state, volume |
| `src/youtube.js` | YouTube Music search/country charts, oEmbed checks, watch-page metadata |
| `src/moderation.js` | Optional event-aware LLM content filter |
| `public/host.*` | Player at `/`: YouTube IFrame, start gesture, QR, legacy host controls |
| `public/guest.*` | Public search, Explore, song requests, queue display at `/guest` and `/explore` |
| `public/admin.*` | Protected remote controls and queue editing at `/admin`; reuses Guest search/request scripts |
| `public/i18n.js` | Shared UI dictionary and `t()` interpolation |
| `scripts/test.mjs` | Isolated HTTP/WebSocket integration checks using Node assertions |

## State and authorization invariants

- The server owns one `JukeboxState`. Browser snapshots are views; queue changes
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
- `HOST_PASSWORD` gates Player/Admin pages, their direct `.html` paths, and
  `/api/host-token`. An empty password disables privileged access with HTTP 503;
  missing/wrong credentials with a configured password receive HTTP 401.
- Every WebSocket starts read-only. Only a valid per-boot host token authorizes
  control events; Guest remains able to search and request tracks without login.
  Validate privileged payloads on the server even when the UI disables controls.
- Queue, history, pause, and volume reset on server restart. Only filter state,
  moderation mode, cooldown, and event description persist in `data/settings.json`;
  saved values take precedence over their initial environment settings.

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
- Player needs a start gesture for browser audio. Preserve playback-error handling,
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
The Compose setup uses the external `reverseproxy` network, a settings volume,
and `PUBLIC_URL` for the QR destination; the proxy must forward WebSocket upgrades.

The deployment workflow uses a self-hosted runner and triggers on pushes to
`main` or manual dispatch. Preserve that trigger restriction: adding
`pull_request` execution would let public contributions run on the home server.
Keep the original Hangton/Hangton-Code credit in README and the MIT copyright
notice in LICENSE when modifying or distributing this fork.
