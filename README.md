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
3. `claude.js` spawns `claude --print --output-format json` and feeds the system prompt + trigger.
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
│   ├── state.js          better-sqlite3: messages + plays tables
│   └── scripts/
│       └── auth-google.js   one-time OAuth bootstrap
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
| `CLAUDE_MODEL` | Model alias passed to `claude --model`; defaults to `opus` | no |
| `FISH_AUDIO_API_KEY` | Fish Audio TTS bearer token; DJ patter is silent without it | no |
| `FISH_AUDIO_REFERENCE_ID` | Voice clone reference id on Fish Audio | no |
| `FISH_AUDIO_MODEL` | TTS model (default `s1`) | no |
| `OPENWEATHER_API_KEY` | OpenWeather current-weather API | no |
| `OPENWEATHER_CITY` | City query string (default `Shanghai`) | no |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Calendar OAuth | no (all three or none) |

Everything except the Claude CLI is optional — the DJ degrades gracefully (no weather → skips that section, etc.).

### Claude CLI

The server shells out to the `claude` binary. Install it however you normally do; the server runs `claude --print --output-format json --model <model> --system-prompt <…>` and pipes the trigger message into stdin.

---

## Running

```bash
npm install
npm run dev    # node --watch
# or
npm start
```

Open http://localhost:8080. The DJ tunes in automatically.

### One-time Google Calendar setup

```bash
npm run auth:google
```

The script prints an auth URL; visit it, paste the resulting code back into the terminal, and a refresh token gets written to `.env`.

---

## Data model

```sql
-- server/state.js (auto-created on boot)
CREATE TABLE messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  role    TEXT CHECK (role IN ('user', 'dj')),
  content TEXT NOT NULL
);

CREATE TABLE plays (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  title    TEXT,
  artist   TEXT,
  query    TEXT
);
```

`messages` feeds RECENT CHATS in the prompt + drives auto-mode language detection. `plays` feeds RECENTLY PLAYED so the DJ doesn't loop.

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

| Method | Path             | Body                                                 | Returns |
| ------ | ---------------- | ---------------------------------------------------- | ------- |
| POST   | `/api/chat`      | `{ message: string }`                                | `{ say, sayAudioUrl, play[], misses[], reason, segue }` |
| POST   | `/api/auto-show` | —                                                    | same shape as `/api/chat` |
| POST   | `/api/played`    | `{ videoId, title?, artist?, query? }`               | `{ ok: true }` |
| GET    | `/api/search`    | `?q=<query>`                                         | `{ hits: [{ videoId, title, artist, duration, thumbnail }] }` |

Static files: `pwa/` at `/`, TTS mp3s at `/tts/*.mp3` (7-day immutable cache).
