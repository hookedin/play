/** The local wallet `hookedin-game serve` runs beside a game: dice, played with pretend money in a real browser, and a
 * game's server playing against its stand-in casino. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { chromium } from 'playwright-core';
import { serveGame } from '../bin/hookedin-game.js';
import { createDeveloper } from '../src/developer.ts';
import { METH, NO_ALLOWANCE } from '../src/wire.ts';
import { decode, encode } from '../local-json.ts';

test('a game opens in the local wallet with nothing to play with, plays what it is allowed, and keeps it through Reload game', async t => {
  // The house's dice in a folder of its own that has the SDK installed, as a game made from the template does.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(fileURLToPath(new URL('../../games/dice/src', import.meta.url)), path.join(root, 'src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'node_modules/@hookedin'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../..', import.meta.url)), path.join(root, 'node_modules/@hookedin/play'));
  const { server } = await serveGame(root, 0);
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

test("a developer bet the local wallet places is read and settled by the game's server, through createDeveloper over HTTP", async t => {
  // A game served elsewhere, as a Worker is under wrangler dev: here nothing loads it, and the test is its page.
  const { server, env } = await serveGame('http://127.0.0.1:9/', 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const local = `http://localhost:${(server.address() as any).port}`;
  assert.equal(env.CASINO_URL, local);
  /** What the wallet answers the page. */
  const ask = async (path: string, value: unknown) =>
    decode(await (await fetch(local + path, { method: 'POST', body: encode(value) })).text());
  /** The next thing the wallet tells the page that `wanted` takes. */
  const events = (await fetch(`${local}/events`)).body!.pipeThrough(new TextDecoderStream()).getReader();
  let heard = '';
  const told = async (wanted: (event: string, fields: any) => boolean): Promise<any> => {
    for (;;) {
      const end = heard.indexOf('\n\n');
      if (end < 0) heard += (await events.read()).value;
      else {
        const [event, fields] = decode(heard.slice('data: '.length, end));
        heard = heard.slice(end + 2);
        if (wanted(event, fields)) return fields;
      }
    }
  };
  // The page says it places developer bets, so the player's allowance allows them, and places one.
  await ask('/wallet', { method: 'game.placesDeveloperBets', params: {} });
  await ask('/allowance', 5000n * METH);
  const { result: placed } = await ask('/wallet', {
    method: 'game.developerBet',
    params: { id: 'match', stake: 100n * METH, meta: { pick: 'home' } },
  });
  assert.equal(placed.status, 'open');
  // The game's server, with the key serve prints and nothing else, waits for the bet, backs it with a casino bet on a
  // round of its own, and pays it what that paid.
  const stranger = await createDeveloper({
    casinoURL: env.CASINO_URL,
    key: Wallet.createRandom().privateKey,
    game: env.GAME,
  });
  await assert.rejects(stranger.bets({ wait: 1 }), (error: any) => error.code === 'unauthorized');
  const developer = await createDeveloper({ casinoURL: env.CASINO_URL, key: env.SERVER_KEY, game: env.GAME });
  const { bets } = await developer.bets({ wait: 1 });
  assert.deepEqual(
    bets.map(bet => [bet.bet, bet.meta]),
    [[placed.bet, { pick: 'home' }]],
  );
  const round = await developer.openRound(),
    revealed = await developer.casinoBet({
      round: round.id,
      stake: 100n * METH,
      chance: 1n << 63n,
      prize: 190n * METH,
      group: 'match',
      meta: { covered: [placed.bet] },
    }),
    pays = revealed.casinoBet!.payout!;
  const [settled] = await developer.settle([{ bet: placed.bet, player: pays, casino: 0n }]);
  assert.deepEqual([settled!.status, settled!.settlement!.player], ['settled', pays]);
  // The page asks after its bet: the wallet collects what it was paid, and tells the page.
  await ask('/wallet', { method: 'game.receipt', params: { id: 'match' } });
  const { receipt } = await told((event, fields) => event === 'game.receipt' && fields.receipt.id === 'match');
  assert.deepEqual([receipt.status, receipt.payout], ['settled', pays]);
  const { result: allowance } = await ask('/wallet', { method: 'game.allowance', params: {} });
  assert.equal(allowance.allowance, 4900n * METH + pays);
  await events.cancel();
});
