import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { PROTOCOL } from '@hookedin/play/protocol/protocol.ts';
import { SportsBook } from './worker.ts';

const CASINO = 'https://casino.test';

/** The book's Durable Object against a stub casino, with somewhere to keep its state. */
function worker(t: { mock: { method: typeof import('node:test').mock.method } }, token?: string) {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = String(url).slice(CASINO.length);
    if (path === '/api/config')
      return Response.json({
        chainId: '31337',
        contractAddress: '0x' + 'c'.repeat(40),
        protocol: PROTOCOL,
        limits: { window: { min: 1000, max: 60000 } },
      });
    if (path === '/api/pots') return Response.json({ id: keccak256(toUtf8Bytes(String(++count))), status: 'open' });
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  const stored = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, value),
    },
  } as unknown as DurableObjectState;
  const book = new SportsBook(ctx, {
    CASINO_URL: CASINO,
    DEVELOPER: Wallet.createRandom().address,
    GAME_NAME: 'sports',
    REFEREE_KEY: Wallet.createRandom().privateKey,
    ...(token ? { ADMIN_TOKEN: token } : {}),
  } as never);
  return (path: string, body?: unknown, authorization?: string) =>
    book.fetch(
      new Request(`https://sports.test/api${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: authorization ? { authorization } : {},
      }),
    );
}

const market = {
  title: 'Final',
  outcomes: [
    { name: 'Home', odds: 20000 },
    { name: 'Away', odds: 20000 },
  ],
  closesAt: Date.now() + 60_000,
  deadline: Date.now() + 120_000,
};

test("only the operator's token opens a market, and anyone reads the markets", async t => {
  const call = worker(t, 'operator-token');
  assert.equal((await call('/markets', market)).status, 401);
  assert.equal((await call('/markets', market, 'Bearer wrong')).status, 401);
  const opened = await call('/markets', market, 'Bearer operator-token');
  assert.equal(opened.status, 200);
  const { id } = (await opened.json()) as any;
  assert.deepEqual(
    ((await (await call('/markets')).json()) as any[]).map(m => m.id),
    [id],
  );
  assert.equal((await call(`/markets/${id}/void`, {})).status, 401);
});

test('without a token set, nobody operates the book', async t => {
  const call = worker(t);
  assert.equal((await call('/markets', market, 'Bearer ')).status, 401);
  assert.equal((await call('/markets', market, 'Bearer undefined')).status, 401);
});
