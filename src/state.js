// Authoritative, in-memory queue state. The server owns the queue; the host
// page is just the player that renders whatever `nowPlaying` says.
//
// Any mutation fires onChange(), which the server uses to broadcast the full
// state to every connected client. The state is small (a party playlist), so
// broadcasting the whole thing on every change keeps the logic dead simple.

import { randomUUID } from "node:crypto";

export class JukeboxState {
  constructor() {
    this.nowPlaying = null; // current item or null
    this.queue = []; // upcoming items
    this.paused = false;
    this.volume = 60;
    this.history = []; // played items (most recent last), capped
    this.onChange = () => {};
  }

  // Is this video already playing or somewhere in the queue?
  has(videoId) {
    return this.nowPlaying?.videoId === videoId || this.queue.some((s) => s.videoId === videoId);
  }

  snapshot() {
    return {
      nowPlaying: this.nowPlaying,
      queue: this.queue,
      historyCount: this.history.length,
      paused: this.paused,
      volume: this.volume,
    };
  }

  _emit() {
    this.onChange(this.snapshot());
  }

  // Promote the next queued song if nothing is playing.
  _promoteIfIdle() {
    if (!this.nowPlaying && this.queue.length > 0) {
      this.nowPlaying = this.queue.shift();
    }
  }

  // Add a moderated/approved song. Returns the created item incl. its position.
  add({ videoId, title, channel, duration, thumbnail, addedBy }) {
    const item = {
      id: randomUUID(),
      videoId,
      title,
      channel: channel || "",
      duration: duration || "",
      thumbnail: thumbnail || null,
      addedBy: (addedBy || "").slice(0, 40),
      addedAt: Date.now(),
    };
    this.queue.push(item);
    this._promoteIfIdle();
    this._emit();
    const position = this.nowPlaying === item ? 0 : this.queue.indexOf(item) + 1;
    return { item, position };
  }

  // Advance to the next song. `finishedVideoId` guards against double-advances
  // from duplicate "ended"/"error" events for the same track.
  advance(finishedVideoId) {
    if (finishedVideoId && this.nowPlaying?.videoId !== finishedVideoId) {
      return; // stale event for a track we already moved past
    }
    if (this.nowPlaying) {
      this.history.push(this.nowPlaying);
      if (this.history.length > 100) this.history.shift();
    }
    this.nowPlaying = this.queue.shift() || null;
    this.paused = false;
    this._emit();
  }

  // Host control: skip the current track regardless of what's playing.
  skip() {
    this.advance(this.nowPlaying?.videoId);
  }

  // Remove an upcoming item by id (host control).
  remove(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((s) => s.id !== id);
    if (this.queue.length !== before) this._emit();
  }

  // Move an upcoming item up/down (host control).
  move(id, dir) {
    const i = this.queue.findIndex((s) => s.id === id);
    if (i === -1 || !["up", "down"].includes(dir)) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this._emit();
  }

  clear() {
    this.queue = [];
    this._emit();
  }

  // Apply only a complete permutation: stale clients cannot lose new requests.
  reorder(ids) {
    if (!Array.isArray(ids) || ids.length !== this.queue.length ||
        new Set(ids).size !== ids.length) return false;
    const items = new Map(this.queue.map((item) => [item.id, item]));
    if (!ids.every((id) => items.has(id))) return false;
    this.queue = ids.map((id) => items.get(id));
    this._emit();
    return true;
  }

  playNow(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.queue.splice(index, 1);
    this.queue.unshift(item);
    this.advance();
  }

  setPaused(paused) {
    if (typeof paused !== "boolean") return;
    this.paused = paused;
    this._emit();
  }

  setVolume(volume) {
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) return;
    this.volume = Math.round(volume);
    this._emit();
  }
}
