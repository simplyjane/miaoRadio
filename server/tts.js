import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { EdgeTTS } from 'node-edge-tts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache/tts');

// DJ voice backend: 'edge' (edge-tts, free, no key) or 'fish' (api.fish.audio, paid).
// Default stays 'fish' whenever a key is set, so the cloud is unchanged; the box opts
// into edge with TTS_BACKEND=edge in its .env. One multilingual edge voice covers zh/en/fr.
const BACKEND = process.env.TTS_BACKEND || (process.env.FISH_AUDIO_API_KEY ? 'fish' : null);
const EDGE_VOICE = process.env.DJ_EDGE_VOICE || 'en-US-AvaMultilingualNeural';

export function ttsConfigured() {
  if (BACKEND === 'edge') return true;
  return BACKEND === 'fish' && Boolean(process.env.FISH_AUDIO_API_KEY);
}

export async function synthesizeAndCache(text, { referenceId: refOverride } = {}) {
  if (!ttsConfigured()) return null;
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const referenceId = (refOverride || process.env.FISH_AUDIO_REFERENCE_ID || '').trim();
  const model = process.env.FISH_AUDIO_MODEL || 's1';
  // Cache key carries the backend + voice so switching engines never serves a stale clip.
  const voiceKey = BACKEND === 'edge' ? EDGE_VOICE : `${model}\n${referenceId}`;
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${BACKEND}\n${voiceKey}\n${trimmed}`)
    .digest('hex')
    .slice(0, 16);
  const filename = `${cacheKey}.mp3`;
  const filepath = path.join(CACHE_DIR, filename);

  try {
    await fs.access(filepath);
    return `/tts/${filename}`;
  } catch {}

  if (BACKEND === 'edge') {
    // Write to a temp file then rename, so a failed synth never poisons the cache.
    const tmp = `${filepath}.tmp`;
    const tts = new EdgeTTS({ voice: EDGE_VOICE, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' });
    await tts.ttsPromise(trimmed, tmp);
    await fs.rename(tmp, filepath);
    return `/tts/${filename}`;
  }

  const body = {
    text: trimmed,
    format: 'mp3',
    mp3_bitrate: 128,
    normalize: true,
    latency: 'normal',
  };
  if (referenceId) body.reference_id = referenceId;

  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      'Content-Type': 'application/json',
      'model': model,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Fish TTS ${res.status}: ${errText.slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filepath, buf);
  return `/tts/${filename}`;
}
