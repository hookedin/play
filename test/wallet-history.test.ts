import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { CasinoWallet, HISTORICAL_CHANNEL_BATCH } from '../client/wallet.ts';
import { channelId } from '../protocol/protocol.ts';
import { MemoryStore } from '../client/storage.ts';

test('historical polling stays bounded, sweeps all evidence and prioritizes reorged active channels', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.address = ZeroAddress;
  wallet.storageKey = 'historical-wallet';
  wallet.config = { contractAddress: ZeroAddress };
  wallet.recoveryOnly = true;
  wallet.reader = {} as any;
  wallet.assertNetwork = async () => {};
  // The account's channels, each after a close started on the one before: the last is closing, and the account's
  // current channel is the next, with nothing on-chain.
  const keys = Array.from({ length: 513 }, (_, i) => channelId(ZeroAddress, BigInt(i)));
  keys.forEach(
    (key, i) =>
      (wallet.channels[key] = {
        opening: { channelId: key, player: ZeroAddress, index: String(i) },
        state: { player: ZeroAddress, index: String(i), balance: '10', sequence: '1' },
        onchain: { status: 2 },
        claim: { amount: '10', paid: '10' },
      } as any),
  );
  let current = keys.length - 1,
    reads: any[] = [],
    fail = false;
  const seen = new Set();
  wallet.observer = {
    observe: async () => ({ block: { number: 100, hash: 'canonical' } }),
    balance: async () => 1n,
    accept: async () => {},
    corroborate: async (_: any, read: any) => read({ getBlock: async () => ({ hash: 'canonical' }) }),
    contractRead: async (_: any, method: any, args: any) => {
      if (method === 'channelIndex') return BigInt(current + 1);
      if (fail) throw new Error('RPC unavailable');
      if (method === 'channels') {
        const key = channelId(args[0], args[1]);
        reads.push(key);
        seen.add(key);
        const status = key === keys[current] ? 1 : keys.includes(key) ? 2 : 0;
        return { status, deposited: 0n, closingSequence: 0n, closingBalance: 0n, deadline: 999n };
      }
      if (method === 'collectable') return 0n;
      if (method === 'claims') return { amount: 10n, paid: 10n, protectedRemaining: 0n, winningsRemaining: 0n };
      throw new Error(method);
    },
  } as any;
  const active = keys[current];
  await wallet.refresh();
  await wallet.refreshDetails();
  assert.deepEqual([wallet.channelId, wallet.publicState.closingChannelId], [null, active]);
  assert.equal(wallet.publicState.needsChallenge, true);
  assert.ok(reads.includes(active));
  // Each round reads the current channel, the closing one and one batch of the rest.
  for (let i = 0; i < Math.ceil(keys.length / HISTORICAL_CHANNEL_BATCH); i++) {
    reads = [];
    await wallet.refresh();
    await wallet.refreshDetails();
    assert.ok(reads.length <= HISTORICAL_CHANNEL_BATCH + 2);
    assert.ok(reads.includes(active));
  }
  // Every channel the account had, and its current one.
  assert.equal(seen.size, keys.length + 1);
  reads = [];
  await wallet.refresh({ channelId: keys[400] });
  await wallet.refreshDetails();
  assert.ok(reads.includes(keys[400]));
  assert.ok(reads.length <= HISTORICAL_CHANNEL_BATCH + 3);
  current = keys.length;
  const cursor = wallet.monitorCursor;
  fail = true;
  await assert.rejects(wallet.refresh(), /RPC unavailable/);
  assert.equal(wallet.monitorCursor, cursor);
  assert.equal(wallet.lastChainCheck, 0);
});
