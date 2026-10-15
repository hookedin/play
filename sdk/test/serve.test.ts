import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { buildGame, createStaticServer } from '../bin/hookedin-game.js';

test('a game served while its sources are watched reloads its pages when a source changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-serve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src/index.html'),
    '<!doctype html><head></head><script type="module" src="./game.js"></script>',
  );
  fs.writeFileSync(path.join(root, 'src/game.ts'), 'export {};');
  await buildGame(root);
  const server = createStaticServer(path.join(root, 'dist'), () => buildGame(root), path.join(root, 'src'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  // The page carries the script that listens, and the script listens on the server's stream.
  assert.match(await (await fetch(base + '/')).text(), /<script type="module" src="\/__reload.js"><\/script><\/head>/);
  assert.match(await (await fetch(base + '/__reload.js')).text(), /new EventSource\('\/__reload'\)/);
  const stream = (await fetch(base + '/__reload')).body!.getReader();
  fs.writeFileSync(path.join(root, 'src/game.ts'), 'export const changed = true;');
  const { value } = await stream.read();
  assert.equal(new TextDecoder().decode(value), 'data: reload\n\n');
  await stream.cancel();
});

test('a game served without watching its sources is served as its static host serves it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-serve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.html'), '<!doctype html><head></head>');
  fs.writeFileSync(path.join(root, 'src/game.ts'), 'export {};');
  await buildGame(root);
  const server = createStaticServer(path.join(root, 'dist'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal(await (await fetch(base + '/')).text(), '<!doctype html><head></head>');
  assert.equal((await fetch(base + '/__reload')).status, 404);
});
