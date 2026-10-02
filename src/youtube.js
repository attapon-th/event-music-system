// YouTube access without an API key:
//  - searchYouTube(): queries YouTube Music's internal search API (InnerTube,
//    the same JSON endpoint the music.youtube.com web app calls), filtered to
//    the "Songs" category, or regular YouTube videos for karaoke/video search;
//    the returned videoIds play in the regular YouTube iframe as usual.
//  - checkPlayable(): uses the oEmbed endpoint to reject deleted/private videos
//    before they reach the queue. (Embed-disabled videos still return 200 here,
//    so the host player ALSO auto-skips on iframe error codes 101/150.)

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// The SOCS/CONSENT cookie avoids the EU "before you continue" consent wall that
// otherwise replaces ytInitialData with an interstitial.
const COMMON_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  Cookie: "SOCS=CAI;CONSENT=YES+1",
};

function pickThumbnail(thumbs) {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  // YT Music returns tiny (60/120px) album art, but the size lives in the URL
  // suffix — ask for a bigger square instead.
  return thumbs[thumbs.length - 1].url.replace(/=w\d+-h\d+/, "=w320-h320");
}

// InnerTube search filter for the "Songs" category (same value ytmusicapi uses).
const SONGS_FILTER = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

export async function searchYouTube(query, { limit = 12, timeoutMs = 8000, region = "TH", locale = "th-TH", mode = "songs" } = {}) {
  const karaoke = mode === "karaoke";
  const videos = mode !== "songs";
  if (karaoke && !/karaoke|คาราโอเกะ/i.test(query)) query += " karaoke";
  const origin = videos ? "https://www.youtube.com" : "https://music.youtube.com";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch(origin + "/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "application/json",
        Origin: origin,
        Referer: origin + "/",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: videos ? "WEB" : "WEB_REMIX", clientVersion: videos ? "2.20250101.00.00" : "1.20250101.01.00", hl: locale.split("-")[0], gl: region },
        },
        query,
        params: videos ? "EgIQAQ%3D%3D" : SONGS_FILTER,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube search responded ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  if (videos) {
    const results = [];
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      for (const item of section.itemSectionRenderer?.contents || []) {
        const r = item.videoRenderer;
        if (!r?.videoId || (karaoke && !r.lengthText)) continue;
        results.push({
          videoId: r.videoId,
          title: r.title?.runs?.map((run) => run.text).join("") || r.title?.simpleText || "(untitled)",
          channel: (r.ownerText || r.shortBylineText)?.runs?.map((run) => run.text).join("") || "Unknown",
          duration: r.lengthText?.simpleText || r.lengthText?.runs?.map((run) => run.text).join("") || "",
          thumbnail: pickThumbnail(r.thumbnail?.thumbnails),
        });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents || [];

  const results = [];
  for (const section of sections) {
    for (const item of section?.musicShelfRenderer?.contents || []) {
      const r = item.musicResponsiveListItemRenderer;
      const videoId =
        r?.playlistItemData?.videoId ||
        r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
          ?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;
      // flexColumns: [0] = title, [1] = "artist • album • duration" as runs.
      const cols = (r.flexColumns || []).map(
        (c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      );
      const byline = cols[1] || [];
      const duration = byline.map((run) => run.text).filter((t) => /^\d+:\d\d/.test(t)).pop();
      results.push({
        videoId,
        title: cols[0]?.map((run) => run.text).join("") || "(untitled)",
        channel: byline[0]?.text || "Unknown",
        duration: duration || "",
        thumbnail: pickThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// YouTube's daily top music videos for the configured country.
// Country charts are discovered from YouTube rather than hard-coding a playlist.
function findChartPlaylist(data) {
  if (!data || typeof data !== "object") return null;
  const id = data.musicTwoRowItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
  if (id?.startsWith("VLPL")) return id;
  for (const value of Object.values(data)) {
    const found = findChartPlaylist(value);
    if (found) return found;
  }
  return null;
}

// Current country chart hits, in the same shape as searchYouTube() results.
// Items are music videos (that's what the chart tracks); they play the same.
export async function fetchChartHits({ limit = 40, timeoutMs = 8000, region = "TH", locale = "th-TH" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const browse = async (browseId, extra = {}) => {
      const res = await fetch("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false", {
        method: "POST",
        headers: { ...COMMON_HEADERS, "Content-Type": "application/json", Origin: "https://music.youtube.com" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: locale.split("-")[0], gl: region } },
          browseId,
          ...extra,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`YouTube Music responded ${res.status}`);
      return res.json();
    };
    const charts = await browse("FEmusic_charts", { formData: { selectedValues: [region] } });
    const playlist = findChartPlaylist(charts);
    if (!playlist) throw new Error("YouTube country chart unavailable");
    data = await browse(playlist);
  } finally {
    clearTimeout(timer);
  }

  const sections =
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ||
    data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
      ?.contents ||
    [];

  const results = [];
  for (const section of sections) {
    for (const item of section?.musicPlaylistShelfRenderer?.contents || []) {
      const r = item.musicResponsiveListItemRenderer;
      const videoId = r?.playlistItemData?.videoId;
      if (!videoId) continue;
      const cols = (r.flexColumns || []).map(
        (c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      );
      results.push({
        videoId,
        title: cols[0]?.map((run) => run.text).join("") || "(untitled)",
        channel: cols[1]?.[0]?.text || "Unknown",
        duration:
          r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
            ?.text || "",
        thumbnail: pickThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// Returns { ok: true } if the video exists and is publicly available, or
// { ok: false, reason } for deleted/private/nonexistent IDs.
export async function checkPlayable(videoId, { timeoutMs = 5000 } = {}) {
  const url =
    "https://www.youtube.com/oembed?url=" +
    encodeURIComponent("https://youtu.be/" + videoId) +
    "&format=json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, reason: "วิดีโอนี้ไม่อนุญาตให้เล่นแบบฝัง" };
    if (res.status === 404 || res.status === 400)
      return { ok: false, reason: "วิดีโอนี้เป็นส่วนตัว ถูกลบ หรือไม่มีอยู่" };
    return { ok: false, reason: `ไม่สามารถเล่นวิดีโอนี้ได้ (สถานะ ${res.status})` };
  } catch (err) {
    // Network hiccup — don't block on it; let the host player be the backstop.
    return { ok: true, soft: true, note: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch richer metadata from the watch page for moderation context:
// category (Music vs not), YouTube's own isFamilySafe flag, and the description.
// Returns null on any failure — callers must treat it as best-effort.
export async function fetchVideoDetails(videoId, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://www.youtube.com/watch?v=" + videoId, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var|<\/script>)/s);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const vd = data.videoDetails || {};
    const mf = data.microformat?.playerMicroformatRenderer || {};
    return {
      author: vd.author || "",
      category: mf.category || "",
      isFamilySafe: mf.isFamilySafe,
      description: (vd.shortDescription || "").slice(0, 500),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
