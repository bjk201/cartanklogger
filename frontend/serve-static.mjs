import { createServer } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------
// Root-Verzeichnis der gebauten SPA:
// 1. IMMER /app/dist, wenn vorhanden (Produktiv-Container, Image-Build)
// 2. Fallback: dist relativ zu dieser Datei (Host-Betrieb/Entwicklung)
// ---------------------------------------------------------------------
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const candidates = [resolve('/app/dist'), resolve(join(__dirname, 'dist'))];
const distDir = candidates.find((d) => existsSync(join(d, 'index.html'))) || candidates[0];

const PORT = Number(process.env.PORT || 5173);
// Backend fuer /api-Proxy:
// - Host-Betrieb:        http://127.0.0.1:13132 (Backend-Publish-Port)
// - Docker-Container:    wird von update.sh gesetzt (host.docker.internal)
const PROXY_TARGET = process.env.PROXY_TARGET || 'http://127.0.0.1:13132';

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[serve-static] WARNUNG: ${join(distDir, 'index.html')} fehlt — alle Anfragen werden 404. Erst 'npm run build' ausfuehren!`);
} else {
  console.log(`[serve-static] distRoot=${distDir} (index.html OK)`);
}
console.log(`[serve-static] API-Proxy /api -> ${PROXY_TARGET}`);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendFile(res, filePath, method) {
  const stat = statSync(filePath);
  const headers = {
    'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
  };
  // Gehashte Assets duerfen aggressiv gecacht werden, HTML nie:
  if (filePath.includes(`${sep}assets${sep}`)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : readFileSync(filePath));
}

function sendIndex(res, method) {
  sendFile(res, join(distDir, 'index.html'), method);
}

const server = createServer(async (req, res) => {
  const rawUrl = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();

  // ----------------------------- API-Proxy -----------------------------
  if (rawUrl.startsWith('/api')) {
    const url = new URL(rawUrl, PROXY_TARGET);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    try {
      const proxyRes = await fetch(url.toString(), {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        body: body.length > 0 ? body : undefined,
        duplex: 'half',
      });
      const resHeaders = { 'content-type': proxyRes.headers.get('content-type') || 'application/json' };
      res.writeHead(proxyRes.status, resHeaders);
      res.end(Buffer.from(await proxyRes.arrayBuffer()));
    } catch (err) {
      console.error('Proxy error:', err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad gateway (proxy)' }));
    }
    return;
  }

  // ------------------------- Statische SPA-Dateien ----------------------
  // Query-String/Hash abtrennen und dekodieren:
  const pathname = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);

  // Pfad-Traversal verhindern: Aufloesung MUSS innerhalb distDir bleiben.
  const requested = resolve(join(distDir, pathname));
  if (!requested.startsWith(distDir + sep) && requested !== distDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    if (pathname === '/') {
      sendIndex(res, method);
      return;
    }
    const filePath = requested;
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      // Verzeichnis ohne Datei -> SPA-Fallback
      sendIndex(res, method);
      return;
    }
    sendFile(res, filePath, method);
  } catch {
    // Nicht gefundene Route: SPA-Fallback auf index.html — AUSSER Assets
    // (fehlende Asset-Datei ist ein echter 404, kein Fallback-Text)
    if (!pathname.startsWith('/assets')) {
      try {
        sendIndex(res, method);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve-static] listening on http://0.0.0.0:${PORT}`);
});
