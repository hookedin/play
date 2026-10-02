import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, parseEther, toUtf8Bytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';

/** A wallet whose address, RPC, signer and contract are stubs: what it signs is recorded, and nothing is broadcast. */
function fixture({ network = 'sepolia', rpcChain = '' } = {}) {
  const wallet = new CasinoWallet({ network, storage: new MemoryStore() });
  const state = {
    rpcChain: rpcChain || (network === 'local' ? '0x7a69' : '0xaa36a7'),
    balance: parseEther('0.05'),
    gas: 50000n,
    maxFee: 2000000000n,
    priorityFee: 1000000000n,
    latestNonce: '0x7',
    pendingNonce: '0x7',
    calls: [] as string[],
    signed: [] as any[],
    estimated: [] as bigint[],
  };
  Object.assign(wallet, {
    storageKey: 'wallet',
    render: () => {},
    refresh: async () => {},
    config: { chainId: String(wallet.expectedChainId) },
    address: '0x2222222222222222222222222222222222222222',
  });
  wallet.provider = {
    getBalance: async (address: string, tag: string) => {
      assert.deepEqual([address, tag], [wallet.address, 'pending']);
      return state.balance;
    },
    getFeeData: async () => ({ maxFeePerGas: state.maxFee, maxPriorityFeePerGas: state.priorityFee }),
    send: async (method: string, args: any[]) => {
      state.calls.push(method);
      if (method === 'eth_chainId') return state.rpcChain;
      if (method === 'eth_getTransactionCount') return args[1] === 'latest' ? state.latestNonce : state.pendingNonce;
      throw new Error(`Unexpected RPC method ${method}`);
    },
    broadcastTransaction: async (raw: string) => ({ hash: keccak256(raw) }),
  } as any;
  wallet.signer = {
    signTransaction: async (request: any) => {
      state.signed.push(request);
      return keccak256(toUtf8Bytes(String(state.signed.length)));
    },
  } as any;
  const method = (name: string) =>
    Object.assign(async () => assert.fail('a transaction is signed, never sent straight'), {
      estimateGas: async (...args: any[]) => {
        state.estimated.push(args.at(-1).value);
        return state.gas;
      },
      populateTransaction: async (...args: any[]) => ({ method: name, ...args.at(-1) }),
    });
  wallet.contract = {
    getAddress: async () => '0x4444444444444444444444444444444444444444',
    interface: { encodeFunctionData: () => '0x' },
    deposit: method('deposit'),
    startClose: method('startClose'),
    claim: method('claim'),
  } as any;
  return { wallet, state };
}

test('Sepolia is required by default, and unknown or mainnet modes cannot be selected', () => {
  const wallet = new CasinoWallet();
  assert.equal(wallet.expectedChainId, 11155111n);
  assert.equal(wallet.networkName, 'Sepolia');
  assert.equal(wallet.recommendedStake, '1000000000000');
  for (const network of ['mainnet', 'ethereum', '1', '', 'testnet'])
    assert.throws(() => new CasinoWallet({ network }), /supported/);
  wallet.config = { chainId: '31337' };
  assert.throws(() => wallet.validateConfiguredNetwork(), /requires Sepolia.*casino reports chain 31337/);
});

test('a casino advertising the wrong chain is rejected before consulting the RPC', async () => {
  const { wallet, state } = fixture();
  wallet.config.chainId = '1';
  await assert.rejects(wallet.sendTransaction('claim'), /requires Sepolia/);
  assert.deepEqual([state.calls, state.signed], [[], []]);
});

test('a mainnet or local RPC, or one that changes chain during the estimate, signs nothing', async () => {
  for (const rpcChain of ['0x1', '0x7a69']) {
    const { wallet, state } = fixture({ rpcChain });
    await assert.rejects(wallet.sendTransaction('claim'), /RPC must be on Sepolia/);
    assert.equal(state.signed.length, 0);
  }
  const { wallet, state } = fixture();
  wallet.contract.deposit.estimateGas = async () => {
    state.rpcChain = '0x1';
    return state.gas;
  };
  await assert.rejects(wallet.sendTransaction('deposit', [], { value: 1n }), /RPC must be on Sepolia/);
  assert.equal(state.signed.length, 0);
});

test('a transaction reads the network before and after, spends no more than the address holds, and pins its fee caps', async () => {
  const { wallet, state } = fixture();
  await assert.rejects(
    wallet.sendTransaction('deposit', [], { value: state.balance }),
    /Your address holds too little/,
  );
  const value = state.balance - 60000n * state.maxFee;
  await wallet.sendTransaction('deposit', [], { value, nonce: 7, chainId: 1n });
  assert.equal(state.calls[0], 'eth_chainId');
  assert.equal(state.calls.at(-1), 'eth_chainId');
  assert.deepEqual(state.signed, [
    {
      method: 'deposit',
      value,
      nonce: 7,
      chainId: 11155111n,
      gasLimit: 60000n,
      maxFeePerGas: state.maxFee,
      maxPriorityFeePerGas: state.priorityFee,
      type: 2,
    },
  ]);
  assert.equal(wallet.transactionIntent.nonce, 7);
});

test('a deposit of everything at the address keeps back nothing but its own fee, priced once', async () => {
  const { wallet, state } = fixture();
  const { amount, fee, overrides } = await wallet.depositable();
  // The estimate with a fifth more, at the most the fee can be.
  assert.equal(fee, 60000n * state.maxFee);
  assert.equal(amount + fee, state.balance);
  await wallet.sendTransaction('deposit', [wallet.address], { value: amount, ...overrides });
  assert.equal(state.signed[0].value, amount);
  assert.equal(state.estimated.length, 1, 'the deposit keeps the price its amount was worked out with');
});

test('unusual RPC gas and fee responses are rejected before signing', async () => {
  for (const changes of [
    { gas: 2000001n, maxFee: 1n, priorityFee: 1n },
    { gas: 21000n, maxFee: 200000000001n, priorityFee: 1n },
    { gas: 1000000n, maxFee: 100000000000n, priorityFee: 1n },
  ]) {
    const { wallet, state } = fixture();
    Object.assign(state, changes, { balance: parseEther('10') });
    await assert.rejects(wallet.sendTransaction('claim'), /fee caps/);
    assert.equal(state.signed.length, 0);
  }
});

test('a pending nonce or a failing estimate blocks signing', async () => {
  const { wallet, state } = fixture();
  state.pendingNonce = '0x8';
  await assert.rejects(wallet.sendTransaction('deposit', [], { value: 1n }), /transaction is pending/);
  state.pendingNonce = '0x7';
  wallet.contract.deposit.estimateGas = async () => {
    throw new Error('estimate unavailable');
  };
  await assert.rejects(wallet.sendTransaction('deposit', [], { value: 1n }), /estimate unavailable/);
  assert.equal(state.signed.length, 0);
});

test('every transaction the account sends, a close too, needs its fee at the address', async () => {
  const { wallet, state } = fixture();
  wallet.channels.channel = {} as any;
  const close = [{ base: { channelId: 'channel' } }];
  state.balance = 60000n * state.maxFee - 1n;
  await assert.rejects(
    wallet.sendTransaction('startClose', close),
    /its fee can be up to .* µETH\. Send that much ETH/,
  );
  state.balance += 1n;
  await wallet.sendTransaction('startClose', close);
  assert.deepEqual([state.signed[0].method, wallet.channels.channel.closing], ['startClose', true]);
});

test('only a local casino that says so offers its faucet', async () => {
  const { wallet } = fixture({ network: 'local' });
  assert.equal(wallet.isLocalDevelopment, false, 'the casino has not said so');
  wallet.config.isLocalDevelopment = true;
  assert.equal(wallet.isLocalDevelopment, true);
  const sepolia = fixture().wallet;
  sepolia.config.isLocalDevelopment = true;
  assert.equal(sepolia.isLocalDevelopment, false, 'a Sepolia wallet never uses a faucet, whatever the casino says');
  await assert.rejects(sepolia.setupDemo(), /local only/);
});

test('stale independent observations pause off-chain play', () => {
  const { wallet } = fixture();
  wallet.channelId = 'test';
  wallet.channels = { test: { state: { balance: '1' }, onchain: { status: 1 }, registered: true } as any };
  wallet.lastChainCheck = Date.now() - 61000;
  assert.throws(() => wallet.ready(), /stale/);
});
