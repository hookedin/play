/** The wallet's storage in a real browser: IndexedDB, Web Locks and WebCrypto, which Node does not have. */
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

test('storage, recovery, history and backups hold in a real browser, and two tabs choose one funding key', async t => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  // The Chrome installed on the machine: GitHub's runners have it, and playwright-core downloads nothing.
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(async () => {
    await browser.close();
    server.close();
  });
  const context = await browser.newContext();

  const smoke = await context.newPage();
  await smoke.goto(base + '/__test');
  const report = await result(smoke);
  assert.equal(report.passed, true, report.error);
  assert.equal(report.indexedDB.atomicCommits, 300);
  assert.equal(report.walletHistory.channels, 1000);
  assert.equal(report.compactBackup.restored, true);

  // Both tabs share one origin's storage, so they are pages of one context.
  const run = crypto.randomUUID();
  const tabs = await Promise.all(['a', 'b'].map(() => context.newPage()));
  await Promise.all(tabs.map((tab, i) => tab.goto(`${base}/__test-funding?run=${run}&role=${'ab'[i]}`)));
  for (const [i, tab] of tabs.entries()) {
    const funding = await result(tab);
    assert.equal(funding.passed, true, funding.error);
    assert.equal(funding.role, 'ab'[i]);
    assert.equal(funding.simultaneousFundingSelection, true);
    assert.equal(funding.durableAccounts, 1);
    assert.equal(funding.atomicUpdates, 40);
  }
});
