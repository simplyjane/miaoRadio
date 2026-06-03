import crypto from 'node:crypto';
import { callClaude, parseDJResponse } from './claude.js';
import { buildSystemPrompt } from './context.js';
import { searchSongs } from './ytmusic.js';
import { synthesizeAndCache } from './tts.js';
import {
  recordMessage,
  getLastUserMessage,
  incrementChatsUsed,
  getSettings,
  getDislikedVideoIds,
  getRecentLikedVideoIds,
} from './state.js';

// Liked songs are taste *signals*, not "play again" requests. Suppress the
// literal track from auto-picks for this long after a like — the DJ should
// be recommending similar tracks, not the same one.
const LIKE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Pending TTS jobs that the client can pick up via /api/patter/:id while the
// queue is already showing. Each entry holds the synth promise + a creation
// timestamp; we sweep entries older than 5 min so the Map can't grow.
const PATTER_TTL_MS = 5 * 60 * 1000;
const pendingPatter = new Map(); // id → { promise, createdAt }
setInterval(() => {
  const cutoff = Date.now() - PATTER_TTL_MS;
  for (const [id, item] of pendingPatter) {
    if (item.createdAt < cutoff) pendingPatter.delete(id);
  }
}, 60_000).unref?.();

export function getPendingPatter(id) {
  return pendingPatter.get(id);
}

export async function handleChat(message, user) {
  recordMessage('user', message, user.id);
  if (user.is_guest) incrementChatsUsed(user.id);
  return runDJ({ trigger: message, langHint: message, user });
}

export async function handleAutoShow(user) {
  const trigger = [
    '[AUTO-CONTINUE]',
    'The current on-air queue is about to run out. Continue your show.',
    'Pick 4–6 fresh tracks that fit RIGHT NOW: time of day, weather, mood signals,',
    "today's calendar, and the user's taste corpus. Do NOT repeat anything in RECENTLY PLAYED.",
    'In <say>, write a short on-air transition (1–2 sentences) — like a radio DJ bridging into the next set.',
    'No questions; the listener is not at the keyboard. Just keep the show going.',
  ].join(' ');
  const langHint = getLastUserMessage(user.id);
  return runDJ({ trigger, langHint, user });
}

async function runDJ({ trigger, langHint, user }) {
  const t0 = Date.now();
  const system = await buildSystemPrompt({
    userMessage: langHint,
    userId: user.id,
    userName: user.name,
  });
  const tPrompt = Date.now();

  const wrapper = await callClaude({ system, user: trigger });
  const tClaude = Date.now();

  if (wrapper.is_error || (wrapper.subtype && wrapper.subtype !== 'success')) {
    throw new Error(`claude error: ${wrapper.result || JSON.stringify(wrapper).slice(0, 200)}`);
  }

  const dj = parseDJResponse(wrapper.result ?? '');
  const tParse = Date.now();

  // Kick off TTS in parallel with YT — but DON'T block the response on it.
  // The client picks up the patter URL through /api/patter/:id once it's
  // ready, while the queue is already on screen.
  const ttsStart = Date.now();
  let ttsDone = 0;
  const patterPromise = synthesizeAndCache(dj.say, {
    referenceId: getSettings(user.id)?.tts_reference_id || undefined,
  }).then((r) => { ttsDone = Date.now(); return r; }).catch((e) => {
    console.warn('[tts]', e.message);
    ttsDone = Date.now();
    return null;
  });
  const sayAudioPendingId = dj.say
    ? crypto.randomBytes(8).toString('hex')
    : null;
  if (sayAudioPendingId) {
    pendingPatter.set(sayAudioPendingId, {
      promise: patterPromise,
      createdAt: Date.now(),
    });
  }

  // YT searches are the only thing the response actually waits on.
  const ytStart = Date.now();
  const enriched = await Promise.all(
    dj.play.map(async (item) => {
      const query = typeof item === 'string' ? item : item?.query;
      if (!query) return { query: null, error: 'empty query' };
      try {
        const hits = await searchSongs(query, 1);
        if (!hits.length) return { query, error: 'not found' };
        return { query, ...hits[0] };
      } catch (e) {
        return { query, error: e.message };
      }
    }),
  );
  const ytDone = Date.now();
  const tEnrich = Date.now();

  const usage = wrapper.usage || {};
  console.log(
    `[runDJ] user=${user.id} ` +
    `total=${tEnrich - t0}ms ` +
    `prompt=${tPrompt - t0}ms ` +
    `claude=${tClaude - tPrompt}ms ` +
    `(in=${usage.input_tokens ?? '?'} ` +
    `cache_read=${usage.cache_read_input_tokens ?? 0} ` +
    `out=${usage.output_tokens ?? '?'}) ` +
    `parse=${tParse - tClaude}ms ` +
    `yt=${ytDone - ytStart}ms ` +
    `tts=${ttsDone - ttsStart}ms ` +
    `tracks=${dj.play.length}`,
  );

  if (dj.say) recordMessage('dj', dj.say, user.id);

  // Safety net: drop any disliked tracks AND recently-liked tracks (cooldown).
  const disliked = getDislikedVideoIds(user.id);
  const recentLiked = getRecentLikedVideoIds(user.id, Date.now() - LIKE_COOLDOWN_MS);
  const filtered = enriched.filter(
    (x) => !x.error && !disliked.has(x.videoId) && !recentLiked.has(x.videoId),
  );
  const droppedDisliked = enriched.filter((x) => !x.error && disliked.has(x.videoId));
  const droppedRecentLiked = enriched.filter(
    (x) => !x.error && !disliked.has(x.videoId) && recentLiked.has(x.videoId),
  );

  return {
    say: dj.say,
    sayAudioUrl: null,           // deferred — client picks up via /api/patter/:id
    sayAudioPendingId,
    play: filtered,
    misses: [
      ...enriched.filter((x) => x.error),
      ...droppedDisliked.map((x) => ({ query: x.query, error: 'disliked' })),
      ...droppedRecentLiked.map((x) => ({ query: x.query, error: 'recently_liked' })),
    ],
    reason: dj.reason,
    segue: dj.segue,
  };
}
