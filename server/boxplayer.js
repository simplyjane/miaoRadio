/* Headless server-side player for the box (walking/watch mode).
 *
 * Runs INSIDE the miaoRadio server process (BOX_PLAYER=1), so it drives the SAME
 * radio: it calls the real DJ (handleChat / handleAutoShow) as the owner user, then
 * plays each track's audio on the box's speaker via yt-dlp + mpv. No browser tab.
 *
 * Stays IDLE until the watch asks for music (POST /api/box-play). Controls
 * (POST /api/box-control: next | prev | stop) drive it — e.g. the watch's buttons.
 */
import { spawn } from 'node:child_process';

import { handleChat, handleAutoShow } from './router.js';
import { recordPlay, getOwnerUser } from './state.js';

const YTDLP = process.env.YTDLP_PATH || `${process.env.HOME}/.local/bin/yt-dlp`;
const MPV = process.env.MPV_PATH || 'mpv';
const SINK = process.env.BOX_SINK || '';   // pulse sink name; empty = default output

let queue = [];        // upcoming tracks [{videoId, title, artist}]
let history = [];      // finished tracks, newest last (for "previous")
let pending = null;    // a spoken request waiting to become a fresh queue
let current = null;    // the running mpv child (so controls can interrupt it)
let active = false;    // idle until the watch asks — don't blast on startup
let skipTo = null;     // 'next' | 'prev' set by a control while a track plays
let owner = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP_RE = /\b(stop|pause|quiet)\b|停|别放|別放|关掉|關掉|不听|不聽|安静|安靜/i;

function kill() { if (current) { try { current.kill('SIGTERM'); } catch { /* gone */ } } }

/* A spoken request from the watch: start (or replace) the show. */
export function boxPlayEnqueue(message) {
  if (STOP_RE.test(message)) { active = false; queue = []; pending = null; kill(); return; }
  active = true; pending = message; kill();     // interrupt so the new request plays now
}

/* A button/control: next | prev | stop (pause). */
export function boxControl(action) {
  if (action === 'stop' || action === 'pause') { active = false; queue = []; kill(); return; }
  if (!active) return;                           // next/prev do nothing when idle — start via voice first
  if (action === 'next' || action === 'prev') { skipTo = action; kill(); }
}

function ytAudioUrl(videoId) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, ['-f', 'bestaudio', '-g', `https://www.youtube.com/watch?v=${videoId}`]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim().split('\n')[0] || null));
    p.on('error', () => resolve(null));
  });
}

function playUrl(url) {
  return new Promise((resolve) => {
    const args = ['--no-video', '--really-quiet', '--volume=100'];
    if (SINK) args.push(`--audio-device=pulse/${SINK}`);
    args.push(url);
    current = spawn(MPV, args, { stdio: 'ignore' });
    const done = () => { current = null; resolve(); };
    current.on('close', done);
    current.on('error', done);
  });
}

async function playTrack(t) {
  const url = await ytAudioUrl(t.videoId);
  if (!url) { console.log('[boxplayer] no stream:', t.title); return; }
  console.log('[boxplayer] ▶', t.title, t.artist ? `— ${t.artist}` : '');
  try { recordPlay({ videoId: t.videoId, title: t.title, artist: t.artist, query: null, userId: owner.id }); }
  catch (e) { console.log('[boxplayer] recordPlay:', e.message); }
  await playUrl(url);
}

export function startBoxPlayer() {
  owner = getOwnerUser();
  console.log('[boxplayer] started', owner ? `for user ${owner.id}` : '(waiting for owner login)');
  (async function loop() {
    for (;;) {
      try {
        if (!owner) { owner = getOwnerUser(); if (!owner) { await sleep(5000); continue; } }
        if (!active) { await sleep(800); continue; }          // idle until asked
        if (pending) {
          const msg = pending; pending = null;
          const r = await handleChat(msg, owner);
          queue = (r.play || []).filter((t) => t.videoId);
          console.log(`[boxplayer] request "${msg}" -> ${queue.length} tracks`);
        }
        if (queue.length === 0) {                              // auto-DJ keeps the show going
          const r = await handleAutoShow(owner);
          queue = (r.play || []).filter((t) => t.videoId);
          console.log(`[boxplayer] auto-show -> ${queue.length} tracks`);
        }
        if (queue.length === 0) { await sleep(4000); continue; }

        const t = queue.shift();
        skipTo = null;
        await playTrack(t);                                    // blocks until end or a control kills it
        if (skipTo === 'prev') {
          queue.unshift(t);                                    // re-queue current...
          const prev = history.pop();
          if (prev) queue.unshift(prev);                       // ...and play the previous track first
        } else {
          history.push(t);                                     // natural end or 'next' → advance
        }
        skipTo = null;
      } catch (e) {
        console.log('[boxplayer] loop error:', e.message);
        await sleep(4000);
      }
    }
  })();
}
