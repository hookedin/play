/** Stake digits must fit at phone widths, up to stakes of a hundred thousand ETH. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const games = ['dice', 'mines', 'plinko', 'samson'];

test('complete stake amounts are readable on phones and tablets, on pages that hold only the game', async t => {
  const server = http.createServer(async (req, res) => {
    const parts = new URL(req.url!, 'http://localhost').pathname.split('/').filter(Boolean);
    if (!parts.length) return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
    if (!games.includes(parts[0]!) || parts.includes('..')) return void res.writeHead(404).end();
    const file = parts.length === 1 ? 'index.html' : parts.slice(1).join('/');
    try {
      const data = await readFile(new URL(`../../games/${parts[0]}/dist/${file}`, import.meta.url));
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
      res.writeHead(200, { 'content-type': type }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const game of games) {
    await page.goto(base);
    // The real game runs inside its frame, as it does in the wallet. Only its wallet replies are fixtures.
    await page.setContent('<iframe style="border:0;width:100%;height:900px"></iframe><style>body{margin:0}</style>');
    await page.evaluate(url => {
      const iframe = document.querySelector('iframe')!;
      window.addEventListener('message', event => {
        const request = event.data;
        if (event.source !== iframe.contentWindow || !request.hookedin || !request.method) return;
        const result =
          request.method === 'wallet.hello'
            ? { bounds: {} }
            : request.method === 'wallet.info'
              ? {
                  uname: 'layout',
                  discordUsername: null,
                  chainId: '31337',
                  virtualBankroll: '1000000000000000000000',
                  recommendedStake: '1000000000000',
                }
              : null;
        iframe.contentWindow!.postMessage({ hookedin: true, id: request.id, result }, '*');
      });
      iframe.src = url;
    }, `${base}/${game}/`);
    const frame = page.frameLocator('iframe');
    await frame.locator('#stake').waitFor();
    // The wallet's top bar names the game and shows its allowance: the page has neither.
    assert.equal(await frame.locator('h1, #allowance, .game-head').count(), 0, `${game} draws a header of its own`);
    for (const width of [320, 390, 720, 761, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const value of ['1', '1000000', '123456789012']) {
        const input = frame.locator('#stake');
        await input.fill(value);
        const fit = await input.evaluate((node: HTMLInputElement) => {
          const style = getComputedStyle(node),
            canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const textWidth = context.measureText(node.value).width;
          const available = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return {
            textWidth,
            available,
            value: node.value,
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        assert.equal(fit.value, value);
        assert.ok(fit.available >= fit.textWidth, `${game} at ${width}px clips ${value}: ${JSON.stringify(fit)}`);
        assert.ok(fit.scrollWidth <= fit.width, `${game} at ${width}px has horizontal page overflow`);
      }
      // Exercise the same controls with long cash-out and win figures, without placing a bet.
      if (game === 'mines')
        await frame.locator('#play').evaluate(node => (node.textContent = 'Cash out 123,456.789 µETH'));
      if (game === 'samson') {
        await frame.locator('#win-multiple').evaluate(node => (node.textContent = '6912×'));
        await frame.locator('#win-amount').evaluate(node => (node.textContent = '123,456.789 µETH'));
      }
      for (const selector of game === 'mines' ? ['#play'] : game === 'samson' ? ['.meter-value', '#win-amount'] : []) {
        const visible = await frame
          .locator(selector)
          .evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight);
        assert.ok(visible, `${game} at ${width}px clips ${selector}`);
      }
    }
  }
});
