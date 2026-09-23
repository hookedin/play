import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { QUOTE_TYPES, domain, hashJSON } from '@hookedin/play/protocol/protocol.ts';
import type { Referee } from '@hookedin/play/sdk/referee';
import { Book } from '../server/book.ts';
import type { Market } from '../server/book.ts';

const d = domain(31337n, '0x' + 'c'.repeat(40));
const DAY = 86_400_000;

/** A casino that does what the referee kit asks, and a clock the test turns. */
function book() {
  let now = 1_000_000_000_000,
    count = 0,
    failing: Error | null = null;
  const key = Wallet.createRandom(),
    pots = new Map<string, any>(),
    saves: Market[][] = [];
  const referee = {
    address: key.address,
    async open(options: any) {
      const id = keccak256(toUtf8Bytes(String(++count)));
      pots.set(id, { id, status: 'open', ...options });
      return { pot: pots.get(id) };
    },
    async quote(pot: string, stake: bigint, prizes: any[], expiresAt: number) {
      const message = { pot, stake: String(stake), prizes: hashJSON(prizes), expiresAt: String(expiresAt) };
      return { expiresAt: message.expiresAt, signature: await key.signTypedData(d, QUOTE_TYPES, message) };
    },
    async resolve(id: string, result: any) {
      if (failing) throw failing;
      const pot = pots.get(id);
      // The casino answers a pot it has resolved with how it ended, whatever it is asked.
      if (pot.status === 'open') Object.assign(pot, { status: 'resolved', result });
      return pot;
    },
    async void(id: string) {
      pots.get(id).status = 'void';
      return pots.get(id);
    },
  } as unknown as Referee;
  const b = new Book({ referee, now: () => now, save: markets => void saves.push(structuredClone(markets)) });
  const market = () =>
    b.open({
      title: 'Final',
      outcomes: [
        { name: 'Home', odds: 21000 },
        { name: 'Draw', odds: 34000 },
        { name: 'Away', odds: 30000 },
      ],
      closesAt: now + DAY,
      deadline: now + 2 * DAY,
    });
  return {
    book: b,
    key,
    pots,
    saves,
    market,
    advance: (ms: number) => (now += ms),
    fail: (error: Error | null) => (failing = error),
    now: () => now,
  };
}

test('a market is a developer pot in each asset, with the outcomes and the deadline it was opened with', async () => {
  const t = book(),
    market = await t.market();
  assert.deepEqual(Object.keys(market.pots), ['eth', 'test']);
  for (const [asset, id] of Object.entries(market.pots))
    assert.deepEqual(
      (({ bank, asset, outcomes, closesAt, deadline }) => ({ bank, asset, outcomes, closesAt, deadline }))(
        t.pots.get(id),
      ),
      { bank: 'developer', asset, outcomes: 3, closesAt: market.closesAt, deadline: market.deadline },
    );
  assert.deepEqual(t.saves.at(-1), [market], 'and saved');
  for (const bad of [
    { title: '', outcomes: market.outcomes },
    { title: 'x', outcomes: [market.outcomes[0]] },
    { title: 'x', outcomes: [{ name: 'Evens', odds: 10000 }, market.outcomes[0]] },
  ])
    await assert.rejects(t.book.open({ ...bad, closesAt: t.now() + 1, deadline: t.now() + 2 }), /A market/);
  await assert.rejects(
    t.book.open({ title: 'x', outcomes: market.outcomes, closesAt: t.now() + 2, deadline: t.now() + 1 }),
    /resolved by its deadline/,
  );
});

test('a quote is the stake at the market odds, on its one outcome, signed by the referee for a minute', async () => {
  const t = book(),
    market = await t.market();
  const { pot, prizes, quote } = await t.book.quote({ market: market.id, asset: 'test', outcome: 2, stake: '1000' });
  assert.equal(pot, market.pots.test);
  assert.deepEqual(prizes, [{ rangeStart: '2', rangeEnd: '3', payout: '3000' }]);
  assert.equal(Number(quote.expiresAt), Math.floor(t.now() / 1000) + 60);
  const message = { pot, stake: '1000', prizes: hashJSON(prizes), expiresAt: quote.expiresAt };
  assert.equal(await t.key.signTypedData(d, QUOTE_TYPES, message), quote.signature);
  for (const bad of [
    { outcome: 3, stake: '1000' },
    { outcome: 0, stake: '0' },
    { outcome: 0, stake: '1.5' },
  ])
    await assert.rejects(t.book.quote({ market: market.id, asset: 'eth', ...bad }), /outcome|stake/);
  t.advance(market.closesAt - t.now());
  await assert.rejects(t.book.quote({ market: market.id, asset: 'eth', outcome: 0, stake: '1' }), /no more bets/);
});

test('a winner is saved before any pot is resolved, and a resolution cut short finishes with the same one', async () => {
  const t = book(),
    market = await t.market();
  t.fail(Object.assign(new Error("The developer's bank cannot pay this pot in full"), { status: 409 }));
  await assert.rejects(t.book.resolve(market.id, 1), /cannot pay/);
  assert.equal(t.saves.at(-1)![0]!.winner, 1);
  await assert.rejects(t.book.quote({ market: market.id, asset: 'eth', outcome: 0, stake: '1' }), /no more bets/);
  await assert.rejects(t.book.resolve(market.id, 0), /another winner/);
  await assert.rejects(t.book.void(market.id), /has a winner/);
  t.fail(null);
  const resolved = await t.book.resolve(market.id, 1);
  assert.equal(resolved.status, 'resolved');
  for (const id of Object.values(market.pots)) assert.deepEqual(t.pots.get(id).result, { outcome: 1 });
});

test('a market called off voids its pots, and one nobody resolved shows void after its deadline', async () => {
  const t = book(),
    called = await t.market(),
    forgotten = await t.market();
  assert.equal((await t.book.void(called.id)).status, 'void');
  for (const id of Object.values(called.pots)) assert.equal(t.pots.get(id).status, 'void');
  await assert.rejects(t.book.resolve(called.id, 0), /void/);
  t.advance(2 * DAY);
  assert.deepEqual(
    t.book.list().map(market => [market.id, market.status]),
    [
      [called.id, 'void'],
      [forgotten.id, 'void'],
    ],
  );
});
