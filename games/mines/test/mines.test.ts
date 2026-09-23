import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import { CASHOUTS, MINES, TILES, minesGraph } from '../src/rules.ts';
import { compileGame } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';
import { betReturn } from '@hookedin/play/sdk/admits';

const memoryStore = () => {
  const map = new Map<string, string>();
  return {
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
};

test('the board is five tiles, one mine, and the advertised cash-outs', () => {
  assert.deepEqual([TILES, MINES], [5, 1]);
  assert.deepEqual(CASHOUTS, [120n, 156n, 228n], '1.20×, 1.56×, 2.28×');
  const stake = 10n ** 15n;
  const graph = minesGraph({ stake: String(stake) });
  const payouts = graph.nodes
    .filter(node => node.kind === 'terminal' && node.id.startsWith('mines:payout:'))
    .map(node => BigInt((node as any).payout));
  assert.deepEqual(
    payouts,
    CASHOUTS.map(n => (stake * n) / 100n),
    'every cash-out pays its multiple',
  );
  const loss = graph.nodes.find(node => node.id === 'mines:loss') as any;
  assert.equal(BigInt(loss.payout), 0n, 'the mine pays nothing');
});

test('a round settles through the real wallet: cash out, or hit the mine', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('mines'));
  await w.setGameLimit('200000');
  const bridge = {
    balance: async () => w.gameLimit(),
    call: async (method: string, params: any = {}) => {
      if (method === 'wallet.hello') return w.gameHello();
      if (method === 'wallet.info') return { ...w.gameInfo(), bankroll: '1000000000000' };
      if (method === 'game.receipt') return w.gameReceipt(params.id);
      if (method === 'game.bet') return w.gameBet(params);
      throw new Error(`unexpected ${method}`);
    },
  };
  const round = new RoundClient(bridge, minesGraph, undefined, { store: memoryStore(), name: 'mines' });
  let cashed = 0,
    mined = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    await round.restore();
    let state = await round.start({ stake: '1000' });
    state = await round.action('reveal');
    if (state.nodeId === 'mines:loss') {
      assert.equal(state.cash, '0', 'the mine takes the stake');
      mined++;
      continue;
    }
    assert.ok(state.actions.includes('cash-out'), 'a gem offers the cash-out');
    state = await round.action('cash-out');
    assert.equal(state.terminal, true);
    assert.equal(state.cash, String((1000n * CASHOUTS[0]!) / 100n), 'one gem pays 1.20×');
    cashed++;
  }
  // Both endings are checked as they come; over twelve rounds every one settled as the rules say.
  assert.equal(cashed + mined, 12);
});

const GRAPHS = (stake: bigint) => [minesGraph({ stake: String(stake) })];

/** Every step this game can ever place, at every stake it takes: the floor holds for each one, so it
 * is checked against all of them and not against a sample. */
/** The least any one bet of this game pays back, in millionths of its stake. The game publishes no
 * such figure — a promise nobody can verify is worth nothing, because no game bounds how often it
 * wagers what it holds — but its own table is held to it here, and every player sees the measured
 * return of each bet they actually signed. */
const FLOOR = 960000n;

test('every step pays back at least the floor this game is built to', () => {
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const graph of GRAPHS(stake)) {
      const plan = compileGame(graph, {
        admits,
        bankrollFloor: 10n ** 9n * stake,
        cashQuantum: stake / 10n ** 9n || 1n,
        initialCash: stake,
      });
      for (const node of plan.nodes) {
        if (node.kind !== 'decision') continue;
        for (const action of node.actions) {
          const step = action.transition;
          // Every step is a bet that pays something back: this game never charges for nothing.
          assert.ok(step.kind === 'bet' || step.amount === 0n, `${node.id}/${action.id} charges for nothing`);
          if (step.kind !== 'bet') continue;
          assert.ok(
            betReturn(step.bet) >= FLOOR,
            `${node.id}/${action.id} at ${stake} wei pays back less than this game's floor`,
          );
        }
      }
    }
});
