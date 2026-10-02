import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeTo, gameWallet, memoryStore } from '@hookedin/play/testing/game-wallet.ts';
import { MemoryStore } from '../../client/storage.ts';
import { id, ZeroAddress } from 'ethers';
import {
  rejectionCheckpoint,
  checkpointEvidence,
  hashState,
  QUOTE_TYPES,
  QUOTE_PERIOD,
} from '../../protocol/protocol.ts';
import { RoundClient } from '../src/round.ts';
import { validateRequest } from '../../client/bridge.ts';
import type { GameReceipt } from '../../protocol/game-types.ts';
import { createMines, fraction } from '../src/engine/index.ts';
import { coin } from './coin.ts';

const odds = { chance: '9000000000000000000', prize: '20' };
const terms = (id = 'op-0') => ({ id, stake: '10', ...odds });
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
  await assert.rejects(w.setGameAllowance('100'), /No game is open/);
  w.openGame(f.identity('a'));
  await assert.rejects(w.gameCasinoBet(terms()), /exceeds the game's allowance/);
  await w.setGameAllowance('100');
  assert.equal(w.availableBalance(), 999900n);
  await assert.rejects(w.setGameAllowance('1000001'), /exceeds your balance/);
  await assert.rejects(w.gameCasinoBet({ ...terms(), stake: '101' }), /game's allowance/);
  await assert.rejects(w.payBankroll(999901n), /less the game's allowance/);
  w.closeGame();
  assert.equal(w.availableBalance(), 1000000n);
  assert.throws(() => w.gameAllowance(), /No game is open/);
  const record = await f.storage.get(w.storageKey);
  assert.doesNotMatch(JSON.stringify(record), /games|allowance/);
  const reloaded = await f.reload();
  assert.equal(reloaded.game, null);
  assert.equal(reloaded.availableBalance(), 1000000n);
  // Opened again, a game starts with nothing to play with.
  w.openGame(f.identity('a'));
  assert.deepEqual(w.gameAllowance(), { allowance: '0', pending: false, developerBets: false });
});

test('a group keeps what its bets win out of the allowance until the game ends it, and only its own bets stake it', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000');
  // Each bet of the group stakes what the group holds first, and what it wins stays with the group.
  let allowance = 1000n,
    held = 0n;
  for (let i = 0; i < 6; i++) {
    const receipt = await w.gameCasinoBet({ ...terms(`step-${i}`), group: 'round' }),
      drawn = held < 10n ? held : 10n;
    allowance -= 10n - drawn;
    held += BigInt(receipt.payout!) - drawn;
    assert.equal(w.gameAllowance().allowance, String(allowance));
    assert.equal(w.inPlay(), held);
    assert.equal(w.gameAllowance('round').allowance, String(allowance + held));
  }
  // Another group stakes only the allowance.
  await assert.rejects(
    w.gameCasinoBet({ id: 'other', stake: String(allowance + 1n), ...odds, group: 'other' }),
    /game's allowance/,
  );
  // The player sets the allowance itself; what the group holds stays with it, and is the player's all the same.
  await w.setGameAllowance('500');
  assert.deepEqual([w.gameAllowance().allowance, w.inPlay()], ['500', held]);
  assert.equal(w.availableBalance(), (await w.balance()) - 500n - held);
  await assert.rejects(w.setGameAllowance(String((await w.balance()) - held + 1n)), /exceeds your balance/);
  // Once the game has shown how the group ended, what it won joins the allowance.
  w.gameEnd('round');
  w.gameEnd('never-placed');
  assert.deepEqual([w.gameAllowance().allowance, w.inPlay()], [String(500n + held), 0n]);
});

test("what a bet keeps of its group's cash leaves the allowance with its stake, and stays with the group", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000');
  // A round's first step stakes 10 and keeps 4 of the round's 14: all 14 leave the allowance the player sees.
  const receipt = await w.gameCasinoBet({ ...terms('step-1'), group: 'round', kept: '4' }),
    won = BigInt(receipt.payout!);
  assert.equal(w.gameAllowance().allowance, '986');
  assert.equal(w.inPlay(), 4n + won);
  // A bet keeps nothing outside a group, and its stake and what it keeps fit what the group may stake.
  assert.throws(
    () => validateRequest({ hookedin: true, id: 1, method: 'game.casinoBet', params: { ...terms('x'), kept: '1' } }),
    /Only a bet in a group/,
  );
  await assert.rejects(
    w.gameCasinoBet({ ...terms('step-2'), group: 'round', kept: String(986n + 4n + won) }),
    /game's allowance/,
  );
  w.gameEnd('round');
  assert.equal(w.gameAllowance().allowance, String(990n + won));
});

test('a game places developer bets only once the player allows them, and only a published game can be', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000');
  const bet = { id: 'match', stake: '10', meta: { pick: 'home' } };
  await assert.rejects(w.gameDeveloperBet(bet), (error: any) => error.code === 'developer-bets-not-allowed');
  assert.equal(w.gameAllowance().allowance, '1000');
  await w.setGameAllowance('1000', true);
  assert.equal((await w.gameDeveloperBet(bet)).status, 'open');
  // Changing the allowance keeps the leave; taking all of it back takes the leave with it.
  await w.setGameAllowance('500');
  assert.equal(w.gameAllowance().developerBets, true);
  await w.setGameAllowance('0');
  assert.equal(w.gameAllowance().developerBets, false);
  // A game opened by its URL alone has no developer to bet against.
  w.openGame(f.identity('unpublished', { developer: ZeroAddress }));
  await assert.rejects(w.setGameAllowance('100', true), /Only a published game/);
});

test('verified gains and losses move the allowance; exact retries by ID never charge twice', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000');
  let allowance = 1000n;
  for (let i = 0; i < 20; i++) {
    const request = terms(`round-${i}`),
      receipt = await w.gameCasinoBet(request);
    assert.equal(receipt.status, 'settled');
    allowance += BigInt(receipt.payout!) - 10n;
    assert.equal(w.gameAllowance().allowance, String(allowance));
    assert.equal(w.availableBalance(), 999000n);
    assert.deepEqual(receipt, {
      id: request.id,
      kind: 'casino-bet',
      status: 'settled',
      stake: '10',
      ...odds,
      outcome: receipt.outcome,
      payout: receipt.payout,
    });
    assert.deepEqual(await w.gameCasinoBet(request), receipt);
    assert.deepEqual(await w.gameReceipt(request.id), receipt);
    await assert.rejects(w.gameCasinoBet({ ...request, prize: '21' }), /different intent/);
  }
  assert.equal(f.settlements(), 20);
  assert.equal(await w.gameReceipt('never-played'), null);
  // Another game cannot reuse this game's operation IDs.
  w.openGame(f.identity('other'));
  await w.setGameAllowance('100');
  await w.gameCasinoBet(terms('round-0'));
  assert.equal(f.settlements(), 21);
});

test("a developer bet keeps its game's meta, is paid only what its developer signed, and a game published nowhere takes none", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000', true);
  const pushed: GameReceipt[] = [];
  f.bridge.onReceipt(receipt => pushed.push(receipt));
  const request = { id: 'ride', stake: '10', meta: { cashout: '2.5' }, group: 'round-7' };
  const placed = await w.gameDeveloperBet(request);
  assert.match(placed.bet!, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(placed, { ...request, kind: 'developer-bet', status: 'open', bet: placed.bet });
  assert.equal(w.gameAllowance().allowance, '990');
  assert.equal(f.bank(), 10n ** 12n + 10n, "the stake went into the developer's bank");
  assert.deepEqual(await w.gameDeveloperBet(request), placed, 'asking again while it is open');
  await assert.rejects(w.gameDeveloperBet({ ...request, stake: '20' }), /different intent/);
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
    ['settled', '25', undefined],
    "a developer bet rests on its developer's word",
  );
  assert.deepEqual(pushed, [receipt]);
  // What it was paid returns to its group, until the game has shown the result and ends the group.
  assert.deepEqual([w.gameAllowance().allowance, w.gameAllowance('round-7').allowance], ['990', '1015']);
  w.gameEnd('round-7');
  assert.equal(w.gameAllowance().allowance, '1015');
  // A game published nowhere has no developer to take a developer bet.
  w.openGame(f.identity('plain', { slug: undefined }));
  await w.setGameAllowance('100', true);
  await assert.rejects(w.gameDeveloperBet({ ...request, id: 'nobody' }), /published nowhere/);
});

test("settlements the developer's bank cannot pay are refused whole, and the bets wait", async () => {
  const f = await gameWallet({ bank: 5n }),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000', true);
  const won = await w.gameDeveloperBet({ id: 'won', stake: '10', meta: {} }),
    lost = await w.gameDeveloperBet({ id: 'lost', stake: '10', meta: {} });
  assert.equal(f.bank(), 25n, "both stakes went into the developer's bank");
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
  await w.setGameAllowance('1000', true);
  const place = async (id: string) => (await w.gameDeveloperBet({ id, stake: '10', meta: {} })).bet!;
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
  const revision = w.revision;
  await w.collectPayouts();
  assert.equal(w.revision, revision, 'unchanged pages do not invalidate another tab');
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
  assert.equal((await w.gameReceipt('loss'))!.payout, '0');
  assert.equal(w.developerBets[lost], undefined);
  assert.equal(w.developerBets[returned]!.state!.status, 'settled');
  assert.equal(w.developerBets[returned]!.state!.payout, '10');
  assert.equal(w.developerBets[returned]!.error, 'Credit unavailable');
  assert.equal(await w.balance(), 999970n);
  const restored = await f.reload(),
    cursor = restored.developerBetCursor;
  await restored.collectPayouts();
  assert.equal(restored.developerBetCursor, cursor, 'retry uses saved settlements even with an empty feed');
  assert.deepEqual(Object.keys(restored.developerBets), [waiting]);
  assert.equal(await restored.balance(), 999980n);
  restored.openGame(game);
  assert.equal((await restored.gameReceipt('return'))!.payout, '10');
});
test('a game learns how its operations ended and never whose they were', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000', true);
  const replies: any[] = [],
    reply = async (value: unknown) => void replies.push(await value);
  f.bridge.onReceipt(receipt => replies.push(receipt));
  await reply(w.gameHello());
  await reply(w.gameInfo());
  await reply(w.gameAllowance());
  await reply(w.gameCasinoBet(terms('own')));
  await reply(w.gameDeveloperBet({ id: 'seat', stake: '10', meta: { seat: 1 } }));
  await f.developer.settle([{ bet: replies.at(-1).bet, player: 10n, casino: 0n }]);
  await w.collectPayouts();
  await reply(w.gamePayment({ id: 'pay', amount: '1' }));
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
  for (const r of replies)
    for (const secret of player) assert.doesNotMatch(JSON.stringify(r).toLowerCase(), new RegExp(secret));
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
  await w.setGameAllowance('100');
  const api = w.api.bind(w);
  w.api = async (...args) => {
    const result = await api(...args);
    if (args[0].endsWith('/operations')) throw new Error('lost reply');
    return result;
  };
  await assert.rejects(w.gameCasinoBet(terms('lost')), /lost reply/);
  assert.equal(w.gameAllowance().pending, true);
  const request = structuredClone(w.pending.request);
  const restored = await f.reload();
  assert.equal(restored.game, null, 'the allowance did not survive the reload');
  assert.deepEqual(restored.pending.request, request);
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
  await w.setGameAllowance('100');
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
  assert.equal(w.gameAllowance().allowance, String(100n - 10n + BigInt(receipt.payout)));
  w.closeGame();
  w.openGame(f.identity('b'));
  await w.setGameAllowance('50');
  lose = true;
  await assert.rejects(w.gameCasinoBet(terms('b')), /lost reply/);
  w.closeGame();
  const before = await w.balance();
  const settled: any = await w.exclusive(() => w.resume());
  assert.equal(await w.balance(), before - 10n + BigInt(settled.payout));
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
      return method === 'wallet.info' ? { ...value, uname: 'somebodyelse', alias: null } : value;
    },
  };
  const theirs = new RoundClient(other, createMines, undefined, { store, name: 'mines' });
  await theirs.restore();
  assert.notEqual(theirs['storageKey'], mine);
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
  assert.equal(after['storageKey'], mine);
});

for (const boundary of ['request', 'settlement'])
  test('failed ' + boundary + ' persistence stops spending and restores without duplicate settlement', async () => {
    const f = await gameWallet(),
      w = f.wallet;
    w.openGame(f.identity());
    await w.setGameAllowance('100');
    let commits = 0;
    // The signed request is saved once, and the settlement is the save after it.
    f.storage.beforeCommit = () => {
      if (++commits === (boundary === 'request' ? 1 : 2)) throw new Error('disk failed');
    };
    await assert.rejects(w.gameCasinoBet(terms()), /disk failed/);
    await assert.rejects(w.setGameAllowance('10'), /storage needs recovery/);
    f.storage.beforeCommit = null;
    const restored = await f.reload();
    if (restored.pending) await restored.exclusive(() => restored.resume());
    restored.openGame(f.identity());
    await restored.setGameAllowance('100');
    await restored.gameCasinoBet(terms());
    assert.equal(f.settlements(), 1);
  });

test('mines runs its own rules through the wallet bridge and its own storage, including reload', async () => {
  const name = 'mines',
    allowance = '100000';
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity(name));
  await w.setGameAllowance(allowance);
  const bridge = bridgeFor(w),
    store = memoryStore();
  const graph = () => createMines({ tiles: 5, mines: 1, cashouts: [1200n, 1560n, 2280n] });
  const stake = '1000';
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
    assert.equal(w.gameAllowance().allowance, String(BigInt(allowance) - BigInt(state.contributed)));
    assert.equal(
      w.gameAllowance(state.id).allowance,
      String(BigInt(allowance) - BigInt(state.contributed) + BigInt(state.cash)),
    );
    assert.equal(w.inPlay(), BigInt(state.cash));
  }
  assert.equal(state.terminal, true);
  assert.equal(await w.balance(), before - BigInt(state.contributed) + BigInt(state.cash));
  await bridge.call('game.end', { group: state.id });
  assert.equal(w.inPlay(), 0n);
  assert.equal(w.gameAllowance().allowance, String(BigInt(allowance) - BigInt(state.contributed) + BigInt(state.cash)));
  assert.equal(store.map.size, 1, 'the round lives under one key per player');
  assert.equal([...store.map.keys()][0], `hookedin:round:${name}:31337:${w.uname}`);
});

test('importing newer evidence brings the channel up to date', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('100');
  const before = await f.storage.get(w.storageKey);
  await w.gameCasinoBet(terms());
  const bundle = await w.exportEvidence();
  const restored = await f.reload();
  restored.storage = new MemoryStore();
  restored.hydrate(before);
  await restored.storage.put(w.storageKey, before);
  restored.reader = {
    channels: async () => ({ status: 1, player: f.player.address }),
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
  await w.setGameAllowance('1000');
  let loseReply = true,
    settlements = 0;
  const bridge = bridgeFor(w, async (method, params) => {
    if (method === 'game.requestAllowance') return { allowed: false, ...w.gameAllowance() };
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
  await round.start({ stake: '1000' });
  const before = await w.balance();
  await assert.rejects(round.action('double'), /Allow this game more ETH/);
  assert.equal(settlements, 0);
  assert.equal(
    JSON.parse(store.get(round['storageKey'])!).pending,
    null,
    'no ticket is drawn while the allowance is short',
  );
  await w.setGameAllowance('2000');
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
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('shortfall'));
  const requests: any[] = [];
  let approve = true;
  // The player authorizes only the stated minimum, not the suggested session amount.
  const minimum = (params: any) => String(BigInt(params.amount) - 4000n);
  const bridge = bridgeFor(w, async (method, params) => {
    if (method !== 'game.requestAllowance') return undefined;
    requests.push(params);
    if (approve) await w.setGameAllowance(String(BigInt(w.gameAllowance().allowance) + BigInt(minimum(params))));
    return { allowed: approve, ...w.gameAllowance() };
  });
  const graph = coin({ action: 'double', additionalCash: 1000n, payout: () => 3000n });
  const round = new RoundClient(bridge, graph, undefined, { store: memoryStore() });
  await round.start({ stake: '1000' });
  assert.deepEqual(requests, [{ amount: '5000' }], 'shortfall plus four stakes');
  assert.equal(w.gameAllowance().allowance, '1000');
  approve = false;
  await assert.rejects(round.action('double'), /Allow this game more ETH/);
  assert.deepEqual(requests.at(-1), { amount: '5000' });
  approve = true;
  const state = await round.action('double');
  assert.equal(state.terminal, true);
  assert.deepEqual(requests.at(-1), { amount: '5000' });
  assert.equal(requests.length, 3);
});

test('a stake the casino cannot back fails with a plain capacity message, not a pricing error', async () => {
  const bridge = {
    call: async (method: string) =>
      method === 'game.allowance'
        ? { allowance: '100000000000000000', pending: false, developerBets: false }
        : { virtualBankroll: '5000000000000000', chainId: '1' },
  };
  const round = new RoundClient(bridge, coin({ payout: stake => (stake * 19n) / 10n }), undefined, {
    store: memoryStore(),
  });
  await assert.rejects(round.start({ stake: '5000000000000000' }), /back about 0\.0025 ETH of payouts/);
  await assert.rejects(round.start({ stake: '5000000000000000' }), error => !/initialCash/.test(String(error)));
  assert.equal((await round.start({ stake: '1000000000000' })).terminal, false);
});

test('a supported plan is reused across rounds and recomputed when the bankroll falls below its bound', async () => {
  let bankroll = 1000000000n,
    builds = 0;
  const bridge = {
    call: async (method: string) =>
      method === 'game.allowance'
        ? { allowance: '10000', pending: false, developerBets: false }
        : { virtualBankroll: String(bankroll), chainId: '1' },
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
  const plan = round['plan'];
  await round.action('push');
  await round.start({ stake: '1000' });
  assert.equal(round['plan'], plan);
  await round.action('push');
  bankroll = 100000000n;
  await round.start({ stake: '1000' });
  assert.notEqual(round['plan'], plan);
  assert.equal(builds, 1, 'one setup builds its graph once per page');
});

test('a rejected game action survives a lost reply and reload without resampling or charging', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('rejection'));
  await w.setGameAllowance('1000');
  const api = w.api.bind(w),
    attempts: any[] = [];
  w.api = async (url, body: any) => {
    if (url.endsWith('/operations')) {
      if (!body.rejectionSignature) attempts.push(body.request);
      if (attempts.length === 1 && !body.rejectionSignature) {
        const state = rejectionCheckpoint(w.domain, w.channel!.state, body.request);
        return {
          status: 'rejected',
          reason: 'No quote of the casino covers this casino bet',
          request: body.request,
          state,
          operationId: body.request.operationId,
          developer: null,
          casinoSignature: '0x',
          evidence: checkpointEvidence(w.channel!.state, w.channel!.playerSignature, w.channel!.casinoSignature),
        };
      }
    }
    return api(url, body);
  };
  // The game prices the step against the virtual bankroll it was told, and the quote the wallet holds by the time it
  // signs covers none of it.
  const told = (await w.gameInfo()).virtualBankroll;
  const bridge = bridgeFor(w, async (method, params) => {
    if (method === 'wallet.info') return { ...(await w.gameInfo()), virtualBankroll: told };
    if (method !== 'game.casinoBet') return undefined;
    const receipt = await w.gameCasinoBet(params);
    if (receipt.status === 'rejected') throw new Error('reply lost');
    return receipt;
  });
  const graph = coin({ payout: () => 1900n, labels: ['win', 'loss'] });
  const store = memoryStore();
  let round = new RoundClient(bridge, graph, undefined, { store });
  await round.start({ stake: '1000' });
  // The casino's quote for the step covers nothing it bets, so the casino declines it, and the wallet takes that.
  const message = {
    channelId: w.channel!.state.channelId,
    previousStateHash: hashState(w.domain, w.channel!.state),
    round: id('a round'),
    virtualBankroll: '0',
    expiresAt: String(Math.floor(Date.now() / 1000) + QUOTE_PERIOD),
  };
  w.channel!.quote = { message, signature: await f.owner.signTypedData(w.domain, QUOTE_TYPES, message) };
  const before = await w.balance();
  await assert.rejects(round.action('roll'), /reply lost/);
  const ticket = structuredClone(round['data'].pending.ticket);
  assert.equal(w.pending, null);
  assert.equal(await w.balance(), before);
  assert.equal(w.gameAllowance().allowance, '1000');
  round = new RoundClient(bridge, graph, undefined, { store });
  const resumed = await round.restore();
  assert.equal(resumed!.events.length, 0);
  assert.equal(resumed!.terminal, false);
  assert.deepEqual(round['data'].pending.ticket, ticket, 'the rejected step is kept, under a new operation ID');
  const result = await round.action('roll');
  assert.equal(result.terminal, true);
  assert.equal(result.events.length, 1);
  for (const field of ['amount', 'chance', 'prize']) assert.deepEqual(attempts[1][field], attempts[0][field]);
  assert.notEqual(attempts[1].memo, attempts[0].memo);
  // The stub's channel has taken its deposit in at sequence 1; a declined step takes two sequences.
  assert.equal(attempts[0].sequence, '2');
  assert.equal(attempts[1].sequence, '4');
});

test('the state carries the setup its round was started with, across a reload', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('setup'));
  await w.setGameAllowance('10000');
  const store = memoryStore(),
    graph = (setup: any) => createMines({ tiles: setup.tiles, mines: 1, cashouts: [1200n, 1560n, 2280n] }),
    setup = { stake: '1000', tiles: 5 };
  assert.deepEqual((await new RoundClient(bridgeFor(w), graph, undefined, { store }).start(setup)).setup, setup);
  const reloaded = new RoundClient(bridgeFor(w), graph, undefined, { store });
  assert.deepEqual((await reloaded.restore())!.setup, setup);
});

test('a round saved with a setup the rules refuse is let go once, and the next round starts', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('setup'));
  await w.setGameAllowance('10000');
  const store = memoryStore(),
    graph = (setup: any) => createMines({ tiles: setup.tiles, mines: 1, cashouts: [1200n, 1560n, 2280n] });
  await new RoundClient(bridgeFor(w), graph, undefined, { store }).start({ stake: '1000', tiles: 5 });
  // The game's rules change so that the saved setup no longer builds a graph.
  const stricter = (setup: any) => {
    if (setup.mines === undefined) throw new RangeError('mines requires integer 0 < mines < tiles');
    return graph(setup);
  };
  const reloaded = new RoundClient(bridgeFor(w), stricter, undefined, { store });
  await assert.rejects(reloaded.restore(), /rules this game does not play/);
  assert.equal(await reloaded.restore(), null);
  assert.deepEqual((await reloaded.start({ stake: '1000', tiles: 5, mines: 1 })).setup, {
    stake: '1000',
    tiles: 5,
    mines: 1,
  });
});

test('an action sent again after its reply was lost is that step, not another from where it led', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('retry'));
  await w.setGameAllowance('10000');
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
  await round.start({ stake: '1000' });
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
  await w.setGameAllowance('10000');
  const graph = coin({ payout: () => 1900n });
  // The wallet's bridge answers a game's requests one at a time, in the order asked.
  const bridge = bridgeTo(w);
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = {
    ...bridge,
    call: (method: string, params?: any) => (turn = turn.catch(() => {}).then(() => bridge.call(method, params))),
  };
  const round = new RoundClient(inTurn, graph, undefined, { store: memoryStore() });
  await round.start({ stake: '1000' });
  const [first, second] = await Promise.allSettled([round.action('roll'), round.action('roll')]);
  assert.equal(first.status, 'fulfilled');
  assert.match(String((second as PromiseRejectedResult).reason), /Wait for the action under way/);
  assert.deepEqual([(first as PromiseFulfilledResult<any>).value.terminal, f.settlements()], [true, 1]);
});

test("the stub developer pages a game's bets 100 at a time, as the casino does", async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('1000', true);
  for (let i = 0; i < 101; i++) await w.gameDeveloperBet({ id: `bet-${i}`, stake: '1', meta: {} });
  const first = await f.developer.bets();
  assert.deepEqual([first.bets.length, first.more], [100, true]);
  const rest = await f.developer.bets({ after: first.cursor });
  assert.deepEqual([rest.bets.length, rest.more], [1, false]);
});
