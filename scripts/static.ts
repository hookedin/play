import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The headers every file is served with: the `/*` block of a Cloudflare Pages `_headers` file. */
async function readHeaders(dir: string) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  const text = await fs.readFile(path.join(dir, '_headers'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match) headers[match[1]] = match[2];
  }
  return headers;
}

/**
 * Serve a built directory the way the static host does: its files, its `_headers`, and the page for any
 * extensionless route. `config`, when given, replaces config.js so a launcher can point the wallet at its casino.
 * `build`, when given, builds the directory again before every page load, so a change shows on reload.
 */
export function createStaticServer(dir: string, config?: unknown, build?: () => Promise<unknown>) {
  let built: Promise<unknown> = Promise.resolve();
  return http.createServer(async (req, res) => {
    let headers = await readHeaders(dir);
    if (req.method === 'OPTIONS') return void res.writeHead(204, headers).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, headers).end();
    try {
      const pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
      if (
        pathname.includes('\0') ||
        pathname.split('/').some(p => p === '..' || p.startsWith('.') || p.startsWith('_'))
      )
        throw new Error('Invalid path');
      if (build) {
        // One build at a time: a page starts one, and everything requested meanwhile waits for it.
        if (!path.extname(pathname) || pathname.endsWith('.html')) built = built.catch(() => {}).then(build);
        const failure = await built.then(
          () => null,
          (error: Error) => error,
        );
        if (failure) return void res.writeHead(500, { 'Content-Type': 'text/plain' }).end(failure.message);
        headers = await readHeaders(dir);
      }
      let data: Buffer | string, type: string;
      if (pathname === '/config.js' && config) {
        data = `export default ${JSON.stringify(config)};`;
        type = types['.js'];
      } else {
        // Wallet routes such as /wallet and /@hookedin/dice are client-side.
        const file = path.join(dir, !path.extname(pathname) ? 'index.html' : pathname);
        if (!(path.extname(file) in types)) throw new Error('Invalid file');
        data = await fs.readFile(file);
        type = types[path.extname(file)];
      }
      res.writeHead(200, { ...headers, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const port = Number(process.env.PORT ?? 4184);
  createStaticServer(dir).listen(port, '127.0.0.1', () => console.log(`Serving ${dir}: http://127.0.0.1:${port}`));
}
