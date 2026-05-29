import express from 'express';
import path from 'node:path';
import { handleChat, handleAutoShow } from './router.js';
import { searchSongs } from './ytmusic.js';
import { lookupCityForIp } from './geo.js';
import {
  recordPlay,
  getCorpus,
  setCorpus,
  getSettings,
  setSettings,
  getGoogleTokens,
  deleteGoogleTokens,
  setReaction,
  listReactions,
} from './state.js';
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
  if (existing?.weather_city) return;
  const geo = await lookupCityForIp(req.ip).catch(() => null);
  if (geo?.city) {
    setSettings(user.id, {
      weather_city: geo.city,
      tts_reference_id: existing?.tts_reference_id || null,
    });
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
  const { weather_city, tts_reference_id } = req.body ?? {};
  setSettings(user.id, {
    weather_city: (weather_city ?? '').trim() || null,
    tts_reference_id: (tts_reference_id ?? '').trim() || null,
  });
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
    res.status(500).json({ error: e.message });
  }
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
});
