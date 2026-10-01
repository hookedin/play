import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/static.ts';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

async function serve(t: TestContext, config?: unknown, build?: () => Promise<unknown>, directory = dist) {
  const server = createStaticServer(directory, config, build);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('the built wallet is one module plus the untouched ethers release and its config', async t => {
  const base = await serve(t, { network: 'local' });
  const html = await fetch(base + '/');
  assert.match(await html.text(), /src="\/main\.js"/);
  assert.match(html.headers.get('content-security-policy')!, /worker-src 'self'/);
  // The wallet must never be frameable: a same-origin game frame could otherwise drop its own sandbox.
  for (const route of ['/', '/games/dice', '/main.js'])
    assert.match((await fetch(base + route)).headers.get('content-security-policy')!, /frame-ancestors 'none'/, route);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await (await fetch(base + '/config.js')).text(), 'export default {"network":"local"};');

  const main = await (await fetch(base + '/main.js')).text();
  const imports = [...main.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]).sort();
  assert.deepEqual([...new Set(imports)], ['/config.js', '/vendor/ethers.js']);
  const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  assert.equal(
    sha(new Uint8Array(await (await fetch(base + '/vendor/ethers.js')).arrayBuffer())),
    sha(fs.readFileSync(new URL('../dist/ethers.min.js', import.meta.resolve('ethers')))),
  );
});

test('simultaneous tab reloads serve complete files throughout preview rebuilds', async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'hookedin-static-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let builds = 0;
  const build = async () => {
    builds++;
    fs.rmSync(directory, { recursive: true, force: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), '<title>Wallet</title><script src="/main.js"></script>');
    fs.writeFileSync(path.join(directory, 'main.js'), 'window.walletReady = true;');
    fs.writeFileSync(path.join(directory, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'\n");
  };
  const base = await serve(t, undefined, build, directory);
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(base + '/wallet?tab=' + i)));
  assert.equal(builds, 8);
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.match(await reply.text(), /<title>Wallet<\/title>/);
    assert.match(reply.headers.get('content-security-policy')!, /default-src 'self'/);
  }
  const assets = await Promise.all([fetch(base + '/'), fetch(base + '/main.js'), fetch(base + '/wallet/settings')]);
  assert.deepEqual(
    assets.map(reply => reply.status),
    [200, 200, 200],
  );
  assert.equal(await assets[1].text(), 'window.walletReady = true;');
});

test('wallet routes resolve to the client page without exposing other files', async t => {
  const base = await serve(t),
    page = await (await fetch(base + '/')).text();
  for (const route of [
    '/wallet',
    '/wallet/activity',
    '/wallet/settings',
    '/games',
    '/bets',
    '/bankroll',
    '/games/dice',
    '/@hookedin/dice',
    '/%40hookedin/dice',
    `/games/0x${'ab'.repeat(32)}`,
    '/games/custom?url=https://x.example/',
  ])
    assert.equal(await (await fetch(base + route)).text(), page, route);
  for (const route of [
    '/games/dice.js',
    '/games/.hidden',
    '/main.ts',
    '/.env',
    '/_headers',
    '/%2e%2e%2fprotocol%2fprotocol.ts',
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
