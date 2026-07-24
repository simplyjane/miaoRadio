import express from 'express';
import path from 'node:path';
import { handleChat, handleAutoShow, getPendingPatter } from './router.js';
import { startBoxPlayer, boxPlayEnqueue, boxControl } from './boxplayer.js';
import { searchSongs } from './ytmusic.js';
import { synthesizeAndCache } from './tts.js';
import { lookupCityForIp } from './geo.js';
import { getSongInfo } from './wiki.js';
import {
  recordPlay,
  getCorpus,
  setCorpus,
  getSettings,
  setSettings,
  setUserCountry,
  getTopPlaysByCountry,
  getTopPlaysGlobal,
  getChartsForCountryMonth,
  getGoogleTokens,
  deleteGoogleTokens,
  setReaction,
  listReactions,
} from './state.js';
import { startChartsScheduler, currentMonthKey } from './charts.js';
import {
  resolveUser,
  publicUserShape,
  isValidInviteCode,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  decodeIdToken,
  verifyOAuthState,
  completeSignIn,
  endSession,
  buildCalendarAuthUrl,
  verifyCalendarState,
  exchangeCalendarCode,
  maybeSeedAdminCorpus,
  GUEST_CHAT_LIMIT,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(import.meta.dirname, '..');

const app = express();
// Respect X-Forwarded-For so req.ip is the client behind a reverse proxy.
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'pwa')));
app.use('/tts', express.static(path.join(ROOT, 'cache/tts'), {
  maxAge: '7d',
  immutable: true,
}));

/* ───── auth endpoints ─────────────────────────────────────────────────── */

app.get('/api/auth/me', (req, res) => {
  const user = resolveUser(req, res);
  res.json({ user: publicUserShape(user) });
});

app.get('/api/auth/validate-code', (req, res) => {
  const code = String(req.query.code ?? '').trim();
  if (!isValidInviteCode(code)) {
    return res.status(400).json({ ok: false, error: 'invalid_code' });
  }
  res.json({ ok: true });
});

app.get('/api/auth/start', (req, res) => {
  const code = String(req.query.code ?? '').trim();
  if (!isValidInviteCode(code)) {
    return res.status(400).send('invalid invite code');
  }
  try {
    const url = buildGoogleAuthUrl({ code });
    res.redirect(url);
  } catch (e) {
    console.error('[auth/start]', e);
    res.status(500).send(e.message);
  }
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?login=1&error=${encodeURIComponent(String(error))}`);
  if (!code || !state) return res.redirect('/?login=1&error=missing_params');
  const verified = verifyOAuthState(String(state));
  if (!verified) return res.redirect('/?login=1&error=invalid_state');
  if (!isValidInviteCode(verified.code)) {
    return res.redirect('/?login=1&error=invalid_invite');
  }

  try {
    const tokens = await exchangeCodeForTokens(String(code));
    if (!tokens.id_token) throw new Error('no id_token in response');
    const claims = decodeIdToken(tokens.id_token);
    completeSignIn(req, res, { claims, inviteCode: verified.code });
    res.redirect('/');
  } catch (e) {
    console.error('[auth/callback]', e);
    res.redirect(`/?login=1&error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/auth/signout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

/* ───── per-user settings endpoints ────────────────────────────────────── */

function requireSignedIn(req, res) {
  const user = resolveUser(req, res);
  if (!user || user.is_guest) {
    res.status(401).json({ error: 'signin_required' });
    return null;
  }
  return user;
}

// Backfill weather_city from the client IP one time per user. Subsequent
// requests skip immediately because the field is set.
async function ensureGeoCity(user, req) {
  if (!user) return;
  const existing = getSettings(user.id);
  // Skip if we already know both city AND country.
  if (existing?.weather_city && existing?.country_code) return;
  const geo = await lookupCityForIp(req.ip).catch(() => null);
  if (!geo) return;
  if (geo.city && !existing?.weather_city) {
    setSettings(user.id, {
      weather_city: geo.city,
      country_code: geo.country || null,
    });
  } else if (geo.country && !existing?.country_code) {
    setUserCountry(user.id, geo.country);
  }
}

app.get('/api/me/corpus', async (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  // Lazy migration: if this is the admin and they haven't been seeded yet
  // (e.g. their account pre-dates the seeding logic), copy user/*.md now.
  await maybeSeedAdminCorpus(user.id, user.email).catch(() => {});
  const row = getCorpus(user.id) || { taste: '', routines: '', mood_rules: '' };
  res.json({ taste: row.taste, routines: row.routines, mood_rules: row.mood_rules });
});

app.post('/api/me/corpus', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  const { taste, routines, mood_rules } = req.body ?? {};
  setCorpus(user.id, {
    taste: String(taste ?? ''),
    routines: String(routines ?? ''),
    mood_rules: String(mood_rules ?? ''),
  });
  res.json({ ok: true });
});

app.get('/api/me/settings', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  const row = getSettings(user.id) || {};
  const cal = getGoogleTokens(user.id);
  res.json({
    weather_city: row.weather_city || '',
    tts_reference_id: row.tts_reference_id || '',
    calendar_connected: !!cal,
    calendar_email: cal?.email || null,
  });
});

app.post('/api/me/settings', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  // Partial update: only overwrite fields the caller explicitly sent. Lets
  // the home-page voice chip change tts_reference_id without blowing away
  // the user's weather_city, and vice versa for the settings drawer.
  const body = req.body ?? {};
  const existing = getSettings(user.id) || {};
  const next = {
    weather_city: existing.weather_city || null,
    tts_reference_id: existing.tts_reference_id || null,
  };
  if ('weather_city' in body) {
    next.weather_city = String(body.weather_city || '').trim() || null;
  }
  if ('tts_reference_id' in body) {
    next.tts_reference_id = String(body.tts_reference_id || '').trim() || null;
  }
  setSettings(user.id, next);
  res.json({ ok: true });
});

app.get('/api/me/calendar/start', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  try {
    res.redirect(buildCalendarAuthUrl({ userId: user.id }));
  } catch (e) {
    console.error('[cal/start]', e);
    res.status(500).send(e.message);
  }
});

app.get('/api/me/calendar/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?settings=1&error=${encodeURIComponent(String(error))}`);
  if (!code || !state) return res.redirect('/?settings=1&error=missing_params');
  const verified = verifyCalendarState(String(state));
  if (!verified) return res.redirect('/?settings=1&error=invalid_state');
  const user = resolveUser(req, res);
  if (!user || user.is_guest || user.id !== verified.userId) {
    return res.redirect('/?settings=1&error=session_mismatch');
  }
  try {
    await exchangeCalendarCode(String(code), user.id);
    res.redirect('/?settings=1&calendar=ok');
  } catch (e) {
    console.error('[cal/callback]', e);
    res.redirect(`/?settings=1&error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/me/calendar/disconnect', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  deleteGoogleTokens(user.id);
  res.json({ ok: true });
});

/* ───── radio endpoints (auth-aware) ───────────────────────────────────── */

app.post('/api/chat', async (req, res) => {
  const { message } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  const user = resolveUser(req, res, { createGuest: true });
  if (user.is_guest && user.chats_used >= GUEST_CHAT_LIMIT) {
    return res.status(402).json({
      error: 'signup_required',
      chats_used: user.chats_used,
      chats_limit: GUEST_CHAT_LIMIT,
    });
  }
  await ensureGeoCity(user, req);
  try {
    const result = await handleChat(message.trim(), user);
    res.json({ ...result, user: publicUserShape({ ...user, chats_used: user.chats_used + (user.is_guest ? 1 : 0) }) });
  } catch (e) {
    console.error('[chat]', e);
    if (e.code === 'overloaded') {
      return res.status(503).json({ error: 'service_busy', retryable: true });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ───── remote control (StackChan pet) ──────────────────────────────────
   The pet's proxy POSTs a spoken request here (shared-token auth); the
   owner's open PWA polls GET and runs it through the normal chat path.
   Single-slot mailbox: a newer command replaces an unconsumed older one. */
let remoteCmd = null; // { text, ts }

app.post('/api/remote', (req, res) => {
  const token = process.env.REMOTE_TOKEN;
  if (!token || req.get('x-remote-token') !== token) {
    return res.status(401).json({ error: 'bad token' });
  }
  const { message } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  remoteCmd = { text: message.trim(), ts: Date.now() };
  res.json({ ok: true });
});

/* Watch-mode remote: play on the BOX speaker via the headless player (same DJ,
   same radio) instead of a browser tab. Shared-token auth like /api/remote. */
app.post('/api/box-play', (req, res) => {
  const token = process.env.REMOTE_TOKEN;
  if (!token || req.get('x-remote-token') !== token) {
    return res.status(401).json({ error: 'bad token' });
  }
  const { message } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  boxPlayEnqueue(message.trim());
  res.json({ ok: true });
});

/* Box player transport controls (watch buttons): next | prev | stop. */
app.post('/api/box-control', (req, res) => {
  const token = process.env.REMOTE_TOKEN;
  if (!token || req.get('x-remote-token') !== token) {
    return res.status(401).json({ error: 'bad token' });
  }
  const { action } = req.body ?? {};
  if (!['next', 'prev', 'stop', 'pause', 'volup', 'voldown'].includes(action)) {
    return res.status(400).json({ error: 'bad action' });
  }
  boxControl(action);
  res.json({ ok: true });
});

app.get('/api/remote', (req, res) => {
  // Only the owner's signed-in player may consume commands (any session when
  // ADMIN_EMAIL is unset, i.e. a private home instance).
  const user = resolveUser(req, res);
  const admin = process.env.ADMIN_EMAIL;
  if (admin && user?.email?.toLowerCase() !== admin.toLowerCase()) {
    return res.json(null);
  }
  const cmd = remoteCmd && Date.now() - remoteCmd.ts < 300_000 ? remoteCmd : null;
  remoteCmd = null;
  res.json(cmd);
});

app.post('/api/auto-show', async (req, res) => {
  const user = resolveUser(req, res);
  if (!user) return res.status(401).json({ error: 'signin_required' });
  if (user.is_guest) return res.status(403).json({ error: 'signin_required' });
  await ensureGeoCity(user, req);
  try {
    const result = await handleAutoShow(user);
    res.json(result);
  } catch (e) {
    console.error('[auto-show]', e);
    if (e.code === 'overloaded') {
      return res.status(503).json({ error: 'service_busy', retryable: true });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reactions', (req, res) => {
  const user = resolveUser(req, res);
  if (!user) return res.status(401).json({ error: 'no_session' });
  res.json({ reactions: listReactions(user.id) });
});

app.post('/api/reactions', (req, res) => {
  const user = requireSignedIn(req, res);
  if (!user) return;
  const { videoId, reaction, title, artist } = req.body ?? {};
  if (typeof videoId !== 'string' || !videoId) {
    return res.status(400).json({ error: 'videoId required' });
  }
  const r = Number(reaction);
  if (![0, 1, -1].includes(r)) {
    return res.status(400).json({ error: 'reaction must be -1, 0, or 1' });
  }
  setReaction(user.id, { videoId, reaction: r, title, artist });
  res.json({ ok: true });
});

// Long-poll for a deferred patter MP3. The client fires this immediately
// after /api/chat returns; the response holds open until TTS resolves
// (typically 0.5–5s on warm, much longer on cold) or the timeout trips.
app.get('/api/patter/:id', async (req, res) => {
  const item = getPendingPatter(req.params.id);
  if (!item) return res.status(404).json({ error: 'expired_or_unknown' });
  const timeout = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 45_000));
  const winner = await Promise.race([item.promise, timeout]);
  if (winner === '__timeout__') return res.status(504).json({ error: 'timeout' });
  res.json({ sayAudioUrl: winner || null });
});

app.post('/api/played', (req, res) => {
  const user = resolveUser(req, res);
  if (!user) return res.status(401).json({ error: 'no_session' });
  const { videoId, title, artist, query } = req.body ?? {};
  if (typeof videoId !== 'string' || !videoId) {
    return res.status(400).json({ error: 'videoId required' });
  }
  recordPlay({ videoId, title, artist, query, userId: user.id });
  res.json({ ok: true });
});

// Country-scoped starter queue for cold page loads. All backing queries are
// indexed lookups (sub-ms), so no cache — the moment the chart scheduler
// writes fresh data, callers see it. Simplicity > premature optimization.
const PRESET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PRESET_LIMIT = 8;
const HARD_FALLBACK_PRESET = [
  { videoId: '1OZDaRhHHyM', title: 'Merry Christmas Mr. Lawrence', artist: 'Ryuichi Sakamoto', duration: '4:49' },
];

function computePreset(country) {
  // Preference order:
  //   1. This month's Apple-derived chart snapshot for the caller's country.
  //   2. Country top plays over the last 30 days (from our own listens).
  //   3. Global top plays (last 30 days across everyone).
  //   4. Hardcoded singleton if the DB has nothing at all.
  if (country) {
    const chart = getChartsForCountryMonth(country, currentMonthKey(), PRESET_LIMIT);
    if (chart.length >= 3) {
      return {
        tracks: chart.map((r) => ({
          videoId: r.video_id,
          title: r.title || '?',
          artist: r.artist || '',
          rank: r.rank,
        })),
        source: 'chart',
      };
    }
  }
  const sinceTs = Date.now() - PRESET_WINDOW_MS;
  const countryHits = country ? getTopPlaysByCountry(country, sinceTs, PRESET_LIMIT) : [];
  const globalHits = countryHits.length >= 3
    ? []
    : getTopPlaysGlobal(sinceTs, PRESET_LIMIT);
  const raw = countryHits.length >= 3 ? countryHits : globalHits;
  if (raw.length) {
    return {
      tracks: raw.map((r) => ({
        videoId: r.video_id,
        title: r.title || '?',
        artist: r.artist || '',
        playCount: r.play_count,
      })),
      source: countryHits.length >= 3 ? 'plays_country' : 'plays_global',
    };
  }
  return { tracks: HARD_FALLBACK_PRESET, source: 'fallback' };
}

app.get('/api/preset', async (req, res) => {
  // Country + city attribution: prefer the caller's saved settings; fall
  // back to a fresh IP lookup for pure anonymous callers.
  let country = null;
  let city = null;
  const user = resolveUser(req, res);
  if (user) {
    const s = getSettings(user.id);
    country = s?.country_code || null;
    city = s?.weather_city || null;
  }
  if (!country || !city) {
    const geo = await lookupCityForIp(req.ip).catch(() => null);
    country ||= geo?.country || null;
    city ||= geo?.city || null;
  }
  const { tracks, source } = computePreset(country);
  res.json({ country, city, tracks, source });
});

// Public — guests can browse song info too. No auth gate.
app.get('/api/song-info', async (req, res) => {
  const artist = String(req.query.artist ?? '').trim();
  const title = String(req.query.title ?? '').trim();
  if (!artist && !title) {
    return res.status(400).json({ error: 'artist or title required' });
  }
  try {
    const info = await getSongInfo({ artist, title });
    res.json(info);
  } catch (e) {
    console.warn('[song-info]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const hits = await searchSongs(q, 8);
    res.json({ hits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`miaoRadio listening on http://localhost:${PORT}`);
  if (process.env.BOX_PLAYER === '1') startBoxPlayer();   // headless speaker player (watch mode)
  // Warm cold caches so the first real chat doesn't pay 60+ seconds for
  // Innertube to bootstrap. Fire and forget — failures don't block serving.
  warmup();
  // Kicks off the monthly chart-snapshot self-healer: check on boot, then
  // re-check every 24h. Fetches Apple's country RSS + resolves each track
  // to a videoId via our YT search. Idempotent — same-month reruns skip.
  startChartsScheduler();
});

async function warmup() {
  const t0 = Date.now();
  // Run YT and TTS warmups in parallel — both have ~70s cold-start penalties
  // we want to eat at boot rather than on the user's first chat.
  await Promise.allSettled([
    (async () => {
      const start = Date.now();
      try {
        const r = await searchSongs('warmup', 1);
        console.log(`[warmup] yt ready in ${Date.now() - start}ms (sample: ${r[0]?.title || 'n/a'})`);
      } catch (e) {
        console.warn(`[warmup] yt failed: ${e.message}`);
      }
    })(),
    (async () => {
      const start = Date.now();
      try {
        // Cheap probe ("·") so the on-disk cache picks it up too. Trivial cost
        // (~$0.001 per boot, deploys happen rarely).
        await synthesizeAndCache('·');
        console.log(`[warmup] tts ready in ${Date.now() - start}ms`);
      } catch (e) {
        console.warn(`[warmup] tts failed: ${e.message}`);
      }
    })(),
  ]);
  console.log(`[warmup] total ${Date.now() - t0}ms`);
}
