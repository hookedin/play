import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, parseEther, toUtf8Bytes, ZeroAddress } from 'ethers';
import { CasinoWallet, CHECK_EVERY } from '../client/wallet.ts';
import { channelId } from '../protocol/protocol.ts';
import { MemoryStore } from '../client/storage.ts';

/** A wallet whose address, RPC, signer and contract are stubs: what it signs is recorded, and nothing is broadcast. */
function fixture({ network = 'mainnet', rpcChain = '' } = {}) {
  const wallet = new CasinoWallet({ network, storage: new MemoryStore() });
  const state = {
    rpcChain: rpcChain || (network === 'local' ? '0x7a69' : '0x1'),
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
    config: { chainId: wallet.expectedChainId },
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

test('Ethereum is required by default, and unknown or test-network modes cannot be selected', () => {
  const wallet = new CasinoWallet();
  assert.equal(wallet.expectedChainId, 1n);
  assert.equal(wallet.networkName, 'Ethereum');
  assert.equal(wallet.recommendedStake, 1000000000000n);
  for (const network of ['sepolia', 'ethereum', '1', '', 'testnet'])
    assert.throws(() => new CasinoWallet({ network }), /supported/);
});

test('a test-network or local RPC, or one that changes chain during the estimate, signs nothing', async () => {
  for (const rpcChain of ['0xaa36a7', '0x7a69']) {
    const { wallet, state } = fixture({ rpcChain });
    await assert.rejects(wallet.sendTransaction('claim'), /RPC must be on Ethereum/);
    assert.equal(state.signed.length, 0);
  }
  const { wallet, state } = fixture();
  wallet.contract.deposit.estimateGas = async () => {
    state.rpcChain = '0xaa36a7';
    return state.gas;
  };
  await assert.rejects(wallet.sendTransaction('deposit', [], { value: 1n }), /RPC must be on Ethereum/);
  assert.equal(state.signed.length, 0);
});

test('a transaction reads the network before and after, spends no more than the address holds, and pins its fee caps', async () => {
  const { wallet, state } = fixture();
  await assert.rejects(
    wallet.sendTransaction('deposit', [], { value: state.balance }),
    /Your address holds too little/,
  );
  // The nonce is the address's next, as the RPC counts it, and the chain the wallet's own.
  state.latestNonce = state.pendingNonce = '0x9';
  const value = state.balance - 60000n * state.maxFee;
  await wallet.sendTransaction('deposit', [], { value });
  assert.equal(state.calls[0], 'eth_chainId');
  assert.equal(state.calls.at(-1), 'eth_chainId');
  assert.deepEqual(state.signed, [
    {
      method: 'deposit',
      value,
      nonce: 9,
      chainId: 1n,
      gasLimit: 60000n,
      maxFeePerGas: state.maxFee,
      maxPriorityFeePerGas: state.priorityFee,
      type: 2,
    },
  ]);
  assert.equal(wallet.transactionIntent!.nonce, 9);
});

test('a deposit of everything at the address keeps back nothing but its own fee, priced once', async () => {
  const { wallet, state } = fixture();
  const { amount, fee, overrides } = await wallet.depositable();
  // The estimate with a fifth more, at the most the fee can be.
  assert.equal(fee, 60000n * state.maxFee);
  assert.equal(amount + fee, state.balance);
  await wallet.sendTransaction('deposit', [wallet.address], { value: amount, priced: overrides });
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
  const { wallet, state } = fixture(),
    key = channelId(ZeroAddress, 0n);
  wallet.channels[key] = {} as any;
  const close = [{ base: { player: ZeroAddress, index: 0n } }];
  state.balance = 60000n * state.maxFee - 1n;
  await assert.rejects(
    wallet.sendTransaction('startClose', close),
    /its fee can be up to .* METH\. Send that much ETH/,
  );
  state.balance += 1n;
  await wallet.sendTransaction('startClose', close);
  assert.deepEqual([state.signed[0].method, wallet.channels[key].closing], ['startClose', true]);
});

test('only a local casino that says so offers demo ETH', async () => {
  const { wallet } = fixture({ network: 'local' });
  assert.equal(wallet.isLocalDevelopment, false, 'the casino has not said so');
  wallet.config.isLocalDevelopment = true;
  assert.equal(wallet.isLocalDevelopment, true);
  const mainnet = fixture().wallet;
  mainnet.config.isLocalDevelopment = true;
  assert.equal(
    mainnet.isLocalDevelopment,
    false,
    'an Ethereum wallet never asks for demo ETH, whatever the casino says',
  );
  await assert.rejects(mainnet.setupDemo(), /local only/);
});

test('an operation on a check older than CHECK_EVERY checks again first, and pauses when it cannot', async () => {
  const { wallet } = fixture();
  wallet.channelId = 'test';
  wallet.channels = {
    test: { state: { balance: 1n, deposited: 0n }, onchain: { status: 0n, deposited: 0n }, registered: true } as any,
  };
  let checks = 0;
  wallet.refreshLocked = async () => {
    checks++;
    throw new Error('RPC down');
  };
  wallet.lastChainCheck = Date.now() - CHECK_EVERY + 5000;
  await wallet.ready();
  assert.equal(checks, 0);
  wallet.lastChainCheck = Date.now() - CHECK_EVERY - 1000;
  await assert.rejects(wallet.ready(), /RPC down/);
  wallet.refreshLocked = async () => {
    checks++;
    wallet.lastChainCheck = Date.now();
    return wallet.publicState;
  };
  await wallet.ready();
  assert.equal(checks, 2);
});
