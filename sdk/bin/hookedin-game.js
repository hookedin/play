#!/usr/bin/env node
// hookedin-game build [dir ...] | serve [dir] — turn a game's src/ into dist/, the folder any static host serves as is.
// A game is its URL: dist/index.html is the page the wallet frames, and dist/icon.svg the icon it shows the game by.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sdk = fileURLToPath(new URL('../', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Build the game in `root` (its src/) into the chosen output directory. */
export async function buildGame(root = process.cwd(), dist = path.join(root, 'dist')) {
  const src = path.join(root, 'src');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'brand'), { recursive: true });
  await build({
    entryPoints: [path.join(src, 'game.ts')],
    outfile: path.join(dist, 'game.js'),
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
  });
  // Everything in src/ that is not TypeScript ships as it is: the page, its styles, its icon and other images.
  fs.cpSync(src, dist, { recursive: true, filter: file => !file.endsWith('.ts') });
  fs.copyFileSync(path.join(sdk, 'shared.css'), path.join(dist, 'shared.css'));
  fs.copyFileSync(path.join(sdk, '../brand/hookedin-mark.svg'), path.join(dist, 'brand/hookedin-mark.svg'));
  // The page talks to no one but its own origin: a game with a server runs it there, as a Worker beside these files.
  fs.writeFileSync(
    path.join(dist, '_headers'),
    [
      '/*',
      `  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`,
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer',
      '',
    ].join('\n'),
  );
}

/**
 * Serve a built directory the way its static host does: its files, the headers of its `_headers` file, and the page
 * for any path without an extension. `config`, when given, replaces config.js, so a launcher can point the wallet at
 * its casino. `build`, when given, builds the directory again before every page load, so a change shows on reload.
 */
export function createStaticServer(dir, config, build) {
  let serving = Promise.resolve();
  /** The headers every file is served with: the `/*` block of the `_headers` file. */
  const readHeaders = async () => {
    const headers = { 'Cache-Control': 'no-store' };
    const text = await fs.promises.readFile(path.join(dir, '_headers'), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
      if (match) headers[match[1]] = match[2];
    }
    return headers;
  };
  return http.createServer(async (req, res) => {
    const respond = async () => {
      let headers = await readHeaders();
      if (req.method === 'OPTIONS') return void res.writeHead(204, headers).end();
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, headers).end();
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (
          pathname.includes('\0') ||
          pathname.split('/').some(p => p === '..' || p.startsWith('.') || p.startsWith('_'))
        )
          throw new Error('Invalid path');
        if (build && (!path.extname(pathname) || pathname.endsWith('.html'))) {
          try {
            await build();
          } catch (error) {
            return void res.writeHead(500, { 'Content-Type': 'text/plain' }).end(error.message);
          }
          headers = await readHeaders();
        }
        let data, type;
        if (pathname === '/config.js' && config) {
          data = `export default ${JSON.stringify(config)};`;
          type = types['.js'];
        } else {
          // A path without an extension, such as the wallet's /wallet or /@hookedin/dice, is a route of the page's own.
          const file = path.join(dir, path.extname(pathname) ? pathname : 'index.html');
          data = await fs.promises.readFile(file);
          type = types[path.extname(file)] ?? 'application/octet-stream';
        }
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found');
      }
    };
    // Reading the built files waits behind a rebuild: a second tab must not clear the directory while the first
    // reads its page or scripts.
    if (build) await (serving = serving.catch(() => {}).then(respond));
    else await respond();
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...dirs] = process.argv.slice(2);
  // A build problem is the developer's to fix, not a stack trace to read.
  try {
    if (command === 'build')
      for (const dir of dirs.length ? dirs : ['.']) {
        await buildGame(path.resolve(dir));
        console.log(`Built ${path.join(dir, 'dist')}/`);
      }
    else if (command === 'serve') {
      const root = path.resolve(dirs[0] ?? '.'),
        port = Number(process.env.PORT ?? 4185);
      await buildGame(root);
      createStaticServer(path.join(root, 'dist'), undefined, () => buildGame(root)).listen(port, '127.0.0.1', () =>
        console.log(
          `Game: http://127.0.0.1:${port}/\nIn the wallet, choose Open a game by its URL and paste that address.\nEvery page load rebuilds the game, so reload to see a change.`,
        ),
      );
    } else {
      console.error('Usage: hookedin-game build [dir ...] | serve [dir]');
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
