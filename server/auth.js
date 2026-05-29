import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createGuestUser,
  createSession,
  getSession,
  getUserById,
  getUserByGoogleSub,
  bindGuestToGoogle,
  createSignedInUser,
  deleteUser,
  deleteSession,
  getCorpus,
  setCorpus,
  setGoogleTokens,
} from './state.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const COOKIE_NAME = 'mr_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;       // 10 minutes
export const GUEST_CHAT_LIMIT = 3;

/* ───── env-driven config ──────────────────────────────────────────────── */

export function getInviteCodes() {
  return (process.env.INVITE_CODES || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

export function isValidInviteCode(code) {
  if (!code || typeof code !== 'string') return false;
  return getInviteCodes().includes(code.trim());
}

function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET must be set (≥16 chars). Run: openssl rand -hex 32');
  }
  return s;
}

function getPublicUrl() {
  return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
}

function getGoogleClientId() {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not set');
  return id;
}

function getGoogleClientSecret() {
  const s = process.env.GOOGLE_CLIENT_SECRET;
  if (!s) throw new Error('GOOGLE_CLIENT_SECRET is not set');
  return s;
}

export function getRedirectUri() {
  return `${getPublicUrl()}/api/auth/callback`;
}

/* ───── HMAC-signed OAuth state (no server-side storage) ───────────────── */

export function signOAuthState({ code }) {
  const payload = { code, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.ts !== 'number') return null;
    if (Date.now() - payload.ts > OAUTH_STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ───── cookies ────────────────────────────────────────────────────────── */

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildCookie(name, value, { maxAgeMs, deleteCookie } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (deleteCookie) {
    parts.push('Max-Age=0');
  } else if (maxAgeMs != null) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }
  // Use Secure cookies behind HTTPS only — if PUBLIC_URL is https or the
  // request is forwarded as https, set the flag.
  if ((process.env.PUBLIC_URL || '').startsWith('https://')) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, token, { maxAgeMs: SESSION_TTL_MS }));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, '', { deleteCookie: true }));
}

/* ───── session creation + lookup ──────────────────────────────────────── */

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function startSessionFor(userId, res) {
  const token = newSessionToken();
  createSession(userId, token, SESSION_TTL_MS);
  setSessionCookie(res, token);
  return token;
}

export function endSession(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) deleteSession(token);
  clearSessionCookie(res);
}

/**
 * Look up the user from the request cookie. If none exists, optionally
 * create a guest user + session (so /api/chat can transparently track them).
 */
export function resolveUser(req, res, { createGuest = false } = {}) {
  const cookies = parseCookies(req);
  let token = cookies[COOKIE_NAME];
  let session = getSession(token);
  let user = session ? getUserById(session.user_id) : null;

  if (!user && createGuest) {
    const userId = createGuestUser();
    token = newSessionToken();
    createSession(userId, token, SESSION_TTL_MS);
    setSessionCookie(res, token);
    user = getUserById(userId);
  }
  return user;
}

/* ───── Google OAuth ───────────────────────────────────────────────────── */

export function buildGoogleAuthUrl({ code }) {
  const state = signOAuthState({ code });
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function getCalendarRedirectUri() {
  return `${getPublicUrl()}/api/me/calendar/callback`;
}

export function signCalendarState({ userId }) {
  const payload = { kind: 'cal', userId, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyCalendarState(state) {
  if (!state || typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.kind !== 'cal') return null;
    if (Date.now() - payload.ts > OAUTH_STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildCalendarAuthUrl({ userId }) {
  const state = signCalendarState({ userId });
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: getCalendarRedirectUri(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code, { redirectUri } = {}) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      redirect_uri: redirectUri || getRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`google token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  return data; // { access_token, refresh_token, id_token, expires_in, scope, ... }
}

export async function exchangeCalendarCode(code, userId) {
  const tokens = await exchangeCodeForTokens(code, { redirectUri: getCalendarRedirectUri() });
  if (!tokens.refresh_token) {
    // Google omits refresh_token when the user previously authorized this scope
    // without `prompt=consent` — we set that flag so this shouldn't happen, but
    // surface it if it does.
    throw new Error('google did not return a refresh_token; revoke access and reconnect');
  }
  let email = null;
  if (tokens.id_token) {
    try { email = decodeIdToken(tokens.id_token).email || null; } catch {}
  }
  setGoogleTokens(userId, {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scopes: tokens.scope || null,
    email,
  });
  return { email };
}

export function decodeIdToken(idToken) {
  // We trust the ID token because it came over a TLS-secured exchange with
  // our client_secret (RFC 6749 authorization-code flow). No JWKS verify.
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return payload; // { sub, email, email_verified, name, picture, ... }
}

/**
 * Finalize sign-up / sign-in after Google OAuth callback.
 * - If a user with this google_sub already exists, sign in to that user (and
 *   discard any guest row we may have been carrying).
 * - Else if the current cookie is a guest, convert the guest in place.
 * - Else create a fresh signed-in user.
 * Sets a new session cookie either way.
 */
export function completeSignIn(req, res, { claims, inviteCode }) {
  const currentUser = resolveUser(req, res); // no guest creation here
  const existing = getUserByGoogleSub(claims.sub);

  let userId;
  if (existing) {
    userId = existing.id;
    if (currentUser && currentUser.is_guest && currentUser.id !== existing.id) {
      deleteUser(currentUser.id); // drops their sessions + messages too via cascade
    }
  } else if (currentUser && currentUser.is_guest) {
    bindGuestToGoogle(currentUser.id, {
      googleSub: claims.sub,
      email: claims.email || null,
      name: claims.name || null,
      pictureUrl: claims.picture || null,
      inviteCode,
    });
    userId = currentUser.id;
  } else {
    userId = createSignedInUser({
      googleSub: claims.sub,
      email: claims.email || null,
      name: claims.name || null,
      pictureUrl: claims.picture || null,
      inviteCode,
    });
  }

  // One-shot: if this user matches ADMIN_EMAIL and has no corpus yet,
  // seed it from the on-disk user/*.md files. Also triggered lazily by
  // /api/me/corpus GET for existing admin accounts that pre-date this code.
  maybeSeedAdminCorpus(userId, claims.email).catch((e) =>
    console.warn('[admin-seed]', e.message),
  );

  // Issue a fresh session token for the resolved user.
  return startSessionFor(userId, res);
}

export async function maybeSeedAdminCorpus(userId, email) {
  if (!process.env.ADMIN_EMAIL || !email) return;
  if (email.toLowerCase() !== process.env.ADMIN_EMAIL.toLowerCase()) return;
  const existing = getCorpus(userId);
  if (existing && (existing.taste || existing.routines || existing.mood_rules)) {
    return; // already populated; idempotent
  }
  const [taste, routines, mood_rules] = await Promise.all([
    fs.readFile(path.join(ROOT, 'user/taste.md'), 'utf-8').catch(() => ''),
    fs.readFile(path.join(ROOT, 'user/routines.md'), 'utf-8').catch(() => ''),
    fs.readFile(path.join(ROOT, 'user/mood-rules.md'), 'utf-8').catch(() => ''),
  ]);
  if (!taste && !routines && !mood_rules) return;
  setCorpus(userId, {
    taste: taste.trim(),
    routines: routines.trim(),
    mood_rules: mood_rules.trim(),
  });
}

/* ───── shaping for the client ─────────────────────────────────────────── */

export function publicUserShape(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || null,
    name: user.name || null,
    picture: user.picture_url || null,
    isGuest: !!user.is_guest,
    chatsUsed: user.chats_used || 0,
    chatsLimit: GUEST_CHAT_LIMIT,
  };
}
