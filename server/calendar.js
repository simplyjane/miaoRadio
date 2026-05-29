import { getGoogleTokens, updateGoogleAccessToken } from './state.js';

export function calendarConfigured() {
  // Auth is per-user now; we just need the OAuth client creds.
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function getAccessTokenForUser(userId) {
  const row = getGoogleTokens(userId);
  if (!row?.refresh_token) return null;
  if (row.access_token && row.expires_at && Date.now() < row.expires_at - 60_000) {
    return row.access_token;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`refresh_token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  updateGoogleAccessToken(userId, { accessToken: data.access_token, expiresAt });
  return data.access_token;
}

export async function getTodayEvents(userId) {
  if (!calendarConfigured() || !userId) return null;
  const token = await getAccessTokenForUser(userId);
  if (!token) return null;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', start.toISOString());
  url.searchParams.set('timeMax', end.toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '20');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`calendar fetch failed: ${data.error?.message || res.status}`);
  }

  return (data.items || []).map((e) => ({
    summary: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !e.start?.dateTime,
    location: e.location || null,
  }));
}

export function formatEventsForPrompt(events) {
  if (!events) return '(calendar not connected)';
  if (!events.length) return '(no events today)';
  return events
    .map((e) => {
      if (e.allDay) return `- (all day) ${e.summary}`;
      const t = new Date(e.start).toLocaleTimeString('en-CA', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const loc = e.location ? ` @ ${e.location}` : '';
      return `- ${t} ${e.summary}${loc}`;
    })
    .join('\n');
}
