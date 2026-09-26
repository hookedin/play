import test from 'node:test';
import assert from 'node:assert/strict';
import { CasinoWallet } from '../client/wallet.ts';

function fixture({
  network = 'sepolia',
  rpcChain = '0xaa36a7',
  signerChain = '0xaa36a7',
  isLocalDevelopment = false,
} = {}) {
  const wallet = new CasinoWallet({ network });
  const state = { rpcChain, signerChain, sent: [] as any[], calls: [] as string[] };
  wallet.config = { chainId: String(wallet.expectedChainId), isLocalDevelopment };
  wallet.address = '0x2222222222222222222222222222222222222222';
  wallet.provider = {
    getBalance: async () => 10n ** 18n,
    getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getNetwork: () => {
      throw new Error('Do not trust a cached network for a signing guard.');
    },
    send: async (method: any) => {
      state.calls.push(`rpc:${method}`);
      if (method === 'eth_chainId') return state.rpcChain;
      if (method === 'eth_getTransactionCount') return '0x7';
      throw new Error(`Unexpected RPC method ${method}`);
    },
  } as any;
  wallet.signer = {
    provider: {
      send: async (method: any) => {
        state.calls.push(`signer:${method}`);
        assert.equal(method, 'eth_chainId');
        return state.signerChain;
      },
    },
  } as any;
  wallet.contract = Object.fromEntries(
    ['openChannel', 'startClose', 'claim'].map(method => [
      method,
      async (...args: any[]) => {
        state.sent.push({ method, args });
        return { hash: 'stubbed-no-broadcast', wait: async () => ({ status: 1 }) };
      },
    ]),
  ) as any;
  for (const method of Object.values(wallet.contract)) method.estimateGas = async () => 21000n;
  wallet.refresh = (async () => {}) as any;
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
  assert.throws(
    () => wallet.validateConfiguredNetwork(),
    /requires Sepolia.*casino reports chain 31337.*npm run sepolia/,
  );
});

test('a casino advertising the wrong chain is rejected before consulting either provider', async () => {
  const { wallet, state } = fixture();
  wallet.config.chainId = '1';
  await assert.rejects(wallet.sendTransaction('openChannel', [], { nonce: 0 }), /requires Sepolia/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.sent, []);
});

test('a mainnet or local RPC cannot sign transactions in Sepolia mode', async () => {
  for (const rpcChain of ['0x1', '0x7a69']) {
    const { wallet, state } = fixture({ rpcChain });
    await assert.rejects(wallet.sendTransaction('openChannel', [], { nonce: 0 }), /RPC must be on Sepolia/);
    assert.equal(state.sent.length, 0);
    assert.equal(wallet.verifiedChainId, null);
  }
});

test('every contract write is rejected if the injected wallet switches away from Sepolia', async () => {
  const { wallet, state } = fixture();
  await wallet.assertNetwork();
  state.signerChain = '0x1';
  for (const method of ['openChannel', 'startClose', 'claim']) {
    await assert.rejects(wallet.sendTransaction(method, [], { nonce: 0 }), /Switch your signing wallet to Sepolia/);
  }
  assert.equal(state.sent.length, 0);
  assert.equal(wallet.verifiedChainId, null);
});

test('the write guard reads both current networks and pins Sepolia on the stubbed transaction', async () => {
  const { wallet, state } = fixture();
  await wallet.sendTransaction('openChannel', [], { nonce: 7, value: 1n, chainId: 1n });
  assert.deepEqual(state.calls.slice(0, 2), ['rpc:eth_chainId', 'signer:eth_chainId']);
  assert.deepEqual(state.calls.slice(-2), ['rpc:eth_chainId', 'signer:eth_chainId']);
  assert.deepEqual(state.sent, [
    {
      method: 'openChannel',
      args: [
        {
          nonce: 7,
          value: 1n,
          chainId: 11155111n,
          gasLimit: 25200n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          type: 2,
        },
      ],
    },
  ]);
  state.rpcChain = '0x1';
  await assert.rejects(wallet.sendTransaction('openChannel', [], { nonce: 8 }), /RPC must be on Sepolia/);
  assert.equal(state.sent.length, 1, 'a later network change must not inherit earlier approval');
});

test('Anvil tests require an explicit constructor mode and verified chain 31337', async () => {
  const { wallet, state } = fixture({
    network: 'local',
    rpcChain: '0x7a69',
    signerChain: '0x7a69',
    isLocalDevelopment: true,
  });
  assert.equal(wallet.isLocalDevelopment, false, 'configuration alone cannot enable the faucet');
  await wallet.assertNetwork();
  assert.equal(wallet.isLocalDevelopment, true);
  assert.equal(wallet.expectedChainId, 31337n);
  assert.notEqual(wallet.expectedChainId, new CasinoWallet().expectedChainId);
  state.rpcChain = '0xaa36a7';
  await assert.rejects(wallet.assertNetwork(), /RPC must be on Anvil test chain/);
  assert.equal(wallet.isLocalDevelopment, false);
});

test('the automatic faucet remains disabled on Sepolia, even if the server claims local development', async () => {
  const { wallet, state } = fixture({ isLocalDevelopment: true });
  await wallet.assertNetwork();
  assert.equal(wallet.isLocalDevelopment, false);
  await assert.rejects(wallet.setupDemo(), /local only/);
  assert.deepEqual(state.sent, []);
});

test('chain 31337 without the explicit server development flag cannot use the automatic faucet', async () => {
  const { wallet, state } = fixture({ network: 'local', rpcChain: '0x7a69', signerChain: '0x7a69' });
  await wallet.assertNetwork();
  assert.equal(wallet.isLocalDevelopment, false);
  await assert.rejects(wallet.setupDemo(), /local only/);
  assert.deepEqual(state.sent, []);
});

test('stale independent observations pause off-chain play', () => {
  const { wallet } = fixture();
  wallet.channelId = 'test';
  wallet.channels = { test: { state: { balance: '1' }, onchain: { status: 1 }, key: 'unused' } as any };
  wallet.lastChainCheck = Date.now() - 61000;
  assert.throws(() => wallet.ready(), /stale/);
});
