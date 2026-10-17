import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, ZeroAddress } from 'ethers';
import { CasinoWallet, type WalletChannel } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { baseState, channelId } from '../protocol/protocol.ts';

/** The account's first channel at its base, with `changes`. */
const channel = (player: string, changes: Partial<WalletChannel> = {}): WalletChannel => ({
  opening: { channelId: channelId(player, 0n), player, index: 0n },
  state: baseState(player, 0n),
  playerSignature: '0x',
  casinoSignature: '0x',
  onchain: null,
  ...changes,
});
test('confirmed transaction receipts report actual claim payment and preserve old unpaid claims', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  wallet.address = '0x1111111111111111111111111111111111111111';
  wallet.channels = {
    old: channel(wallet.address, { claim: { amount: 15n, paid: 10n, winningsRemaining: 5n } as any }),
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
  wallet.transactionIntent = { method: 'claim', value: 0n, to: wallet.config.contractAddress } as any;
  await wallet.recordTransaction({
    hash: '0xreceipt',
    status: 1,
    logs: [{ address: wallet.config.contractAddress }],
  } as any);
  assert.equal(wallet.history[0].kind, 'withdrawal');
  assert.equal(wallet.history[0].amount, 3n);
  assert.equal(wallet.transactionIntent, null);
  assert.equal(wallet.channels.old.claim!.winningsRemaining, 5n);
  await wallet.recordTransaction({
    hash: '0xreceipt',
    status: 1,
    logs: [{ address: wallet.config.contractAddress }],
  } as any);
  assert.equal(wallet.history.length, 1);
  assert.equal((await storage.get('wallet:test')).channels.old.claim.paid, 10n);
});
test('an account whose saved state is not in its one form opens with nothing, saying to start over', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage }),
    key = Wallet.createRandom(),
    contractAddress = '0x2222222222222222222222222222222222222222';
  wallet.config = { contractAddress };
  // A record whose amounts are decimal strings, as JSON holds them: the wallet keeps bigints.
  const state = baseState(key.address, 0n),
    saved = {
      schema: 'HOOKEDIN/WALLET-STATE/1',
      channels: {
        [channelId(key.address, 0n)]: {
          ...channel(key.address),
          state: { ...state, index: '0', sequence: '0', balance: '0', deposited: '0', withdrawn: '0' },
        },
      },
      fund: { sequence: 0n, shares: 0n, statement: null },
    };
  await storage.put(`wallet:31337:${contractAddress}:${key.address.toLowerCase()}`, saved);
  await assert.rejects(wallet.useKey(key.privateKey), {
    code: 'unreadable-state',
    message:
      "This browser's saved wallet data can't be read. Use Start over in Settings, then sign in again with your passkey or key file.",
  });
  // The account is there, with nothing loaded: the page still renders, and Start over finds the account to delete.
  assert.deepEqual([wallet.savedAddresses, wallet.guest, wallet.busy], [[key.address], false, false]);
  assert.deepEqual([wallet.channels, wallet.publicState.balance], [{}, 0n]);
  // Nothing writes over the record it could not read.
  await assert.rejects(wallet.save(), /reload from durable state/);
  assert.deepEqual(await storage.get(`wallet:31337:${contractAddress}:${key.address.toLowerCase()}`), saved);
  // Each part of the record is held to its one form.
  for (const changes of [
    { fund: { sequence: 0, shares: '0', statement: null } },
    { atAddress: '5' },
    { transactionIntent: { value: '0' } },
    { channels: { [channelId(key.address, 0n)]: { ...channel(key.address), opening: { index: '0' } } } },
  ])
    assert.throws(() => wallet.hydrate({ ...saved, channels: {}, ...changes }), { code: 'unreadable-state' });
  wallet.hydrate({ ...saved, channels: { [channelId(key.address, 0n)]: channel(key.address) } });
});
test('durable wallet state survives reload, and a failed write latches a waiting action, a save, a refresh and a send', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  wallet.channelId = 'channel';
  // A funded account: it plays on its channel.
  wallet.channels.channel = channel(ZeroAddress);
  wallet.pending = { request: { operationId: 'saved' }, signature: 'signed' } as any;
  await wallet.save();
  const next = new CasinoWallet({ network: 'local', storage });
  next.hydrate(await storage.get(wallet.storageKey));
  assert.deepEqual(next.pending, wallet.pending);
  // A background write fails while an action waits for it.
  const write = Promise.withResolvers<void>(),
    commit = storage.commit;
  storage.commit = () => write.promise;
  wallet.refreshing = wallet.save();
  let ran = false;
  const action = wallet.exclusive(async () => {
    ran = true;
  });
  write.reject(new Error('disk unavailable'));
  await assert.rejects(action, /reload from durable state/);
  assert.deepEqual([ran, wallet.storageFailed], [false, true]);
  storage.commit = () => assert.fail('a latched wallet must not write');
  for (const attempt of [
    () => wallet.save(),
    () => wallet.refresh(),
    () => wallet.sendTransaction('claim'),
    () => wallet.recoverTransaction(),
    () => wallet.useKey(''),
  ])
    await assert.rejects(attempt(), /reload from durable state/);
  storage.commit = commit;
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
    value: 10n,
    to: '0xcasino',
    data: '0x1234',
  } as any;
  wallet.provider = {
    getTransactionReceipt: async () => ({ status: 1, hash: '0xtransaction', blockHash: 'block', blockNumber: 1 }),
    getBlock: async () => ({ number: 1, hash: 'block' }),
    waitForTransaction: async () => ({ status: 1, hash: '0xtransaction' }),
    getTransaction: async () => ({ to: '0xself', data: '0x', value: 0n }),
  } as any;
  wallet.observer = {
    receipt: (hash: string) => wallet.provider.getTransactionReceipt(hash),
    corroborate: (_: string, read: any) => read(wallet.provider),
  } as any;
  await assert.rejects(wallet.recoverTransaction(), /replaced/);
  assert.equal(wallet.transactionIntent, null);
  assert.equal(wallet.history.length, 1);
  assert.equal(wallet.history[0].status, 'replaced');
  assert.equal(wallet.history[0].amount, 0n);
});
test('a confirmation the witness disputes keeps the saved transaction and records nothing', async () => {
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  Object.assign(wallet, { config: { confirmations: 2 }, storageKey: 'confirmation', render: () => {} });
  wallet.transactionIntent = {
    method: 'challengeClose',
    value: 0n,
    raw: 'signed transaction',
    hash: '0xclaimed',
  } as any;
  await wallet.save();
  wallet.observer = {
    receipt: async () => {
      throw new Error('Independent RPC transaction receipts disagree');
    },
  } as any;
  await assert.rejects(
    wallet.waitTransaction({ wait: async () => ({ hash: '0xclaimed', status: 1, logs: [] }) } as any),
    /disagree/,
  );
  assert.equal((await storage.get(wallet.storageKey)).transactionIntent.raw, 'signed transaction');
  assert.deepEqual([wallet.history, wallet.lastChainCheck], [[], 0]);
});
test('past the newest 100 receipts, a withdrawal or a lock-in stays until it is paid or returned', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  wallet.storageKey = 'wallet:test';
  wallet.render = (() => {}) as any;
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const status = 'signed';
  await wallet.save({
    kind: 'withdrawal',
    operationId: 'owed',
    status,
    withdrawal: '0xaa',
    paid: false,
    createdAt: at(0),
  });
  await wallet.save({
    kind: 'lock-in',
    operationId: 'locking in',
    status,
    withdrawal: '0xbb',
    paid: false,
    createdAt: at(1),
  });
  await wallet.save({
    kind: 'withdrawal',
    operationId: 'paid',
    status,
    withdrawal: '0xcc',
    paid: true,
    createdAt: at(2),
  });
  for (let i = 0; i < 100; i++)
    await wallet.save({ kind: 'payment', operationId: 'payment ' + i, status, createdAt: at(10 + i) });
  assert.deepEqual(
    wallet.history.slice(100).map(r => r.operationId),
    ['locking in', 'owed'],
  );
  wallet.history = wallet.history.map(r => (r.withdrawal ? { ...r, paid: true } : r));
  await wallet.save({ kind: 'payment', operationId: 'payment 100', status, createdAt: at(110) });
  assert.equal(wallet.history.length, 100);
});
test("a recorded withdrawal's transaction is looked for in blocks whose logs an RPC serves without a key", async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  const account = '0x1111111111111111111111111111111111111111',
    looked: number[][] = [];
  wallet.observer = {
    contractRead: async (_: unknown, method: string) =>
      method === 'claims'
        ? { beneficiary: account, recipient: account, protectedRemaining: 0n, winningsRemaining: 0n }
        : { status: 0n, claimed: 1500n },
  } as any;
  wallet.reader = {
    filters: { Withdrawal: () => ({}) },
    queryFilter: async (_: unknown, from: number, to: number) => (looked.push([from, to]), []),
  } as any;
  const entry = {
    kind: 'withdrawal',
    withdrawal: '0xaa',
    proof: {
      base: { player: account, index: 0n, withdrawn: 0n },
      step: { operation: { recipient: account, amount: 1500n } },
    },
  };
  await wallet.withdrawalState(entry as any, { number: 30000, hash: '0x1' } as any);
  // An RPC without a key can refuse logs from 10,000 blocks below its head, as publicnode does, and the confirmed block
  // can be a few below it.
  const [[from, to]] = looked;
  assert.ok(to === 30000 && to - from < 9990, `looked from ${from} to ${to}`);
});
test('a withdrawal is read again when its recording is taken back, or the block that read it paid leaves the chain', async () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  const account = '0x1111111111111111111111111111111111111111',
    first = '0x5555555555555555555555555555555555555555',
    elsewhere = '0x6666666666666666666666666666666666666666',
    none = { beneficiary: ZeroAddress, recipient: ZeroAddress, protectedRemaining: 0n, winningsRemaining: 0n };
  // The chain: what the claim still owes, and the channel's status and `claimed`, which says whether it is recorded.
  let claim = { beneficiary: account, recipient: first, protectedRemaining: 0n, winningsRemaining: 500n },
    channel = { status: 0n, claimed: 1500n },
    chain: Record<number, string> = {};
  wallet.observer = {
    contractRead: async (_: unknown, method: string) =>
      method === 'claims' ? claim : method === 'channels' ? channel : 0n,
    corroborate: async (_: string, read: any) => read({ getBlock: async (n: number) => ({ hash: chain[n] }) }),
  } as any;
  wallet.reader = { filters: { Withdrawal: () => ({}) }, queryFilter: async () => [] } as any;
  const sent = {
    kind: 'withdrawal',
    operationId: 'sent',
    withdrawal: '0xaa',
    amount: 1500n,
    to: first,
    paid: false,
    proof: {
      base: { player: account, index: 0n, withdrawn: 0n },
      step: { operation: { recipient: first, amount: 1500n } },
    },
  };
  const observe = async (number: number, entry: any) => {
    chain[number] = '0x' + number;
    return (await wallet.observeTransactionHistory({ number, hash: '0x' + number } as any, [entry]))[0];
  };
  const recorded = await observe(10, sent);
  assert.deepEqual([recorded.recorded, recorded.owed, recorded.paid, recorded.to], [true, 500n, false, first]);
  // Its account redirected it: it pays elsewhere from now on.
  claim = { ...claim, recipient: elsewhere };
  assert.equal((await observe(11, recorded)).to, elsewhere);
  // A reorganisation took the recording back: nothing read of it stands, and it can be sent again.
  claim = none;
  channel = { status: 0n, claimed: 0n };
  assert.deepEqual(await observe(12, recorded), sent);
  // Recorded again and paid in full at once, which leaves no claim: read paid at block 13, and not read again while
  // that block stands.
  channel = { status: 0n, claimed: 1500n };
  const paid = await observe(13, sent);
  assert.deepEqual([paid.paid, paid.to, paid.settledAt], [true, first, { number: 13, hash: '0x13' }]);
  claim = { beneficiary: account, recipient: first, protectedRemaining: 0n, winningsRemaining: 500n };
  assert.equal(await observe(14, paid), paid);
  // Block 13 left the chain, and the recording that replaced it could pay only part: 500 is owed.
  chain[13] = '0xother';
  const owed = await observe(15, paid);
  assert.deepEqual([owed.paid, owed.owed, owed.settledAt], [false, 500n, undefined]);
  // Not recorded by the time its channel's close is final: the close returned it.
  claim = none;
  channel = { status: 2n, claimed: 0n };
  const returned = await observe(16, owed);
  assert.deepEqual(
    [returned.returned, returned.recorded, returned.settledAt],
    [true, undefined, { number: 16, hash: '0x16' }],
  );
});
test("the wallet offers a channel's withdrawals to send in the order they were made, as the contract records them", () => {
  const wallet = new CasinoWallet({ network: 'local', storage: new MemoryStore() });
  const withdrawal = (operationId: string, index: bigint, sequence: bigint) => ({
    kind: 'withdrawal',
    operationId,
    status: 'signed',
    createdAt: '',
    withdrawal: '0x' + operationId,
    paid: false,
    proof: { base: { player: ZeroAddress, index, sequence } },
  });
  const first = withdrawal('aa', 0n, 3n),
    second = withdrawal('bb', 0n, 5n),
    elsewhere = withdrawal('cc', 1n, 9n);
  wallet.history = [second, elsewhere, first];
  assert.deepEqual(
    [first, second, elsewhere].map(entry => wallet.nextToRecord(entry)),
    [true, false, true],
  );
  wallet.history = [second, elsewhere, { ...first, recorded: true }];
  assert.equal(wallet.nextToRecord(second), true);
});
