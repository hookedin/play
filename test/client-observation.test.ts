import test from 'node:test';
import assert from 'node:assert/strict';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();

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
