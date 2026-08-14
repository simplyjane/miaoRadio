/* Headless server-side player for the box (walking/watch mode).
 *
 * Runs INSIDE the miaoRadio server process (BOX_PLAYER=1), so it drives the SAME
 * radio: it calls the real DJ (handleChat / handleAutoShow) as the owner user, then
 * plays each track's audio on the box's speaker via yt-dlp + mpv. No browser tab.
 *
 * Stays IDLE until the watch asks for music (POST /api/box-play). Controls
 * (POST /api/box-control: next | prev | stop) drive it — e.g. the watch's buttons.
 */
import { spawn, execFile } from 'node:child_process';

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

function kill() {
  if (!current) return;
  // playUrl runs a `yt-dlp | mpv` pipeline in its own process group — kill the
  // whole group, else mpv survives its shell and the track keeps playing.
  try { process.kill(-current.pid, 'SIGTERM'); } catch { try { current.kill('SIGTERM'); } catch { /* gone */ } }
}

/* A spoken request from the watch: start (or replace) the show. */
export function boxPlayEnqueue(message) {
  if (STOP_RE.test(message)) { active = false; queue = []; pending = null; kill(); return; }
  active = true; pending = message; kill();     // interrupt so the new request plays now
}

/* Adjust the box speaker's volume (PulseAudio sink). delta like '+8%' / '-8%'. */
function setVol(delta) {
  const sink = SINK || '@DEFAULT_SINK@';
  execFile('pactl', ['set-sink-volume', sink, delta],
    { env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000' } },
    (e) => { if (e) console.log('[boxplayer] setVol:', e.message); });
}

/* A button/control: next | prev | stop | volup | voldown. */
export function boxControl(action) {
  if (action === 'volup') { setVol('+8%'); return; }       // volume works anytime, even idle
  if (action === 'voldown') { setVol('-8%'); return; }
  if (action === 'stop' || action === 'pause') {
    active = false; queue = []; kill();
    // Belt & suspenders: kill() races the loop (a next track spawned in the same tick
    // escapes it) — reap EVERY pipeline so stop always means silence.
    spawn('pkill', ['-f', 'mpv --no-video --really-quiet'], { stdio: 'ignore' });
    return;
  }
  if (!active) return;                           // next/prev do nothing when idle — start via voice first
  if (action === 'next' || action === 'prev') { skipTo = action; kill(); }
}

/* Play one track: yt-dlp downloads (its TLS handles YouTube's CDN; mpv/ffmpeg on
 * 22.04 chokes with "Error decoding the received TLS packet") and pipes raw audio
 * into mpv. Own process group so skip/stop can kill the whole pipeline. */
function playPipeline(videoId) {
  return new Promise((resolve) => {
    const sinkArg = SINK ? `--audio-device=pulse/${SINK}` : '';
    const cmd = `${YTDLP} -q -f bestaudio -o - "https://www.youtube.com/watch?v=${videoId}" | ` +
                `${MPV} --no-video --really-quiet --volume=100 ${sinkArg} -`;
    current = spawn('sh', ['-c', cmd], { stdio: 'ignore', detached: true });
    const done = () => { current = null; resolve(); };
    current.on('close', done);
    current.on('error', done);
  });
}

async function playTrack(t) {
  console.log('[boxplayer] ▶', t.title, t.artist ? `— ${t.artist}` : '');
  try { recordPlay({ videoId: t.videoId, title: t.title, artist: t.artist, query: null, userId: owner.id }); }
  catch (e) { console.log('[boxplayer] recordPlay:', e.message); }
  await playPipeline(t.videoId);
}

export function startBoxPlayer() {
  owner = getOwnerUser();
  // If a previous instance crashed (node SEGV etc.), its detached yt-dlp|mpv pipeline
  // survives as an orphan and keeps playing music nobody controls. Reap strays first.
  spawn('pkill', ['-f', 'mpv --no-video --really-quiet'], { stdio: 'ignore' });
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
        if (!active) continue;                                 // stop landed while we were fetching
        const t0 = Date.now();
        await playTrack(t);                                    // blocks until end or a control kills it
        if (Date.now() - t0 < 5000) {                          // died suspiciously fast (bad/blocked video?)
          console.log(`[boxplayer] track ended after ${Math.round((Date.now() - t0) / 1000)}s:`, t.title);
        }
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
