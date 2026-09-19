import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, id, keccak256 } from 'ethers';
import { TransactionJournal } from '../protocol/transaction-journal.ts';
import { confirmedNonce, confirmedReceipt, findNonceTransaction } from '../protocol/transaction-recovery.ts';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';

test('journal retries reject changed intent before confirmation or broadcast, including after reload', async () => {
  const signer = Wallet.createRandom(),
    destination = Wallet.createRandom().address;
  const request = { to: destination, value: 1n, data: '0x1234' };
  const raw = await signer.signTransaction({
    ...request,
    nonce: 0,
    chainId: 31337,
    type: 2,
    gasLimit: 50000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  const hash = keccak256(raw),
    block = { number: 10, hash: id('retry-block') };
  let broadcasts = 0,
    mined = false,
    durable;
  const provider = {
    send: async (method: any) => (method === 'eth_chainId' ? '0x7a69' : '0x0'),
    getBlock: async () => block,
    getTransactionReceipt: async () => (mined ? { hash, blockNumber: 10, blockHash: block.hash, status: 1 } : null),
    broadcastTransaction: async (value: any) => {
      assert.equal(value, raw);
      broadcasts++;
      return { hash };
    },
  };
  const config = {
    signer,
    provider,
    chainId: 31337,
    persist: (state: any) => {
      durable = structuredClone(state);
    },
  };
  let journal = new TransactionJournal({
    ...config,
    initialState: {
      schema: 'HOOKEDIN/TRANSACTIONS/1',
      casino: destination,
      pending: { action: 'claim', raw, hash, updatedAt: Date.now(), attempts: [{ hash, raw }] },
    },
  } as any);
  journal.save();
  journal = new TransactionJournal({ ...config, initialState: durable } as any);
  assert.equal(journal.state.casino, destination);
  for (mined of [false, true]) {
    for (const change of [{ to: signer.address }, { value: 2n }, { data: '0xabcd' }]) {
      await assert.rejects(journal.submit('claim', { ...request, ...change }), /different intent/);
      assert.equal(journal.state.pending!.hash, hash);
    }
  }
  assert.equal(broadcasts, 0);
  mined = false;
  await journal.submit('claim', request);
  await journal.submit('claim', null);
  assert.equal(broadcasts, 2);
  mined = true;
  assert.equal((await journal.submit('claim', request)).status, 'confirmed');
});

test('shared receipt validation uses the supplied confirmation anchor and rejects orphaned or malformed receipts', async () => {
  const anchor = { number: 10, hash: id('anchor'), timestamp: 0 },
    included = { number: 8, hash: id('included') };
  let receipt = { hash: id('tx'), blockNumber: 8, blockHash: included.hash, status: 1 },
    changed = false;
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlock: async (height: any) => {
      assert.notEqual(height, 'latest', 'the monitor already supplied its confirmed block');
      return height === 8 ? included : changed ? { ...anchor, hash: id('replacement') } : anchor;
    },
  };
  assert.equal(await confirmedReceipt({ provider: provider as any }, receipt.hash, anchor), receipt);
  receipt = { ...receipt, blockNumber: 11 };
  assert.equal(await confirmedReceipt({ provider: provider as any }, receipt.hash, anchor), null);
  receipt = { ...receipt, blockNumber: 8, blockHash: id('orphan') };
  assert.equal(await confirmedReceipt({ provider: provider as any }, receipt.hash, anchor), null);
  receipt = { ...receipt, blockHash: included.hash, status: 2 };
  await assert.rejects(
    confirmedReceipt({ provider: provider as any }, receipt.hash, anchor),
    /Invalid transaction receipt/,
  );
  receipt.status = 1;
  changed = true;
  await assert.rejects(confirmedReceipt({ provider: provider as any }, receipt.hash, anchor), /Chain changed/);
});

for (const boundary of ['initial', 'replacement', 'completion'])
  test('journal latches persistence failure at ' + boundary, async () => {
    const key = Wallet.createRandom();
    let clock = 1,
      fail = boundary === 'initial',
      broadcasts = 0,
      mined = false;
    let durable = { schema: 'HOOKEDIN/TRANSACTIONS/1', pending: null, history: [] };
    const block = { number: 10, hash: id('block') };
    const provider = {
      send: async (method: any) => (method === 'eth_chainId' ? '0x7a69' : '0x0'),
      getTransactionCount: async () => 0,
      getBlock: async () => block,
      getTransactionReceipt: async (hash: any) =>
        mined ? { hash, blockNumber: 10, blockHash: block.hash, status: 1 } : null,
      getFeeData: async () => ({ maxFeePerGas: 10n }),
      broadcastTransaction: async () => {
        broadcasts++;
        return {};
      },
    };
    const signer = {
      getAddress: () => key.getAddress(),
      signTransaction: (tx: any) => key.signTransaction(tx),
      populateTransaction: async (tx: any) => ({
        ...tx,
        type: 2,
        gasLimit: 21000n,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
      }),
    };
    const config = {
      signer,
      provider,
      chainId: 31337,
      now: () => clock,
      persist: (state: any) => {
        if (fail) throw new Error('disk failure');
        durable = structuredClone(state);
      },
    };
    const journal = new TransactionJournal({ ...config, initialState: structuredClone(durable) } as any);
    const request = { to: key.address, value: 1n };
    if (boundary !== 'initial') {
      await journal.submit('payment', request);
      fail = true;
    }
    const before = broadcasts;
    if (boundary === 'replacement') clock += 50000;
    if (boundary === 'completion') mined = true;
    await assert.rejects(journal.submit('payment', request), /disk failure/);
    for (const action of [() => journal.submit('payment', request), () => journal.reconcile()])
      await assert.rejects(action(), /restart from durable state/);
    assert.throws(() => journal.adopt({} as any), /restart from durable state/);
    assert.equal(broadcasts, before, 'failed state must never broadcast');
    fail = false;
    const restored = new TransactionJournal({ ...config, initialState: structuredClone(durable) } as any);
    if (boundary === 'completion') assert.equal((await restored.reconcile())!.status, 'confirmed');
    else {
      await restored.submit('payment', request);
      assert.equal(broadcasts, before + 1);
    }
  });

for (const operation of ['nonce', 'receipt', 'replacement'])
  test('transaction ' + operation + ' rejects a branch change before committing', async () => {
    const original = { number: 10, hash: id('old') },
      replacement = { ...original, hash: id('new') };
    let changed = false,
      headers = 0,
      nonceReads = 0;
    const provider = {
      async getBlock(tag: any) {
        if (tag === 'latest') return original;
        if (operation === 'receipt' && ++headers === 3) changed = true;
        return changed ? replacement : original;
      },
      async send(method: any, args: any) {
        assert.equal(method, 'eth_getTransactionCount');
        assert.deepEqual(args[1], { blockHash: original.hash, requireCanonical: true });
        nonceReads++;
        changed = true;
        return '0x0';
      },
      getTransactionReceipt: async (hash: any) => ({ hash, blockNumber: 10, blockHash: original.hash, status: 1 }),
    };
    const context = { provider, address: Wallet.createRandom().address, nonce: 0 };
    await assert.rejects(
      operation === 'nonce'
        ? confirmedNonce(context as any, context.address)
        : operation === 'receipt'
          ? confirmedReceipt(context as any, id('transaction'))
          : findNonceTransaction(context as any),
      /Chain changed/,
    );
    if (operation !== 'receipt') assert.equal(nonceReads, 1);
  });
