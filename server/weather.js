let cached = null;
let cachedAt = 0;
const CACHE_MS = 10 * 60 * 1000;

export function weatherConfigured() {
  return Boolean(process.env.OPENWEATHER_API_KEY);
}

export async function getCurrentWeather() {
  if (!weatherConfigured()) return null;
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const city = process.env.OPENWEATHER_CITY || 'Shanghai';
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('q', city);
  url.searchParams.set('appid', process.env.OPENWEATHER_API_KEY);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'zh_cn');

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`weather fetch failed: ${data.message || res.status}`);
  }

  cached = {
    city: data.name,
    temp: Math.round(data.main?.temp),
    feelsLike: Math.round(data.main?.feels_like),
    description: data.weather?.[0]?.description || '',
    humidity: data.main?.humidity,
    wind: data.wind?.speed,
  };
  cachedAt = Date.now();
  return cached;
}

export function formatWeatherForPrompt(w) {
  if (!w) return '(weather not configured)';
  const parts = [`${w.city} ${w.temp}°C ${w.description}`];
  if (w.feelsLike != null && Math.abs(w.feelsLike - w.temp) >= 2) {
    parts.push(`体感 ${w.feelsLike}°C`);
  }
  if (w.humidity != null) parts.push(`湿度 ${w.humidity}%`);
  return parts.join('，');
}
