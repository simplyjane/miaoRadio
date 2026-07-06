// Monthly top-hit snapshots per country. Fetches Apple's public marketing
// RSS (no auth, no API key), resolves each track to a YouTube videoId via
// our existing ytmusic search, and writes the result into chart_snapshots.
//
// The scheduler is a plain setInterval — no external cron, no admin
// endpoint. On boot we check whether the current month has data; if not,
// we refresh in the background. Every 24h we re-check so a long-running
// server catches a month rollover without a restart.

import { searchSongs } from './ytmusic.js';
import {
  insertChartSnapshot,
  hasChartsForMonth,
  getDistinctUserCountries,
} from './state.js';

// Major-market baseline so the app has data before any user has attributed
// themselves to a country. Additional countries get added dynamically from
// the distinct set observed in user_settings.
const BASELINE_COUNTRIES = ['US', 'CA', 'GB', 'JP', 'CN', 'FR', 'DE', 'HK', 'TW', 'AU'];

// Apple's marketing RSS wants a User-Agent; without one they may 403.
const UA = 'miaoRadio/1.0 (https://miaoradio.pilipalajing.com)';

const APPLE_TIMEOUT_MS = 8000;
const TRACKS_PER_COUNTRY = 10;
const SLEEP_BETWEEN_COUNTRIES_MS = 500;
const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const BOOT_DELAY_MS = 30 * 1000;                // give warmup a head start

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export async function fetchAppleCharts(country, limit = TRACKS_PER_COUNTRY) {
  const cc = country.toLowerCase();
  const url = `https://rss.applemarketingtools.com/api/v2/${cc}/music/most-played/${limit}/songs.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`apple charts ${res.status} for ${country}`);
  const data = await res.json();
  const results = data?.feed?.results || [];
  return results.map((r, i) => ({
    rank: i + 1,
    title: r.name || '',
    artist: r.artistName || '',
  }));
}

async function refreshCountry(country) {
  const month = currentMonthKey();
  if (hasChartsForMonth(country, month)) {
    return { country, month, skipped: true };
  }
  let picks;
  try {
    picks = await fetchAppleCharts(country);
  } catch (e) {
    console.warn(`[charts] apple fetch failed for ${country}: ${e.message}`);
    return { country, month, error: e.message };
  }
  let inserted = 0;
  for (const p of picks) {
    if (!p.title) continue;
    const q = p.artist ? `${p.artist} ${p.title}` : p.title;
    try {
      const hits = await searchSongs(q, 1);
      if (hits.length) {
        insertChartSnapshot({
          country,
          month,
          videoId: hits[0].videoId,
          title: hits[0].title || p.title,
          artist: hits[0].artist || p.artist,
          rank: p.rank,
        });
        inserted++;
      }
    } catch (e) {
      console.warn(`[charts] YT search failed for "${q}": ${e.message}`);
    }
  }
  console.log(`[charts] ${country} ${month}: ${inserted}/${picks.length} resolved`);
  return { country, month, inserted, attempted: picks.length };
}

async function refreshAllActiveCountries() {
  // Union of baseline + any country codes we've seen from real users.
  const dynamic = getDistinctUserCountries();
  const countries = Array.from(new Set([...BASELINE_COUNTRIES, ...dynamic]));
  const month = currentMonthKey();
  const need = countries.filter((c) => !hasChartsForMonth(c, month));
  if (!need.length) {
    console.log(`[charts] ${month}: all ${countries.length} countries already snapshotted`);
    return;
  }
  console.log(`[charts] ${month}: refreshing ${need.length} country(ies)`);
  for (const c of need) {
    await refreshCountry(c);
    await sleep(SLEEP_BETWEEN_COUNTRIES_MS);
  }
}

let scheduler = null;
export function startChartsScheduler() {
  if (scheduler) return;
  setTimeout(() => {
    refreshAllActiveCountries().catch((e) => console.warn('[charts boot]', e.message));
  }, BOOT_DELAY_MS);
  scheduler = setInterval(() => {
    refreshAllActiveCountries().catch((e) => console.warn('[charts daily]', e.message));
  }, RESCAN_INTERVAL_MS);
  scheduler.unref?.();
}
