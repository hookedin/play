import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGame, fraction, loadFundedGame, UINT256_MAX } from '../src/engine/index.ts';
import { admits } from '../src/admits.ts';
import { RoundClient } from '../src/round.ts';

// The committed blackjack table itself is checked against the one full compile in sequential-games.test.ts.
const graph = (scale: bigint) => ({
  root: 'start',
  nodes: [
    {
      id: 'start',
      kind: 'decision' as const,
      actions: [
        {
          id: 'double',
          additionalCash: 2n * scale,
          outcomes: [
            { next: 'win', probability: fraction(1n, 2n), label: 'card' },
            { next: 'loss', probability: fraction(1n, 2n), label: 'other card' },
          ],
        },
      ],
    },
    { id: 'win', kind: 'terminal' as const, payout: 6n * scale },
    { id: 'loss', kind: 'terminal' as const, payout: 0n },
  ],
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
    // The step a loaded plan builds lazily is the step a full compile builds: one bet, one prize.
    const [step] = (loaded.nodes.find(n => n.id === 'start') as any).actions.map((a: any) => a.transition);
    assert.deepEqual(step.bet, {
      stake: 4n * scale,
      prizes: [{ rangeStart: 0n, rangeEnd: 1n << 63n, payout: 6n * scale }],
    });
    assert.deepEqual(
      step.successors.map((s: any) => s.label),
      ['card', 'other card'],
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
    const store = new Map<string, string>();
    const call = {
      call: async () => ({ bankroll: String(bankroll), chainId: '31337', address: '0xab', channelId: '0x01' }),
      balance: async () => ({ balance: '100', pending: false }),
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
    const memory = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
      remove: (k: string) => void store.delete(k),
    };
    const round = new RoundClient(call, make, funding, { store: memory }),
      started = await round.start({ stake: String(stake) });
    assert.equal(round.plan!.bankrollFloor, floor);
    const reloaded = new RoundClient(call, make, funding, { store: memory });
    assert.deepEqual(await reloaded.restore(), started);
    assert.equal(reloaded.plan!.bankrollFloor, round.plan!.bankrollFloor);
  }
});
