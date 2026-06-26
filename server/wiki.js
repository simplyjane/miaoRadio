// Wikipedia REST summary fetcher for the SONG INFO popup. Mirrors the
// in-memory-TTL-cache pattern from server/geo.js so the same artist + title
// pair stays warm for a day and we don't hammer Wikipedia.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map(); // key → { value, at }

const UA = 'miaoRadio/1.0 (https://miaoradio.pilipalajing.com)';

// CJK ideographs — same range used by detectLanguage in server/context.js.
function hasCJK(s) {
  return /[一-鿿㐀-䶿]/.test(s || '');
}

function pickLang(artist, title) {
  return hasCJK(artist) || hasCJK(title) ? 'zh' : 'en';
}

function key(artist, title) {
  return `${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}`;
}

function remember(k, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(k, { value, at: Date.now() });
}

async function summary(lang, term) {
  if (!term) return null;
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.type === 'disambiguation') return null;
    return {
      name: data.title || term,
      summary: data.extract || '',
      thumbnail: data.thumbnail?.source || null,
      wikiUrl: data.content_urls?.desktop?.page || null,
    };
  } catch {
    return null;
  }
}

function redditSearchUrl(artist, title) {
  const q = [artist, title].filter(Boolean).join(' ');
  return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`;
}

export async function getSongInfo({ artist, title }) {
  const a = (artist || '').trim();
  const t = (title || '').trim();
  if (!a && !t) {
    return { artist: null, song: null, redditUrl: redditSearchUrl(a, t) };
  }
  const k = key(a, t);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const lang = pickLang(a, t);

  // Look up artist + song in parallel. Song falls back to "{title} (song)"
  // because Wikipedia disambiguates many tracks that way.
  const [artistInfo, songInfo] = await Promise.all([
    a ? summary(lang, a) : Promise.resolve(null),
    (async () => {
      const direct = t ? await summary(lang, t) : null;
      if (direct) return direct;
      if (!t) return null;
      return summary(lang, `${t} (song)`);
    })(),
  ]);

  const value = {
    artist: artistInfo,
    song: songInfo,
    redditUrl: redditSearchUrl(a, t),
  };
  remember(k, value);
  return value;
}
