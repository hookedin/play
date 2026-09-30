import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet, memoryStore, worstReturn } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import { TILES, coveredPicks, minesGraph, multiplier, payout } from '../src/rules.ts';
import { compileGame } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';
/** The ways to choose k of n, counted apart from the rules' own count. */
const factorial = (n: number): bigint => (n < 2 ? 1n : BigInt(n) * factorial(n - 1));
const choose = (n: number, k: number) => factorial(n) / (factorial(k) * factorial(n - k));

test('a cash-out pays 99% of fair odds, rounded down to the wei', () => {
  const stake = 10n ** 15n;
  assert.equal(payout(stake, 1, 1), 1031250000000000n, '1 mine, 1 gem: 1.03125×');
  assert.equal(payout(stake, 3, 1), 1125000000000000n, '3 mines, 1 gem: 1.125×');
  assert.equal(payout(stake, 3, 2), 1285714285714285n, '3 mines, 2 gems: 0.99 × 300 / 231');
  assert.equal(payout(stake, 5, 20), 52598700000000000000n, '5 mines, every gem: 0.99 × 53,130');
  assert.equal(payout(stake, 12, 13), 5148297000000000000000n, '12 mines, every gem: 0.99 × 5,200,300');
  assert.equal(payout(stake, 24, 1), 24750000000000000n, '24 mines, the one gem: 24.75×');
  for (const wei of [1000n, 12345678901n, stake, 10n ** 18n])
    for (let mines = 1; mines < TILES; mines++)
      for (let picks = 1; picks <= TILES - mines; picks++) {
        // Surviving `picks` picks has chance C(25 − mines, picks) / C(25, picks); the cash-out returns 99% of the
        // stake at those odds, less the part of a wei it rounds away.
        const paid = payout(wei, mines, picks),
          fair = 99n * wei * choose(TILES, picks),
          odds = 100n * choose(TILES - mines, picks);
        assert.ok(paid * odds <= fair && fair < (paid + 1n) * odds, `${mines} mines, ${picks} gems`);
        assert.ok(paid > (picks > 1 ? payout(wei, mines, picks - 1) : 0n), `${mines} mines: every gem pays more`);
        assert.deepEqual(multiplier(mines, picks), { n: 99n * choose(TILES, picks), d: odds });
      }
});

test('a round allows up to one pick per gem, from 1 to 24 mines', () => {
  const stake = '1000000';
  for (let mines = 1; mines < TILES; mines++) {
    const graph = minesGraph({ stake, mines, picks: TILES - mines });
    const payouts = graph.nodes
      .filter(node => node.kind === 'terminal' && node.id.startsWith('mines:payout:'))
      .map(node => (node as any).payout);
    assert.deepEqual(
      payouts,
      Array.from({ length: TILES - mines }, (_, k) => payout(BigInt(stake), mines, k + 1)),
      `${mines} mines: every cash-out pays its multiple`,
    );
    assert.equal((graph.nodes.find(node => node.id === 'mines:loss') as any).payout, 0n, 'a mine pays nothing');
    assert.throws(() => minesGraph({ stake, mines, picks: TILES - mines + 1 }), RangeError, 'no pick past the gems');
  }
  for (const mines of [0, 25]) assert.throws(() => minesGraph({ stake, mines, picks: 1 }), RangeError);
});

/** A real wallet playing Mines against an in-memory casino with this bankroll. */
async function setUp(bankroll?: bigint) {
  const f = await gameWallet({ bankroll }),
    w = f.wallet;
  w.openGame(f.identity('mines'));
  await w.setGameLimit('200000');
  const store = memoryStore(),
    client = () => new RoundClient(f.bridge, minesGraph, undefined, { store, name: 'mines' }),
    covered = async (stake: bigint, mines: number) =>
      coveredPicks(stake, mines, BigInt((await f.bridge.call('wallet.info')).bankroll));
  return { client, covered };
}

test('a round settles through the real wallet, and a reload rebuilds it from its setup', async () => {
  const { client, covered } = await setUp();
  let cashed = 0,
    mined = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const round = client();
    await round.restore();
    const setup = { stake: '1000', mines: 5, picks: await covered(1000n, 5) };
    assert.equal(setup.picks, 20, 'this bankroll covers every gem');
    let state = await round.start(setup);
    state = await round.action('reveal');
    if (state.nodeId === 'mines:loss') {
      assert.equal(state.cash, '0', 'the mine takes the stake');
      mined++;
      continue;
    }
    // The page reloads: the round comes back with its mines and plays on under the same rules.
    const reloaded = client();
    state = (await reloaded.restore())!;
    assert.deepEqual([state.nodeId, state.setup], ['mines:picks:1', setup]);
    assert.deepEqual(state.actions, ['cash-out', 'reveal']);
    state = await reloaded.action('cash-out');
    assert.equal(state.terminal, true);
    assert.equal(state.cash, String(payout(1000n, 5, 1)), 'one gem among 5 mines pays 1.2375×');
    cashed++;
  }
  // Both endings are checked as they come; over twelve rounds every one settled as the rules say.
  assert.equal(cashed + mined, 12);
});

test('a round goes only as far as the casino covers at its stake', async () => {
  const { client, covered } = await setUp(20000n);
  const round = client();
  await round.restore();
  assert.equal(await covered(1000n, 3), 0, 'a bankroll this small covers no pick among 3 mines');
  await assert.rejects(round.start({ stake: '1000', mines: 3, picks: 1 }), /can only back about/);
  for (let attempt = 0; ; attempt++) {
    const picks = await covered(1000n, 1);
    assert.ok(picks > 0 && picks < TILES - 1, 'it covers some of the gems among 1 mine, not all');
    await assert.rejects(round.start({ stake: '1000', mines: 1, picks: picks + 1 }), /can only back about/);
    let state = await round.start({ stake: '1000', mines: 1, picks });
    for (let found = 0; found < picks && state.nodeId !== 'mines:loss'; found++) state = await round.action('reveal');
    if (state.nodeId === 'mines:loss') {
      assert.ok(attempt < 20, 'a round among 1 mine reaches the last covered pick most times');
      continue;
    }
    assert.deepEqual(state.actions, ['cash-out'], 'the last covered pick leaves the cash-out');
    state = await round.action('cash-out');
    assert.equal(state.cash, String(payout(1000n, 1, picks)));
    break;
  }
});

/** The least any bet of this game pays back, in millionths of its stake: 99%, less at most a thousandth, what
 * rounding a cash-out down to the wei takes from a stake of 1000 wei. */
const FLOOR = 989000n;

test('every bet this game can place pays back at least its floor, and a cash-out keeps the rest', () => {
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const bankroll of [5000n * stake, 10n ** 6n * stake, 2n * 10n ** 9n * stake])
      for (let mines = 1; mines < TILES; mines++) {
        // The ladder the page starts, priced as `RoundClient` prices it.
        const picks = coveredPicks(stake, mines, bankroll);
        if (!picks) continue;
        const plan = compileGame(minesGraph({ stake: String(stake), mines, picks }), {
          admits,
          bankrollFloor: bankroll / 2n,
          cashQuantum: stake / 10n ** 9n || 1n,
          initialCash: stake,
        });
        assert.ok(worstReturn(plan) >= FLOOR, `a bet among ${mines} mines pays back less than this game's floor`);
        for (const node of plan.nodes) {
          if (node.kind !== 'decision') continue;
          for (const { transition: step } of node.actions) {
            if (step.kind === 'casino-bet') continue;
            // A state holds a little more than its cash-out: what the next pick needs beyond fair odds for the
            // casino to take it. Cashing out gives that back, never a 99th of what the cash-out pays.
            const cashout = payout(stake, mines, Number(node.id.split(':')[2]));
            assert.ok(99n * step.amount <= cashout, `${node.id} among ${mines} mines keeps too much`);
          }
        }
      }
});
