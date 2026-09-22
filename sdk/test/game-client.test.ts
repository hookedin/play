import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { MemoryStore } from '@hookedin/play/client/storage.ts';
import { decryptBackup } from '@hookedin/play/client/backup.ts';
import {
  hashState,
  initialState,
  rejectionCheckpoint,
  STATE_TYPES,
  checkpointEvidence,
} from '@hookedin/play/protocol/protocol.ts';
import { validateRequest } from '@hookedin/play/client/bridge.ts';
import { RoundClient } from '../src/round.ts';
import type { RoundStore } from '../src/round.ts';
import { createBlackjack, createMines } from '../src/engine/index.ts';
import { blackjackFunding } from '../src/generated/blackjack-funding.ts';

const prize = { rangeStart: '0', rangeEnd: '9000000000000000000', payout: '20' };
const terms = (id = 'op-0') => ({ id, stake: '10', prizes: [prize] });
/** A game's own origin storage, shared by every RoundClient of one test like localStorage would be. */
const memoryStore = (): RoundStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    get: key => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: key => void map.delete(key),
  };
};
/** What the SDK gives a round: bridge requests, plus the wallet's latest pushed limit. */
const bridgeFor = (w: any, extra: (method: string, params: any) => Promise<unknown> | undefined = () => undefined) => ({
  balance: async () => w.gameLimit(),
  call: async (method: string, params: any = {}) => {
    const handled = await extra(method, params);
    if (handled !== undefined) return handled;
    // Exactly what the wallet answers with, so a game's view of the player is the real one.
    if (method === 'wallet.hello') return w.gameHello();
    if (method === 'wallet.info') return { ...w.gameInfo(), bankroll: '1000000000000' };
    if (method === 'game.receipt') return w.gameReceipt(params.id);
    if (method === 'game.requestFunds') {
      await w.setGameLimit(String(BigInt(w.gameLimit().balance) + BigInt(params.amount)));
      return { funded: true, amount: params.amount, ...w.gameLimit() };
    }
    return method === 'game.bet' ? w.gameBet(params) : w.gamePayment(params);
  },
});

test('the spending limit lives in memory: leaving the game releases it, and nothing about games is saved', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  await assert.rejects(w.setGameLimit('100'), /No game is open/);
  w.openGame(f.identity('a'));
  await assert.rejects(w.gameBet(terms()), /exceeds the game balance/);
  await w.setGameLimit('100');
  assert.equal(w.availableBalance(), 999900n);
  await assert.rejects(w.setGameLimit('1000001'), /exceeds your playing balance/);
  await assert.rejects(w.gameBet({ ...terms(), stake: '101' }), /game balance/);
  await assert.rejects(w.payBankroll(999901n), /unallocated/);
  w.closeGame();
  assert.equal(w.availableBalance(), 1000000n);
  assert.throws(() => w.gameLimit(), /No game is open/);
  const record = await f.storage.get(w.storageKey);
  assert.doesNotMatch(JSON.stringify(record), /games|allocation|"balance":"100"/);
  const reloaded = await f.reload();
  assert.equal(reloaded.game, null);
  assert.equal(reloaded.availableBalance(), 1000000n);
});

test('verified gains and losses move the limit; exact retries by ID never charge twice', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameLimit('1000');
  let balance = 1000n;
  for (let i = 0; i < 20; i++) {
    const request = terms(`round-${i}`),
      receipt = await w.gameBet(request);
    assert.equal(receipt.status, 'signed');
    balance += BigInt(receipt.payout!) - 10n;
    assert.equal(w.gameLimit().balance, String(balance));
    assert.equal(w.availableBalance(), 999000n);
    assert.deepEqual(receipt, {
      id: request.id,
      kind: 'bet',
      status: 'signed',
      verified: true,
      stake: '10',
      prizes: [prize],
      outcome: receipt.outcome,
      payout: receipt.payout,
    });
    assert.deepEqual(await w.gameBet(request), receipt);
    assert.deepEqual(await w.gameReceipt(request.id), receipt);
    await assert.rejects(w.gameBet({ ...request, prizes: [{ ...prize, payout: '21' }] }), /different intent/);
  }
  assert.equal(f.settlements(), 20);
  assert.equal(await w.gameReceipt('never-played'), null);
  // Another game cannot reuse this game's operation IDs.
  w.openGame(f.identity('other'));
  await w.setGameLimit('100');
  await w.gameBet(terms('round-0'));
  assert.equal(f.settlements(), 21);
});

test('a shared round: the wallet takes a seat, the host closes the round, and the same call returns the receipt', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('table', { rounds: true }));
  await w.setGameLimit('1000');
  // The stub casino plays the host's part: a round with the hash of the host's seed, closed when the host says.
  const round = f.openRound(),
    request = { ...terms('spin-1'), round };
  assert.deepEqual(await w.gameBet(request), { id: 'spin-1', status: 'pending', verified: false });
  assert.equal(w.gameLimit().pending, true);
  assert.equal((await w.gameBet(request)).status, 'pending', 'asking again while the round is open');
  assert.equal(f.settlements(), 0);
  await f.closeRound(round.id);
  const receipt = await w.gameBet(request),
    saved = await w.getReceipt(w.gameOperationId('spin-1'));
  assert.equal(receipt.status, 'signed');
  assert.equal(saved.hosted, true);
  assert.equal(saved.proof.step.operation.seedHash, round.seedHash, "the seat signed the hash of the host's seed");
  assert.equal(w.gameLimit().balance, String(1000n - 10n + BigInt(receipt.payout!)));
  assert.equal(w.gameLimit().pending, false);
  // The wallet's own next bet is unaffected: it still has the round the casino named for it.
  assert.equal((await w.gameBet(terms('own'))).status, 'signed');
});

test('changing the chips on a seat is giving it up and placing a new bet', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('table', { rounds: true }));
  await w.setGameLimit('1000');
  const round = f.openRound(),
    chips = (id: string, stake: string) => ({
      id,
      stake,
      prizes: [{ ...prize, payout: String(2n * BigInt(stake)) }],
      round,
    });
  assert.equal((await w.gameBet(chips('layout', '10'))).status, 'pending');
  // A name is bound to the terms the wallet signed: other chips need another bet.
  await assert.rejects(w.gameBet(chips('layout', '40')), /different intent/);
  assert.equal((await w.gameCancel({ id: 'layout' })).status, 'rejected');
  assert.equal(w.gameLimit().balance, '1000', 'a withdrawn bet moves no money');
  assert.equal((await w.gameBet(chips('layout-2', '40'))).status, 'pending');
  await f.closeRound(round.id);
  const receipt: any = await w.gameBet(chips('layout-2', '40'));
  assert.deepEqual([receipt.status, receipt.stake], ['signed', '40']);
  assert.equal(w.gameLimit().balance, String(1000n - 40n + BigInt(receipt.payout!)));
});

test('a game learns how its operations ended and never whose they were', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('table', { rounds: true }));
  await w.setGameLimit('1000');
  const replies: any[] = [],
    reply = async (value: unknown) => void replies.push(await value);
  await reply(w.gameHello());
  await reply(w.gameInfo());
  await reply(w.gameLimit());
  await reply(w.gameBet(terms('own')));
  const round = f.openRound();
  await reply(w.gameBet({ ...terms('left'), round }));
  await reply(w.gameCancel({ id: 'left' }));
  await reply(w.gameBet({ ...terms('seat'), round }));
  await f.closeRound(round.id);
  await reply(w.gameBet({ ...terms('seat'), round }));
  await reply(w.gamePayment({ id: 'pay', amount: '1' }));
  for (const id of ['own', 'left', 'seat', 'pay']) await reply(w.gameReceipt(id));
  const fields = ['id', 'kind', 'status', 'verified', 'stake', 'prizes', 'outcome', 'payout', 'reason'];
  for (const r of replies.filter(r => r.status))
    assert.deepEqual(
      Object.keys(r).filter(key => !fields.includes(key)),
      [],
      `${r.id} ${r.status}`,
    );
  const player = [w.channelId!, f.player.address, w.current!.opening.signer].map(hex => hex.slice(2).toLowerCase());
  for (const r of replies)
    for (const secret of player) assert.doesNotMatch(JSON.stringify(r).toLowerCase(), new RegExp(secret));
  const statuses = replies.filter(r => r.status).map(r => `${r.id} ${r.status}`);
  assert.deepEqual(statuses, [
    'own signed',
    'left pending',
    'left rejected',
    'seat pending',
    'seat signed',
    'pay signed',
    'own signed',
    'left rejected',
    'seat signed',
    'pay signed',
  ]);
});

test('the limit moves while a seat waits: what the bet committed is not the player’s to allocate', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('table', { rounds: true }));
  await w.setGameLimit('1000');
  const round = f.openRound(),
    request = { ...terms('spin'), round };
  assert.equal((await w.gameBet(request)).status, 'pending');
  await w.setGameLimit('999990');
  assert.equal(w.gameLimit().balance, '999990', 'the limit is the player’s to set while the seat waits');
  await assert.rejects(w.setGameLimit('999991'), /exceeds your playing balance/, 'all but the stake it committed');
  await w.setGameLimit('10');
  await f.closeRound(round.id);
  const receipt = await w.gameBet(request);
  assert.equal(receipt.status, 'signed');
  assert.equal(w.gameLimit().balance, receipt.payout, 'and the result moves the limit it was left at');
});

test('a lost reply is recovered after reload without any game state in the wallet', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameLimit('100');
  const api = w.api.bind(w);
  w.api = async (...args) => {
    const result = await api(...args);
    if (args[0].endsWith('/operations')) throw new Error('lost reply');
    return result;
  };
  await assert.rejects(w.gameBet(terms('lost')), /lost reply/);
  assert.equal(w.gameLimit().pending, true);
  const request = structuredClone(w.pending.request);
  const restored = await f.reload();
  assert.equal(restored.game, null, 'the limit did not survive the reload');
  assert.deepEqual(restored.pending.request, request);
  await restored.exclusive(() => restored.resume());
  assert.equal(restored.availableBalance(), await restored.balance(), 'the result landed in the channel balance');
  restored.openGame(f.identity());
  assert.equal(restored.gameLimit().pending, false);
  assert.equal((await restored.gameReceipt('lost'))!.status, 'signed', 'the game can still learn the outcome by ID');
  assert.equal(f.settlements(), 1);
  await restored.gameBet(terms('lost'));
  assert.equal(f.settlements(), 1);
});

test('a result recovered in the same tab updates the open game; a closed game changes only the channel', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameLimit('100');
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
  await assert.rejects(w.gameBet(terms('a')), /lost reply/);
  const receipt: any = await w.exclusive(() => w.resume());
  assert.equal(w.gameLimit().balance, String(100n - 10n + BigInt(receipt.payout)));
  w.closeGame();
  w.openGame(f.identity('b'));
  await w.setGameLimit('50');
  lose = true;
  await assert.rejects(w.gameBet(terms('b')), /lost reply/);
  w.closeGame();
  const before = await w.balance();
  const settled: any = await w.exclusive(() => w.resume());
  assert.equal(await w.balance(), before - 10n + BigInt(settled.payout));
  assert.equal(w.availableBalance(), await w.balance());
});

test('saved round state belongs to one player and one asset', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('a'));
  const store = memoryStore();
  const keyFor = async (wallet: any) => {
    const round = new RoundClient(bridgeFor(wallet), createMines, undefined, { store, name: 'mines' });
    await round.restore();
    return (round as any).storageKey;
  };
  const mine = await keyFor(w);
  // Nothing a game keys by may be a field the wallet does not send: `undefined` in a key is every
  // account sharing one.
  assert.equal(mine.includes('undefined'), false, mine);
  assert.ok(w.uname && mine.includes(w.uname.toLowerCase()), mine);
  // Another account, and the same account's test coins, are somewhere else entirely.
  const other = {
    ...bridgeFor(w),
    call: async (method: string, params: any = {}) => {
      const value = await bridgeFor(w).call(method, params);
      return method === 'wallet.info' ? { ...value, uname: 'somebodyelse', alias: null } : value;
    },
  };
  const theirs = new RoundClient(other, createMines, undefined, { store, name: 'mines' });
  await theirs.restore();
  assert.notEqual((theirs as any).storageKey, mine);
  // An alias is what they are called today; it never moves what they saved.
  const renamed = {
    ...bridgeFor(w),
    call: async (method: string, params: any = {}) => {
      const value = await bridgeFor(w).call(method, params);
      return method === 'wallet.info' ? { ...value, alias: 'Renamed' } : value;
    },
  };
  const after = new RoundClient(renamed, createMines, undefined, { store, name: 'mines' });
  await after.restore();
  assert.equal((after as any).storageKey, mine);
});

test('the bridge validates game requests without revisions or checkpoints', () => {
  for (const params of [
    { ...terms(), developer: '0x1' },
    { ...terms(), seed: '0x00' },
    { ...terms(), revision: 0 },
    { ...terms(), data: {} },
    { ...terms(), prizes: [{ ...prize, rangeEnd: String((1n << 64n) + 1n) }] },
    { ...terms(), winThreshold: '5' },
    { ...terms(), prizes: [] },
  ])
    assert.throws(() => validateRequest({ hookedin: true, id: 1, method: 'game.bet', params }));
  assert.equal(validateRequest({ hookedin: true, id: 1, method: 'game.bet', params: terms() }).method, 'game.bet');
  for (const id of ['1', -1, 1.5])
    assert.throws(() => validateRequest({ hookedin: true, id, method: 'wallet.info' }), /request ID/);
  assert.throws(() => validateRequest({ hookedin: true, id: 1, method: 'game.save', params: {} }), /not available/);
  assert.throws(() => validateRequest({ hookedin: true, id: 1, method: 'wallet.sign', params: {} }));
});

for (const boundary of ['request', 'settlement'])
  test('failed ' + boundary + ' persistence stops spending and restores without duplicate settlement', async () => {
    const f = await gameWallet(),
      w = f.wallet;
    w.openGame(f.identity());
    await w.setGameLimit('100');
    let commits = 0;
    f.storage.beforeCommit = () => {
      if (++commits === (boundary === 'request' ? 1 : 3)) throw new Error('disk failed');
    };
    await assert.rejects(w.gameBet(terms()), /disk failed/);
    await assert.rejects(w.setGameLimit('10'), /storage needs recovery/);
    f.storage.beforeCommit = null;
    const restored = await f.reload();
    if (restored.pending) await restored.exclusive(() => restored.resume());
    restored.openGame(f.identity());
    await restored.setGameLimit('100');
    await restored.gameBet(terms());
    assert.equal(f.settlements(), 1);
  });

for (const name of ['mines', 'blackjack'])
  test(name + ' runs its own rules through the atomic bridge and its own storage, including reload', async () => {
    const allocation = name === 'blackjack' ? '1000000' : '100000';
    const f = await gameWallet(),
      w = f.wallet;
    w.openGame(f.identity(name));
    await w.setGameLimit(allocation);
    const bridge = bridgeFor(w),
      store = memoryStore();
    const graph = (setup: any) =>
      name === 'blackjack'
        ? createBlackjack({ stake: BigInt(setup.stake) })
        : createMines({ tiles: 5, mines: 1, cashouts: [1200n, 1560n, 2280n] });
    const stake = name === 'blackjack' ? '1000000' : '1000',
      funding = name === 'blackjack' ? blackjackFunding : undefined;
    let round = new RoundClient(bridge, graph, funding, { store, name }),
      state = await round.start({ stake });
    if (funding) assert.equal(round.plan!.bankrollFloor, funding.bankrollFloor);
    const before = await w.balance();
    // What a bank shows: the limit without the cash inside the unfinished round.
    const shown = () => BigInt(w.gameLimit().balance) - round.inHand();
    assert.equal(shown(), BigInt(allocation) - BigInt(stake));
    for (let i = 0; !state.terminal && i < 64; i++) {
      state = await round.action(state.actions.find(a => ['stand', 'cash-out'].includes(a)) ?? state.actions[0]);
      if (i === 2) round = new RoundClient(bridge, graph, funding, { store, name });
      state = (await round.restore())!;
      if (!state.terminal)
        assert.equal(
          shown(),
          BigInt(allocation) - BigInt(state.contributed),
          'a running value is never shown as money',
        );
    }
    assert.equal(state.terminal, true);
    assert.equal(round.inHand(), 0n);
    assert.equal(await w.balance(), before - BigInt(state.contributed) + BigInt(state.cash));
    assert.equal(w.gameLimit().balance, String(BigInt(allocation) - BigInt(state.contributed) + BigInt(state.cash)));
    assert.equal(store.map.size, 1, 'the round lives under one key per player and asset');
    assert.equal([...store.map.keys()][0], `hookedin:round:${name}:31337:eth:${w.uname}`);
  });

test('encrypted backups carry no game state and restore the channel evidence alone', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('a'));
  await w.setGameLimit('1000');
  await w.gameBet(terms('kept'));
  for (let i = 0; i < 101; i++) await w.gamePayment({ id: `pay-${i}`, amount: '1' });
  const password = 'game backup test passphrase',
    backup = await w.encryptedBackup(password);
  const contents = await decryptBackup(backup, password);
  assert.equal(contents.record.history.length, 100);
  assert.equal('gameReceipts' in contents, false);
  assert.doesNotMatch(JSON.stringify(contents.record.channels), /games/);
  const restored = await f.reload();
  restored.storage = new MemoryStore();
  restored.channels = {};
  restored.currentId = null;
  restored.revision = 0;
  restored.refresh = async () => ({});
  await restored.restoreBackup(backup, password);
  assert.equal(restored.game, null);
  await assert.rejects(restored.gameReceipt('kept'), /No game is open/);
  restored.openGame(f.identity('a'));
  assert.equal(await restored.gameReceipt('kept'), null, 'receipts beyond the retained history are not restored');
  await restored.setGameLimit('100');
  await restored.gameBet(terms('after-restore'));
  assert.equal(f.settlements(), 103);
});

test('importing newer financial evidence needs no game bookkeeping', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameLimit('100');
  const before = await f.storage.get(w.storageKey);
  await w.gameBet(terms());
  const bundle = await w.exportEvidence();
  const restored = await f.reload();
  restored.storage = new MemoryStore();
  restored.hydrate(before);
  await restored.storage.put(w.storageKey, before);
  restored.reader = {
    channels: async () => ({ status: 1, initialHash: hashState(w.domain, initialState(w.current!.opening)) }),
  } as any;
  restored.refresh = async () => ({});
  await restored.importEvidence(bundle);
  assert.equal(restored.current!.state.balance, w.current!.state.balance);
  assert.equal(restored.availableBalance(), await w.balance());
});

test('additional game wagers debit the limit once and recover their cards and costs after a lost reply', async () => {
  const { fraction } = await import('../src/engine/index.ts');
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('extra-cash'));
  await w.setGameLimit('1000');
  let loseReply = true,
    settlements = 0;
  const bridge = bridgeFor(w, async (method, params) => {
    if (method === 'game.requestFunds') return { funded: false, amount: null, ...w.gameLimit() };
    if (method !== 'game.bet' && method !== 'game.payment') return undefined;
    const receipt = method === 'game.bet' ? await w.gameBet(params) : await w.gamePayment(params);
    settlements++;
    if (loseReply) {
      loseReply = false;
      throw new Error('reply lost');
    }
    return receipt;
  });
  const graph = () => ({
    root: 'start',
    nodes: [
      {
        id: 'start',
        kind: 'decision' as const,
        actions: [
          {
            id: 'double',
            additionalCash: 1000n,
            outcomes: [
              { next: 'win', probability: fraction(1n, 2n), label: 'player:0:10:0' },
              { next: 'loss', probability: fraction(1n, 2n), label: 'player:0:5:3' },
            ],
          },
        ],
      },
      { id: 'win', kind: 'terminal' as const, payout: 3000n },
      { id: 'loss', kind: 'terminal' as const, payout: 0n },
    ],
  });
  const store = memoryStore();
  let round = new RoundClient(bridge, graph, undefined, { store });
  await round.start({ stake: '1000' });
  const before = await w.balance();
  await assert.rejects(round.action('double'), /enough money/);
  assert.equal(settlements, 0);
  assert.equal(JSON.parse(store.get(round.storageKey)!).pending, null, 'no ticket is drawn before funding');
  await w.setGameLimit('2000');
  await assert.rejects(round.action('double'), /reply lost/);
  round = new RoundClient(bridge, graph, undefined, { store });
  const recovered = (await round.restore())!;
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.contributed, '2000');
  assert.equal(recovered.events.length, 1);
  assert.match(recovered.events[0]!.label!, /^player:0:/);
  assert.equal(await w.balance(), before - 2000n + BigInt(recovered.cash));
  assert.deepEqual(await round.restore(), recovered);
  assert.equal(settlements, 1);
});

test('the round helper asks the wallet for exactly the shortfall and stops when the player declines', async () => {
  const { fraction } = await import('../src/engine/index.ts');
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('shortfall'));
  const requests: any[] = [];
  let approve = true;
  // The player authorizes only the stated minimum, not the suggested session amount.
  const minimum = (params: any) => String(BigInt(params.amount) - 4000n);
  const bridge = bridgeFor(w, async (method, params) => {
    if (method !== 'game.requestFunds') return undefined;
    requests.push(params);
    if (approve) await w.setGameLimit(String(BigInt(w.gameLimit().balance) + BigInt(minimum(params))));
    return { funded: approve, amount: approve ? params.amount : null, ...w.gameLimit() };
  });
  const graph = () => ({
    root: 'start',
    nodes: [
      {
        id: 'start',
        kind: 'decision' as const,
        actions: [
          {
            id: 'double',
            additionalCash: 1000n,
            outcomes: [
              { next: 'win', probability: fraction(1n, 2n) },
              { next: 'loss', probability: fraction(1n, 2n) },
            ],
          },
        ],
      },
      { id: 'win', kind: 'terminal' as const, payout: 3000n },
      { id: 'loss', kind: 'terminal' as const, payout: 0n },
    ],
  });
  const round = new RoundClient(bridge, graph, undefined, { store: memoryStore() });
  await round.start({ stake: '1000' });
  assert.deepEqual(requests, [{ amount: '5000' }], 'shortfall plus four stakes');
  assert.equal(w.gameLimit().balance, '1000');
  approve = false;
  await assert.rejects(round.action('double'), /Add enough money/);
  assert.deepEqual(requests.at(-1), { amount: '5000' });
  approve = true;
  const state = await round.action('double');
  assert.equal(state.terminal, true);
  assert.deepEqual(requests.at(-1), { amount: '5000' });
  assert.equal(requests.length, 3);
});

test("every sentence the round helper writes names the wallet's own asset", async () => {
  const { fraction } = await import('../src/engine/index.ts');
  const requests: any[] = [];
  let limit = '0';
  const bridge = {
    call: async (method: string, params: any = {}) => {
      if (method === 'game.requestFunds') {
        requests.push(params);
        return { funded: false, amount: null, balance: limit, pending: false };
      }
      return { bankroll: '5000000000000000', chainId: '1', asset: { id: 'test', symbol: 'TEST', decimals: 18 } };
    },
    balance: async () => ({ balance: limit, pending: false }),
  };
  const round = new RoundClient(
    bridge,
    (setup: any) => ({
      root: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'decision' as const,
          actions: [
            {
              id: 'roll',
              outcomes: [
                { next: 'win', probability: fraction(1n, 2n) },
                { next: 'loss', probability: fraction(1n, 2n) },
              ],
            },
          ],
        },
        { id: 'win', kind: 'terminal' as const, payout: (BigInt(setup.stake) * 19n) / 10n },
        { id: 'loss', kind: 'terminal' as const, payout: 0n },
      ],
    }),
    undefined,
    { store: memoryStore() },
  );
  await assert.rejects(round.start({ stake: '1000' }), /Add enough money/);
  assert.deepEqual(requests.at(-1), { amount: '5000' }, 'the shortfall plus four stakes, and no words of its own');
  limit = '100000000000000000';
  await assert.rejects(round.start({ stake: '5000000000000000' }), /back about 0\.0025 TEST of payouts/);
});

test('a stake the casino cannot back fails with a plain capacity message, not a pricing error', async () => {
  const { fraction } = await import('../src/engine/index.ts');
  const bridge = {
    call: async () => ({
      bankroll: '5000000000000000',
      chainId: '1',
      asset: { id: 'eth', symbol: 'ETH', decimals: 18 },
    }),
    balance: async () => ({ balance: '100000000000000000', pending: false }),
  };
  const round = new RoundClient(
    bridge,
    (setup: any) => ({
      root: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'decision',
          actions: [
            {
              id: 'roll',
              outcomes: [
                { next: 'win', probability: fraction(1n, 2n) },
                { next: 'loss', probability: fraction(1n, 2n) },
              ],
            },
          ],
        },
        { id: 'win', kind: 'terminal', payout: (BigInt(setup.stake) * 19n) / 10n },
        { id: 'loss', kind: 'terminal', payout: 0n },
      ],
    }),
    undefined,
    { store: memoryStore() },
  );
  await assert.rejects(round.start({ stake: '5000000000000000' }), /back about 0\.0025 ETH of payouts/);
  await assert.rejects(round.start({ stake: '5000000000000000' }), error => !/initialCash/.test(String(error)));
  assert.equal((await round.start({ stake: '1000000000000' })).terminal, false);
});

test('a supported plan is reused across rounds and recomputed when the bankroll falls below its bound', async () => {
  const { fraction } = await import('../src/engine/index.ts');
  let bankroll = 1000000000n,
    builds = 0;
  const bridge = {
    call: async () => ({
      bankroll: String(bankroll),
      chainId: '1',
      asset: { id: 'eth', symbol: 'ETH', decimals: 18 },
    }),
    balance: async () => ({ balance: '10000', pending: false }),
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
  await round.start({ stake: '1000' });
  await round.action('push');
  await round.start({ stake: '1000' });
  assert.equal(builds, 1);
  await round.action('push');
  bankroll = 100000000n;
  await round.start({ stake: '1000' });
  assert.equal(builds, 2);
});

test('a rejected game action survives a lost reply and reload without resampling or charging', async () => {
  const { fraction } = await import('../src/engine/index.ts');
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('rejection'));
  await w.setGameLimit('1000');
  const api = w.api.bind(w),
    attempts: any[] = [];
  w.api = async (url, body: any) => {
    if (url.endsWith('/operations')) {
      attempts.push(body.request);
      if (attempts.length === 1) {
        const state = rejectionCheckpoint(w.domain, w.current!.state, body.request);
        const signature = await f.owner.signTypedData(w.domain, STATE_TYPES, state);
        return {
          status: 'rejected',
          reason: 'Capacity unavailable',
          request: body.request,
          // A declined bet on the channel's own round reveals it.
          secret: f.secretOf(body.request.round),
          state,
          operationId: body.request.operationId,
          developer: null,
          casinoSignature: signature,
          evidence: checkpointEvidence(w.current!.state, w.current!.playerSignature, w.current!.casinoSignature),
        };
      }
    }
    return api(url, body);
  };
  const bridge = bridgeFor(w, async (method, params) => {
    if (method !== 'game.bet') return undefined;
    const receipt = await w.gameBet(params);
    if (receipt.status === 'rejected') throw new Error('reply lost');
    return receipt;
  });
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
              { next: 'win', probability: fraction(1n, 2n), label: 'win' },
              { next: 'loss', probability: fraction(1n, 2n), label: 'loss' },
            ],
          },
        ],
      },
      { id: 'win', kind: 'terminal' as const, payout: 1900n },
      { id: 'loss', kind: 'terminal' as const, payout: 0n },
    ],
  });
  const store = memoryStore();
  let round = new RoundClient(bridge, graph, undefined, { store });
  await round.start({ stake: '1000' });
  const before = await w.balance();
  await assert.rejects(round.action('roll'), /reply lost/);
  const ticket = structuredClone(round.data.pending.ticket);
  assert.equal(w.pending, null);
  assert.equal(await w.balance(), before);
  assert.equal(w.gameLimit().balance, '1000');
  round = new RoundClient(bridge, graph, undefined, { store });
  const resumed = await round.restore();
  assert.equal(resumed!.events.length, 0);
  assert.equal(resumed!.terminal, false);
  assert.deepEqual(round.data.pending.ticket, ticket, 'the rejected step is kept, under a new operation ID');
  const result = await round.action('roll');
  assert.equal(result.terminal, true);
  assert.equal(result.events.length, 1);
  for (const field of ['amount', 'prizes']) assert.deepEqual(attempts[1][field], attempts[0][field]);
  assert.notEqual(attempts[1].operationId, attempts[0].operationId);
  assert.equal(attempts[0].sequence, '1');
  assert.equal(attempts[1].sequence, '3');
});
