import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { DropClient } from '../src/drop.ts';
import { RISKS, ROWS, dropBet, landing, multipliers, paths } from '../src/tables.ts';
import { admits } from '@hookedin/play/sdk/admits';
import { describeBet, betReturn } from '@hookedin/play/sdk/admits';
import { OUTCOME_SPACE } from '@hookedin/play/sdk/engine';

const memoryStore = () => {
  const map = new Map<string, string>();
  return {
    map,
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
};

test('every board is one bet that tiles the outcome space and returns exactly 99%', t => {
  const stake = 10n ** 12n;
  for (const rows of ROWS)
    for (const risk of RISKS) {
      const table = multipliers(rows, risk);
      assert.equal(table.length, rows + 1);
      assert.deepEqual(table, [...table].reverse(), 'boards are symmetric');
      assert.equal(
        table.reduce((sum, hundredths, bucket) => sum + paths(rows, bucket) * BigInt(hundredths), 0n),
        99n * (1n << BigInt(rows)),
        `${rows} ${risk}`,
      );
      const bet = dropBet(rows, risk, stake);
      assert.equal(bet.prizes.length, rows + 1, 'a prize per bucket');
      let edge = 0n;
      for (const [bucket, prize] of bet.prizes.entries()) {
        assert.equal(prize.rangeStart, edge, 'buckets sit side by side');
        assert.equal(
          prize.rangeEnd - prize.rangeStart,
          paths(rows, bucket) << BigInt(64 - rows),
          'with exact binomial widths',
        );
        edge = prize.rangeEnd;
      }
      assert.equal(edge, OUTCOME_SPACE);
      // What the player signs returns exactly 99% of the stake: nothing is sampled or rounded.
      const signed = describeBet(bet);
      assert.equal(signed.expectedPayout * 100n, 99n * stake * OUTCOME_SPACE);
      assert.equal(signed.maxPayout, (stake * BigInt(Math.max(...table))) / 100n);
      assert.ok(admits(20000n * stake, bet), 'and the casino admits it as one wager');
      assert.ok(
        !admits(BigInt(Math.max(...table)) * (stake / 100n), bet),
        'but not against a bankroll its top prize would empty',
      );
    }
  assert.equal(paths(16, 8), 12870n);
  t.diagnostic('9 boards: exact 99% from the signed prizes alone');
});

test("the round's outcome is the ball: every path once, in its own bucket, to the last outcome", () => {
  for (const rows of ROWS) {
    const seen = new Set<string>(),
      perBucket = new Map<number, number>(),
      shift = BigInt(64 - rows),
      step = rows === 16 ? 97n : 1n; // Every path on the small boards; a spread of them on the largest.
    for (let path = 0n; path < 1n << BigInt(rows); path += step) {
      const { bucket, turns } = landing(rows, (path << shift) + ((path * 0x9e3779b97f4a7c15n) & ((1n << shift) - 1n)));
      assert.equal(turns.length, rows);
      assert.equal(turns.filter(Boolean).length, bucket, 'the turns land in the bucket');
      seen.add(turns.map(Number).join(''));
      perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
    }
    if (step === 1n) {
      assert.equal(seen.size, 1 << rows, 'each equally likely path is a different ball');
      for (const [bucket, count] of perBucket) assert.equal(BigInt(count), paths(rows, bucket));
    }
    // The ball and the money never disagree, even at the first and last outcome of every prize.
    for (const [bucket, prize] of dropBet(rows, 'medium', 1000n).prizes.entries())
      for (const outcome of [prize.rangeStart, prize.rangeEnd - 1n])
        assert.equal(landing(rows, outcome).bucket, bucket);
  }
});

test('drops settle as single wagers, recover a lost reply under the same ID, and explain limits', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('plinko'));
  await w.setGameLimit('200000');
  const store = memoryStore();
  let loseReply = false,
    bets = 0,
    bankroll = '1000000000000';
  const bridge = {
    balance: async () => w.gameLimit(),
    call: async (method: string, params: any = {}) => {
      if (method === 'wallet.hello') return w.gameHello();
      if (method === 'wallet.info') return { ...w.gameInfo(), bankroll };
      if (method === 'game.receipt') return w.gameReceipt(params.id);
      if (method !== 'game.bet') throw new Error(`unexpected ${method}`);
      bets++;
      assert.equal(JSON.parse(store.map.values().next().value!).id, params.id, 'the drop is saved before it is sent');
      assert.equal(
        params.prizes.length,
        JSON.parse(store.map.values().next().value!).rows + 1,
        'one bet carries the whole board',
      );
      const receipt = await w.gameBet(params);
      if (loseReply) throw new Error('The wallet did not respond.');
      return receipt;
    },
  };
  let client = new DropClient(bridge, { store, name: 'plinko' });
  let expected = await w.balance();
  for (let ball = 0; ball < 24; ball++) {
    const rows = ROWS[ball % 3],
      risk = RISKS[ball % 2];
    const landed = await client.drop({ rows, risk, stake: '1000' });
    const bucket = landed.turns.filter(Boolean).length;
    assert.equal(landed.turns.length, rows);
    assert.equal(BigInt(landed.payout), (1000n * BigInt(multipliers(rows, risk)[bucket])) / 100n);
    expected += BigInt(landed.payout) - 1000n;
    assert.equal(await w.balance(), expected, 'a ball moves exactly its payout minus the bet');
    assert.equal(store.map.size, 0, 'a landed ball leaves no ticket');
  }
  assert.equal(bets, 24, 'one wager per ball');

  loseReply = true;
  await assert.rejects(client.drop({ rows: 16, risk: 'high', stake: '1000' }), /did not respond/);
  loseReply = false;
  // After a reload the settled wager lands once, on its own board, without another bet.
  client = new DropClient(bridge, { store, name: 'plinko' });
  const recovered = await client.restore();
  assert.equal(recovered!.rows, 16);
  assert.equal(
    BigInt(recovered!.payout),
    (1000n * BigInt(multipliers(16, 'high')[recovered!.turns.filter(Boolean).length])) / 100n,
  );
  assert.equal(bets, 25);
  assert.equal(store.map.size, 0);
  assert.equal(await client.restore(), null);

  await assert.rejects(client.drop({ rows: 8, risk: 'low', stake: '1' }), /too small/);
  bankroll = '1000000';
  client = new DropClient(bridge, { store, name: 'plinko' });
  await assert.rejects(client.drop({ rows: 16, risk: 'high', stake: '1000' }), /can only back about/);
  assert.equal(store.map.size, 0, 'nothing is saved for a table the casino cannot back');
});

/** The least any one bet of this game pays back, in millionths of its stake. The game publishes no
 * such figure — a promise nobody can verify is worth nothing, because no game bounds how often it
 * wagers what it holds — but its own table is held to it here, and every player sees the measured
 * return of each bet they actually signed. */
const FLOOR = 990000n;

test('every board pays back at least the floor this game is built to', () => {
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const rows of ROWS)
      for (const risk of RISKS)
        assert.ok(
          betReturn(dropBet(rows, risk, stake)) >= FLOOR,
          `${rows} rows at ${risk} risk for ${stake} wei pays back less than this game's floor`,
        );
});
