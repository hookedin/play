import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGame, fraction, loadFundedGame } from '../src/engine/index.ts';
import { UINT256_MAX } from '../../protocol/risk.ts';
import { admits } from '../src/admits.ts';
import { RoundClient } from '../src/round.ts';
import { memoryStore } from '../../testing/game-wallet.ts';
import { coin } from './coin.ts';

// A table as a game commits it: the required cash of every action, at one scale.
const graph = (scale: bigint) =>
  coin({ action: 'double', additionalCash: 2n * scale, payout: () => 6n * scale, labels: ['card', 'other card'] })({
    stake: '0',
  });
const base = compileGame(graph(1n), { admits, bankrollFloor: 1000n, cashQuantum: 1n, initialCash: 2n });
const table = {
  bankrollFloor: base.bankrollFloor,
  cashQuantum: base.cashQuantum,
  initialCash: base.initialCash,
  conservativeBankroll: base.conservativeBankroll,
  actions: Object.fromEntries(
    base.nodes.filter(n => n.kind === 'decision').map(n => [n.id, n.actions.map(a => a.requiredCash)]),
  ),
};
test('loaded integer-scaled plans preserve exact bets, successors, labels and additional wagers', () => {
  for (const scale of [1n, 7n, 10n ** 12n]) {
    const loaded = loadFundedGame(graph(scale), table, scale, admits);
    const compiled = compileGame(graph(scale), {
      admits,
      bankrollFloor: table.bankrollFloor * scale,
      cashQuantum: table.cashQuantum * scale,
      initialCash: table.initialCash * scale,
    });
    assert.deepEqual(loaded, compiled);
    // The step a loaded plan builds lazily is the step a full compile builds: a coin's two cards are one bet.
    const [step] = (loaded.nodes.find(n => n.id === 'start') as any).actions.map((a: any) => a.transition);
    assert.deepEqual(
      step.branches.map((b: any) => b.bet),
      [{ stake: 4n * scale, chance: 1n << 63n, prize: 6n * scale }],
    );
    assert.deepEqual(
      step.outcomes.map((s: any) => s.label),
      ['other card', 'card'],
    );
  }
  assert.throws(() => loadFundedGame(graph(1n), table, 0n, admits), /funding scale/);
  assert.throws(() => loadFundedGame(graph(1n), table, UINT256_MAX, admits), /bankrollFloor/);
  assert.throws(() => loadFundedGame(graph(1n), { ...table, actions: {} }, 1n, admits), /missing actions/);
  assert.throws(() => loadFundedGame(graph(1n), { ...table, conservativeBankroll: 1n }, 1n, admits), /does not match/);
});

test('rounds use the table when supported and preserve the ordinary fallback and saved pricing', async () => {
  for (const [stake, bankroll, floor] of [
    [2n, 10000n, 1000n],
    [3n, 10000n, 5000n],
    [2n, 1001n, 500n],
  ]) {
    const call = {
      call: async (method: string) =>
        method === 'game.allowance'
          ? { allowance: '100', pending: false, developerBets: false }
          : { virtualBankroll: String(bankroll), chainId: '31337', address: '0xab', channelId: '0x01' },
    };
    // This deterministic graph keeps fallback coverage fast.
    const make = (setup: any) => ({
      root: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'decision' as const,
          actions: [{ id: 'push', outcomes: [{ next: 'done', probability: fraction(1n) }] }],
        },
        { id: 'done', kind: 'terminal' as const, payout: BigInt(setup.stake) },
      ],
    });
    const funding = {
      bankrollFloor: 1000n,
      cashQuantum: 1n,
      initialCash: 2n,
      conservativeBankroll: 1002n,
      actions: { start: [2n] },
    };
    const memory = memoryStore();
    const round = new RoundClient(call, make, funding, { store: memory }),
      started = await round.start({ stake: String(stake) });
    assert.equal(round['plan']!.bankrollFloor, floor);
    const reloaded = new RoundClient(call, make, funding, { store: memory });
    assert.deepEqual(await reloaded.restore(), started);
    assert.equal(reloaded['plan']!.bankrollFloor, round['plan']!.bankrollFloor);
  }
});
