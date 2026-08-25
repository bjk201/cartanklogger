import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(__dirname, 'dist');
const PORT = 5173;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  // API Proxy to backend
  if (req.url?.startsWith('/api')) {
    const target = 'http://localhost:13132';
    const url = new URL(req.url, target);

    // Collect request body (needed for POST/PUT/PATCH)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    try {
      const proxyRes = await fetch(url.toString(), {
        method: req.method,
        headers: {
          ...req.headers,
          host: 'localhost:13132',
        },
        body: body.length > 0 ? body : undefined,
        duplex: 'half',
      });

      const resHeaders = { 'content-type': proxyRes.headers.get('content-type') || 'application/json' };
      res.writeHead(proxyRes.status, resHeaders);
      const resBody = Buffer.from(await proxyRes.arrayBuffer());
      res.end(resBody);
    } catch (err) {
      console.error('Proxy error:', err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad gateway (proxy)' }));
    }
    return;
  }

  // Serve static files
  let filePath = join(distDir, req.url === '/' ? 'index.html' : req.url);
  
  try {
    const content = readFileSync(filePath);
    const ext = filePath.split('.').pop();
    res.writeHead(200, { 'Content-Type': mimeTypes[`.${ext}`] || 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback
    if (!req.url?.startsWith('/assets')) {
      try {
        const content = readFileSync(join(distDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Static server with API proxy running on http://0.0.0.0:${PORT}`);
});
