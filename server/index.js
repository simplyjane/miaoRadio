import express from 'express';
import path from 'node:path';
import { handleChat, handleAutoShow } from './router.js';
import { searchSongs } from './ytmusic.js';
import { recordPlay } from './state.js';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(import.meta.dirname, '..');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'pwa')));
app.use('/tts', express.static(path.join(ROOT, 'cache/tts'), {
  maxAge: '7d',
  immutable: true,
}));

app.post('/api/chat', async (req, res) => {
  const { message } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  try {
    const result = await handleChat(message.trim());
    res.json(result);
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auto-show', async (_req, res) => {
  try {
    const result = await handleAutoShow();
    res.json(result);
  } catch (e) {
    console.error('[auto-show]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/played', (req, res) => {
  const { videoId, title, artist, query } = req.body ?? {};
  if (typeof videoId !== 'string' || !videoId) {
    return res.status(400).json({ error: 'videoId required' });
  }
  recordPlay({ videoId, title, artist, query });
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const hits = await searchSongs(q, 8);
    res.json({ hits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`miaoRadio listening on http://localhost:${PORT}`);
});
