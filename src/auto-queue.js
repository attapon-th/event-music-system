import { fetchRadioTracks, checkPlayable, durationSeconds } from "./youtube.js";

// Called after a room state changes. One prepared song stays outside the queue;
// the request identity makes late network replies harmless.
export function updateAutoQueue(room, isActive, youtubeOptions) {
  const state = room.state;
  if (!isActive() || !state.autoQueue || state.queue.length || state.autoQueueFailures >= 3) return;
  const eligible = (song) => !state.has(song.videoId) && !state.history.some(item => item.videoId === song.videoId);
  if (!state.nowPlaying && !state.paused && state.autoQueueNext) {
    const song = state.autoQueueNext;
    state.autoQueueNext = null;
    if (eligible(song)) state.add({ ...song, autoQueued: true });
    return;
  }
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
      const songs = await fetchRadioTracks(seed.videoId, youtubeOptions);
      if (!current()) return;
      // Keep unavailable recommendations bounded instead of retrying forever.
      const candidates = songs.filter(song => durationSeconds(song.duration) <= 600 && eligible(song));
      const checked = new Set();
      for (const song of candidates) {
        if (checked.has(song.videoId)) continue;
        if (checked.size === 3) break;
        checked.add(song.videoId);
        const playable = await checkPlayable(song.videoId);
        if (!current()) return;
        if (!playable.ok || !eligible(song)) continue;
        state.autoQueueNext = song;
        state.setAutoQueueStatus("ready");
        return;
      }
      state.setAutoQueueStatus("unavailable");
    } catch {
      if (current()) state.setAutoQueueStatus("unavailable");
    }
  })();
}
