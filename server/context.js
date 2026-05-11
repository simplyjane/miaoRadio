import fs from 'node:fs/promises';
import path from 'node:path';
import { getTodayEvents, formatEventsForPrompt, calendarConfigured } from './calendar.js';
import { getCurrentWeather, formatWeatherForPrompt, weatherConfigured } from './weather.js';
import { getRecentMessages, getRecentPlays } from './state.js';

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
  // Has any CJK character → Chinese; else → English
  return /[一-鿿㐀-䶿]/.test(text) ? 'Chinese' : 'English';
}

export async function buildSystemPrompt({ userMessage } = {}) {
  const replyLang = detectLanguage(userMessage);
  const [persona, taste, routines, moodRules, calendar, weather] = await Promise.all([
    safeRead('prompts/dj-persona.md'),
    safeRead('user/taste.md'),
    safeRead('user/routines.md'),
    safeRead('user/mood-rules.md'),
    safeCalendar(),
    safeWeather(),
  ]);

  const recentChats = formatRecentChats(getRecentMessages(10));
  const recentPlays = formatRecentPlays(getRecentPlays(30));

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

  return [
    persona,
    langOverride,
    section('USER TASTE', taste),
    section('USER ROUTINES', routines),
    section('MOOD RULES', moodRules),
    section("TODAY'S CALENDAR", calendar),
    section('ENVIRONMENT', env),
    section('RECENT CHATS', recentChats),
    section('RECENTLY PLAYED (avoid repeating these)', recentPlays),
  ].filter(Boolean).join('\n\n');
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

async function safeCalendar() {
  if (!calendarConfigured()) return '';
  try {
    const events = await getTodayEvents();
    return formatEventsForPrompt(events);
  } catch (e) {
    console.warn('[calendar]', e.message);
    return `(calendar fetch failed: ${e.message})`;
  }
}

async function safeWeather() {
  if (!weatherConfigured()) return null;
  try {
    const w = await getCurrentWeather();
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
