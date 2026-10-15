/** The local wallet `hookedin-game serve` runs beside a game: dice, played with pretend money in a real browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveGame } from '../bin/hookedin-game.js';
import { NO_ALLOWANCE } from '../src/wire.ts';

test('a game opens in the local wallet with nothing to play with, plays what it is allowed, and keeps it through Reload game', async t => {
  // The house's dice in a folder of its own that has the SDK installed, as a game made from the template does.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(fileURLToPath(new URL('../../games/dice/src', import.meta.url)), path.join(root, 'src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'node_modules/@hookedin'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../..', import.meta.url)), path.join(root, 'node_modules/@hookedin/play'));
  const server = await serveGame(root, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage(),
    problems: string[] = [];
  page.on(
    'console',
    message => message.type() === 'error' && problems.push(`${message.text()} ${message.location().url}`),
  );
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`http://localhost:${(server.address() as any).port}/`);
  const game = page.frameLocator('iframe');
  await game.locator('#status', { hasText: NO_ALLOWANCE }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#balance').textContent(), '1,000,000 METH');
  await page.locator('#amount').fill('5000');
  await page.locator('#allow button').click();
  await page.locator('#allowance', { hasText: '5,000 METH' }).waitFor();
  await game.locator('#stake').fill('100');
  await game.locator('#play:not([disabled])').click();
  await game.locator('#history li').first().waitFor({ timeout: 30000 });
  // Reloaded in place, the game keeps its allowance, less what the roll took or plus what it won.
  const allowed = await page.locator('#allowance').textContent();
  await page.locator('#reload').click();
  await game.locator('#play:not([disabled])').waitFor({ timeout: 30000 });
  assert.equal(await game.locator('#status').textContent(), '');
  assert.equal(await page.locator('#allowance').textContent(), allowed);
  await game.locator('#play').click();
  await game.locator('#history li:nth-child(2)').waitFor({ timeout: 30000 });
  assert.deepEqual(problems, []);
});
