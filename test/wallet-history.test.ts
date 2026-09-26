import test from 'node:test';
import assert from 'node:assert/strict';
import { id, ZeroAddress, ZeroHash } from 'ethers';
import { CasinoWallet, HISTORICAL_CHANNEL_BATCH } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';

test('historical polling stays bounded, sweeps all evidence and prioritizes reorged active channels', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.address = ZeroAddress;
  wallet.storageKey = 'historical-wallet';
  wallet.config = { contractAddress: ZeroAddress };
  wallet.recoveryOnly = true;
  wallet.reader = {} as any;
  wallet.assertNetwork = async () => {};
  const keys = Array.from({ length: 513 }, (_, i) => id('history-' + i));
  for (const key of keys)
    wallet.channels[key] = {
      opening: { deposit: '10' },
      state: { channelId: key, balance: '10', sequence: '1', index: '0', length: '1' },
      onchain: { status: 3 },
      claim: { amount: '10', paid: '10' },
    } as any;
  let active = keys.at(-1),
    reads: any[] = [],
    fail = false;
  const seen = new Set();
  wallet.observer = {
    observe: async () => ({ block: { number: 100, hash: 'canonical' } }),
    balance: async () => 1n,
    accept: async () => {},
    corroborate: async (_: any, read: any) => read({ getBlock: async () => ({ hash: 'canonical' }) }),
    contractRead: async (_: any, method: any, [key]: any) => {
      if (method === 'activeChannel') return active;
      if (fail) throw new Error('RPC unavailable');
      if (method === 'channels') {
        reads.push(key);
        seen.add(key);
        return { status: key === active ? 2 : 3, closingSequence: 0n, closingBalance: 0n, deadline: 999n };
      }
      if (method === 'allocatedWinnings') return 0n;
      if (method === 'claims') return { amount: 10n, paid: 10n, protectedRemaining: 0n, winningsRemaining: 0n };
      throw new Error(method);
    },
  } as any;
  await wallet.refresh();
  await wallet.refreshDetails();
  assert.equal(wallet.channelId, active);
  assert.equal(wallet.publicState.needsChallenge, true);
  assert.ok(reads.includes(active));
  for (let i = 0; i < Math.ceil(keys.length / HISTORICAL_CHANNEL_BATCH); i++) {
    reads = [];
    await wallet.refresh();
    await wallet.refreshDetails();
    assert.ok(reads.length <= HISTORICAL_CHANNEL_BATCH + 1);
    assert.ok(reads.includes(active));
  }
  assert.equal(seen.size, keys.length);
  reads = [];
  await wallet.refresh({ channelId: keys[400] });
  await wallet.refreshDetails();
  assert.ok(reads.includes(keys[400]));
  assert.ok(reads.length <= HISTORICAL_CHANNEL_BATCH + 2);
  active = ZeroHash;
  const cursor = wallet.monitorCursor;
  fail = true;
  await assert.rejects(wallet.refresh(), /RPC unavailable/);
  assert.equal(wallet.monitorCursor, cursor);
  assert.equal(wallet.lastChainCheck, 0);
});
