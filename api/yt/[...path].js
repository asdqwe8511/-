// Public read-only proxy for the YouTube Data API.
//
// The site has no login, so this endpoint is reachable by anyone. Two things
// keep that from burning the project's daily quota:
//   1. Only a fixed allow-list of read endpoints is forwarded — this can't be
//      used as a general relay to googleapis.com.
//   2. Successful responses are cached at Vercel's edge, so repeat traffic is
//      served from the CDN instead of hitting YouTube again. Quota use is
//      therefore roughly constant no matter how many visitors there are.
// The API key itself stays server-side and is never exposed to the browser.
const ALLOWED_ENDPOINTS = new Set(['videos', 'videoCategories', 'channels']);

const CACHE_SECONDS = 1800;        // serve from edge for 30 min
const STALE_SECONDS = 3600;        // then serve stale up to 1h while refreshing

module.exports = async (req, res) => {
  // Derive the target endpoint straight from the request path instead of the
  // dynamic route's query param — on this platform Vercel has been observed
  // to expose the catch-all value under a literal "...path" key rather than
  // "path", so name-based lookup isn't reliable here.
  const pathname = (req.url || '').split('?')[0];
  const endpoint = pathname.replace(/^\/api\/yt\/?/, '').split('/').filter(Boolean)[0];

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    res.status(400).json({ error: { message: '허용되지 않은 API 경로입니다.' } });
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: '서버에 YOUTUBE_API_KEY 환경변수가 설정되지 않았습니다.' } });
    return;
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(req.query).forEach(([k, v]) => {
    if (k === 'path' || k === '...path') return; // dynamic-route artifact, not a real YouTube param
    url.searchParams.set(k, Array.isArray(v) ? v[0] : v);
  });
  url.searchParams.set('key', apiKey);

  try {
    const ytRes = await fetch(url);
    const data = await ytRes.json();

    // Only cache good responses — caching an error (e.g. a transient quota
    // failure) would pin the site to that error for the whole window.
    if (ytRes.ok) {
      res.setHeader(
        'Cache-Control',
        `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`
      );
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.status(ytRes.status).json(data);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: { message: e.message } });
  }
};
