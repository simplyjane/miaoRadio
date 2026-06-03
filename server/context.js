import fs from 'node:fs/promises';
import path from 'node:path';
import { getTodayEvents, formatEventsForPrompt, calendarConfigured } from './calendar.js';
import { getCurrentWeather, formatWeatherForPrompt, weatherConfigured } from './weather.js';
import {
  getRecentMessages,
  getRecentPlays,
  getCorpus,
  getSettings,
  getRecentByReaction,
} from './state.js';

const ROOT = path.resolve(import.meta.dirname, '..');

async function safeRead(rel) {
  try {
    const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
    return text.trim();
  } catch {
    return '';
  }
}

function detectLanguage(text) {
  if (!text) return null;
  return /[一-鿿㐀-䶿]/.test(text) ? 'Chinese' : 'English';
}

/**
 * For signed-in users, taste/routines/mood come from their corpus row.
 * For guests (no corpus row), fall back to the on-disk user/*.md files
 * so the trial experience still has a personality.
 */
async function loadCorpus(userId) {
  if (userId) {
    const row = getCorpus(userId);
    if (row) {
      return { taste: row.taste, routines: row.routines, moodRules: row.mood_rules };
    }
  }
  const [taste, routines, moodRules] = await Promise.all([
    safeRead('user/taste.md'),
    safeRead('user/routines.md'),
    safeRead('user/mood-rules.md'),
  ]);
  return { taste, routines, moodRules };
}

export async function buildSystemPrompt({ userMessage, userId, userName } = {}) {
  const replyLang = detectLanguage(userMessage);
  const settings = userId ? getSettings(userId) : null;
  const [persona, corpus, calendar, weather] = await Promise.all([
    safeRead('prompts/dj-persona.md'),
    loadCorpus(userId),
    safeCalendar(userId),
    safeWeather(settings?.weather_city),
  ]);
  const { taste, routines, moodRules } = corpus;

  // Pull the user's first name from Google profile data when available, so
  // the DJ can use it naturally for warmth. Guests have no name.
  const firstName = userName ? String(userName).trim().split(/\s+/)[0] : null;

  const recentChats = formatRecentChats(getRecentMessages(10, userId));
  const recentPlays = formatRecentPlays(getRecentPlays(30, userId));
  const liked = formatReactions(getRecentByReaction(userId, 1, 30));
  const disliked = formatReactions(getRecentByReaction(userId, -1, 60));

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const env = [
    `Current local time: ${now.toLocaleString('en-CA', { hour12: false })} (${tz})`,
    `ISO: ${now.toISOString()}`,
    `Weekday: ${now.toLocaleDateString('en-US', { weekday: 'long' })}`,
    weather ? `Weather: ${weather}` : null,
  ].filter(Boolean).join('\n');

  const langOverride = replyLang
    ? `# CRITICAL: REPLY LANGUAGE\nThe user's current message is in ${replyLang}. Reply in ${replyLang}. This overrides any pattern from RECENT CHATS.`
    : '';

  const userIdentitySection = firstName
    ? section(
        'USER NAME',
        `First name: ${firstName}\n` +
        `Address them by name occasionally — at greetings, key emotional transitions, ` +
        `or when the moment calls for a personal touch. Never overuse it (max once or ` +
        `twice per <say> block); leaning on it makes the radio feel like a chatbot ` +
        `rather than a real DJ who knows their listener.`,
      )
    : null;

  const stable = [
    persona,
    userIdentitySection,
    section('USER TASTE', taste),
    section('USER ROUTINES', routines),
    section('MOOD RULES', moodRules),
  ].filter(Boolean).join('\n\n');

  const volatile = [
    langOverride,
    section("TODAY'S CALENDAR", calendar),
    section('ENVIRONMENT', env),
    section('RECENT CHATS', recentChats),
    section('RECENTLY PLAYED (avoid repeating these)', recentPlays),
    section('LIKED — taste beacons. Use these to infer the user\'s direction (artists, era, mood). DO NOT re-recommend the literal tracks listed here; recommend OTHER songs in the same direction.', liked),
    section('DISLIKED — NEVER recommend these tracks or near-identical covers.', disliked),
  ].filter(Boolean).join('\n\n');

  return { stable, volatile };
}

function formatRecentChats(messages) {
  if (!messages.length) return '(no prior conversation)';
  return messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');
}

function formatRecentPlays(plays) {
  if (!plays.length) return '(nothing played yet)';
  return plays
    .map((p) => `- ${p.title || '?'} — ${p.artist || '?'}`)
    .join('\n');
}

function formatReactions(rows) {
  if (!rows.length) return '(none)';
  return rows
    .map((r) => `- ${r.title || '?'} — ${r.artist || '?'}`)
    .join('\n');
}

async function safeCalendar(userId) {
  if (!calendarConfigured() || !userId) return '';
  try {
    const events = await getTodayEvents(userId);
    if (events == null) return ''; // user hasn't connected calendar
    return formatEventsForPrompt(events);
  } catch (e) {
    console.warn('[calendar]', e.message);
    return `(calendar fetch failed: ${e.message})`;
  }
}

async function safeWeather(cityOverride) {
  if (!weatherConfigured()) return null;
  try {
    const w = await getCurrentWeather(cityOverride);
    return formatWeatherForPrompt(w);
  } catch (e) {
    console.warn('[weather]', e.message);
    return null;
  }
}

function section(title, body) {
  const content = body || '(empty — user has not filled this in yet)';
  return `# ${title}\n${content}`;
}
