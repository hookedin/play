import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
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
  wallet.channelId = 'new';
  wallet.reader = {
    interface: {
      parseLog: () => ({
        name: 'ClaimPayment',
        args: { recipient: wallet.address, amount: 3n },
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
  wallet.channelId = 'channel';
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
test('a replaced transaction cannot be reported as a channel deposit', async () => {
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
test('past the newest 100 receipts, a withdrawal or a lock-in stays until it is paid or returned', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  await wallet.save({ kind: 'withdrawal', operationId: 'owed', withdrawal: '0xaa', paid: false, createdAt: at(0) });
  await wallet.save({ kind: 'lock-in', operationId: 'locking in', withdrawal: '0xbb', paid: false, createdAt: at(1) });
  await wallet.save({ kind: 'withdrawal', operationId: 'paid', withdrawal: '0xcc', paid: true, createdAt: at(2) });
  for (let i = 0; i < 100; i++)
    await wallet.save({ kind: 'payment', operationId: 'payment ' + i, createdAt: at(10 + i) });
  assert.deepEqual(
    wallet.history.slice(100).map(r => r.operationId),
    ['locking in', 'owed'],
  );
  wallet.history = wallet.history.map(r => (r.withdrawal ? { ...r, paid: true } : r));
  await wallet.save({ kind: 'payment', operationId: 'payment 100', createdAt: at(110) });
  assert.equal(wallet.history.length, 100);
});
test('a withdrawal is read again when its claim is taken back, or the block that read it paid leaves the chain', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  const account = '0x1111111111111111111111111111111111111111',
    first = '0x5555555555555555555555555555555555555555',
    elsewhere = '0x6666666666666666666666666666666666666666';
  let claim = { beneficiary: account, recipient: first, protectedRemaining: 0n, winningsRemaining: 500n },
    status = 1,
    chain: Record<number, string> = {};
  wallet.observer = {
    contractRead: async (_: unknown, method: string) =>
      method === 'claims' ? claim : method === 'channels' ? { status } : 0n,
    corroborate: async (_: string, read: any) => read({ getBlock: async (n: number) => ({ hash: chain[n] }) }),
  } as any;
  wallet.reader = { filters: { Withdrawal: () => ({}) }, queryFilter: async () => [] } as any;
  const sent = {
    kind: 'withdrawal',
    operationId: 'sent',
    withdrawal: '0xaa',
    amount: '1500',
    to: first,
    paid: false,
    proof: { base: { channelId: 'channel' }, step: { operation: { channelId: 'channel', recipient: first } } },
  };
  const observe = async (number: number, entry: any) => {
    chain[number] = '0x' + number;
    return (await wallet.observeTransactionHistory({ number, hash: '0x' + number } as any, [entry]))[0];
  };
  const recorded = await observe(10, sent);
  assert.deepEqual([recorded.recorded, recorded.owed, recorded.paid, recorded.to], [true, '500', false, first]);
  // Its account redirected it: it pays elsewhere from now on.
  claim = { ...claim, recipient: elsewhere };
  assert.equal((await observe(11, recorded)).to, elsewhere);
  // A reorganisation took the claim back: nothing read of it stands, and it can be sent again.
  claim = { ...claim, beneficiary: ZeroAddress, recipient: ZeroAddress };
  assert.deepEqual(await observe(12, recorded), sent);
  // Recorded again and paid in full at once, which keeps no recipient: read paid at block 13, and not read again while
  // that block stands.
  claim = { ...claim, beneficiary: account, winningsRemaining: 0n };
  const paid = await observe(13, sent);
  assert.deepEqual([paid.paid, paid.to, paid.settledAt], [true, first, { number: 13, hash: '0x13' }]);
  claim = { ...claim, recipient: first, winningsRemaining: 500n };
  assert.equal(await observe(14, paid), paid);
  // The payment left the chain with block 13: the claim is owed 500 again.
  chain[13] = '0xother';
  const owed = await observe(15, paid);
  assert.deepEqual([owed.paid, owed.owed, owed.settledAt], [false, '500', undefined]);
  // Not recorded by the time its channel's close is final: the close returned it.
  claim = { ...claim, beneficiary: ZeroAddress, recipient: ZeroAddress };
  status = 3;
  const returned = await observe(16, owed);
  assert.deepEqual(
    [returned.returned, returned.recorded, returned.settledAt],
    [true, undefined, { number: 16, hash: '0x16' }],
  );
});
