/** The wallet in a real browser: IndexedDB and passkeys, which Node does not have. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { createStaticServer } from '../sdk/bin/hookedin-game.js';

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
  if (req.url === '/__test-passkey') {
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

test('storage holds in a real browser, and only the tab that took the wallet writes it', async () => {
  const smoke = await (await browser.newContext()).newPage();
  await smoke.goto(`http://127.0.0.1:${port}/__test`);
  const report = await result(smoke);
  assert.equal(report.passed, true, report.error);
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
  await tab.waitForFunction(() => 'passkeyAccount' in window);
  return (create: boolean): Promise<{ key: string; user: number[] }> =>
    tab.evaluate(create => (window as any).passkeyAccount(create), create);
}

test('a passkey holds one account key, and another passkey another', async () => {
  const account = await passkeyPage();
  await assert.rejects(account(false), /No passkey was used/, 'a device with no passkey says so, in words');
  const made = await account(true);
  assert.match(made.key, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await account(false), made, 'signing in gives the key and the user the passkey was made with');
  assert.notEqual((await account(true)).key, made.key);
});
