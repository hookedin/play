import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { DropClient } from '../src/drop.ts';
import { RISKS, ROWS, bucketOf, dropGraph, multipliers, path, paths } from '../src/tables.ts';
import { admits, betReturn, RETURN_SCALE } from '@hookedin/play/sdk/admits';
import { compileGame, fraction, getNode, seededRandom } from '@hookedin/play/sdk/engine';

const memoryStore = () => {
  const map = new Map<string, string>();
  return {
    map,
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
};
const plan = (rows: any, risk: any, stake: bigint, bankroll = 20000n * stake) =>
  compileGame(dropGraph({ stake: String(stake), rows, risk }), {
    admits,
    bankrollFloor: bankroll,
    cashQuantum: 1n,
    initialCash: stake,
  });

test('every board reaches each bucket as often as fair pegs do and returns exactly 99%', t => {
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
      const drop = plan(rows, risk, stake),
        step = (getNode(drop, drop.root) as any).actions[0].transition;
      // Every bucket, as a state of the one decision, at its binomial odds exactly.
      for (const [bucket, hundredths] of table.entries()) {
        const outcome = step.outcomes.find((o: any) => bucketOf(o.next) === bucket);
        assert.deepEqual(outcome.probability, fraction(paths(rows, bucket), 1n << BigInt(rows)));
        assert.equal(outcome.cash, (stake * BigInt(hundredths)) / 100n);
      }
      // Every drop is a bet, and every bet the page can draw is one the casino takes.
      assert.ok(step.branches.every((b: any) => b.kind === 'bet' && admits(20000n * stake, b.bet)));
      assert.throws(() => plan(rows, risk, stake, BigInt(Math.max(...table)) * (stake / 100n)), /below required/);
    }
  assert.equal(paths(16, 8), 12870n);
  t.diagnostic('9 boards: exact 99% from the odds alone');
});

test("the ball lands in the bucket its bet reached, on one of that bucket's paths, the same one for the same result", () => {
  for (const rows of ROWS)
    for (let bucket = 0; bucket <= rows; bucket++) {
      const count = paths(rows, bucket),
        seen = new Set<string>(),
        step = count > 1000n ? count / 97n : 1n;
      // Every path of the bucket, once each, as its index is drawn.
      for (let index = 0n; index < count; index += step) {
        const turns = path(rows, bucket, () => index);
        assert.equal(turns.length, rows);
        assert.equal(turns.filter(Boolean).length, bucket, 'the turns land in the bucket');
        seen.add(turns.map(Number).join(''));
      }
      if (step === 1n) assert.equal(BigInt(seen.size), count, 'each equally likely path is a different ball');
      assert.deepEqual(path(rows, bucket, seededRandom(42n)), path(rows, bucket, seededRandom(42n)));
    }
});

test('each drop is one casino bet, recovers a lost reply under the same ID, and explains limits', async () => {
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
      if (method !== 'game.casinoBet') throw new Error(`unexpected ${method}`);
      bets++;
      const saved = JSON.parse([...store.map].find(([key]) => key.startsWith('hookedin:round:'))![1]);
      assert.equal(saved.pending.id, params.id, 'the drop is saved before it is sent');
      assert.ok(BigInt(params.stake) <= 1000n, 'one bet between two buckets, staking at most the ball');
      const receipt = await w.gameCasinoBet(params);
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
    assert.equal(client.pending, null, 'a landed ball leaves no pending drop');
  }
  assert.equal(bets, 24, 'one casino bet per ball');

  loseReply = true;
  await assert.rejects(client.drop({ rows: 16, risk: 'high', stake: '1000' }), /did not respond/);
  loseReply = false;
  // After a reload the settled casino bet lands once, on its own board, without another bet.
  client = new DropClient(bridge, { store, name: 'plinko' });
  const recovered = await client.restore();
  assert.equal(recovered!.rows, 16);
  assert.equal(
    BigInt(recovered!.payout),
    (1000n * BigInt(multipliers(16, 'high')[recovered!.turns.filter(Boolean).length])) / 100n,
  );
  assert.equal(bets, 25);
  assert.equal(client.pending, null);
  assert.equal(await client.restore(), null, 'and only once');

  await assert.rejects(client.drop({ rows: 8, risk: 'low', stake: '1' }), /too small/);
  bankroll = '1000000';
  client = new DropClient(bridge, { store, name: 'plinko' });
  await assert.rejects(client.drop({ rows: 16, risk: 'high', stake: '1000' }), /can only back about/);
  assert.equal(client.pending, null, 'nothing is pending for a table the casino cannot back');
});

/** The least any one bet of this game pays back, in millionths of its stake, when the casino's bankroll is far above
 * the stake. A drop bets only what its ball can lose, and the bets for the outer buckets carry more of the board's edge
 * than the rest, so a bet pays back less of its stake than the board does of the ball. The game publishes no such
 * figure — a promise nobody can verify is worth nothing, because no game bounds how often it wagers what it holds —
 * but its own table is held to it here, and every player sees the measured return of each bet they actually signed. */
const FLOOR = 927000n;

test('every bet this game can place pays back at least the floor it is built to', t => {
  let worst = RETURN_SCALE;
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const rows of ROWS)
      for (const risk of RISKS) {
        const drop = plan(rows, risk, stake, 10n ** 9n * stake);
        for (const branch of (getNode(drop, drop.root) as any).actions[0].transition.branches)
          if (betReturn(branch.bet) < worst) worst = betReturn(branch.bet);
      }
  assert.ok(worst >= FLOOR, `a bet pays back ${worst} millionths, below this game's floor`);
});
