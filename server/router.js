import { callClaude, parseDJResponse } from './claude.js';
import { buildSystemPrompt } from './context.js';
import { searchSongs } from './ytmusic.js';
import { synthesizeAndCache } from './tts.js';
import { recordMessage } from './state.js';

export async function handleChat(message) {
  recordMessage('user', message);
  const system = await buildSystemPrompt({ userMessage: message });
  const wrapper = await callClaude({ system, user: message });

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
