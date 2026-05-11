import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache/tts');

export function ttsConfigured() {
  return Boolean(process.env.FISH_AUDIO_API_KEY);
}

export async function synthesizeAndCache(text) {
  if (!ttsConfigured()) return null;
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const referenceId = process.env.FISH_AUDIO_REFERENCE_ID || '';
  const model = process.env.FISH_AUDIO_MODEL || 's1';
  const cacheKey = crypto
    .createHash('sha1')
    .update(model + '\n' + referenceId + '\n' + trimmed)
    .digest('hex')
    .slice(0, 16);
  const filename = `${cacheKey}.mp3`;
  const filepath = path.join(CACHE_DIR, filename);

  try {
    await fs.access(filepath);
    return `/tts/${filename}`;
  } catch {}

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
