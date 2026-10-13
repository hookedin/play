import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeTo, gameWallet, memoryStore } from '@hookedin/play/testing/game-wallet.ts';
import { MemoryStore } from '../../client/storage.ts';
import { id, ZeroAddress } from 'ethers';
import {
  drawStep,
  hashState,
  json,
  landStep,
  plain,
  QUOTE_TYPES,
  QUOTE_PERIOD,
  roundId,
} from '../../protocol/protocol.ts';
import { admits, OUTCOME_SPACE } from '../../protocol/risk.ts';
import { splitStep } from '../src/engine/transition.ts';
import { RoundClient } from '../src/round.ts';
import type { GameReceipt } from '../../protocol/game-types.ts';
import { createMines, fraction } from '../src/engine/index.ts';
import { coin } from './coin.ts';

const odds = { chance: 9000000000000000000n, prize: 20n };
/** A step of one casino bet, which stakes `stake` and keeps `kept` of the step's cash with its group: its prize with
 * its chance, or what it keeps. */
const terms = (
  id = 'op-0',
  { stake = 10n, kept = 0n, group }: { stake?: bigint; kept?: bigint; group?: string } = {},
) => ({
  id,
  cash: stake + kept,
  results: [
    { weight: odds.chance, cash: kept + odds.prize },
    { weight: OUTCOME_SPACE - odds.chance, cash: kept },
  ],
  ...(group === undefined ? {} : { group }),
});
/** What the SDK gives a round: the bridge to wallet `w`, with `extra` answering some requests first. */
const bridgeFor = (w: any, extra: (method: string, params: any) => Promise<unknown> | undefined = () => undefined) => {
  const bridge = bridgeTo(w);
  return {
    ...bridge,
    call: async (method: string, params: any = {}) => (await extra(method, params)) ?? bridge.call(method, params),
  };
};

test('the allowance lives in memory: leaving the game releases it, and nothing about games is saved', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  await assert.rejects(w.setGameAllowance(100n), /No game is open/);
  w.openGame(f.identity('a'));
  await assert.rejects(w.gameCasinoBet(terms()), /Not enough allowance/);
  await w.setGameAllowance(100n);
  assert.equal(w.availableBalance(), 999900n);
  await assert.rejects(w.setGameAllowance(1000001n), /exceeds your balance/);
  await assert.rejects(w.gameCasinoBet(terms('op-0', { stake: 101n })), /Not enough allowance/);
  await assert.rejects(w.payBankroll(999901n), /less the game's allowance/);
  w.closeGame();
  assert.equal(w.availableBalance(), 1000000n);
  assert.throws(() => w.gameAllowance(), /No game is open/);
  const record = await f.storage.get(w.storageKey);
  assert.doesNotMatch(json(record), /games|allowance/);
  const reloaded = await f.reload();
  assert.equal(reloaded.game, null);
  assert.equal(reloaded.availableBalance(), 1000000n);
  // Opened again, a game starts with nothing to play with.
  w.openGame(f.identity('a'));
  assert.deepEqual(w.gameAllowance(), { allowance: 0n, pending: false, developerBets: false });
});

test('a group keeps what its bets win out of the allowance until the game ends it, and only its own bets stake it', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  // Each bet of the group stakes what the group holds first, and what it wins stays with the group.
  let allowance = 1000n,
    held = 0n;
  for (let i = 0; i < 6; i++) {
    const receipt = await w.gameCasinoBet(terms(`step-${i}`, { group: 'round' })),
      drawn = held < 10n ? held : 10n;
    allowance -= 10n - drawn;
    held += receipt.payout! - drawn;
    assert.equal(w.gameAllowance().allowance, allowance);
    assert.equal(w.inPlay(), held);
    assert.equal(w.gameAllowance('round').allowance, allowance + held);
  }
  // Another group stakes only the allowance.
  await assert.rejects(
    w.gameCasinoBet(terms('other', { stake: allowance + 1n, group: 'other' })),
    /Not enough allowance/,
  );
  // The player sets the allowance itself; what the group holds stays with it, and is the player's all the same.
  await w.setGameAllowance(500n);
  assert.deepEqual([w.gameAllowance().allowance, w.inPlay()], [500n, held]);
  assert.equal(w.availableBalance(), (await w.balance()) - 500n - held);
  await assert.rejects(w.setGameAllowance((await w.balance()) - held + 1n), /exceeds your balance/);
  // Once the game has shown how the group ended, what it won joins the allowance.
  w.gameEnd('round');
  w.gameEnd('never-placed');
  assert.deepEqual([w.gameAllowance().allowance, w.inPlay()], [500n + held, 0n]);
});

test("what a bet keeps of its group's cash leaves the allowance with its stake, and stays with the group", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  // A round's first step stakes 10 and keeps 4 of the round's 14: all 14 leave the allowance the player sees.
  const receipt = await w.gameCasinoBet(terms('step-1', { group: 'round', kept: 4n })),
    won = receipt.payout!;
  assert.equal(w.gameAllowance().allowance, 986n);
  assert.equal(w.inPlay(), 4n + won);
  // Outside a group, what a bet keeps never leaves the allowance.
  const allowance = w.gameAllowance().allowance,
    loose = await w.gameCasinoBet(terms('loose', { kept: 4n }));
  assert.equal(w.gameAllowance().allowance, allowance - 10n + loose.payout!);
  // In one, its stake and what it keeps fit what the group may stake.
  await assert.rejects(
    w.gameCasinoBet(terms('step-2', { group: 'round', kept: w.gameAllowance('round').allowance })),
    /Not enough allowance/,
  );
  w.gameEnd('round');
  assert.equal(w.gameAllowance().allowance, 980n + won + loose.payout!);
});

test('a visit adds up: what the player allowed, less what they took back, and what the game won or lost, is left', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  const visit = () => {
    const { allowed, takenBack, result, left } = w.gameVisit();
    assert.equal(allowed - takenBack + result, left);
    return [allowed, takenBack, result, left];
  };
  assert.deepEqual(visit(), [0n, 0n, 0n, 0n]);
  await w.setGameAllowance(1000n);
  const first = (await w.gameCasinoBet(terms('op-1'))).payout!;
  assert.deepEqual(visit(), [1000n, 0n, first - 10n, 990n + first]);
  // A round's whole stake shows as lost until the game has shown how it ended.
  const won = (await w.gameCasinoBet(terms('step-1', { group: 'round', kept: 4n }))).payout!;
  assert.deepEqual(visit(), [1000n, 0n, first - 24n, 976n + first]);
  w.gameEnd('round');
  const left = 980n + first + won;
  assert.deepEqual(visit(), [1000n, 0n, first + won - 20n, left]);
  // Lowering the allowance takes money back; raising it again allows more.
  await w.setGameAllowance(500n);
  assert.deepEqual(visit(), [1000n, left - 500n, first + won - 20n, 500n]);
  await w.setGameAllowance(600n);
  assert.deepEqual(visit(), [1100n, left - 500n, first + won - 20n, 600n]);
});

test("the wallet splits a step's table and draws it with its bet's seed: no bet signs nothing, and an ID is one draw", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  // A push keeps the step's 30, a win leaves 39 and a loss 20.
  const results = [
      { weight: 1n, cash: 30n, label: 'push' },
      { weight: 3n, cash: 39n, label: 'win' },
      { weight: 3n, cash: 20n, label: 'loss' },
    ],
    step = (id: string, weight = 3n) => ({
      id,
      cash: 30n,
      group: 'round',
      results: results.map((result, i) => (i === 2 ? { ...result, weight } : result)),
    }),
    landed = [0, 0, 0];
  for (let i = 0; i < 40; i++) {
    const before = await w.balance(),
      receipt = await w.gameCasinoBet(step(`s-${i}`)),
      own = await w.gameBet(`s-${i}`),
      seed = own.seed ?? own.proof.step.seed,
      branches = splitStep({ admits, bankroll: own.details.table.bankroll, cash: 30n, results }),
      way =
        branches[
          Number(
            drawStep(
              seed,
              branches.map(branch => branch.weight),
            ),
          )
        ]!,
      left = 'stake' in way ? 30n - way.stake + receipt.payout! : 30n;
    assert.deepEqual(own.details.table, { cash: 30n, bankroll: own.details.table.bankroll, results });
    assert.equal(
      receipt.status,
      'stake' in way ? 'settled' : 'kept',
      'drawn from its seed, by the table the game gave',
    );
    assert.deepEqual(
      { result: receipt.result, draw: receipt.draw },
      landStep(seed, results, left),
      'and landed with the same seed on a result that leaves what the bet left',
    );
    landed[Number(receipt.result)]!++;
    if (receipt.status === 'kept') {
      assert.deepEqual(receipt, {
        id: `s-${i}`,
        kind: 'casino-bet',
        status: 'kept',
        group: 'round',
        result: 0n,
        draw: receipt.draw,
        payout: 0n,
      });
      assert.equal(await w.balance(), before, 'nothing was signed');
    } else
      assert.deepEqual(
        { stake: receipt.stake, chance: receipt.chance, prize: receipt.prize, weight: way.weight },
        way,
        'the bet drawn went with the seed that drew it',
      );
    assert.deepEqual(await w.gameCasinoBet(step(`s-${i}`)), receipt, 'the same ID is the same draw');
    assert.deepEqual(await w.gameReceipt(`s-${i}`), receipt);
    await assert.rejects(w.gameCasinoBet(step(`s-${i}`, 2n)), /different intent/);
  }
  assert.ok(landed[0]! > 0 && landed[1]! > landed[0]! && landed[2]! > landed[0]!, 'each about as often as its weight');
  await assert.rejects(w.gameBet('never-played'), (error: any) => error.code === 'not-found');
});

test('a step that moves no money but leads to one of several states asks the wallet to draw which', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('equal-cash-noop'));
  await w.setGameAllowance(1000n);
  // Either card leaves the same cash, and each state has a different action after it: as a blackjack card can.
  const graph = () => ({
      root: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'decision' as const,
          actions: [
            {
              id: 'deal',
              outcomes: [
                { next: 'left', probability: fraction(1n, 3n) },
                { next: 'right', probability: fraction(2n, 3n) },
              ],
            },
          ],
        },
        ...['left', 'right'].map(id => ({
          id,
          kind: 'decision' as const,
          actions: [{ id: `${id}-only`, outcomes: [{ next: 'done', probability: fraction(1n) }] }],
        })),
        { id: 'done', kind: 'terminal' as const, payout: 1000n },
      ],
    }),
    calls: string[] = [],
    bridge = bridgeFor(w, async (method, params) => void calls.push(`${method} ${params.id ?? ''}`)),
    round = new RoundClient(bridge, graph, undefined, { store: memoryStore() });
  await round.start({ stake: 1000n });
  const before = await w.balance(),
    state = await round.action('deal'),
    settlement = state.settlement as { kind: string; id: string };
  assert.equal(settlement.kind, 'noop');
  assert.deepEqual(
    calls.filter(call => /payment|casinoBet/.test(call)),
    [`game.casinoBet ${settlement.id}`],
  );
  assert.ok(['left', 'right'].includes(state.nodeId));
  assert.equal(await w.balance(), before, 'nothing was signed');
  assert.equal((await w.gameReceipt(settlement.id))!.status, 'kept');
});

test('a step that pays the bankroll pays first, and then the wallet draws which of its successors it reaches', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('equal-cash'));
  await w.setGameAllowance(1000n);
  const graph = () => ({
      root: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'decision' as const,
          actions: [
            {
              id: 'deal',
              outcomes: [
                { next: 'left', probability: fraction(1n, 3n) },
                { next: 'right', probability: fraction(2n, 3n) },
              ],
            },
          ],
        },
        { id: 'left', kind: 'terminal' as const, payout: 400n },
        { id: 'right', kind: 'terminal' as const, payout: 400n },
      ],
    }),
    calls: string[] = [],
    bridge = bridgeFor(w, async (method, params) => void calls.push(`${method} ${params.id ?? ''}`)),
    round = new RoundClient(bridge, graph, undefined, { store: memoryStore() });
  await round.start({ stake: 1000n });
  const before = await w.balance(),
    state = await round.action('deal'),
    settlement = state.settlement as { kind: string; id: string };
  assert.equal(settlement.kind, 'payment');
  const id = settlement.id;
  assert.deepEqual(
    calls.filter(call => /payment|casinoBet/.test(call)),
    [`game.payment ${id.slice(0, -':draw'.length)}`, `game.casinoBet ${id}`],
    'the payment, then the draw',
  );
  assert.ok(['left', 'right'].includes(state.nodeId));
  assert.equal(await w.balance(), before - 600n);
  assert.equal((await w.gameReceipt(id))!.status, 'kept');
  // The payment signed what it left the round: the round held its 600 and those 400.
  const payment = await w.gameBet(id.slice(0, -':draw'.length));
  assert.deepEqual([payment.details.group, payment.details.kept], [state.id, 400n]);
});

test("a game's last bet the player has seen is the latest outside a group or in one the game ended", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n, true);
  const game = w.game!.identity.id,
    last = () => w.lastShownBet(game);
  assert.equal(last(), null);
  // A bet outside a group is shown as it settles; a round's wait for the game to end the round.
  await w.gameCasinoBet(terms('alone'));
  assert.equal(last()!.operationId, w.gameOperationId('alone'));
  await w.gameCasinoBet(terms('step-1', { group: 'round' }));
  assert.equal(last()!.operationId, w.gameOperationId('alone'), 'never a result the game has not shown');
  await w.gameEnd('round');
  assert.equal(last()!.operationId, w.gameOperationId('step-1'));
  // A step that drew no bet is a result as well, and stays out of nothing but Activity.
  await w.gameCasinoBet({ id: 'no-bet', cash: 10n, group: 'round-2', results: [{ weight: 1n, cash: 10n }] });
  await w.gameEnd('round-2');
  assert.deepEqual([last()!.operationId, last()!.status], [w.gameOperationId('no-bet'), 'kept']);
  assert.equal(
    (await f.reload()).history.some(receipt => receipt.status === 'kept'),
    true,
    'kept across a reload',
  );
  // A payment is no bet, and a developer bet is one once what it paid is collected.
  await w.gamePayment({ id: 'pay', amount: 1n });
  const seat = await w.gameDeveloperBet({ id: 'seat', stake: 10n, meta: { seat: 1 } });
  assert.equal(last()!.operationId, w.gameOperationId('no-bet'));
  await f.developer.settle([{ bet: seat.bet!, player: 10n, casino: 0n }]);
  await w.collectPayouts();
  assert.equal(last()!.operationId, w.gameOperationId('seat'));
  // Another game's are its own.
  w.openGame(f.identity('other'));
  assert.equal(w.lastShownBet(w.game!.identity.id), null);
});

test('the next round, shown before a bet, is the round the bet settles on, and its secret hashes to it', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  const before = await w.nextRound();
  assert.match(before!, /^0x[0-9a-f]{64}$/);
  assert.equal(await w.nextRound(), before, 'the same until a bet settles');
  await w.gameCasinoBet(terms('first'));
  const { proof } = await w.gameBet('first');
  assert.equal(proof.step.operation.round, before);
  assert.equal(roundId(proof.step.secret), before);
  assert.notEqual(await w.nextRound(), before, 'and the next bet has a round of its own');
});

test('a game places developer bets only once the player allows them, and only a published game can be', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  const bet = { id: 'match', stake: 10n, meta: { pick: 'home' } };
  await assert.rejects(w.gameDeveloperBet(bet), (error: any) => error.code === 'developer-bets-not-allowed');
  assert.equal(w.gameAllowance().allowance, 1000n);
  await w.setGameAllowance(1000n, true);
  assert.equal((await w.gameDeveloperBet(bet)).status, 'open');
  // Changing the allowance keeps the leave; taking all of it back takes the leave with it.
  await w.setGameAllowance(500n);
  assert.equal(w.gameAllowance().developerBets, true);
  await w.setGameAllowance(0n);
  assert.equal(w.gameAllowance().developerBets, false);
  // A game opened by its URL alone has no developer to bet against.
  w.openGame(f.identity('unpublished', { developer: ZeroAddress }));
  await assert.rejects(w.setGameAllowance(100n, true), /Only a published game/);
});

test('verified gains and losses move the allowance; exact retries by ID never charge twice', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  let allowance = 1000n;
  for (let i = 0; i < 20; i++) {
    const request = terms(`round-${i}`),
      receipt = await w.gameCasinoBet(request);
    assert.equal(receipt.status, 'settled');
    allowance += receipt.payout! - 10n;
    assert.equal(w.gameAllowance().allowance, allowance);
    assert.equal(w.availableBalance(), 999000n);
    assert.deepEqual(receipt, {
      id: request.id,
      kind: 'casino-bet',
      status: 'settled',
      stake: 10n,
      ...odds,
      result: receipt.payout ? 0n : 1n,
      draw: receipt.draw,
      outcome: receipt.outcome,
      payout: receipt.payout,
    });
    assert.deepEqual(await w.gameCasinoBet(request), receipt);
    assert.deepEqual(await w.gameReceipt(request.id), receipt);
    await assert.rejects(
      w.gameCasinoBet({ ...request, results: [{ ...request.results[0]!, cash: 21n }, request.results[1]!] }),
      /different intent/,
    );
  }
  assert.equal(f.settlements(), 20);
  assert.equal(await w.gameReceipt('never-played'), null);
  // Another game cannot reuse this game's operation IDs.
  w.openGame(f.identity('other'));
  await w.setGameAllowance(100n);
  await w.gameCasinoBet(terms('round-0'));
  assert.equal(f.settlements(), 21);
});

test("a developer bet keeps its game's meta, is paid only what its developer signed, and a game published nowhere takes none", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n, true);
  const pushed: GameReceipt[] = [];
  f.bridge.onReceipt(receipt => pushed.push(receipt));
  const request = { id: 'ride', stake: 10n, meta: { cashout: '2.5' }, group: 'round-7' };
  const placed = await w.gameDeveloperBet(request);
  assert.match(placed.bet!, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(placed, { ...request, kind: 'developer-bet', status: 'open', bet: placed.bet });
  assert.equal(w.gameAllowance().allowance, 990n);
  assert.equal(f.bank(), 10n ** 12n + 10n, "the stake went into the game's bank");
  assert.deepEqual(await w.gameDeveloperBet(request), placed, 'asking again while it is open');
  await assert.rejects(w.gameDeveloperBet({ ...request, stake: 20n }), /different intent/);
  await assert.rejects(w.gameDeveloperBet({ ...request, meta: { cashout: '3' } }), /different intent/);
  await f.developer.settle([{ bet: placed.bet!, player: 25n, casino: 1n }]);
  // A settlement its developer did not sign is refused before the wallet signs anything for it.
  const api = w.api.bind(w);
  w.api = async (...args: [string, unknown?]) => {
    const value = await api(...args);
    if (args[0].startsWith('/api/developer-bets/')) value.settlement.player = '26';
    return value;
  };
  await assert.rejects(w.collectDeveloperBet(placed.bet!), /Invalid signature/);
  assert.equal(w.pending, null);
  w.api = api;
  // Asking about it is enough: the wallet collects it, and sends the settled receipt.
  assert.equal((await w.gameReceipt('ride'))!.status, 'open');
  await w.collectPayouts();
  const receipt = (await w.gameReceipt('ride'))!;
  assert.deepEqual(
    [receipt.status, receipt.payout, receipt.outcome],
    ['settled', 25n, undefined],
    "a developer bet rests on its developer's word",
  );
  assert.deepEqual(pushed, [receipt]);
  // What it was paid returns to its group, until the game has shown the result and ends the group.
  assert.deepEqual([w.gameAllowance().allowance, w.gameAllowance('round-7').allowance], [990n, 1015n]);
  w.gameEnd('round-7');
  assert.equal(w.gameAllowance().allowance, 1015n);
  // A game published nowhere has no developer to take a developer bet.
  w.openGame(f.identity('plain', { slug: undefined }));
  await w.setGameAllowance(100n, true);
  await assert.rejects(w.gameDeveloperBet({ ...request, id: 'nobody' }), /published nowhere/);
});

test("settlements the game's bank cannot pay are refused whole, and the bets wait", async () => {
  const f = await gameWallet({ bank: 5n }),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n, true);
  const won = await w.gameDeveloperBet({ id: 'won', stake: 10n, meta: {} }),
    lost = await w.gameDeveloperBet({ id: 'lost', stake: 10n, meta: {} });
  assert.equal(f.bank(), 25n, "both stakes went into the game's bank");
  await assert.rejects(
    f.developer.settle([{ bet: won.bet!, player: 30n, casino: 0n }]),
    (error: any) => error.code === 'bank-short',
  );
  await f.developer.settle([
    { bet: won.bet!, player: 25n, casino: 0n },
    { bet: lost.bet!, player: 0n, casino: 0n },
  ]);
  assert.equal(f.bank(), 0n);
});
test('settled developer bets are found through the account feed, zero payouts are recorded, and a failed collection survives reload', async () => {
  const f = await gameWallet(),
    w = f.wallet,
    game = f.identity();
  w.openGame(game);
  await w.setGameAllowance(1000n, true);
  const place = async (id: string) => (await w.gameDeveloperBet({ id, stake: 10n, meta: {} })).bet!;
  const waiting = await place('waiting'),
    returned = await place('return'),
    lost = await place('loss');
  let betReads = 0;
  const api = w.api.bind(w);
  w.api = async (...args) => {
    if (args[0].startsWith('/api/developer-bets/')) betReads++;
    return api(...args);
  };
  await w.collectPayouts();
  assert.equal(betReads, 0, 'open bets need no polling one by one');
  await f.developer.settle([
    { bet: lost, player: 0n, casino: 0n },
    { bet: returned, player: 10n, casino: 0n },
  ]);
  const perform = w.perform.bind(w);
  w.perform = async (...args) => {
    if (args[0] === 'developer-bet-payout') throw new Error('Credit unavailable');
    return perform(...args);
  };
  await w.collectPayouts();
  assert.equal((await w.gameReceipt('loss'))!.payout, 0n);
  assert.equal(w.developerBets[lost], undefined);
  assert.equal(w.developerBets[returned]!.state!.status, 'settled');
  assert.equal(w.developerBets[returned]!.state!.payout, 10n);
  assert.equal(w.developerBets[returned]!.error, 'Credit unavailable');
  assert.equal(await w.balance(), 999970n);
  const restored = await f.reload(),
    cursor = restored.developerBetCursor;
  await restored.collectPayouts();
  assert.equal(restored.developerBetCursor, cursor, 'retry uses saved settlements even with an empty feed');
  assert.deepEqual(Object.keys(restored.developerBets), [waiting]);
  assert.equal(await restored.balance(), 999980n);
  restored.openGame(game);
  assert.equal((await restored.gameReceipt('return'))!.payout, 10n);
});
test('a game learns how its operations ended and never whose they were', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n, true);
  const replies: any[] = [],
    reply = async (value: unknown) => void replies.push(await value);
  f.bridge.onReceipt(receipt => replies.push(receipt));
  await reply(w.gameHello());
  await reply(w.gameInfo());
  await reply(w.gameAllowance());
  await reply(w.gameCasinoBet(terms('own')));
  await reply(w.gameDeveloperBet({ id: 'seat', stake: 10n, meta: { seat: 1 } }));
  await f.developer.settle([{ bet: replies.at(-1).bet, player: 10n, casino: 0n }]);
  await w.collectPayouts();
  await reply(w.gamePayment({ id: 'pay', amount: 1n }));
  for (const id of ['own', 'seat', 'pay']) await reply(w.gameReceipt(id));
  const fields = [
    'id',
    'kind',
    'status',
    'stake',
    'chance',
    'prize',
    'group',
    'meta',
    'bet',
    'result',
    'draw',
    'outcome',
    'payout',
    'reason',
  ];
  for (const r of replies.filter(r => r.status))
    assert.deepEqual(
      Object.keys(r).filter(key => !fields.includes(key)),
      [],
      `${r.id} ${r.status}`,
    );
  const player = [w.channelId!, f.player.address].map(hex => hex.slice(2).toLowerCase());
  for (const r of replies) for (const secret of player) assert.doesNotMatch(json(r).toLowerCase(), new RegExp(secret));
  const statuses = replies.filter(r => r.status).map(r => `${r.id} ${r.kind} ${r.status} ${r.payout ?? ''}`);
  assert.deepEqual(statuses, [
    `own casino-bet settled ${replies[3].payout}`,
    'seat developer-bet open ',
    'seat developer-bet settled 10',
    'pay payment settled ',
    `own casino-bet settled ${replies[3].payout}`,
    'seat developer-bet settled 10',
    'pay payment settled ',
  ]);
});
test('a lost reply is recovered by its ID after a reload', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(100n);
  const api = w.api.bind(w);
  w.api = async (...args) => {
    const result = await api(...args);
    if (args[0].endsWith('/operations')) throw new Error('lost reply');
    return result;
  };
  await assert.rejects(w.gameCasinoBet(terms('lost')), /lost reply/);
  assert.equal(w.gameAllowance().pending, true);
  const request = structuredClone(w.pending!.request);
  const restored = await f.reload();
  assert.equal(restored.game, null, 'the allowance did not survive the reload');
  assert.deepEqual(restored.pending!.request, request);
  await restored.exclusive(() => restored.resume());
  assert.equal(restored.availableBalance(), await restored.balance(), 'the result landed in the channel balance');
  restored.openGame(f.identity());
  assert.equal(restored.gameAllowance().pending, false);
  assert.equal((await restored.gameReceipt('lost'))!.status, 'settled', 'the game can still learn the outcome by ID');
  assert.equal(f.settlements(), 1);
  await restored.gameCasinoBet(terms('lost'));
  assert.equal(f.settlements(), 1);
});

test('a result recovered in the same tab updates the open game; a closed game changes only the channel', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(100n);
  const api = w.api.bind(w);
  let lose = true;
  w.api = async (...args) => {
    const result = await api(...args);
    if (args[0].endsWith('/operations') && lose) {
      lose = false;
      throw new Error('lost reply');
    }
    return result;
  };
  await assert.rejects(w.gameCasinoBet(terms('a')), /lost reply/);
  const receipt: any = await w.exclusive(() => w.resume());
  assert.equal(w.gameAllowance().allowance, 100n - 10n + receipt.payout);
  w.closeGame();
  w.openGame(f.identity('b'));
  await w.setGameAllowance(50n);
  lose = true;
  await assert.rejects(w.gameCasinoBet(terms('b')), /lost reply/);
  w.closeGame();
  const before = await w.balance();
  const settled: any = await w.exclusive(() => w.resume());
  assert.equal(await w.balance(), before - 10n + settled.payout);
  assert.equal(w.availableBalance(), await w.balance());
});

test('saved round state belongs to one player', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('a'));
  const store = memoryStore();
  const keyFor = async (wallet: any) => {
    const round = new RoundClient(bridgeFor(wallet), createMines, undefined, { store, name: 'mines' });
    await round.restore();
    return round['storageKey'];
  };
  const mine = await keyFor(w);
  // Nothing a game keys by may be a field the wallet does not send: `undefined` in a key is every
  // account sharing one.
  assert.equal(mine.includes('undefined'), false, mine);
  assert.ok(w.uname && mine.includes(w.uname.toLowerCase()), mine);
  // Another account is somewhere else entirely.
  const other = {
    ...bridgeFor(w),
    call: async (method: string, params: any = {}) => {
      const value = await bridgeFor(w).call(method, params);
      return method === 'wallet.info' ? { ...value, uname: 'somebodyelse', discordUsername: null } : value;
    },
  };
  const theirs = new RoundClient(other, createMines, undefined, { store, name: 'mines' });
  await theirs.restore();
  assert.notEqual(theirs['storageKey'], mine);
  // A Discord username is what they are called today; it never moves what they saved.
  const renamed = {
    ...bridgeFor(w),
    call: async (method: string, params: any = {}) => {
      const value = await bridgeFor(w).call(method, params);
      return method === 'wallet.info' ? { ...value, discordUsername: 'renamed' } : value;
    },
  };
  const after = new RoundClient(renamed, createMines, undefined, { store, name: 'mines' });
  await after.restore();
  assert.equal(after['storageKey'], mine);
});

for (const boundary of ['request', 'settlement'])
  test('failed ' + boundary + ' persistence stops spending and restores without duplicate settlement', async () => {
    const f = await gameWallet(),
      w = f.wallet;
    w.openGame(f.identity());
    await w.setGameAllowance(100n);
    let commits = 0;
    // The signed request is saved once, and the settlement is the save after it.
    f.storage.beforeCommit = () => {
      if (++commits === (boundary === 'request' ? 1 : 2)) throw new Error('disk failed');
    };
    await assert.rejects(w.gameCasinoBet(terms()), /disk failed/);
    await assert.rejects(w.setGameAllowance(10n), /storage needs recovery/);
    f.storage.beforeCommit = null;
    const restored = await f.reload();
    if (restored.pending) await restored.exclusive(() => restored.resume());
    restored.openGame(f.identity());
    await restored.setGameAllowance(100n);
    await restored.gameCasinoBet(terms());
    assert.equal(f.settlements(), 1);
  });

test('mines runs its own rules through the wallet bridge and its own storage, including reload', async () => {
  const name = 'mines',
    allowance = 100000n;
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity(name));
  await w.setGameAllowance(allowance);
  const bridge = bridgeFor(w),
    store = memoryStore();
  const graph = () => createMines({ tiles: 5, mines: 1, cashouts: [1200n, 1560n, 2280n] });
  const stake = 1000n;
  let round = new RoundClient(bridge, graph, undefined, { store, name }),
    state = await round.start({ stake });
  const before = await w.balance();
  // The allowance the wallet shows: starting a round moves nothing, a stake leaves it when it is bet, and what the
  // round's steps win stays with the round, which its own steps stake, until the game ends it.
  assert.equal(w.gameAllowance().allowance, allowance);
  for (let i = 0; !state.terminal && i < 64; i++) {
    state = await round.action(state.actions.find(a => ['stand', 'cash-out'].includes(a)) ?? state.actions[0]);
    if (i === 2) round = new RoundClient(bridge, graph, undefined, { store, name });
    state = (await round.restore())!;
    assert.equal(w.gameAllowance().allowance, allowance - state.contributed);
    assert.equal(w.gameAllowance(state.id).allowance, allowance - state.contributed + state.cash);
    assert.equal(w.inPlay(), state.cash);
  }
  assert.equal(state.terminal, true);
  assert.equal(await w.balance(), before - state.contributed + state.cash);
  await bridge.call('game.end', { group: state.id });
  assert.equal(w.inPlay(), 0n);
  assert.equal(w.gameAllowance().allowance, allowance - state.contributed + state.cash);
  assert.equal(store.map.size, 1, 'the round lives under one key per player');
  assert.equal([...store.map.keys()][0], `hookedin:round:${name}:31337:${w.uname}`);
});

test('importing newer evidence brings the channel up to date', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(100n);
  const before = await f.storage.get(w.storageKey);
  await w.gameCasinoBet(terms());
  const bundle = plain(await w.exportEvidence());
  const restored = await f.reload();
  restored.storage = new MemoryStore();
  restored.hydrate(before);
  await restored.storage.put(w.storageKey, before);
  restored.reader = {
    channels: async () => ({ status: 1n, player: f.player.address }),
  } as any;
  restored.refresh = async () => ({});
  await restored.importEvidence(bundle);
  assert.equal(restored.channel!.state.balance, w.channel!.state.balance);
  assert.equal(restored.availableBalance(), await w.balance());
});

test('additional game wagers debit the allowance once and recover their cards and costs after a lost reply', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('extra-cash'));
  await w.setGameAllowance(1000n);
  let loseReply = true,
    settlements = 0;
  const bridge = bridgeFor(w, async (method, params) => {
    if (method !== 'game.casinoBet' && method !== 'game.payment') return undefined;
    const receipt = method === 'game.casinoBet' ? await w.gameCasinoBet(params) : await w.gamePayment(params);
    settlements++;
    if (loseReply) {
      loseReply = false;
      throw new Error('reply lost');
    }
    return receipt;
  });
  const graph = coin({
    action: 'double',
    additionalCash: 1000n,
    payout: () => 3000n,
    labels: ['player:0:10:0', 'player:0:5:3'],
  });
  const store = memoryStore();
  let round = new RoundClient(bridge, graph, undefined, { store });
  await round.start({ stake: 1000n });
  const before = await w.balance();
  await assert.rejects(round.action('double'), /Not enough allowance/);
  assert.equal(settlements, 0);
  assert.equal(
    JSON.parse(store.get(round['storageKey'])!).pending,
    null,
    'no ticket is drawn while the allowance is short',
  );
  await w.setGameAllowance(2000n);
  await assert.rejects(round.action('double'), /reply lost/);
  round = new RoundClient(bridge, graph, undefined, { store });
  const recovered = (await round.restore())!;
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.contributed, 2000n);
  assert.equal(recovered.events.length, 1);
  assert.match(recovered.events[0]!.label!, /^player:0:/);
  assert.equal(await w.balance(), before - 2000n + recovered.cash);
  assert.deepEqual(await round.restore(), recovered);
  assert.equal(settlements, 1);
});

test('the round helper refuses what the allowance does not cover, which only the player sets', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('shortfall'));
  const graph = coin({ action: 'double', additionalCash: 1000n, payout: () => 3000n });
  const round = new RoundClient(bridgeTo(w), graph, undefined, { store: memoryStore() });
  await assert.rejects(round.start({ stake: 1000n }), {
    message:
      'Not enough allowance for this bet: it is what you let this game play with. Set it in the top bar, creating a wallet or depositing first if it asks.',
  });
  // The player sets the allowance in the wallet's top bar.
  await w.setGameAllowance(1000n);
  await round.start({ stake: 1000n });
  await assert.rejects(round.action('double'), /Not enough allowance/);
  await w.setGameAllowance(2000n);
  assert.equal((await round.action('double')).terminal, true);
});

test('a stake the casino cannot back fails with a plain capacity message, not a pricing error', async () => {
  const bridge = {
    call: async (method: string) =>
      method === 'game.allowance'
        ? { allowance: 100000000000000000n, pending: false, developerBets: false }
        : { virtualBankroll: 5000000000000000n, chainId: 1n },
  };
  const round = new RoundClient(bridge, coin({ payout: stake => (stake * 19n) / 10n }), undefined, {
    store: memoryStore(),
  });
  await assert.rejects(round.start({ stake: 5000000000000000n }), /back about 2,500 METH of payouts/);
  await assert.rejects(round.start({ stake: 5000000000000000n }), error => !/initialCash/.test(String(error)));
  assert.equal((await round.start({ stake: 1000000000000n })).terminal, false);
});

test('a supported plan is reused across rounds and recomputed when the bankroll falls below its bound', async () => {
  let bankroll = 1000000000n,
    builds = 0;
  const bridge = {
    call: async (method: string) =>
      method === 'game.allowance'
        ? { allowance: 10000n, pending: false, developerBets: false }
        : { virtualBankroll: bankroll, chainId: 1n },
  };
  const round = new RoundClient(
    bridge,
    () => {
      builds++;
      return {
        root: 'start',
        nodes: [
          {
            id: 'start',
            kind: 'decision',
            actions: [{ id: 'push', outcomes: [{ next: 'done', probability: fraction(1n) }] }],
          },
          { id: 'done', kind: 'terminal', payout: 1000n },
        ],
      };
    },
    undefined,
    { store: memoryStore() },
  );
  await round.start({ stake: 1000n });
  const plan = round['plan'];
  await round.action('push');
  await round.start({ stake: 1000n });
  assert.equal(round['plan'], plan);
  await round.action('push');
  bankroll = 100000000n;
  await round.start({ stake: 1000n });
  assert.notEqual(round['plan'], plan);
  assert.equal(builds, 1, 'one setup builds its graph once per page');
});

test('a step the quote does not cover is refused before anything is drawn or signed, and plays once it is', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('uncovered'));
  await w.setGameAllowance(1000n);
  // The game prices the step against the virtual bankroll it was told, and the quote the wallet holds by the time it
  // draws covers nothing the step can bet.
  const told = (await w.gameInfo()).virtualBankroll,
    bridge = bridgeFor(w, async method =>
      method === 'wallet.info' ? { ...(await w.gameInfo()), virtualBankroll: told } : undefined,
    ),
    graph = coin({ payout: () => 1900n, labels: ['win', 'loss'] }),
    store = memoryStore(),
    round = new RoundClient(bridge, graph, undefined, { store });
  await round.start({ stake: 1000n });
  const start = structuredClone(w.channel!.state),
    real = w.channel!.quote,
    message = {
      previousStateHash: hashState(w.domain, start),
      round: id('a round'),
      virtualBankroll: 0n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + QUOTE_PERIOD),
    };
  w.channel!.quote = { message, signature: await f.signer.signTypedData(w.domain, QUOTE_TYPES, message) };
  const before = await w.balance();
  await assert.rejects(round.action('roll'), /cannot back this step/);
  assert.deepEqual([w.pending, await w.balance(), w.gameAllowance().allowance], [null, before, 1000n]);
  assert.equal(hashState(w.domain, w.channel!.state), hashState(w.domain, start), 'nothing was signed');
  // Once a quote covers it, the same step plays, under the same operation ID.
  const id0 = round['data']!.pending!.id;
  w.channel!.quote = real;
  const result = await round.action('roll');
  assert.equal(result.terminal, true);
  assert.equal(result.settlement?.kind === 'casino-bet' && result.settlement.id, id0);
});

test('the state carries the setup its round was started with, across a reload', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('setup'));
  await w.setGameAllowance(10000n);
  const store = memoryStore(),
    graph = (setup: any) => createMines({ tiles: setup.tiles, mines: 1, cashouts: [1200n, 1560n, 2280n] }),
    setup = { stake: 1000n, tiles: 5 };
  assert.deepEqual((await new RoundClient(bridgeFor(w), graph, undefined, { store }).start(setup)).setup, setup);
  const reloaded = new RoundClient(bridgeFor(w), graph, undefined, { store });
  assert.deepEqual((await reloaded.restore())!.setup, setup);
});

test('a round saved with a setup the rules refuse is let go once, and the next round starts', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('setup'));
  await w.setGameAllowance(10000n);
  const store = memoryStore(),
    graph = (setup: any) => createMines({ tiles: setup.tiles, mines: 1, cashouts: [1200n, 1560n, 2280n] });
  await new RoundClient(bridgeFor(w), graph, undefined, { store }).start({ stake: 1000n, tiles: 5 });
  // The game's rules change so that the saved setup no longer builds a graph.
  const stricter = (setup: any) => {
    if (setup.mines === undefined) throw new RangeError('mines requires integer 0 < mines < tiles');
    return graph(setup);
  };
  const reloaded = new RoundClient(bridgeFor(w), stricter, undefined, { store });
  await assert.rejects(reloaded.restore(), /rules this game does not play/);
  assert.equal(await reloaded.restore(), null);
  assert.deepEqual((await reloaded.start({ stake: 1000n, tiles: 5, mines: 1 })).setup, {
    stake: 1000n,
    tiles: 5,
    mines: 1,
  });
});

test('a saved round holds its amounts as decimal strings, and one saved in another form is let go once', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('form'));
  await w.setGameAllowance(10000n);
  const store = memoryStore(),
    round = new RoundClient(bridgeFor(w), coin({ payout: () => 1900n }), undefined, { store });
  await round.start({ stake: 1000n });
  const key = round['storageKey'],
    saved = JSON.parse(store.get(key)!);
  assert.deepEqual([saved.setup.stake, saved.cash, saved.contributed], ['1000', '1000', '1000']);
  store.set(key, JSON.stringify({ ...saved, cash: 1000 }));
  await assert.rejects(round.restore(), /rules this game does not play/);
  assert.equal(store.get(key), null);
  assert.equal(await round.restore(), null);
});

test('an action sent again after its reply was lost is that step, not another from where it led', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('retry'));
  await w.setGameAllowance(10000n);
  let lose = true;
  const bridge = bridgeFor(w, async (method, params) => {
    if (method !== 'game.casinoBet') return undefined;
    const receipt = await w.gameCasinoBet(params);
    if (lose) {
      lose = false;
      throw new Error('reply lost');
    }
    return receipt;
  });
  // Wherever the first roll lands, the player may roll again.
  const half = fraction(1n, 2n),
    roll = (won: string) => [
      {
        id: 'roll',
        outcomes: [
          { next: won, probability: half },
          { next: 'lost', probability: half },
        ],
      },
    ];
  const graph = () => ({
    root: 'start',
    nodes: [
      {
        id: 'start',
        kind: 'decision' as const,
        actions: [
          {
            id: 'roll',
            outcomes: [
              { next: 'high', probability: half },
              { next: 'low', probability: half },
            ],
          },
        ],
      },
      { id: 'high', kind: 'decision' as const, actions: roll('high-won') },
      { id: 'low', kind: 'decision' as const, actions: roll('low-won') },
      { id: 'high-won', kind: 'terminal' as const, payout: 2000n },
      { id: 'low-won', kind: 'terminal' as const, payout: 1000n },
      { id: 'lost', kind: 'terminal' as const, payout: 0n },
    ],
  });
  const round = new RoundClient(bridge, graph, undefined, { store: memoryStore() });
  await round.start({ stake: 1000n });
  await assert.rejects(round.action('roll'), /reply lost/);
  // The wallet settled the roll; the player presses the same button again.
  const again = await round.action('roll');
  assert.deepEqual([again.events.length, again.terminal, f.settlements()], [1, false, 1]);
  const last = await round.action('roll');
  assert.deepEqual([last.events.length, last.terminal, f.settlements()], [2, true, 2]);
});

test('a button pressed twice plays one step, and the second press bets nothing', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('twice'));
  await w.setGameAllowance(10000n);
  const graph = coin({ payout: () => 1900n });
  // The wallet's bridge answers a game's requests one at a time, in the order asked.
  const bridge = bridgeTo(w);
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = {
    ...bridge,
    call: (method: string, params?: any) => (turn = turn.catch(() => {}).then(() => bridge.call(method, params))),
  };
  const round = new RoundClient(inTurn, graph, undefined, { store: memoryStore() });
  await round.start({ stake: 1000n });
  const [first, second] = await Promise.allSettled([round.action('roll'), round.action('roll')]);
  assert.equal(first.status, 'fulfilled');
  assert.match(String((second as PromiseRejectedResult).reason), /Wait for the action under way/);
  assert.deepEqual([(first as PromiseFulfilledResult<any>).value.terminal, f.settlements()], [true, 1]);
});

test("the stub developer pages a game's bets 100 at a time in the order they were placed, and waits for the next, as the casino does", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n, true);
  const placed: string[] = [];
  for (let i = 0; i < 101; i++) placed.push((await w.gameDeveloperBet({ id: `bet-${i}`, stake: 1n, meta: {} })).bet!);
  const first = await f.developer.bets();
  assert.deepEqual([first.bets.length, first.more], [100, true]);
  const rest = await f.developer.bets({ after: first.cursor });
  assert.deepEqual([rest.bets.length, rest.more], [1, false]);
  assert.deepEqual(
    [...first.bets, ...rest.bets].map(bet => bet.bet),
    placed,
  );
  const waiting = f.developer.bets({ after: rest.cursor, wait: 25 }),
    next = (await w.gameDeveloperBet({ id: 'next', stake: 1n, meta: {} })).bet,
    last = await waiting;
  assert.deepEqual(
    last.bets.map(bet => bet.bet),
    [next],
  );
  // A newer wait answers the one before, and the stub refuses what the casino refuses: a cursor that names no bet.
  const older = f.developer.bets({ after: last.cursor, wait: 25 });
  await f.developer.bets({ after: last.cursor, wait: 1 });
  assert.deepEqual((await older).bets, []);
  for (const query of [{ wait: 26 }, { wait: 0.5 }, { status: 'settled' as const, wait: 1 }, { after: next! }])
    await assert.rejects(f.developer.bets(query), /Wait 1 to 25 seconds|cursor/);
});

test("a game's history is checked against the evidence the casino kept: whatever it changes, the page is refused", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance(1000n);
  await f.bridge.call('game.casinoBet', terms('kept'));
  w.openGame(f.identity('other'));
  await w.setGameAllowance(1000n);
  await f.bridge.call('game.casinoBet', terms('elsewhere'));
  assert.equal((await f.bridge.call('game.history')).entries.length, 1, "only the open game's");
  const api = w.api.bind(w),
    // The other game's operation, as the casino keeps it: genuine, but not this game's.
    [elsewhere] = ((await api(`/api/account/game-history?game=${f.identity('test').id}`)) as any).entries,
    doctored = (change: (entry: any) => void, refusal = /./) => {
      w.api = async (path, body) => {
        const page: any = await api(path, body);
        if (path.startsWith('/api/account/game-history')) change(page.entries[0]);
        return page;
      };
      return assert.rejects(f.bridge.call('game.history'), refusal);
    };
  // Another outcome, another group, another account's operation, or another game's.
  await doctored(entry => (entry.evidence.step.secret = id('another secret')));
  await doctored(entry => (entry.details.group = 'another group'));
  await doctored(entry => (entry.evidence.base.player = ZeroAddress));
  await doctored(entry => Object.assign(entry, structuredClone(elsewhere)), /another account or game/);
});
