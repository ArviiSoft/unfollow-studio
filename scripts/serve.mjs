import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Map([
  ['/', ['demo.html', 'text/html; charset=utf-8']],
  ['/demo.html', ['demo.html', 'text/html; charset=utf-8']],
  ['/dist/instagram-unfollow.js', ['dist/instagram-unfollow.js', 'text/javascript; charset=utf-8']],
  ['/dist/instagram-unfollow.txt', ['dist/instagram-unfollow.txt', 'text/plain; charset=utf-8']]
]);

export function createDemoServer() {
  return http.createServer(async (req, res) => {
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(req.headers.host ?? '')) {
      res.writeHead(403); res.end('Forbidden host'); return;
    }
    let url;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw new Error('Invalid request target');
      url = new URL(req.url, 'http://127.0.0.1');
    } catch { res.writeHead(400); res.end('Bad request'); return; }
    const file = files.get(url.pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(path.join(root, file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('Run npm run build first.'); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDemoServer();
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('Demo: http://127.0.0.1:' + server.address().port));
}