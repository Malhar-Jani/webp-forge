// Minimal zero-dependency static server for WebP Forge.
// Needed because WASM + module workers cannot load from file:// (null origin).
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const START_PORT = Number(process.env.PORT) || 4321;
const OPEN = process.argv.includes('--no-open') ? false : true;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel || 'index.html');
  // Block traversal outside ROOT.
  if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && abs !== ROOT) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  let abs = resolveSafe(req.url === '/' ? '/index.html' : req.url);
  if (!abs) { res.writeHead(403).end('Forbidden'); return; }

  try {
    let info = await stat(abs);
    if (info.isDirectory()) {
      abs = join(abs, 'index.html');
      info = await stat(abs);
    }
    // Vendored codecs never change, and each worker fetches them — let the
    // browser cache those. App files change while iterating, so never cache.
    const vendored = abs.includes(`${sep}vendor${sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': vendored ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

function listen(port, attemptsLeft = 12) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`\n  WebP Forge  ->  ${url}\n  Ctrl+C to stop.\n`);
    if (OPEN) {
      const p = process.platform;
      const [cmd, args] = p === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : p === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
  });
}

listen(START_PORT);
