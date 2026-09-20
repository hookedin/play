import test from 'node:test';
import assert from 'node:assert/strict';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
test('confirmed transaction receipts report actual claim payment and preserve old unpaid claims', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  wallet.address = '0x1111111111111111111111111111111111111111';
  wallet.channels = {
    old: { claim: { amount: '15', paid: '10', winningsRemaining: '5' } } as any,
  };
  wallet.currentId = 'new';
  wallet.reader = {
    interface: {
      parseLog: () => ({
        name: 'ClaimPayment',
        args: { beneficiary: wallet.address, amount: 3n },
      }),
    },
  } as any;
  wallet.config = { contractAddress: '0x2222222222222222222222222222222222222222' };
  wallet.transactionIntent = { method: 'claim', value: '0', to: wallet.config.contractAddress };
  await wallet.recordTransaction({
    hash: '0xreceipt',
    status: 1,
    logs: [{ address: wallet.config.contractAddress }],
  } as any);
  assert.equal(wallet.history[0].kind, 'withdrawal');
  assert.equal(wallet.history[0].amount, '3');
  assert.equal(wallet.transactionIntent, null);
  assert.equal(wallet.channels.old.claim.winningsRemaining, '5');
  await wallet.recordTransaction({
    hash: '0xreceipt',
    status: 1,
    logs: [{ address: wallet.config.contractAddress }],
  } as any);
  assert.equal(wallet.history.length, 1);
  assert.equal((await storage.get('wallet:test')).channels.old.claim.paid, '10');
});
test('durable wallet state survives reload and refuses signing after persistence failure', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  wallet.currentId = 'channel';
  // A funded account: it plays on its on-chain channel.
  wallet.channels.channel = { key: 'unused', onchain: { status: '1' } } as any;
  wallet.pending = { request: { operationId: 'saved' }, signature: 'signed' };
  await wallet.save();
  const next = new CasinoWallet({ network: 'local', storage });
  next.hydrate(await storage.get(wallet.storageKey));
  assert.deepEqual(next.pending, wallet.pending);
  storage.beforeCommit = () => {
    throw new Error('storage full');
  };
  await assert.rejects(wallet.save(), /storage full/);
  await assert.rejects(
    wallet.exclusive(() => {
      throw new Error('must not execute');
    }),
    /storage needs recovery/,
  );
  assert.equal((await storage.get(wallet.storageKey)).channels.channel.pending.signature, 'signed');
});
test('a replaced injected transaction cannot be reported as a channel deposit', async () => {
  const wallet = new CasinoWallet({
    network: 'local',
    storage: new MemoryStore(),
  });
  wallet.config = { confirmations: 1 };
  wallet.storageKey = 'wallet';
  wallet.render = (() => {}) as any;
  wallet.assertNetwork = async () => {};
  wallet.transactionIntent = {
    hash: '0xtransaction',
    method: 'openChannel',
    value: '10',
    to: '0xcasino',
    data: '0x1234',
  };
  wallet.provider = {
    getTransactionReceipt: async () => ({ status: 1, hash: '0xtransaction', blockHash: 'block', blockNumber: 1 }),
    getBlock: async () => ({ number: 1, hash: 'block' }),
    waitForTransaction: async () => ({ status: 1, hash: '0xtransaction' }),
    getTransaction: async () => ({ to: '0xself', data: '0x', value: 0n }),
  } as any;
  await assert.rejects(wallet.recoverTransaction(), /replaced/);
  assert.equal(wallet.transactionIntent, null);
  assert.equal(wallet.history.length, 1);
  assert.equal(wallet.history[0].status, 'replaced');
  assert.equal(wallet.history[0].amount, '0');
});
