import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, id, ZeroAddress } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { gameRef } from '../client/bridge.ts';
import { channelId, gameKey } from '../protocol/protocol.ts';
import type { GameIdentity } from '../protocol/game-types.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();
const DEVELOPER = getAddress('0x00000000000000000000000000000000000000d0');
/** A game its developer published under `name`. */
const testGame = (name = 'test-game'): GameIdentity => ({
  name,
  slug: name,
  url: `https://${name}.example/`,
  developer: DEVELOPER,
  key: gameKey({ developer: DEVELOPER, name }).toLowerCase(),
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
    const input = { stake: 10n, chance: 123n, prize: 30n };
    const operation = { kind: 1, amount: '10', recipient: ZeroAddress, fee: '0', chance: '123', prize: '30' };
    const details = { id: id('operation'), game: gameRef(testGame()) };
    const receipt = { operationId: 'operation', details, proof: { step: { operation } } };
    if (location === 'cached') await storage.put('wallet:receipt:operation', receipt);
    else {
      wallet.channelId = 'channel';
      wallet.channels.channel = {
        key: 'unused',
        onchain: { status: '0', deposited: '10', principal: '10', claimed: '0' },
        pending: { operationId: 'operation', request: operation, details },
      } as any;
      wallet.resume = (async () => receipt) as any;
    }
    // Every term is part of the intent: the stake, the chance and the prize.
    for (const changed of [{ stake: 11n }, { chance: 124n }, { prize: 31n }])
      await assert.rejects(wallet.executeCasinoBet({ ...input, ...changed }, 'operation'), /different intent/);
    await assert.rejects(wallet.payBankroll(10n, 'operation'), /different intent/);
    // The game is part of the intent too: the same terms in another game are another bet.
    wallet.openGame(testGame('another-game'));
    await assert.rejects(wallet.executeCasinoBet(input, 'operation'), /different intent/);
    wallet.openGame(testGame());
    assert.equal((await wallet.executeCasinoBet(input, 'operation')).operationId, 'operation');
  });

test('payment retries reject changed amounts and explicit receipt lookup needs no execution terms', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet';
  wallet.openGame(testGame());
  const receipt = {
    operationId: 'payment',
    amount: '1',
    details: { id: id('payment'), game: gameRef(testGame()) },
    proof: { step: { operation: { kind: 2, amount: '1', recipient: ZeroAddress, fee: '0', chance: '0', prize: '0' } } },
  };
  await storage.put('wallet:receipt:payment', receipt);
  assert.deepEqual(await wallet.getReceipt('payment'), receipt);
  await assert.rejects(wallet.payBankroll(999n, 'payment'), /different intent/);
  assert.equal((await wallet.payBankroll(1n, 'payment')).amount, '1');
});

/** The account's first channel, the one these observations are of. */
const ACTIVE = channelId(ZeroAddress, 0);
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
    state: {
      player: ZeroAddress,
      balance: '10',
      deposited: '10',
      withdrawn: '0',
      sequence: '1',
      index: '0',
      length: '1',
    },
    opening: { channelId: ACTIVE, player: ZeroAddress, index: '0' },
    onchain: { status: '0', deposited: '10', principal: '10', collateral: '0', claimed: '0' },
  } as any;
  const block = { number: 10, hash: id('block') };
  wallet.observer = {
    observe: async () => ({ block }),
    balance: async () => 1n,
    accept: async () => {},
    corroborate: async (_: any, read: any) => read({ getBlock: async () => block }),
    contractRead: async (_: any, method: any) =>
      method === 'channelIndex'
        ? 0n
        : { status: 1n, deposited: 10n, closingSequence: 0n, closingBalance: 0n, deadline: 1000n },
  } as any;
  return wallet;
}
/** Another channel of the account, known by `key`, as the wallet's own is. */
const elsewhere = (wallet: CasinoWallet, key: string) => ({
  ...structuredClone(wallet.channel!),
  opening: { channelId: key, player: ZeroAddress, index: key },
});

test('an unchanged background observation does not bump the revision another tab acts on', async () => {
  const storage = new MemoryStore(),
    a = observingWallet(storage),
    b = observingWallet(storage);
  await a.refresh();
  await a.detailsRefreshing;
  assert.equal(a.channel!.onchain.status, '1', 'the first observation is saved');
  b.hydrate(await storage.get(a.storageKey));
  const revision = a.revision;
  await a.refresh();
  await a.detailsRefreshing;
  assert.equal(a.revision, revision);
  assert.ok(a.lastChainCheck);
  await b.exclusive(async () => {});
  (a.observer as any).contractRead = async (_: any, method: any) =>
    method === 'channelIndex'
      ? 0n
      : {
          status: 2n,
          deposited: 10n,
          closingSequence: 0n,
          closingBalance: 0n,
          deadline: 1000n,
          protectedRemaining: 0n,
          winningsRemaining: 0n,
        };
  await a.refresh();
  await a.detailsRefreshing;
  assert.equal(a.revision, revision + 1, 'a changed observation is saved');
  await assert.rejects(
    b.exclusive(async () => {}),
    /changed in another tab/,
  );
});

test('slow historical refresh merges across active polls without reverting newer records or another tab', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old');
  wallet.channels.newer = elsewhere(wallet, 'newer');
  wallet.history = [{ operationId: 'unchanged' }, { operationId: 'edited', status: 'old' }];
  await wallet.save();
  const gate = deferred(),
    entered = deferred();
  wallet.observeTransactionHistory = async () => {
    entered.resolve!();
    await gate.promise;
    return [
      { operationId: 'unchanged', status: 'checked' },
      { operationId: 'edited', status: 'outdated' },
    ];
  };
  const details = wallet.refreshDetails();
  await entered.promise;
  // Real active refreshes save a new revision while optional history is reading.
  await wallet.refresh();
  await wallet.refresh();
  const saved = await wallet.storage.get(wallet.storageKey);
  saved.channels.newer.onchain.status = '2';
  saved.history = [{ operationId: 'new' }, { operationId: 'unchanged' }, { operationId: 'edited', status: 'newer' }];
  saved.revision++;
  await wallet.storage.put(wallet.storageKey, saved);
  gate.resolve!();
  await details;
  const result = await wallet.storage.get(wallet.storageKey);
  assert.equal(result.channels.old.onchain.status, '1');
  assert.equal(result.channels.newer.onchain.status, '2');
  assert.deepEqual(result.history, [
    { operationId: 'new' },
    { operationId: 'unchanged', status: 'checked' },
    { operationId: 'edited', status: 'newer' },
  ]);
  assert.ok(wallet.detailsObservedAt);
});

test('historical results commit, and an account change discards late results', async () => {
  const wallet = observingWallet();
  wallet.channels.old = elsewhere(wallet, 'old');
  await wallet.save();
  await wallet.refreshDetails();
  assert.equal((await wallet.storage.get(wallet.storageKey)).channels.old.onchain.status, '1');
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
  wallet.revision = 0;
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
  wallet.channels.old = elsewhere(wallet, 'old');
  const read = wallet.observer.contractRead;
  wallet.observer.contractRead = (...args) =>
    args[2][1] === 'old' ? Promise.reject(new Error('old claim unavailable')) : read(...args);
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
  }));
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
  wallet.channels.old = elsewhere(wallet, 'old');
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
  const protection = (state: any, onchain: any, withdrawals: [amount: string, base: any][] = []) => {
    c.state = { ...c.state, ...state };
    c.onchain = { ...c.onchain, ...onchain };
    wallet.history = withdrawals.map(([amount, base], i) => ({
      withdrawal: id('withdrawal ' + i),
      proof: { base: { player: ZeroAddress, index: '0', ...base }, step: { operation: { amount } } },
    }));
    const { covered, uncovered, missing, spare } = wallet.render().protection;
    return [covered, uncovered, missing, spare].map(Number);
  };
  // 100 deposited, 100 of collateral bought, 50 withdrawn and not recorded: they pay it out of the deposits first.
  const fifty: [string, any][] = [['50', { withdrawn: '0', deposited: '100' }]];
  let onchain = { deposited: '100', principal: '100', collateral: '100', claimed: '0' };
  assert.deepEqual(protection({ balance: '50', deposited: '100', withdrawn: '50' }, onchain, fifty), [50, 0, 0, 100]);
  // Won up to 200: 150 is left to protect it, and it stays so once the withdrawal is recorded.
  assert.deepEqual(protection({ balance: '200' }, onchain, fifty), [150, 50, 0, 0]);
  assert.deepEqual(protection({}, { principal: '50', claimed: '50' }, fifty), [150, 50, 0, 0]);
  // 100 deposited and 200 won, 250 withdrawn and not recorded, then 100 more deposited and taken in: the withdrawal is
  // paid out of only the 100 its checkpoint took in, and the later deposit stays protected.
  const late: [string, any][] = [['250', { withdrawn: '0', deposited: '100' }]];
  onchain = { deposited: '200', principal: '200', collateral: '0', claimed: '0' };
  assert.deepEqual(protection({ balance: '150', deposited: '200', withdrawn: '250' }, onchain, late), [100, 50, 0, 0]);
  // Made on another device, its proof is not here: it is taken to draw on every deposit.
  assert.deepEqual(protection({}, onchain), [0, 150, 0, 0]);
  // A deposit the balance took in that a reorganisation took off the chain is shown apart, never as protected.
  onchain = { deposited: '1', principal: '1', collateral: '0', claimed: '0' };
  assert.deepEqual(protection({ balance: '101', deposited: '101', withdrawn: '0' }, onchain), [1, 0, 100, 0]);
});
