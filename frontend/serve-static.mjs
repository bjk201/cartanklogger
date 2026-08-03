import { createServer } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
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
    
    const proxyReq = await fetch(url.toString(), {
      method: req.method,
      headers: {
        ...req.headers,
        host: 'localhost:13132',
      },
    });
    
    res.writeHead(proxyReq.status, Object.fromEntries(proxyReq.headers.entries()));
    const body = await proxyReq.arrayBuffer();
    res.end(Buffer.from(body));
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
