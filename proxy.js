const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || process.env.PROXY_PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Allowlist ----------------------------------------------------------------
const ALLOWED_HOSTS = [
  'vidup.to',
  'vidfast.pro',
  'workers.dev',          // catches *.workers.dev segments (impact/edit/cdn1 etc)
  'stream-balancer',
  'cdn-bubbles.xyz',      // external proxy that serves segments without CORS headers
  'cardlawgive.workers.dev', // explicit catch for edit.cardlawgive.workers.dev paths
];

function isAllowedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    // Allow .live domains for stream balancer
    if (parsed.hostname.endsWith('.live')) return true;

    // Must match an allowed host or its subdomains
    return ALLOWED_HOSTS.some(host =>
      parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

// --- CORS Proxy for HLS Streams -----------------------------------------------
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  if (!isAllowedUrl(targetUrl)) {
    console.warn(`[blocked] ${targetUrl}`);
    return res.status(403).send('Domain not allowed');
  }

  const refHint = req.query.ref; // 'vidup' or 'vidfast'
  let origin = 'https://vidfast.pro';
  let referer = 'https://vidfast.pro/';

  if (refHint === 'vidup' || targetUrl.includes('vidup.to')) {
    origin = 'https://vidup.to';
    referer = 'https://vidup.to/';
  }

  const proxyBase = `${req.protocol}://${req.get('host')}/proxy`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for massive 4K segments

  // If the browser abandons the request (e.g. user scrubs forward), abort upstream fetch instantly!
  req.on('close', () => {
    clearTimeout(timeout);
    controller.abort();
  });

  try {
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
      'Origin': origin,
      'Referer': referer,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    // Forward Range header for video seeking
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    // Request identity encoding so we can safely forward Content-Length for ABR calculations
    headers['Accept-Encoding'] = 'identity';

    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal,
      headers
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[proxy ${response.status}] ${targetUrl}`);
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    // Forward safe headers
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === 'content-encoding' ||
        lower === 'transfer-encoding' ||
        lower === 'access-control-allow-origin'
      ) return;
      res.setHeader(key, value);
    });

    // CRITICAL: We must forward the exact HTTP status (e.g. 206 Partial Content)
    // Otherwise, Range requests for seeking will look like full 200 OKs, resetting the video to 0:00!
    res.status(response.status);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    const ref = (origin === 'https://vidup.to') ? 'vidup' : 'vidfast';

    // -- M3U8 rewrite ---------------------------------------------------------
    if (targetUrl.includes('.m3u8')) {
      const text = await response.text();
      const baseUrl = new URL(targetUrl);

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = new URL(uri, baseUrl).href;
            if (!isAllowedUrl(abs)) return `URI="${uri}"`;
            return `URI="${proxyBase}?url=${encodeURIComponent(abs)}&ref=${ref}"`;
          });
        }

        if (!trimmed.startsWith('#')) {
          const abs = new URL(trimmed, baseUrl).href;
          if (!isAllowedUrl(abs)) return line;
          return `${proxyBase}?url=${encodeURIComponent(abs)}&ref=${ref}`;
        }
        return line;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // -- TS / AAC / VTT — stream directly to client ---------------------------
    // Streaming progressively gives Hls.js instant Time-To-First-Byte for optimal ABR.
    // IMPORTANT: Must handle 'error' on the Readable to prevent crash when client
    // disconnects mid-stream (e.g. user seeks forward, aborting the in-flight request).
    if (response.body) {
      const readable = Readable.fromWeb(response.body);
      readable.on('error', () => { /* client disconnected or aborted, ignore */ });
      res.on('close', () => readable.destroy());
      readable.pipe(res);
    } else {
      res.end();
    }

  } catch (error) {
    clearTimeout(timeout);
    // AbortError is expected when the client disconnects — don't crash or respond
    if (error.name === 'AbortError') return;
    if (!res.headersSent) res.status(500).send(error.message);
  }
});

app.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

// Health check
app.get('/', (_, res) => res.json({ status: 'proxy running' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[✓] Express HLS Proxy running on port ${PORT}`));
