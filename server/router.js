import { callClaude, parseDJResponse } from './claude.js';
import { buildSystemPrompt } from './context.js';
import { searchSongs } from './ytmusic.js';
import { synthesizeAndCache } from './tts.js';
import { recordMessage, getLastUserMessage } from './state.js';

export async function handleChat(message) {
  recordMessage('user', message);
  return runDJ({ trigger: message, langHint: message });
}

export async function handleAutoShow() {
  const trigger = [
    '[AUTO-CONTINUE]',
    'The current on-air queue is about to run out. Continue your show.',
    'Pick 4–6 fresh tracks that fit RIGHT NOW: time of day, weather, mood signals,',
    'today\'s calendar, and the user\'s taste corpus. Do NOT repeat anything in RECENTLY PLAYED.',
    'In <say>, write a short on-air transition (1–2 sentences) — like a radio DJ bridging into the next set.',
    'No questions; the listener is not at the keyboard. Just keep the show going.',
  ].join(' ');
  // Use the user's most recent real message for language detection so the
  // auto-segment doesn't switch language just because the trigger is English.
  const langHint = getLastUserMessage();
  return runDJ({ trigger, langHint });
}

async function runDJ({ trigger, langHint }) {
  const system = await buildSystemPrompt({ userMessage: langHint });
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
    synthesizeAndCache(dj.say).catch((e) => {
      console.warn('[tts]', e.message);
      return null;
    }),
  ]);

  if (dj.say) recordMessage('dj', dj.say);

  return {
    say: dj.say,
    sayAudioUrl,
    play: enriched.filter((x) => !x.error),
    misses: enriched.filter((x) => x.error),
    reason: dj.reason,
    segue: dj.segue,
  };
}
