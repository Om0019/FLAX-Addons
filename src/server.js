const express = require('express');
const cors = require('cors');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const scrapers = require('./scrapers');
const { fetchTextWithTimeout, fetchWithTimeout } = require('./http');

const app = express();
const PROXY_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Enable CORS for Stremio client compatibility
app.use(cors());
app.use(express.json());

// Declare the Stremio Addon Manifest
const manifest = {
  id: 'com.latino.spanish',
  version: '1.0.1',
  name: 'Latino 🇲🇽',
  description: 'Películas y Series en Español Latino y Castellano directas de Cinecalidad, SoloLatino, TioPlus, Cuevana3i, LaMovie, PelisPedia y CineHDPlus.',
  logo: 'https://images.unsplash.com/photo-1574267431422-7bda297781f5?q=80&w=256&auto=format&fit=crop',
  background: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=1280&auto=format&fit=crop',
  types: ['movie', 'series'],
  resources: [
    {
      name: 'stream',
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'tmdb']
    }
  ],
  catalogs: []
};

function getPublicBaseUrl(req) {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}`;
}

function shouldProxyStream(stream) {
  try {
    const url = new URL(stream.url);
    const host = url.hostname.toLowerCase();
    const title = (stream.title || '').toLowerCase();
    const hasProxyHeaders = Boolean(stream?.behaviorHints?.proxyHeaders?.request);
    const headerSensitiveHost = host.includes('acek-cdn.com')
      || host.includes('dramiyos-cdn.com')
      || host.includes('cfglobalcdn.com')
      || host.includes('turboviplay.com')
      || host.includes('premilkyway.com')
      || host.includes('cdn-tnmr.org')
      || host.includes('mediafire.com')
      || host.includes('fireload.com');

    return title.includes('premium')
      || headerSensitiveHost
      || hasProxyHeaders;
  } catch {
    return false;
  }
}

function getProxyFilename(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) return 'stream.m3u8';
    if (pathname.endsWith('.ts')) return 'segment.ts';
    if (pathname.endsWith('.m4s')) return 'segment.m4s';
    if (pathname.endsWith('.mp4') || pathname.endsWith('.bin')) return 'stream.mp4';
    if (pathname.endsWith('.mkv')) return 'stream.mkv';
    if (pathname.endsWith('.key')) return 'key.key';
  } catch {
    // Fall through to the generic name.
  }

  return 'stream';
}

// A player seeking or the user hitting stop tears the response down mid-body.
// That is routine, not a proxy failure, so it must not be logged as an error or
// answered with a status the client is no longer there to read.
function isClientDisconnect(error, res) {
  return res.destroyed
    || ['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'EPIPE'].includes(error?.code);
}

function proxiedStreamUrl(baseUrl, targetUrl, referer) {
  const filename = getProxyFilename(targetUrl);
  return `${baseUrl}/proxy/${filename}?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer || '')}`;
}

function rewriteHlsManifest(manifestText, targetUrl, req) {
  const baseUrl = getPublicBaseUrl(req);
  const referer = req.query.referer || targetUrl;

  const rewriteUri = (uri) => {
    if (!uri || uri.startsWith('data:')) return uri;
    const absoluteUrl = new URL(uri, targetUrl).toString();
    return proxiedStreamUrl(baseUrl, absoluteUrl, referer);
  };

  return manifestText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUri(uri)}"`);
      }

      return rewriteUri(trimmed);
    })
    .join('\n');
}

function isLikelyHlsManifestUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.m3u8(?:$|[?#])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function wrapProxyStreams(streams, req) {
  const baseUrl = getPublicBaseUrl(req);

  return streams.map((stream) => {
    if (!stream?.url || !shouldProxyStream(stream)) {
      return stream;
    }

    const requestHeaders = stream?.behaviorHints?.proxyHeaders?.request || {};
    const proxiedUrl = proxiedStreamUrl(baseUrl, stream.url, requestHeaders.Referer || '');

    return {
      ...stream,
      url: proxiedUrl,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        proxyHeaders: {
          request: {
            'User-Agent': DEFAULT_USER_AGENT
          }
        }
      }
    };
  });
}

// 1. Manifest Endpoint
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

app.get(['/proxy/stream', '/proxy/:filename'], async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://sololatino.net/';

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing url');
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid url');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).send('Invalid protocol');
  }

  try {
    const headers = {
      'User-Agent': req.get('user-agent') || DEFAULT_USER_AGENT,
      'Referer': referer
    };

    const range = req.get('range');
    const requestIsHlsManifest = isLikelyHlsManifestUrl(targetUrl);
    if (range && !requestIsHlsManifest) {
      headers.Range = range;
    }

    let upstream;
    let bufferedManifest = null;

    if (requestIsHlsManifest) {
      // A URL that already looks like a playlist is certain to be buffered and
      // rewritten below, so the deadline should cover the body as well.
      ({ res: upstream, text: bufferedManifest } = await fetchTextWithTimeout(targetUrl, {
        headers
      }, PROXY_FETCH_TIMEOUT_MS));
    } else {
      // Anything else may be a multi-GB video that has to stream for minutes, so
      // the deadline has to stop at the headers or it would abort playback.
      upstream = await fetchWithTimeout(targetUrl, {
        headers
      }, PROXY_FETCH_TIMEOUT_MS);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const isHlsManifest = requestIsHlsManifest
      || contentType.toLowerCase().includes('mpegurl')
      || contentType.toLowerCase().includes('application/vnd.apple');

    res.status(isHlsManifest ? 200 : upstream.status);
    res.setHeader('Content-Type', isHlsManifest ? 'application/vnd.apple.mpegurl' : (contentType || 'application/octet-stream'));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (isHlsManifest) {
      // Only reachable unbuffered when the URL gave no hint and the content-type
      // revealed a playlist after the fact.
      const manifestText = bufferedManifest !== null ? bufferedManifest : await upstream.text();
      res.send(rewriteHlsManifest(manifestText, targetUrl, req));
      return;
    }

    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (!upstream.body) {
      return res.end();
    }

    // pipeline() applies backpressure, so we only pull from the origin as fast as
    // the client drains us — a manual res.write() loop ignores the return value and
    // buffers the whole file in memory against a slow player. It also destroys the
    // upstream stream when the client goes away, so we stop paying for bytes that
    // no longer have anywhere to go.
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (isClientDisconnect(error, res)) {
      return;
    }

    console.error('Proxy Stream Error:', error.message);

    if (res.headersSent) {
      res.destroy();
      return;
    }

    res.status(502).send('Proxy error');
  }
});

// 2. Stream Endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  
  // Parse season & episode if it is a TV show (series)
  let cleanId = id;
  let season = null;
  let episode = null;

  // Stremio series ID formats:
  // - IMDb: tt1234567:1:1 (imdbId:season:episode)
  // - TMDB: tmdb:series:12345:1:1 (tmdb:series:id:season:episode)
  if (type === 'series') {
    const parts = id.split(':');
    if (id.startsWith('tmdb:')) {
      cleanId = `tmdb:series:${parts[2]}`;
      season = parseInt(parts[3]) || 1;
      episode = parseInt(parts[4]) || 1;
    } else {
      cleanId = parts[0];
      season = parseInt(parts[1]) || 1;
      episode = parseInt(parts[2]) || 1;
    }
  }

  console.log(`Stream request: Type=${type}, ID=${cleanId}, Season=${season}, Episode=${episode}`);

  try {
    const streams = await scrapers.getStreams(type, cleanId, season, episode);
    const responseStreams = wrapProxyStreams(streams || [], req);
    console.log(`Stream response: ${responseStreams.length} streams for ${type}/${cleanId}`);
    
    // If no streams found, return empty array (Stremio format)
    res.json({ streams: responseStreams });
  } catch (error) {
    console.error('Stream Route Error:', error.message);
    res.json({ streams: [] });
  }
});

// 3. Landing / Dashboard Page Route
app.get('/', (req, res) => {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const manifestUrl = `${protocol}://${host}/manifest.json`;
  const stremioInstallUrl = `stremio://${host}/manifest.json`;

  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Latino Addon - Stremio en Español</title>
  <!-- Google Fonts Outfit & Inter -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  
  <style>
    :root {
      --bg-color: #07070d;
      --panel-bg: rgba(18, 18, 29, 0.55);
      --border-color: rgba(255, 255, 255, 0.08);
      --primary-color: #8b5cf6;
      --secondary-color: #ec4899;
      --accent-color: #3b82f6;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(139, 92, 246, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(236, 72, 153, 0.15) 0%, transparent 40%);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    h1, h2, h3 {
      font-family: 'Outfit', sans-serif;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 40px 20px;
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    /* Header Styling */
    header {
      text-align: center;
      margin-bottom: 50px;
    }

    .logo-container {
      display: inline-block;
      position: relative;
      margin-bottom: 20px;
    }

    .logo-glow {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 120px;
      height: 120px;
      background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
      filter: blur(40px);
      border-radius: 50%;
      z-index: -1;
      opacity: 0.8;
      animation: pulse 4s infinite alternate;
    }

    .logo {
      font-size: 4rem;
      font-weight: 800;
      background: linear-gradient(135deg, #a78bfa, #f472b6, #60a5fa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -2px;
      text-shadow: 0 0 40px rgba(139, 92, 246, 0.3);
    }

    .subtitle {
      font-size: 1.25rem;
      color: var(--text-muted);
      margin-top: 10px;
      font-weight: 300;
    }

    /* Premium Glassmorphic Cards */
    .glass-card {
      background: var(--panel-bg);
      backdrop-filter: blur(16px) saturate(120%);
      -webkit-backdrop-filter: blur(16px) saturate(120%);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 40px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
      margin-bottom: 30px;
    }

    .card-title {
      font-size: 1.8rem;
      font-weight: 600;
      margin-bottom: 25px;
      text-align: center;
      background: linear-gradient(90deg, #fff, var(--text-muted));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    /* Grid of Providers */
    .grid-providers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .provider-item {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 20px;
      text-align: center;
      transition: all 0.3s ease;
    }

    .provider-item:hover {
      transform: translateY(-5px);
      border-color: rgba(139, 92, 246, 0.4);
      background: rgba(139, 92, 246, 0.05);
      box-shadow: 0 5px 15px rgba(139, 92, 246, 0.1);
    }

    .provider-name {
      font-weight: 600;
      font-size: 1.1rem;
      margin-bottom: 5px;
    }

    .provider-status {
      font-size: 0.8rem;
      color: #10b981; /* Green */
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }

    .provider-status.warning {
      color: #f59e0b; /* Yellow */
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: currentColor;
    }

    /* Setup & Buttons */
    .actions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
      color: white;
      text-decoration: none;
      font-weight: 600;
      font-size: 1.2rem;
      padding: 16px 36px;
      border-radius: 50px;
      box-shadow: 0 10px 25px -5px rgba(139, 92, 246, 0.5);
      transition: all 0.3s ease;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      border: none;
      cursor: pointer;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px -5px rgba(139, 92, 246, 0.7);
    }

    .btn-secondary {
      background: transparent;
      color: var(--text-main);
      border: 1px solid var(--border-color);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.95rem;
      padding: 12px 28px;
      border-radius: 50px;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .manifest-box {
      width: 100%;
      max-width: 600px;
      margin-top: 10px;
      position: relative;
    }

    .manifest-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 12px 15px;
      color: var(--text-muted);
      font-size: 0.85rem;
      text-align: center;
      outline: none;
      font-family: monospace;
      cursor: text;
    }

    /* Installation Steps */
    .steps {
      display: flex;
      flex-direction: column;
      gap: 20px;
      margin-top: 10px;
    }

    .step-item {
      display: flex;
      gap: 15px;
      align-items: flex-start;
    }

    .step-num {
      background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-family: 'Outfit', sans-serif;
      flex-shrink: 0;
    }

    .step-text {
      font-size: 0.95rem;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .step-text strong {
      color: var(--text-main);
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 30px 20px;
      color: var(--text-muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--border-color);
      background: rgba(0, 0, 0, 0.2);
    }

    footer a {
      color: var(--primary-color);
      text-decoration: none;
    }

    footer a:hover {
      text-decoration: underline;
    }

    @keyframes pulse {
      0% {
        opacity: 0.6;
        transform: translate(-50%, -50%) scale(0.95);
      }
      100% {
        opacity: 0.9;
        transform: translate(-50%, -50%) scale(1.05);
      }
    }

    @media (max-width: 600px) {
      .logo {
        font-size: 3rem;
      }
      .glass-card {
        padding: 25px 15px;
      }
    }
  </style>
</head>
<body>

  <div class="container">
    <header>
      <div class="logo-container">
        <div class="logo-glow"></div>
        <h1 class="logo">Latino</h1>
      </div>
      <p class="subtitle">Agregador premium de películas y series en español para Stremio</p>
    </header>

    <div class="glass-card">
      <h2 class="card-title">Instalación Fácil</h2>
      
      <div class="actions">
        <a href="${stremioInstallUrl}" class="btn-primary">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 4V20M20 12H4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Instalar en Stremio
        </a>
        
        <p style="text-align: center; font-size: 0.9rem; color: var(--text-muted);">
          ¿No abre automáticamente? Copia el enlace del manifest de abajo y pégalo en la barra de búsqueda de Stremio.
        </p>

        <div class="manifest-box">
          <input type="text" class="manifest-input" value="${manifestUrl}" readonly onclick="this.select(); document.execCommand('copy'); alert('¡Enlace de manifest copiado!');">
        </div>
      </div>
    </div>

    <div class="glass-card">
      <h2 class="card-title">Fuentes Integradas</h2>
      
      <div class="grid-providers">
        <div class="provider-item">
          <div class="provider-name">SoloLatino.net</div>
          <div class="provider-status">
            <span class="dot"></span> Online
          </div>
        </div>
        <div class="provider-item">
          <div class="provider-name">Cinecalidad.am</div>
          <div class="provider-status">
            <span class="dot"></span> Online
          </div>
        </div>
        <div class="provider-item">
          <div class="provider-name">TioPlus.app</div>
          <div class="provider-status">
            <span class="dot"></span> Online
          </div>
        </div>
        <div class="provider-item">
          <div class="provider-name">LaMovie.org</div>
          <div class="provider-status">
            <span class="dot"></span> Online
          </div>
        </div>
        <div class="provider-item">
          <div class="provider-name">PelisPedia.mov</div>
          <div class="provider-status">
            <span class="dot"></span> Online
          </div>
        </div>
        <div class="provider-item">
          <div class="provider-name">CineHDPlus.org</div>
          <div class="provider-status warning">
            <span class="dot"></span> CF Guarded
          </div>
        </div>
      </div>

      <h2 class="card-title" style="margin-top: 40px; margin-bottom: 20px;">Cómo Configurar</h2>
      <div class="steps">
        <div class="step-item">
          <div class="step-num">1</div>
          <div class="step-text">Asegúrate de tener <strong>Stremio</strong> instalado en tu dispositivo (PC, Móvil, Smart TV o Fire Stick).</div>
        </div>
        <div class="step-item">
          <div class="step-num">2</div>
          <div class="step-text">Haz clic en el botón <strong>Instalar en Stremio</strong> superior para vincular el addon directamente.</div>
        </div>
        <div class="step-item">
          <div class="step-num">3</div>
          <div class="step-text">¡Todo listo! Ve al catálogo de Stremio y busca tus películas o series preferidas. Aparecerán los enlaces de <strong>Latino 🇲🇽</strong> con sus respectivos servidores de video.</div>
        </div>
      </div>
    </div>
  </div>

  <footer>
    <p>Latino Addon v${manifest.version} | Alimentado directamente por TMDB API</p>
  </footer>

</body>
</html>
  `);
});

app.__test = {
  shouldProxyStream,
  getProxyFilename,
  isLikelyHlsManifestUrl,
  proxiedStreamUrl,
  rewriteHlsManifest
};

module.exports = app;
