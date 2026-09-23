#!/usr/bin/env node
// hookedin-game build [dir ...] | serve [dir] — turn a game's src/ into dist/, the folder any static host serves as is.
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
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Build the game in `root` (its src/) into root/dist/, and return its manifest. */
export async function buildGame(root = process.cwd()) {
  const src = path.join(root, 'src');
  const dist = path.join(root, 'dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  // The wallet refuses a manifest whose developer is not a real address, so a typo here is otherwise
  // a green build, a green deploy, and a game nobody can open.
  if (!/^0x[0-9a-fA-F]{40}$/.test(manifest.developer ?? ''))
    throw new Error(
      `"${manifest.developer}" is not a developer address. Set the developer field in src/manifest.json to the address that earns this game's commission.`,
    );
  if (/^0x0{40}$/.test(manifest.developer))
    throw new Error(
      "The developer address cannot be the zero address. Set the developer field in src/manifest.json to the address that earns this game's commission.",
    );
  if (manifest.referee !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(manifest.referee))
    throw new Error(
      `"${manifest.referee}" is not a referee address. It is the address of the key that runs the game's pots.`,
    );
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'brand'), { recursive: true });
  await build({
    entryPoints: [path.join(src, 'game.ts')],
    outfile: path.join(dist, 'game.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    legalComments: 'inline',
  });
  // Everything in src/ that is not TypeScript ships as it is: the page, its styles, images.
  fs.cpSync(src, dist, { recursive: true, filter: file => !file.endsWith('.ts') });
  fs.copyFileSync(path.join(sdk, 'shared.css'), path.join(dist, 'shared.css'));
  fs.copyFileSync(path.join(sdk, '../brand/hookedin-mark.svg'), path.join(dist, 'brand/hookedin-mark.svg'));
  // The wallet frames the game and fetches its manifest from another origin. The page itself talks to no one
  // but its own origin: a game with a server runs it there, as a Worker beside these files.
  fs.writeFileSync(
    path.join(dist, '_headers'),
    [
      '/*',
      `  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`,
      '  Access-Control-Allow-Origin: *',
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer',
      '',
    ].join('\n'),
  );
  return manifest;
}

/** Serve the game in `root`, building it again for every page load, so a change shows on reload. */
async function serve(root) {
  await buildGame(root);
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
        if (name.endsWith('.html')) {
          try {
            await buildGame(root);
          } catch (error) {
            return void res.writeHead(500, { ...headers, 'Content-Type': 'text/plain' }).end(error.message);
          }
        }
        const file = path.join(root, 'dist', name);
        if (!(path.extname(file) in types)) throw new Error();
        const data = fs.readFileSync(file);
        res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] }).end(data);
      } catch {
        res.writeHead(404, headers).end('Not found');
      }
    })
    .listen(port, '127.0.0.1', () =>
      console.log(
        `Game: http://127.0.0.1:${port}/\nIn the wallet, open Games → Add a custom game and paste:\n  http://127.0.0.1:${port}/manifest.json\nEvery page load rebuilds the game, so reload to see a change.`,
      ),
    );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...dirs] = process.argv.slice(2);
  // A build problem is the developer's to fix, not a stack trace to read.
  try {
    if (command === 'build')
      for (const dir of dirs.length ? dirs : ['.']) {
        const manifest = await buildGame(path.resolve(dir));
        console.log(`Built ${manifest.name} into ${path.join(dir, 'dist')}/ (developer ${manifest.developer})`);
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
