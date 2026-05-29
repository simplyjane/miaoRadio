import { Innertube } from 'youtubei.js';

let ytPromise;
function getYt() {
  if (!ytPromise) ytPromise = Innertube.create();
  return ytPromise;
}

// In-memory LRU-ish cache: same query within the TTL skips YT entirely.
// Saves ~1–3s per repeat hit; common when auto-show re-suggests popular
// artists or the DJ runs the same query twice in a session.
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;       // 1 hour
const SEARCH_CACHE_MAX = 500;
const searchCache = new Map();                     // key → { at, hits }

function cacheKey(query, limit) {
  return `${limit}|${query.trim().toLowerCase()}`;
}

function rememberSearch(key, hits) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    // Drop the oldest entry — Map preserves insertion order.
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(key, { at: Date.now(), hits });
}

export async function searchSongs(query, limit = 5) {
  if (!query) return [];
  const key = cacheKey(query, limit);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return cached.hits;
  }
  const yt = await getYt();
  const results = await yt.music.search(query, { type: 'song' });

  const sections = [];
  if (results?.songs?.contents) sections.push(results.songs.contents);
  if (results?.contents) {
    for (const sec of results.contents) {
      if (sec?.contents) sections.push(sec.contents);
    }
  }

  const items = sections.flat().filter(Boolean);
  const out = [];
  for (const item of items) {
    const id = item.id ?? item.video_id;
    if (!id) continue;
    out.push({
      videoId: id,
      title: extractText(item.title),
      artist: extractArtist(item),
      album: extractText(item.album?.name) || null,
      duration: item.duration?.text ?? null,
      thumbnail: extractThumb(item),
    });
    if (out.length >= limit) break;
  }
  rememberSearch(key, out);
  return out;
}

function extractText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string') return v.text;
  if (typeof v.toString === 'function') {
    const s = v.toString();
    return s === '[object Object]' ? '' : s;
  }
  return '';
}

function extractArtist(item) {
  if (Array.isArray(item.artists) && item.artists.length) {
    return item.artists.map((a) => a.name).filter(Boolean).join(', ');
  }
  if (item.author?.name) return item.author.name;
  if (item.subtitle) return extractText(item.subtitle);
  return '';
}

function extractThumb(item) {
  const t = item.thumbnail;
  if (!t) return null;
  if (Array.isArray(t)) return t[0]?.url ?? null;
  if (Array.isArray(t.contents)) return t.contents[0]?.url ?? null;
  return null;
}
