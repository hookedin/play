/** The wallet in a real browser: IndexedDB, Web Locks and passkeys, which Node does not have. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { createStaticServer } from '../scripts/static.ts';

const app = createStaticServer(fileURLToPath(new URL('../dist', import.meta.url)));
/** A browser test is bundled like the wallet itself: our modules inline, ethers from the served release. */
const testScript = (name: string) =>
  buildSync({
    entryPoints: [fileURLToPath(new URL(`${name}.ts`, import.meta.url))],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    alias: { ethers: '/vendor/ethers.js' },
    external: ['/vendor/ethers.js'],
  }).outputFiles[0].text;
const page = (title: string, script: string) =>
  `<!doctype html><title>${title}</title><pre id="result">Running…</pre><script type="module" src="${script}"></script>`;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__test-funding?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('HookedIn two-tab funding validation', '/__test-funding.js'));
  } else if (req.url === '/__test-funding.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(testScript('browser-funding'));
  } else if (req.url === '/__test-passkey') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('HookedIn passkey validation', '/__test-passkey.js'));
  } else if (req.url === '/__test-passkey.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(testScript('browser-passkey'));
  } else if (req.url === '/__test') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'",
    });
    res.end(page('HookedIn browser validation', '/__test.js'));
  } else if (req.url === '/__test.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(testScript('browser-smoke'));
  } else app.emit('request', req, res);
});

/** The JSON a harness page ends with in #result. */
async function result(tab: Page) {
  await tab.waitForFunction(
    () => {
      try {
        return 'passed' in JSON.parse(document.getElementById('result')!.textContent!);
      } catch {
        return false;
      }
    },
    null,
    { timeout: 120000 },
  );
  return JSON.parse((await tab.textContent('#result'))!);
}

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as any).port;
// The Chrome installed on the machine: GitHub's runners have it, and playwright-core downloads nothing.
const browser = await chromium.launch({ channel: 'chrome' });
test.after(async () => {
  await browser.close();
  server.close();
});

test('storage and locks hold in a real browser, and two tabs choose one key', async () => {
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext();

  const smoke = await context.newPage();
  await smoke.goto(base + '/__test');
  const report = await result(smoke);
  assert.equal(report.passed, true, report.error);

  // Both tabs share one origin's storage, so they are pages of one context.
  const run = crypto.randomUUID();
  const tabs = await Promise.all(['a', 'b'].map(() => context.newPage()));
  await Promise.all(tabs.map((tab, i) => tab.goto(`${base}/__test-funding?run=${run}&role=${'ab'[i]}`)));
  for (const [i, tab] of tabs.entries()) {
    const funding = await result(tab);
    assert.equal(funding.passed, true, funding.error);
    assert.equal(funding.role, 'ab'[i]);
    assert.equal(funding.simultaneousSelection, true);
    assert.equal(funding.durableAccounts, 1);
    assert.equal(funding.atomicUpdates, 40);
    assert.equal(funding.imports, 2);
  }
});

/** The harness beside a virtual authenticator that answers PRF requests, as a passkey's device does. WebAuthn takes a
 * domain, never an IP address, so the page is at localhost. */
async function passkeyPage() {
  const context = await browser.newContext(),
    tab = await context.newPage(),
    cdp = await context.newCDPSession(tab);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  await tab.goto(`http://localhost:${port}/__test-passkey`);
  await tab.waitForFunction(() => 'passkeyKey' in window);
  return (create: boolean) => tab.evaluate(create => (window as any).passkeyKey(create), create);
}

test('a passkey holds one account key, and another passkey another', async () => {
  const key = await passkeyPage();
  const made = await key(true);
  assert.match(made, /^0x[0-9a-f]{64}$/);
  assert.equal(await key(false), made, 'signing in gives the key the passkey was made with');
  assert.notEqual(await key(true), made);
});
