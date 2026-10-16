// Browser tests run real room/API/WS code; only upstream YouTube is simulated.
import { createHash } from "node:crypto";
const realFetch = globalThis.fetch;
const title = 'เพลงทดสอบชื่อยาวมากสำหรับตรวจการตัดข้อความ · A very long international song title';
const musicRow = n => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: `chart${String(n).padStart(6, '0')}` },
  flexColumns: [title + ` ${n}`, 'ศิลปิน / Artist'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:20' }] } } }],
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://ui-test.invalid/thumbnail.svg' }] } } },
} });
globalThis.fetch = async (url, options) => {
  if (String(url).includes('youtube.com/oembed')) {
    await new Promise(resolve => setTimeout(resolve, 200));
    return new Response('{}');
  }
  if (!String(url).includes('youtube.com/youtubei')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  if (body.query === 'ไม่พบ') return Response.json({});
  if (body.query === 'ผิดพลาด') return new Response('{}', {status:503});
  if (String(url).includes('/next?')) {
    const prefix = createHash('sha256').update(body.videoId).digest('hex').slice(0, 6);
    const results = Array.from({ length: 8 }, (_, n) => ({ compactVideoRenderer: {
      videoId: `a${prefix}${String(n).padStart(4, '0')}`,
      title: { simpleText: `เพลงอัตโนมัติ ${n + 1} · ${body.videoId}` },
      shortBylineText: { simpleText: 'ช่องเพลงแนะนำ' }, lengthText: { simpleText: '3:20' },
      thumbnail: { thumbnails: [{ url: 'https://ui-test.invalid/thumbnail.svg' }] },
    } }));
    return Response.json({ contents: { twoColumnWatchNextResults: { secondaryResults: { secondaryResults: { results } } } } });
  }
  if (body.query && body.context.client.clientName === 'WEB') {
    const rows = Array.from({ length: 15 }, (_, n) => ({ videoRenderer: {
      videoId: `video${String(n).padStart(6, '0')}`,
      title: { runs: [{ text: body.query + ' · ' + title + ` ${n}` }] },
      ownerText: { runs: [{ text: 'ช่องเพลง / Music channel' }] },
      lengthText: { simpleText: '3:20' }, thumbnail: { thumbnails: [{ url: 'https://ui-test.invalid/thumbnail.svg' }] },
    } }));
    return Response.json({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: rows } }] } } } } });
  }
  if (body.browseId === 'FEmusic_charts') return Response.json({ contents: [{ musicTwoRowItemRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'VLPL_UI' } } } }] });
  const contents = Array.from({ length: 30 }, (_, n) => musicRow(n));
  return Response.json(body.query
    ? { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents } }] } } } }] } } }
    : { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents } }] } } } }] } } });
};
