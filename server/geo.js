// IP → city lookup via ip-api.com (no key, ~45 req/min free tier).
// Cached per-IP for a day so we don't hammer the API.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // ip → { value, at }

function normalizeIp(ip) {
  if (!ip) return null;
  // Express gives ::ffff:1.2.3.4 for IPv4-mapped addresses; strip the prefix.
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  return ip;
}

function isLocal(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const n = Number(ip.split('.')[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

/**
 * Look up a rough city for a public IP. Returns null for private/loopback
 * IPs or on lookup failure (caller should fall back to OPENWEATHER_CITY).
 */
export async function lookupCityForIp(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip || isLocal(ip)) return null;

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,countryCode,lat,lon`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    if (data?.status === 'success' && data.city) {
      const value = {
        city: data.city,
        country: data.countryCode || null,
        lat: data.lat ?? null,
        lon: data.lon ?? null,
      };
      cache.set(ip, { value, at: Date.now() });
      return value;
    }
  } catch (e) {
    console.warn('[geo]', e.message);
  }
  cache.set(ip, { value: null, at: Date.now() });
  return null;
}
