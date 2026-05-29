import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Legacy short names from when this server shelled out to the `claude` CLI.
// Map them to current API model IDs so existing .env values keep working.
const MODEL_ALIASES = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModel() {
  const raw = (process.env.CLAUDE_MODEL || '').trim();
  if (!raw) return DEFAULT_MODEL;
  return MODEL_ALIASES[raw.toLowerCase()] || raw;
}

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Call Claude. Returns a wrapper compatible with the previous CLI-based
 * shape: { result, is_error, subtype, usage?, model?, stop_reason? }.
 *
 * `system` may be a plain string OR { stable, volatile } — the latter form
 * sends two system blocks with cache_control on the stable one, which is
 * cheap for the recurring DJ turns where persona+taste don't change.
 */
export async function callClaude({ system, user, timeoutMs = 60_000 }) {
  const model = resolveModel();
  const maxTokens = Number(process.env.CLAUDE_MAX_TOKENS) || 1024;

  try {
    const response = await getClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: toSystemBlocks(system),
        messages: [{ role: 'user', content: user ?? '' }],
      },
      { timeout: timeoutMs },
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      is_error: false,
      subtype: 'success',
      result: text,
      usage: response.usage,
      model: response.model,
      stop_reason: response.stop_reason,
    };
  } catch (err) {
    return {
      is_error: true,
      subtype: 'error',
      result: err?.message || String(err),
    };
  }
}

function toSystemBlocks(system) {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }];
  }
  const blocks = [];
  if (system.stable) {
    blocks.push({
      type: 'text',
      text: system.stable,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (system.volatile) {
    blocks.push({ type: 'text', text: system.volatile });
  }
  return blocks.length ? blocks : undefined;
}

export function parseDJResponse(text) {
  if (typeof text !== 'string') text = String(text ?? '');

  const say = extractTag(text, 'say');
  const playBlock = extractTag(text, 'play');
  const reason = extractTag(text, 'reason');
  const segue = extractTag(text, 'segue');

  if (say == null && playBlock == null) {
    return { say: text.trim(), play: [], reason: 'unparsed', segue: null };
  }

  const play = (playBlock || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((query) => ({ query }));

  return {
    say: (say || '').trim(),
    play,
    reason: (reason || '').trim(),
    segue: segue ? segue.trim() : null,
  };
}

function extractTag(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1] : null;
}
