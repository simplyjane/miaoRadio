# miaoRadio

A personal AI music radio station. Claude is the DJ — it picks songs from YouTube Music to match the moment (time, weather, calendar, your taste, your mood) and reads short on-air patter between sets through a custom TTS voice. The station auto-continues: it pre-fetches the next set 5 minutes before the queue runs out, then splices a spoken DJ break and the new tracks in seamlessly.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser (PWA)                           │
│  pwa/index.html · pwa/app.js · pwa/style.css                     │
│                                                                  │
│  • YouTube IFrame player (audio playback)                        │
│  • <audio> element for DJ patter (TTS)                           │
│  • Auto-start on load + prefetch when <5 min remains             │
└──────────────────────┬───────────────────────────────────────────┘
                       │ HTTP (8080)
┌──────────────────────▼───────────────────────────────────────────┐
│                      Express server                              │
│  server/index.js                                                 │
│                                                                  │
│  POST /api/chat        — user-seeded show                        │
│  POST /api/auto-show   — DJ continues the show on its own        │
│  POST /api/played      — log a play to SQLite                    │
│  GET  /api/search      — direct YT Music search (debug)          │
└──┬─────────────┬─────────────┬─────────────┬───────────┬─────────┘
   │             │             │             │           │
   │             │             │             │           │
┌──▼──────┐  ┌───▼─────┐  ┌────▼─────┐  ┌────▼─────┐ ┌───▼──────┐
│ Claude  │  │ YT      │  │ Fish     │  │ OpenWeather    Google │
│ CLI     │  │ Music   │  │ Audio    │  │           │  Calendar │
│(subproc)│  │(youtubei│  │ TTS      │  │           │   OAuth   │
└─────────┘  │  .js)   │  └──────────┘  └───────────┘ └──────────┘
             └─────────┘
                                ┌─────────────────┐
                                │  SQLite (WAL)   │
                                │  state.db       │
                                │   · messages    │
                                │   · plays       │
                                └─────────────────┘
```

### Request flow (per DJ turn)

1. Client POSTs `/api/chat` (user-seeded) or `/api/auto-show` (auto-continue).
2. `router.js` builds the system prompt via `context.js`, which concatenates:
   - `prompts/dj-persona.md` — DJ persona + output format spec
   - `user/taste.md`, `user/routines.md`, `user/mood-rules.md`
   - Today's Google Calendar events
   - Current OpenWeather snapshot
   - Last 10 messages from SQLite
   - Last 30 plays (to avoid repeats)
   - Local time + timezone + weekday
3. `claude.js` calls the Anthropic API (`@anthropic-ai/sdk`) with the system prompt + user trigger. The system prompt is sent as two blocks — the stable part (persona + user corpus) carries `cache_control: { type: 'ephemeral' }` so successive DJ turns within ~5 min hit the prompt cache.
4. Claude returns XML-tagged response (`<say>`, `<play>`, `<reason>`, `<segue>`) per `prompts/dj-persona.md`. `parseDJResponse` extracts them.
5. In parallel:
   - Each `<play>` line is searched on YT Music (`ytmusic.js → searchSongs`) to resolve a `videoId`, `title`, `artist`, `duration`, `thumbnail`.
   - `<say>` is sent to Fish Audio TTS (`tts.js`), cached on disk (`cache/tts/*.mp3`), and the URL returned.
6. The DJ message is stored in `messages`; client receives `{ say, sayAudioUrl, play, misses, reason, segue }`.

---

## Auto-DJ (the "real radio" loop)

The station runs itself once seeded. State machine lives in `pwa/app.js`.

| Trigger                              | What happens                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Page open                            | Fetch `/api/auto-show` immediately; apply once the YT player fires `onReady`. (Avoids a race where queue loads before the iframe exists.) |
| Remaining queue time ≤ **5 minutes** | Background `POST /api/auto-show`. Stash the result in `state.pendingNext`. UI shows `auto · NEXT SET READY`.       |
| Last track ends                      | If `pendingNext` is stashed: speak the DJ patter (TTS), then append tracks and continue playing. Zero silence.     |
| Queue ends, prefetch still running   | UI shows `WAITING FOR NEXT SET`. The moment the response arrives, the splice happens.                              |
| Manual chat / Stop button            | Invalidates any in-flight prefetch via `state.prefetchToken`. Stale responses are discarded.                       |

### Remaining-time math (client)

```
remaining = (current track: player.getDuration() − player.getCurrentTime())
          + Σ parsed-duration("M:SS") of upcoming tracks
fallback per missing duration: 240s
```

The check runs every 500 ms inside the existing progress tick (no extra timer).

### Language continuity in auto mode

The auto trigger is an English instruction string, which would normally make the DJ reply in English. To prevent language flips, `handleAutoShow` reads the **last real user message** from SQLite via `getLastUserMessage()` and passes it to `buildSystemPrompt` for the language-hint heuristic.

### Browser autoplay caveat

The first cold-load track may need one user click — browsers block audio playback without a prior gesture. After that initial click, every subsequent set transition plays automatically (the page is now "interactive" and YT/HTMLAudio are unblocked). The PWA forces `iframeWrap` visible and uses `playerVars.autoplay: 1, playsinline: 1`.

---

## Repository layout

```
miaoRadio/
├── server/
│   ├── index.js          Express routes + static hosting
│   ├── router.js         handleChat / handleAutoShow / runDJ pipeline
│   ├── context.js        Builds the system prompt
│   ├── claude.js         Spawns `claude` CLI, parses <tagged> output
│   ├── ytmusic.js        youtubei.js wrapper
│   ├── tts.js            Fish Audio + on-disk cache
│   ├── weather.js        OpenWeather (10-min memo cache)
│   ├── calendar.js       Google Calendar via OAuth refresh token
│   └── state.js          better-sqlite3: users, sessions, corpus, plays…
├── pwa/
│   ├── index.html        Markup (panels: hero, now-playing, queue, DJ, iframe)
│   ├── app.js            Player state machine + auto-DJ logic
│   └── style.css         Dot-matrix radio aesthetic
├── prompts/
│   └── dj-persona.md     DJ persona + strict output format
├── user/                 ← editable by you, hot-read each request
│   ├── taste.md          Free-form taste corpus
│   ├── routines.md       Time-of-day routines ("9pm = reading")
│   ├── mood-rules.md     Rules ("rainy + Sunday → quiet")
│   └── playlists.json    (unused at the moment)
├── cache/tts/            TTS mp3s, content-addressed by SHA1
├── state.db              SQLite (WAL mode)
└── package.json
```

---

## Environment

`.env` at repo root. Loaded via `node --env-file=.env`.

| Variable | Purpose | Required |
| -------- | ------- | -------- |
| `PORT` | HTTP port (default 8080) | no |
| `PUBLIC_URL` | Public-facing origin used for the OAuth redirect URI (default `http://localhost:$PORT`) | no |
| `ANTHROPIC_API_KEY` | Anthropic API key for the DJ | **yes** |
| `CLAUDE_MODEL` | `sonnet` (default), `opus`, `haiku`, or a full API model ID like `claude-sonnet-4-6` | no |
| `CLAUDE_MAX_TOKENS` | Cap on DJ response length (default 1024) | no |
| `SESSION_SECRET` | HMAC key for session cookies + OAuth state (≥16 chars; generate with `openssl rand -hex 32`) | **yes (for auth)** |
| `INVITE_CODES` | Comma-separated codes that grant signup access, e.g. `90E5685CDE,65598B4E18` | **yes (for auth)** |
| `FISH_AUDIO_API_KEY` | Fish Audio TTS bearer token; DJ patter is silent without it | no |
| `FISH_AUDIO_REFERENCE_ID` | Voice clone reference id on Fish Audio | no |
| `FISH_AUDIO_MODEL` | TTS model (default `s1`) | no |
| `OPENWEATHER_API_KEY` | OpenWeather current-weather API | no |
| `OPENWEATHER_CITY` | City query string (default `Shanghai`) | no |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (used for sign-in **and** per-user Calendar connect) | no (both or neither) |

Everything except `ANTHROPIC_API_KEY` is optional — the DJ degrades gracefully (no weather → skips that section; no Fish key → silent patter; no Calendar → no schedule context).

### Anthropic API

The server uses `@anthropic-ai/sdk`. The system prompt is split into a stable block (persona + your taste/routines/mood corpus) sent with `cache_control: { type: 'ephemeral' }`, and a volatile block (time, weather, calendar, recent chats, recently played) sent uncached. With Sonnet, repeat turns inside the 5-minute cache window read most of the prompt at ~10% of the full price.

---

## Running

```bash
npm install
npm run dev    # node --watch
# or
npm start
```

Open http://localhost:8080. The DJ tunes in automatically.

Calendar setup happens per-user inside the PWA — open SETTINGS → "Connect Google Calendar".

---

## Data model

```sql
-- server/state.js (auto-created + migrated on boot)
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub    TEXT UNIQUE,         -- NULL while guest
  email, name, picture_url, invite_code,
  is_guest      INTEGER DEFAULT 0,
  chats_used    INTEGER DEFAULT 0,    -- enforced against GUEST_CHAT_LIMIT (3)
  created_at    INTEGER
);
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER REFERENCES users ON DELETE CASCADE,
  created_at, expires_at
);
CREATE TABLE messages (
  id, ts, role CHECK(role IN ('user','dj')), content,
  user_id INTEGER REFERENCES users ON DELETE CASCADE
);
CREATE TABLE plays (
  id, ts, video_id, title, artist, query,
  user_id INTEGER REFERENCES users ON DELETE CASCADE
);
CREATE TABLE user_corpus (
  user_id     INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  taste, routines, mood_rules, updated_at
);
CREATE TABLE user_settings (
  user_id           INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  weather_city, tts_reference_id, updated_at
);
CREATE TABLE user_google (
  user_id        INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  refresh_token, access_token, expires_at, scopes, email, updated_at
);
```

Everything is scoped per user. `messages` feeds RECENT CHATS in the prompt + drives auto-mode language detection. `plays` feeds RECENTLY PLAYED so the DJ doesn't loop. `user_corpus` replaces the on-disk `user/*.md` files for signed-in users (files remain as the guest default and the admin's seed data). `user_settings` overrides `OPENWEATHER_CITY` and `FISH_AUDIO_REFERENCE_ID` per user. `user_google` stores per-user Calendar OAuth refresh tokens (separate from the sign-in OAuth — uses `calendar.readonly` scope, `prompt=consent` to guarantee a refresh token).

---

## DJ output contract

From `prompts/dj-persona.md`:

```xml
<say>1–3 sentence patter, language-matched to user's latest message</say>
<play>
artist - track title
artist - track title
</play>
<reason>private note about the picks</reason>
<segue>(optional) framing for what comes next</segue>
```

`<play>` is one search query per line — each gets a YT Music lookup. Empty `<play>` means the DJ chose to just chat.

---

## HTTP API

All `/api/*` routes (except auth) require a session cookie (`mr_sid`). A guest session is created automatically on first `/api/chat` hit, so first-time visitors don't need to sign up to try the radio.

### Auth

| Method | Path                       | Body / Query                          | Returns |
| ------ | -------------------------- | ------------------------------------- | ------- |
| GET    | `/api/auth/me`             | —                                     | `{ user: null | { id, email, name, picture, isGuest, chatsUsed, chatsLimit } }` |
| GET    | `/api/auth/validate-code`  | `?code=<invite>`                      | `200 { ok: true }` or `400 { ok: false, error: 'invalid_code' }` |
| GET    | `/api/auth/start`          | `?code=<invite>`                      | 302 → Google OAuth consent screen |
| GET    | `/api/auth/callback`       | `?code&state` (from Google)           | 302 → `/` (success) or `/?login=1&error=...` |
| POST   | `/api/auth/signout`        | —                                     | `{ ok: true }`, clears cookie |

### Radio

| Method | Path             | Body                                                 | Returns |
| ------ | ---------------- | ---------------------------------------------------- | ------- |
| POST   | `/api/chat`      | `{ message: string }`                                | `{ say, sayAudioUrl, play[], misses[], reason, segue, user }` — `402 { error: 'signup_required' }` after 3 trial chats |
| POST   | `/api/auto-show` | —                                                    | Same shape as `/api/chat`. `401`/`403` for guests. |
| POST   | `/api/played`    | `{ videoId, title?, artist?, query? }`               | `{ ok: true }` |
| GET    | `/api/search`    | `?q=<query>`                                         | `{ hits: [{ videoId, title, artist, duration, thumbnail }] }` |

### Settings (signed-in only)

| Method | Path                              | Body / Query                                                        | Returns |
| ------ | --------------------------------- | ------------------------------------------------------------------- | ------- |
| GET    | `/api/me/corpus`                  | —                                                                   | `{ taste, routines, mood_rules }` |
| POST   | `/api/me/corpus`                  | `{ taste, routines, mood_rules }`                                   | `{ ok: true }` |
| GET    | `/api/me/settings`                | —                                                                   | `{ weather_city, tts_reference_id, calendar_connected, calendar_email }` |
| POST   | `/api/me/settings`                | `{ weather_city, tts_reference_id }`                                | `{ ok: true }` |
| GET    | `/api/me/calendar/start`          | —                                                                   | 302 → Google OAuth with `calendar.readonly` scope |
| GET    | `/api/me/calendar/callback`       | `?code&state`                                                       | 302 → `/?settings=1&calendar=ok` |
| POST   | `/api/me/calendar/disconnect`     | —                                                                   | `{ ok: true }` — drops the stored refresh token |

Static files: `pwa/` at `/`, TTS mp3s at `/tts/*.mp3` (7-day immutable cache).

## Auth setup

The PWA uses **invite code + Google sign-in**. First-time visitors get **3 trial chats** as a guest (cookie-tracked, server-side counter); after that they hit a signup wall.

**To enable auth locally:**

1. Generate a session secret and add a few invite codes:
   ```bash
   echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
   echo "INVITE_CODES=$(openssl rand -hex 5 | tr a-f A-F),$(openssl rand -hex 5 | tr a-f A-F)" >> .env
   ```
2. Reuse your existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (already in `.env` for Calendar) **but** add a new authorized redirect URI to the OAuth client in Google Cloud Console: `http://localhost:8080/api/auth/callback` (and your prod URL when you deploy).
3. Restart the server. Visit `/`, you'll get a guest session automatically. Click **SIGN UP** in the header, enter a code, sign in with Google.

The OAuth `state` parameter is HMAC-signed with `SESSION_SECRET` so the invite code survives the round-trip to Google without server-side state.
