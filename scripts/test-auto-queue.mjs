import assert from "node:assert/strict";
import { JukeboxState } from "../src/state.js";
import { updateAutoQueue } from "../src/auto-queue.js";
import { fetchRadioTracks } from "../src/youtube.js";

const song = (videoId, extra = {}) => ({ videoId, title: videoId, channel: "Artist", duration: "3:20", ...extra });
function radioResponse(songs) {
  const contents = songs.map(item => {
    const renderer = { videoId: item.videoId, title: { runs: [{ text: item.title }] },
      shortBylineText: { runs: [{ text: item.channel }] }, lengthText: { simpleText: item.duration },
      thumbnail: { thumbnails: [{ url: item.thumbnail || "https://example.com/thumb.jpg" }] },
      ...(item.unplayable ? { unplayableText: { simpleText: "Unavailable" } } : {}) };
    return item.wrapper ? { playlistPanelVideoWrapperRenderer: { primaryRenderer: { playlistPanelVideoRenderer: renderer } } }
      : { playlistPanelVideoRenderer: renderer };
  });
  return Response.json({ contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: {
    watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { content: { musicQueueRenderer: {
      content: { playlistPanelRenderer: { contents } },
    } } } }] },
  } } } });
}
const realFetch = globalThis.fetch;
let recommendations;
let blocked = new Set();
let requests = [];
let checks = [];
let release;
let responseGate = false;
let checkGate = false;
globalThis.fetch = async (url, options) => {
  if (String(url).includes("/next?")) {
    const body = JSON.parse(options.body);
    assert.equal(body.context.client.clientName, "WEB_REMIX");
    assert.equal(body.context.client.gl, "TH");
    assert.equal(body.context.client.hl, "th");
    assert.equal(body.playlistId, "RDAMVM" + body.videoId);
    assert.equal(body.params, "wAEB");
    requests.push(body.videoId);
    const results = recommendations(body.videoId);
    if (responseGate) {
      responseGate = false;
      await new Promise(resolve => { release = resolve; });
    }
    if (results instanceof Error) throw results;
    return radioResponse(results);
  }
  const id = new URL(new URL(url).searchParams.get("url")).pathname.slice(1);
  checks.push(id);
  if (checkGate) {
    checkGate = false;
    await new Promise(resolve => { release = resolve; });
  }
  return new Response("{}", { status: blocked.has(id) ? 404 : 200 });
};
function room() {
  const value = { state: new JukeboxState(), active: true, tasks: [], snapshots: [] };
  value.state.onChange = () => {
    value.snapshots.push(JSON.parse(JSON.stringify(value.state.snapshot())));
    const task = updateAutoQueue(value, () => value.active, { region: "TH", locale: "th-TH" });
    if (task) value.tasks.push(task);
  };
  value.settle = async () => {
    let count = 0;
    while (count < value.tasks.length) {
      const pending = value.tasks.slice(count);
      count = value.tasks.length;
      await Promise.all(pending);
    }
  };
  return value;
}
try {
  recommendations = () => [song("auto0000001", { wrapper: true, thumbnail: 'https://example.com/"bad' }), song("invalid", {}), song("auto0000002", { unplayable: true })];
  const parsed = await fetchRadioTracks("main0000001");
  assert.deepEqual(parsed.map(item => item.videoId), ["auto0000001"], "radio wrapper parsing, invalid IDs and unplayable tracks");
  assert.equal(parsed[0].thumbnail, null, "radio artwork follows the request pipeline's safe HTTPS validation");
  requests = [];
  const a = room();
  const b = room();
  a.state.setAutoQueue(true);
  assert.equal(a.state.nowPlaying, null, "a new room waits for its first requested song");
  assert.equal(requests.length, 0);
  a.state.setAutoQueue(false);
  a.state.add(song("main0000001"));
  a.state.add(song("main0000002"));
  assert.equal(requests.length, 0, "disabled Auto Queue performs no network work");
  a.state.setAutoQueue("true");
  assert.equal(a.state.autoQueue, false, "toggle accepts booleans only");
  a.state.setAutoQueue(true);
  assert.equal(requests.length, 0, "main queue plays before fetching recommendations");
  blocked = new Set(["auto0000001"]);
  recommendations = seed => [song(seed), song("main0000001"), song("live0000001", { duration: "" }),
    song("long0000001", { duration: "1:00:00" }), song("auto0000001"), song("auto0000001"),
    song(seed === "auto0000002" ? "auto0000003" : "auto0000002")];
  a.state.advance("main0000001");
  await a.settle();
  assert.equal(a.state.autoQueueStatus, "ready");
  assert.equal(a.state.queue.length, 0, "prepared recommendation is outside the main queue");
  assert.equal(a.state.nowPlaying.videoId, "main0000002");
  assert.equal(a.state.autoQueueNext.videoId, "auto0000002");
  assert.deepEqual(checks, ["auto0000001", "auto0000002"], "exclude history/live/compilations and only check each candidate once");
  a.state.advance("main0000002");
  assert.equal(a.state.nowPlaying.videoId, "auto0000002");
  assert.equal(a.state.nowPlaying.autoQueued, true);
  const history = a.state.history.length;
  a.state.advance("main0000002");
  assert.equal(a.state.history.length, history, "duplicate completion cannot advance the automatic song");
  await a.settle();
  a.state.advance("auto0000002");
  assert.equal(a.state.nowPlaying.videoId, "auto0000003", "Auto Queue continues for multiple songs");
  await a.settle();
  a.state.add(song("main0000003"));
  assert.equal(a.state.nowPlaying.videoId, "auto0000003", "request leaves the automatic song playing");
  assert.equal(a.state.queue[0].videoId, "main0000003");
  a.state.advance("auto0000003");
  assert.equal(a.state.nowPlaying.videoId, "main0000003", "requested track has priority over prepared recommendations");
  assert.equal(b.state.autoQueue, false, "room settings and recommendations are isolated");
  a.state.setAutoQueue(false);
  await a.settle();
  a.state.advance("main0000003");
  assert.equal(a.state.nowPlaying, null, "disabled Auto Queue leaves the room idle");

  // Hold an old response across off/on and a new request. Only the latest seed wins.
  recommendations = seed => [song(seed === "main0000004" ? "auto0000004" : "auto0000005")];
  const race = room();
  race.state.add(song("main0000004"));
  responseGate = true;
  race.state.setAutoQueue(true);
  const oldRelease = release;
  race.state.setAutoQueue(false);
  race.state.setAutoQueue(true);
  await Promise.resolve();
  race.state.add(song("main0000005"));
  race.state.advance("main0000004");
  oldRelease();
  await race.settle();
  assert.equal(race.state.nowPlaying.videoId, "main0000005");
  assert.equal(race.state.autoQueueNext.videoId, "auto0000005", "old response cannot replace the new recommendation");
  race.state.setAutoQueue(false);
  assert.equal(race.state.nowPlaying.videoId, "main0000005", "turning off preserves current playback");
  assert.equal(race.state.autoQueueNext, null);

  const checking = room();
  checking.state.add(song("main0000004"));
  checkGate = true;
  checking.state.setAutoQueue(true);
  // Let the radio response reach its asynchronous playability check.
  await new Promise(resolve => setImmediate(resolve));
  checking.state.add(song("main0000005"));
  release();
  await checking.settle();
  assert.equal(checking.state.nowPlaying.videoId, "main0000004");
  assert.equal(checking.state.queue[0].videoId, "main0000005");
  assert.equal(checking.state.autoQueueNext, null, "new requests cancel a recommendation during its playability check");

  const disabled = room();
  disabled.state.add(song("main0000004"));
  responseGate = true;
  disabled.state.setAutoQueue(true);
  disabled.state.advance("main0000004");
  disabled.state.setAutoQueue(false);
  release();
  await disabled.settle();
  assert.equal(disabled.state.nowPlaying, null, "a late recommendation cannot play after disabling while idle");
  assert.equal(disabled.state.autoQueueStatus, "idle");

  // Ending while fetch is pending, pausing while idle, and room closure.
  const delayed = room();
  delayed.state.add(song("main0000004"));
  responseGate = true;
  delayed.state.setAutoQueue(true);
  delayed.state.advance("main0000004");
  delayed.state.setPaused(true);
  release();
  await delayed.settle();
  assert.equal(delayed.state.nowPlaying, null, "a delayed recommendation must respect idle pause");
  delayed.state.setPaused(false);
  assert.equal(delayed.state.nowPlaying.videoId, "auto0000004", "resume uses the prepared song");
  await delayed.settle();
  const closed = room();
  closed.state.add(song("main0000004"));
  responseGate = true;
  closed.state.setAutoQueue(true);
  closed.state.advance("main0000004");
  closed.active = false;
  release();
  await closed.settle();
  assert.equal(closed.state.nowPlaying, null);
  assert.equal(closed.state.autoQueueNext, null, "late reply cannot resurrect a closed room");

  // An unavailable response never retries on unrelated volume/pause broadcasts.
  const failure = room();
  recommendations = () => new Error("Network unavailable");
  failure.state.add(song("main0000006"));
  failure.state.setAutoQueue(true);
  await failure.settle();
  const requestCount = requests.length;
  failure.state.setVolume(25);
  failure.state.setPaused(true);
  failure.state.advance("main0000006");
  await failure.settle();
  assert.equal(requests.length, requestCount);
  assert.equal(failure.state.autoQueueStatus, "unavailable");
  recommendations = () => [];
  failure.state.setAutoQueue(false);
  failure.state.setAutoQueue(true);
  await failure.settle();
  assert.equal(requests.length, requestCount + 1, "off/on starts a new attempt");
  assert.equal(failure.state.autoQueueStatus, "unavailable", "empty radio shows an unavailable status");
  recommendations = () => Array.from({ length: 5 }, (_, i) => song(`bad0000000${i}`));
  blocked = new Set(recommendations().map(item => item.videoId));
  checks = [];
  failure.state.add(song("main0000007"));
  await failure.settle();
  assert.equal(checks.length, 3, "unplayable candidate checks are bounded");

  // Three consecutive IFrame failures stop automatic playback; a new request resets it.
  blocked = new Set();
  let counter = 10;
  recommendations = () => [song(`auto00000${counter++}`)];
  const errors = room();
  errors.state.add(song("main0000008"));
  errors.state.setAutoQueue(true);
  await errors.settle();
  errors.state.advance("main0000008");
  await errors.settle();
  for (let i = 0; i < 3; i++) {
    errors.state.advance(errors.state.nowPlaying.videoId, true);
    await errors.settle();
  }
  assert.equal(errors.state.autoQueueFailures, 3);
  assert.equal(errors.state.nowPlaying, null);
  assert.equal(errors.state.autoQueueStatus, "unavailable");
  errors.state.add(song("main0000009"));
  await errors.settle();
  assert.equal(errors.state.autoQueueFailures, 0);
  assert.equal(errors.state.autoQueueStatus, "ready");
  console.log("PASS: radio parsing, main queue priority, Auto Queue continuation, deduplication, cancellation/off-on races, delayed/paused/closed rooms, bounded failures and retry (YouTube simulated).");
} finally {
  globalThis.fetch = realFetch;
}
