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
  const system = await buildSystemPrompt({ userMessage: langHint, userId: user.id });
  const wrapper = await callClaude({ system, user: trigger });

  if (wrapper.is_error || (wrapper.subtype && wrapper.subtype !== 'success')) {
    throw new Error(`claude error: ${wrapper.result || JSON.stringify(wrapper).slice(0, 200)}`);
  }

  const dj = parseDJResponse(wrapper.result ?? '');

  const [enriched, sayAudioUrl] = await Promise.all([
    Promise.all(
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
    ),
    synthesizeAndCache(dj.say, {
      referenceId: getSettings(user.id)?.tts_reference_id || undefined,
    }).catch((e) => {
      console.warn('[tts]', e.message);
      return null;
    }),
  ]);

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
    sayAudioUrl,
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
