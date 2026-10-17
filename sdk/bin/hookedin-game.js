#!/usr/bin/env node
// hookedin-game build [dir ...] | serve [dir | url] — turn a game's src/ into dist/, the folder any static host serves as
// is, or serve it as it changes, or a game served elsewhere by its URL, beside a local wallet with pretend money.
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

/** What a page served while its sources are watched runs: it loads itself again whenever the server says so. A game
 * that reloads itself keeps its allowance in the wallet. */
const RELOAD =
  "const reload = new EventSource('/__reload');\nreload.addEventListener('message', () => location.reload());\n// Closed as the page goes, the stream ends cleanly rather than cut off.\naddEventListener('pagehide', () => reload.close());\n";

/**
 * Serve a built directory the way its static host does: its files, the headers of its `_headers` file, and the page
 * for any path without an extension. `build`, when given, builds the directory again before every page load, so a
 * change shows on reload. `watched`, when given, is the directory whose changes reload every page open from this server.
 */
export function createStaticServer(dir, build, watched) {
  let serving = Promise.resolve();
  /** The open pages, each a stream the server tells to reload, a moment after the last change. */
  const pages = new Set();
  let changed;
  const watcher =
    watched &&
    fs.watch(watched, { recursive: true }, () => {
      clearTimeout(changed);
      changed = setTimeout(() => {
        for (const page of pages) page.write('data: reload\n\n');
      }, 100);
    });
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
  const server = http.createServer(async (req, res) => {
    // A page's stream stays open, so it is answered here and not behind the rebuilds.
    if (watcher && req.url === '/__reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }).flushHeaders();
      pages.add(res);
      req.on('close', () => pages.delete(res));
      return;
    }
    if (watcher && req.url === '/__reload.js')
      return void res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' }).end(RELOAD);
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
        // A path without an extension, such as the wallet's /wallet, or a player's, such as /@bob.jones/dice, is a
        // route of the page's own.
        const route = !path.extname(pathname) || pathname.startsWith('/@');
        if (build && (route || pathname.endsWith('.html'))) {
          try {
            await build();
          } catch (error) {
            return void res.writeHead(500, { 'Content-Type': 'text/plain' }).end(error.message);
          }
          headers = await readHeaders();
        }
        const file = path.join(dir, route ? 'index.html' : pathname);
        let data = await fs.promises.readFile(file);
        if (watcher && file.endsWith('.html'))
          data = data.toString().replace('</head>', '<script type="module" src="/__reload.js"></script></head>');
        res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
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
  server.on('close', () => watcher?.close());
  return server;
}

/** The local wallet's page: its top bar over the game, and its script, `local-wallet.ts`, built as the server starts. */
const LOCAL_WALLET = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local wallet · HookedIn</title>
    <link rel="icon" href="data:," />
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0; display: flex; flex-direction: column; height: 100vh; background: #0b0e15; color: #edf0f5;
        font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      header {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 16px;
        border-bottom: 1px solid #252b39;
      }
      header > strong { margin-right: auto; }
      small { color: #8a91a0; }
      form { display: flex; align-items: center; gap: 6px; }
      input {
        width: 8em; padding: 6px 8px; border: 1px solid #343b4d; border-radius: 8px; background: #121722;
        color: inherit; font: inherit;
      }
      button {
        padding: 6px 12px; border: 0; border-radius: 8px; background: #a68cff; color: #150f26; font: inherit;
        font-weight: 600; cursor: pointer;
      }
      #reload { border: 1px solid #343b4d; background: #181e2b; color: inherit; }
      #problem { flex-basis: 100%; margin: 0; color: #ef7d95; }
      #problem:empty { display: none; }
      main { flex: 1; display: flex; }
      iframe { flex: 1; border: 0; }
    </style>
  </head>
  <body>
    <header>
      <strong>Local wallet <small>· pretend money</small></strong>
      <span><small>Balance</small> <span id="balance"></span></span>
      <form id="allow">
        <small>Allowance</small> <span id="allowance"></span>
        <input id="amount" inputmode="numeric" placeholder="METH" aria-label="Allowance in METH" autocomplete="off" />
        <button type="submit">Allow</button>
      </form>
      <button id="reload" type="button">Reload game</button>
      <p id="problem" role="alert"></p>
    </header>
    <main id="game"></main>
    <script type="module" src="/local-wallet.js"></script>
  </body>
</html>
`;

/** Whether `game` names a game served elsewhere, by its URL, rather than by its folder. */
const elsewhere = game => /^https?:\/\//.test(game);

/**
 * Serve the local wallet at http://localhost:<port>/: the game framed with pretend money, against a stand-in casino
 * that the game's server, if it has one, reaches at the same address. `game` is the game's folder, served at
 * http://127.0.0.1:<port>/, built again on every page load and reloaded on every change to its src/: one port under two
 * names is two origins, as a wallet and its game always are. Or it is the URL of a game served elsewhere, such as its
 * Worker's under `wrangler dev`. Resolves once the server listens, with it and what the game's server needs to play
 * against the stand-in, as its `.dev.vars` holds it.
 */
export async function serveGame(game, port) {
  const url = elsewhere(game) ? new URL(game).href : null;
  if (!url) await buildGame(game);
  const bundle = async options =>
    (await build({ bundle: true, format: 'esm', target: 'es2022', write: false, ...options })).outputFiles[0].contents;
  const [script, standIn] = await Promise.all([
    bundle({
      entryPoints: [path.join(sdk, 'local-wallet.ts')],
      platform: 'browser',
      minify: true,
      define: { GAME: JSON.stringify(url ?? '') },
    }),
    bundle({ entryPoints: [path.join(sdk, 'local-casino.ts')], platform: 'node' }),
  ]);
  // The stand-in is TypeScript, which Node does not run from node_modules: it runs bundled, from memory.
  const { localCasino, SERVER_KEY } = await import(
    `data:text/javascript;base64,${Buffer.from(standIn).toString('base64')}`
  );
  const casino = await localCasino(url ?? `http://127.0.0.1:${port}/`);
  const local = { '/': [LOCAL_WALLET, types['.html']], '/local-wallet.js': [script, types['.js']] };
  const served = url
    ? null
    : createStaticServer(path.join(game, 'dist'), () => buildGame(game), path.join(game, 'src'));
  const server = http.createServer((req, res) => {
    if (served && new URL(`http://${req.headers.host}`).hostname !== 'localhost')
      return void served.emit('request', req, res);
    const page = local[new URL(req.url, 'http://localhost').pathname];
    if (!page) return void casino.handle(req, res);
    res.writeHead(200, { 'Content-Type': page[1], 'Cache-Control': 'no-store' }).end(page[0]);
  });
  // The game's server stops watching its sources with this one.
  server.on('close', () => served?.close());
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const env = { CASINO_URL: `http://localhost:${server.address().port}`, GAME: casino.game, SERVER_KEY };
  return { server, env };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  // A build problem is the developer's to fix, not a stack trace to read.
  try {
    if (command === 'build')
      for (const dir of args.length ? args : ['.']) {
        await buildGame(path.resolve(dir));
        console.log(`Built ${path.join(dir, 'dist')}/`);
      }
    else if (command === 'serve') {
      const port = Number(process.env.PORT ?? 4185),
        [game = '.'] = args,
        { env } = await serveGame(elsewhere(game) ? game : path.resolve(game), port);
      console.log(
        [
          `Try the game with pretend money: http://localhost:${port}/`,
          ...(elsewhere(game)
            ? []
            : [
                `Play it with ETH at https://play.hookedin.com: choose Open a game by its URL and paste http://127.0.0.1:${port}/`,
                'Saving a file in src/ builds the game again and reloads it, keeping its allowance.',
              ]),
          'Its server, if it has one, plays against the same pretend casino with these in its .dev.vars:',
          ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
        ].join('\n'),
      );
    } else {
      console.error('Usage: hookedin-game build [dir ...] | serve [dir | url]');
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
