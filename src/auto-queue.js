import { fetchVideoRecommendations, checkPlayable, durationSeconds } from "./youtube.js";

// Called after a room state changes. One ordered batch stays outside the queue;
// the request identity makes late network replies harmless.
export function updateAutoQueue(room, isActive, youtubeOptions) {
  const state = room.state;
  if (!isActive() || !state.autoQueue || state.queue.length || state.autoQueueFailures >= 3) return;
  const eligible = (song) => !state.has(song.videoId) && !state.history.some(item => item.videoId === song.videoId);
  if (state._promoteAutoQueue()) return;
  // Refill only after the last automatic song finishes, not while it plays.
  if (state.autoQueueItems.length || (state.nowPlaying?.autoQueued && state.autoQueueRequest?.ready)) return;
  const seed = state.nowPlaying || state.history.at(-1);
  if (!seed) return;
  if (state.autoQueueRequest?.seedId === seed.id) return;
  const request = { seedId: seed.id };
  state.autoQueueRequest = request;
  const current = () => isActive() && state.autoQueue && !state.queue.length && state.autoQueueFailures < 3 &&
    state.autoQueueRequest === request &&
    (state.nowPlaying || state.history.at(-1))?.id === seed.id;
  state.setAutoQueueStatus("loading");
  return (async () => {
    try {
      const songs = await fetchVideoRecommendations(seed.videoId, youtubeOptions);
      if (!current()) return;
      // Keep unavailable recommendations bounded instead of retrying forever.
      const candidates = songs.slice(0, 20).filter(song => durationSeconds(song.duration) <= 600 && eligible(song));
      const checked = new Set();
      const batch = [];
      for (const song of candidates) {
        if (checked.has(song.videoId)) continue;
        if (batch.length === 5) break;
        checked.add(song.videoId);
        const playable = await checkPlayable(song.videoId);
        if (!current()) return;
        if (!playable.ok || !eligible(song)) continue;
        batch.push({ ...song, autoQueued: true });
      }
      request.ready = batch.length > 0;
      state.autoQueueItems = batch;
      state.setAutoQueueStatus(batch.length ? "ready" : "unavailable");
    } catch {
      if (current()) state.setAutoQueueStatus("unavailable");
    }
  })();
}
