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

/** Serve the game in `root`, building it again for every page load, so a change shows on reload. Every request waits
 * for the build in flight, so nothing is read from a dist/ that is being made again. */
async function serve(root) {
  let building = buildGame(root);
  await building;
  const headers = { 'Cache-Control': 'no-store' };
  for (const line of fs.readFileSync(path.join(root, 'dist/_headers'), 'utf8').split('\n')) {
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match) headers[match[1]] = match[2];
  }
  const port = Number(process.env.PORT ?? 4185);
  http
    .createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname.split('/').some(p => p === '..' || p.startsWith('.') || p.startsWith('_'))) throw new Error();
        const name = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
        if (name.endsWith('.html')) building = building.catch(() => {}).then(() => buildGame(root));
        try {
          await building;
        } catch (error) {
          return void res.writeHead(500, { ...headers, 'Content-Type': 'text/plain' }).end(error.message);
        }
        const file = path.join(root, 'dist', name);
        const data = fs.readFileSync(file);
        res
          .writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
          .end(data);
      } catch {
        res.writeHead(404, headers).end('Not found');
      }
    })
    .listen(port, '127.0.0.1', () =>
      console.log(
        `Game: http://127.0.0.1:${port}/\nIn the wallet, choose Open a game by its URL and paste that address.\nEvery page load rebuilds the game, so reload to see a change.`,
      ),
    );
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
    else if (command === 'serve') await serve(path.resolve(dirs[0] ?? '.'));
    else {
      console.error('Usage: hookedin-game build [dir ...] | serve [dir]');
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
