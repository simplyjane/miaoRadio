const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // city → { at, value }

export function weatherConfigured() {
  return Boolean(process.env.OPENWEATHER_API_KEY);
}

export async function getCurrentWeather(cityOverride) {
  if (!weatherConfigured()) return null;
  const city = (cityOverride || process.env.OPENWEATHER_CITY || 'Shanghai').trim();
  if (!city) return null;

  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

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

  const value = {
    city: data.name,
    temp: Math.round(data.main?.temp),
    feelsLike: Math.round(data.main?.feels_like),
    description: data.weather?.[0]?.description || '',
    humidity: data.main?.humidity,
    wind: data.wind?.speed,
  };
  cache.set(city, { at: Date.now(), value });
  return value;
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
