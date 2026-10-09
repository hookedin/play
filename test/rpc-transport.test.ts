import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ZeroAddress } from 'ethers';
import { createRpcProvider, RPC_TIMEOUT_MS } from '../protocol/chain-observer.ts';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';

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
  assert.equal((await storage.get(wallet.storageKey)).revision, 1);
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
