// Movies Made Easy — zero-dependency Node proxy + static file server.
//
// Why a proxy at all: the browser can't call eventcinemas.com.au directly
// (cross-origin) and can't set a non-bot User-Agent from JS. This tiny server
// fetches the live GetSessions endpoint with browser-like headers and serves
// the result to our front-end from the same origin.
//
// Run: node server.js   ->  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Default cinemas (Campbelltown, Ed Square); the front-end overrides via query.
const DEFAULT_CINEMA_IDS = ['65', '94'];

// Short-lived cache of upstream responses, keyed by the exact upstream URL.
// When several friends view the same day/cinemas, they share one fetch — far
// less load on Event Cinemas and less chance of being rate-limited.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60000);
const cache = new Map(); // url -> { body, expires }

const UPSTREAM = 'https://www.eventcinemas.com.au/Cinemas/GetSessions';
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  Referer: 'https://www.eventcinemas.com.au/Sessions',
  'X-Requested-With': 'XMLHttpRequest',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Current date in the cinemas' local timezone (Sydney), as YYYY-MM-DD.
// en-CA formats dates as YYYY-MM-DD.
function todaySydney() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function buildUpstreamUrl(reqQuery) {
  const url = new URL(UPSTREAM);
  // Validate inputs — only numeric cinema ids and ISO dates reach upstream.
  const cinemaIds = reqQuery.getAll('cinemaIds').filter((id) => /^\d+$/.test(id));
  (cinemaIds.length ? cinemaIds : DEFAULT_CINEMA_IDS).forEach((id) =>
    url.searchParams.append('cinemaIds', id)
  );
  const date = reqQuery.get('date');
  url.searchParams.set('date', /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todaySydney());
  return url;
}

function sendJson(res, body, extraHeaders) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Today': todaySydney(),
    ...extraHeaders,
  });
  res.end(body);
}

async function handleSessions(reqQuery, res) {
  const upstreamUrl = buildUpstreamUrl(reqQuery);
  const key = upstreamUrl.toString();

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    sendJson(res, hit.body, { 'X-Data-Source': 'live', 'X-Cache': 'hit' });
    return;
  }

  try {
    const upstream = await fetch(upstreamUrl, { headers: BROWSER_HEADERS });
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    cache.set(key, { body, expires: Date.now() + CACHE_TTL_MS });
    // Opportunistically drop expired entries so the map can't grow unbounded.
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    sendJson(res, body, { 'X-Data-Source': 'live', 'X-Cache': 'miss' });
  } catch (err) {
    // Resilience for dev/demo: if the live call is blocked or offline, fall
    // back to the saved sample so the UI still renders. Clearly flagged so the
    // front-end can tell the user the data may be stale.
    console.error(`[proxy] live fetch failed (${err.message}); trying fallback`);
    const fallbackPath = path.join(__dirname, 'GetSessions.json');
    fs.readFile(fallbackPath, (e, data) => {
      if (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ Success: false, Error: err.message }));
        return;
      }
      sendJson(res, data, { 'X-Data-Source': 'fallback' });
    });
  }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // Guard against path traversal.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  if (parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else if (parsed.pathname === '/api/sessions') {
    handleSessions(parsed.searchParams, res);
  } else {
    serveStatic(parsed.pathname, res);
  }
});

server.listen(PORT, () => {
  console.log(`Movies Made Easy running at http://localhost:${PORT}`);
  console.log(`Default cinemas ${DEFAULT_CINEMA_IDS.join(', ')} · date ${todaySydney()} (Sydney)`);
});
