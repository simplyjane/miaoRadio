let cachedToken = null;
let cachedExpiry = 0;

export function calendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN,
  );
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`refresh_token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

export async function getTodayEvents() {
  if (!calendarConfigured()) return null;

  const token = await getAccessToken();
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
  if (!events) return '(calendar not configured)';
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
