import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ZeroAddress } from 'ethers';
import { createRpcProvider, MIN_PRIORITY_FEE, RPC_TIMEOUT_MS } from '../protocol/chain-observer.ts';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { anvil } from '../testing/contract.ts';

test('stalled RPC transport releases wallet actions and a late response cannot commit', async t => {
  let delayed, entered: any;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const requests = Array.isArray(payload) ? payload : [payload];
    const reply = () => {
      const values = requests.map(item => ({
        jsonrpc: '2.0',
        id: item.id,
        result: item.method === 'eth_chainId' ? '0x7a69' : '0x1',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(payload) ? values : values[0]));
    };
    if (requests.some(item => item.method === 'eth_blockNumber')) {
      delayed = reply;
      entered();
    } else reply();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createRpcProvider('http://127.0.0.1:' + (server.address()! as any).port);
  t.after(async () => {
    provider.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await provider.send('eth_chainId', []);
  const storage = new MemoryStore(),
    wallet = new CasinoWallet({ network: 'local', storage });
  Object.assign(wallet, { storageKey: 'deadline', render: () => {}, lastChainCheck: Date.now() });
  await wallet.save();
  wallet.refreshLocked = (async () => {
    await provider.send('eth_blockNumber', []);
    await wallet.save(null, { history: [{ operationId: 'late' }] });
  }) as any;
  const start = Date.now(),
    refreshing = wallet.refresh();
  const failed = assert.rejects(refreshing, /timeout/i);
  await started;
  let ran = false;
  const action = wallet.exclusive(async () => {
    ran = true;
  });
  await Promise.all([failed, action]);
  assert.ok(ran);
  assert.equal(wallet.lastChainCheck, 0);
  assert.equal(wallet.refreshing, null);
  assert.ok(Date.now() - start < RPC_TIMEOUT_MS + 5000);
  delayed!();
  await new Promise(setImmediate);
  assert.deepEqual((await storage.get(wallet.storageKey)).history, [], 'the late refresh saved nothing');
  assert.deepEqual(wallet.history, []);
  assert.equal(await provider.send('eth_chainId', []), '0x7a69', 'the same provider remains usable after a timeout');
});

test('every call is a request of its own, which an RPC that refuses batches answers', async t => {
  const bodies: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    bodies.push(payload);
    res.writeHead(Array.isArray(payload) ? 429 : 200, { 'content-type': 'application/json' });
    // Tenderly's public gateway answers a batch of six contract calls so.
    res.end(
      JSON.stringify(
        Array.isArray(payload)
          ? { jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limit exceeded' } }
          : { jsonrpc: '2.0', id: payload.id, result: '0x1' },
      ),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createRpcProvider('http://127.0.0.1:' + (server.address()! as any).port, 31337n);
  t.after(async () => {
    provider.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const calls = Array.from({ length: 8 }, () => provider.send('eth_call', [{ to: ZeroAddress, data: '0x' }, 'latest']));
  assert.deepEqual(await Promise.all(calls), Array(8).fill('0x1'));
  assert.equal(bodies.filter(body => Array.isArray(body)).length, 0);
});

test('a fee priced at the gas price pays what a transaction tipping the least tip costs', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const baseFee = 60_000_000n;
  await env.provider.send('anvil_setNextBlockBaseFeePerGas', ['0x' + baseFee.toString(16)]);
  await env.provider.send('evm_mine', []);
  const provider = createRpcProvider(env.url, 31337n);
  t.after(() => provider.destroy());
  // Mainnet's RPCs suggest no tip, and a gas price of about the base fee.
  const send = provider.send.bind(provider);
  provider.send = (method, params) =>
    method === 'eth_gasPrice'
      ? Promise.resolve('0x' + baseFee.toString(16))
      : method === 'eth_maxPriorityFeePerGas'
        ? Promise.resolve('0x0')
        : send(method, params);
  const fees = await provider.getFeeData();
  assert.equal(fees.maxPriorityFeePerGas, MIN_PRIORITY_FEE);
  assert.equal(fees.gasPrice, baseFee + MIN_PRIORITY_FEE);
  const sent = await env.wallets[1].connect(provider).sendTransaction({ to: env.wallets[2].address, value: 1n }),
    receipt = (await sent.wait())!;
  assert.equal(sent.maxPriorityFeePerGas, MIN_PRIORITY_FEE);
  assert.ok(receipt.gasPrice <= fees.gasPrice!, 'it pays no more a gas than the gas price says');
});
