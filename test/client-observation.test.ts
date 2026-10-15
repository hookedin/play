import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, id, ZeroAddress } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { gameRef } from '../client/bridge.ts';
import { UNTOUCHED_CHANNEL, baseState, channelId, urlGameId } from '../protocol/protocol.ts';
import type { GameIdentity } from '../protocol/game-types.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();
const DEVELOPER = getAddress('0x00000000000000000000000000000000000000d0');
/** A game its developer published under `name`. */
const testGame = (name = 'test-game'): GameIdentity => ({
  name,
  slug: name,
  url: `https://${name}.example/`,
  developer: DEVELOPER,
  id: urlGameId(`published ${name}`),
});

test('an operation waits for its own background observation and overlapping refreshes share one read', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.storageKey = 'observation-test';
  wallet.render = (() => {}) as any;
  const gate = deferred(),
    entered = deferred();
  let reads = 0,
    executed = false;
  wallet.refreshLocked = async () => {
    reads++;
    entered.resolve!();
    await gate.promise;
    return wallet.publicState;
  };
  const background = wallet.refresh();
  await entered.promise;
  const secondRefresh = wallet.refresh();
  const operation = wallet.exclusive(() => {
    executed = true;
    return 'completed';
  });
  await new Promise(setImmediate);
  assert.equal(executed, false);
  assert.equal(reads, 1);
  gate.resolve!();
  await Promise.all([background, secondRefresh]);
  assert.equal(await operation, 'completed');
  assert.equal(wallet.refreshing, null);
  assert.equal(wallet.busy, false);
});

test('failed observations invalidate admission freshness and release the observation lock', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.storageKey = 'failed-observation';
  wallet.lastChainCheck = Date.now();
  wallet.refreshLocked = async () => {
    throw new Error('witness unavailable');
  };
  await assert.rejects(wallet.refresh(), /witness unavailable/);
  assert.equal(wallet.lastChainCheck, 0);
  assert.equal(wallet.refreshing, null);
});

for (const location of ['cached', 'pending'])
  test('exact retry intent is checked for ' + location + ' operations', async () => {
    const storage = new MemoryStore(),
      wallet = new CasinoWallet({ network: 'local', storage });
    wallet.storageKey = 'wallet';
    wallet.ready = async () => {};
    wallet.render = (() => {}) as any;
    wallet.openGame(testGame());
    const results = (weight: bigint, cash: bigint) => [
        { weight, cash },
        { weight: 1000n - weight, cash: 0n },
      ],
      input = { cash: 10n, results: results(123n, 30n) },
      play = (step: typeof input) => wallet.playStep(step, 'operation', wallet.gameIntent('operation'));
    const operation = { kind: 1n, amount: 10n, recipient: ZeroAddress, fee: 0n, chance: 123n, prize: 30n };
    const details = { id: id('operation'), game: gameRef(testGame()), table: { ...input, bankroll: 5000n } },
      game = wallet.gameIntent('operation');
    const receipt = { operationId: 'operation', game, details, proof: { step: { operation } } };
    if (location === 'cached') await storage.put('wallet:receipt:operation', receipt);
    else {
      wallet.channelId = 'channel';
      wallet.channels.channel = {
        key: 'unused',
        onchain: { status: 0n, deposited: 10n, principal: 10n, claimed: 0n },
        pending: { operationId: 'operation', request: operation, details, game },
      } as any;
      wallet.resume = (async () => receipt) as any;
    }
    // Every term of the step is part of the intent: its cash, and each result's weight and cash.
    for (const changed of [{ cash: 11n }, { results: results(124n, 30n) }, { results: results(123n, 31n) }])
      await assert.rejects(play({ ...input, ...changed }), /different intent/);
    await assert.rejects(wallet.payBankroll(10n, 'operation'), /different intent/);
    // The game is part of the intent too: the same step in another game is another bet.
    wallet.openGame(testGame('another-game'));
    await assert.rejects(play(input), /different intent/);
    wallet.openGame(testGame());
    assert.equal((await play(input)).operationId, 'operation');
  });

test('payment retries reject changed amounts and explicit receipt lookup needs no execution terms', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet';
  wallet.openGame(testGame());
  const receipt = {
    operationId: 'payment',
    amount: 1n,
    details: { id: id('payment'), game: gameRef(testGame()) },
    proof: { step: { operation: { kind: 2n, amount: 1n, recipient: ZeroAddress, fee: 0n, chance: 0n, prize: 0n } } },
  };
  await storage.put('wallet:receipt:payment', receipt);
  assert.deepEqual(await wallet.getReceipt('payment'), receipt);
  await assert.rejects(wallet.payBankroll(999n, 'payment'), /different intent/);
  assert.equal((await wallet.payBankroll(1n, 'payment')).amount, 1n);
});

/** The account's first channel, the one these observations are of. */
const ACTIVE = channelId(ZeroAddress, 0n);
function observingWallet(storage = new MemoryStore()) {
  const wallet = new CasinoWallet({ network: 'local', storage });
  wallet.openGame(testGame());
  Object.assign(wallet, {
    storageKey: 'wallet',
    address: ZeroAddress,
    reader: {},
    recoveryOnly: true,
    config: {},
    assertNetwork: async () => {},
    channelId: ACTIVE,
  });
  wallet.channels[ACTIVE] = {
    state: { ...baseState(ZeroAddress, 0n), balance: 10n, deposited: 10n, sequence: 1n },
    opening: { channelId: ACTIVE, player: ZeroAddress, index: 0n },
    onchain: { ...UNTOUCHED_CHANNEL, deposited: 10n, principal: 10n },
    playerSignature: '0x',
    casinoSignature: '0x',
  };
  const block = { number: 10, hash: id('block') };
  wallet.observer = {
    observe: async () => ({ block }),
    balance: async () => 1n,
    accept: async () => {},
    requireCanonical: async () => {},
    corroborate: async (_: any, read: any) => read({ getBlock: async () => block }),
    contractRead: async (_: any, method: any) =>
      method === 'channelIndex' ? 0n : { ...UNTOUCHED_CHANNEL, status: 1n, deposited: 10n, deadline: 1000n },
  } as any;
  return wallet;
}
/** Another channel of the account, known by `key`, as the wallet's own is. */
const elsewhere = (wallet: CasinoWallet, key: string, index: bigint) => ({
  ...structuredClone(wallet.channel!),
  opening: { channelId: key, player: ZeroAddress, index },
});

test('slow historical refresh merges across active polls without reverting newer records', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old', 1n);
  wallet.channels.newer = elsewhere(wallet, 'newer', 2n);
  wallet.history = [{ operationId: 'unchanged' }, { operationId: 'edited', status: 'old' }] as any;
  await wallet.save();
  const gate = deferred(),
    entered = deferred();
  wallet.observeTransactionHistory = async () => {
    entered.resolve!();
    await gate.promise;
    return [
      { operationId: 'unchanged', status: 'checked' },
      { operationId: 'edited', status: 'outdated' },
    ] as any;
  };
  const details = wallet.refreshDetails();
  await entered.promise;
  // Active refreshes change the record while optional history is reading.
  await wallet.refresh();
  await wallet.refresh();
  wallet.channels.newer.onchain!.status = 2n;
  wallet.history = [
    { operationId: 'new' },
    { operationId: 'unchanged' },
    { operationId: 'edited', status: 'newer' },
  ] as any;
  gate.resolve!();
  await details;
  const result = await wallet.storage.get(wallet.storageKey);
  assert.equal(result.channels.old.onchain.status, 1n);
  assert.equal(result.channels.newer.onchain.status, 2n);
  assert.deepEqual(result.history, [
    { operationId: 'new' },
    { operationId: 'unchanged', status: 'checked' },
    { operationId: 'edited', status: 'newer' },
  ]);
  assert.ok(wallet.detailsObservedAt);
});

test('historical results commit, and an account change discards late results', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old', 1n);
  await wallet.save();
  await wallet.refreshDetails();
  assert.equal((await wallet.storage.get(wallet.storageKey)).channels.old.onchain.status, 1n);
  assert.ok(wallet.detailsObservedAt);
  const read = deferred(),
    entered = deferred();
  wallet.observeTransactionHistory = async () => {
    entered.resolve!();
    await read.promise;
    return [];
  };
  const stale = wallet.refreshDetails();
  await entered.promise;
  wallet.storageKey = 'another-account';
  wallet.channels = {};
  wallet.history = [];
  await wallet.save();
  read.resolve!();
  await stale;
  assert.deepEqual((await wallet.storage.get(wallet.storageKey)).channels, {});
});

test('a stalled activity refresh cannot block a challenge or overwrite it', async () => {
  const wallet = observingWallet(),
    read = deferred(),
    started = deferred();
  wallet.observeTransactionHistory = (() => {
    started.resolve!();
    return read.promise;
  }) as any;
  await wallet.refresh();
  await started.promise;
  assert.equal(wallet.refreshing, null);
  assert.equal(wallet.publicState.needsChallenge, true);
  let sent = false;
  wallet.evidence = (() => ({})) as any;
  wallet.sendTransaction = (async (method: string) => {
    assert.equal(method, 'challengeClose');
    sent = true;
    await wallet.save(null, { history: [{ operationId: 'new activity' }] });
    return { hash: 'challenge' };
  }) as any;
  wallet.waitTransaction = (async () => {}) as any;
  assert.equal(await wallet.challengeClose(), 'challenge');
  assert.equal(sent, true);
  read.reject!(new Error('optional endpoint failed'));
  await wallet.detailsRefreshing;
  assert.equal(wallet.history[0].operationId, 'new activity');
  assert.equal(wallet.storageFailed, undefined);
});

test('optional failures leave active recovery fresh, label details stale, and bound activity RPCs', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old', 1n);
  const read = wallet.observer.contractRead;
  wallet.observer.contractRead = (...args) =>
    args[2][1] === 1n ? Promise.reject(new Error('old claim unavailable')) : read(...args);
  await wallet.refresh();
  await wallet.refreshDetails();
  assert.match(wallet.detailsError as any, /old claim unavailable/);
  assert.ok(wallet.lastChainCheck);
  assert.equal(wallet.publicState.needsChallenge, true);
  let concurrent = 0,
    maximum = 0;
  wallet.history = Array.from({ length: 100 }, (_, i) => ({
    txHash: id('tx' + i),
    blockNumber: i,
    blockHash: id('block' + i),
    status: 'confirmed',
  })) as any;
  let call = 0;
  wallet.observer.corroborate = (async () => {
    const i = call++;
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await new Promise(setImmediate);
    concurrent--;
    return id('block' + i);
  }) as any;
  assert.equal((await wallet.observeTransactionHistory({ number: 100 } as any)).length, 100);
  assert.ok(maximum <= 8);
  assert.equal(call, 100);
});

test('an action waits for the optional storage commit without being rejected as busy', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old', 1n);
  await wallet.save();
  const write = deferred(),
    started = deferred();
  const commit = wallet.storage.commit.bind(wallet.storage);
  wallet.storage.commit = async entries => {
    started.resolve!();
    await write.promise;
    return commit(entries);
  };
  const details = wallet.refreshDetails();
  await started.promise;
  let ran = false;
  const action = wallet.exclusive(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  write.resolve!();
  await Promise.all([details, action]);
  assert.equal(ran, true);
});

test("the balance's protection follows the contract's rule for the withdrawals it has not recorded yet", () => {
  const wallet = observingWallet(),
    c = wallet.channel!;
  /** What the balance shows as covered, uncovered, missing and spare, with the channel's checkpoint and on-chain record
   * and the withdrawals this browser made. */
  const protection = (state: any, onchain: any, withdrawals: [amount: bigint, base: any][] = []) => {
    c.state = { ...c.state, ...state };
    c.onchain = { ...c.onchain!, ...onchain };
    wallet.history = withdrawals.map(([amount, base], i) => ({
      withdrawal: id('withdrawal ' + i),
      proof: { base: { player: ZeroAddress, index: 0n, ...base }, step: { operation: { amount } } },
    })) as any;
    const { covered, uncovered, missing, spare } = wallet.render().protection!;
    return [covered, uncovered, missing, spare].map(Number);
  };
  // 100 deposited, 100 of collateral bought, 50 withdrawn and not recorded: they pay it out of the deposits first.
  const fifty: [bigint, any][] = [[50n, { withdrawn: 0n, deposited: 100n }]];
  let onchain = { deposited: 100n, principal: 100n, collateral: 100n, claimed: 0n };
  assert.deepEqual(protection({ balance: 50n, deposited: 100n, withdrawn: 50n }, onchain, fifty), [50, 0, 0, 100]);
  // Won up to 200: 150 is left to protect it, and it stays so once the withdrawal is recorded.
  assert.deepEqual(protection({ balance: 200n }, onchain, fifty), [150, 50, 0, 0]);
  assert.deepEqual(protection({}, { principal: 50n, claimed: 50n }, fifty), [150, 50, 0, 0]);
  // 100 deposited and 200 won, 250 withdrawn and not recorded, then 100 more deposited and taken in: the withdrawal is
  // paid out of only the 100 its checkpoint took in, and the later deposit stays protected.
  const late: [bigint, any][] = [[250n, { withdrawn: 0n, deposited: 100n }]];
  onchain = { deposited: 200n, principal: 200n, collateral: 0n, claimed: 0n };
  assert.deepEqual(protection({ balance: 150n, deposited: 200n, withdrawn: 250n }, onchain, late), [100, 50, 0, 0]);
  // Made on another device, its proof is not here: it is taken to draw on every deposit.
  assert.deepEqual(protection({}, onchain), [0, 150, 0, 0]);
  // A deposit the balance took in that a reorganisation took off the chain is shown apart, never as protected.
  onchain = { deposited: 1n, principal: 1n, collateral: 0n, claimed: 0n };
  assert.deepEqual(protection({ balance: 101n, deposited: 101n, withdrawn: 0n }, onchain), [1, 0, 100, 0]);
});
