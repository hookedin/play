import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet, memoryStore, worstReturn } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import { CHANCE_MAX, CHANCE_MIN, diceGraph } from '../src/rules.ts';
import { compileGame } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';

test('every roll on the slider returns 99% of the stake, to the last wei', () => {
  const stake = 10n ** 15n;
  const target = stake * 9900n;
  for (let chance = CHANCE_MIN; chance <= CHANCE_MAX; chance += 1) {
    const graph = diceGraph({ stake: String(stake), chanceBps: chance });
    const win = graph.nodes.find(n => n.id === 'dice:win') as any;
    const payout = BigInt(win.payout),
      bps = BigInt(chance);
    // The payout is the largest whole amount whose return does not exceed 99%: the house never
    // gives up its edge, and never keeps more than one wei of it back.
    assert.ok(payout * bps <= target, `chance ${chance} returns more than 99%`);
    assert.ok((payout + 1n) * bps > target, `chance ${chance} returns less than it could`);
    assert.ok(payout > stake, `chance ${chance} must pay more than the stake`);
  }
  // The round chances the slider snaps to are exact.
  for (const chance of [1000, 1100, 2000, 2500, 4950, 5000, 9000]) {
    const win = diceGraph({ stake: String(stake), chanceBps: chance }).nodes.find(n => n.id === 'dice:win') as any;
    assert.equal(BigInt(win.payout) * BigInt(chance), target, `chance ${chance}`);
  }
});

test('the slider ends are the only chances the rules accept', () => {
  const setup = (chanceBps: number) => () => diceGraph({ stake: '1000', chanceBps });
  assert.doesNotThrow(setup(CHANCE_MIN));
  assert.doesNotThrow(setup(CHANCE_MAX));
  assert.throws(setup(CHANCE_MIN - 1), /between 10% and 90%/);
  assert.throws(setup(CHANCE_MAX + 1), /between 10% and 90%/);
  assert.throws(setup(4950.5), /between 10% and 90%/);
});

test('a roll settles through the real wallet and pays what the rules promise', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('dice'));
  await w.setGameAllowance('200000');
  const round = new RoundClient(f.bridge, diceGraph, undefined, { store: memoryStore(), name: 'dice' });
  // Forty rolls at 49.50% all land on one side about once in 10^12 runs, so both outcomes are always seen.
  let wins = 0,
    losses = 0;
  for (let i = 0; i < 40; i++) {
    await round.restore();
    let state = await round.start({ stake: '1000', chanceBps: 4950 });
    state = await round.action('roll');
    assert.equal(state.terminal, true, 'one roll settles the round');
    if (state.nodeId === 'dice:win') {
      assert.equal(state.cash, '2000', 'a win at 49.50% pays double');
      wins++;
    } else {
      assert.equal(state.cash, '0');
      losses++;
    }
  }
  assert.equal(wins + losses, 40);
  assert.ok(wins > 0 && losses > 0, `saw both outcomes (${wins}/${losses})`);
});

/** The least any bet of this game pays back, in millionths of its stake. */
const FLOOR = 989000n;

test('every bet this game can place pays back at least the floor it is built to', () => {
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const chanceBps of [CHANCE_MIN, 1234, 3333, 5000, 6667, 9000 - 1, CHANCE_MAX]) {
      const plan = compileGame(diceGraph({ stake: String(stake), chanceBps }), {
        admits,
        bankrollFloor: 10n ** 9n * stake,
        cashQuantum: stake / 10n ** 9n || 1n,
        initialCash: stake,
      });
      assert.ok(worstReturn(plan) >= FLOOR, `a bet at ${chanceBps} pays back less than this game's floor`);
    }
});
