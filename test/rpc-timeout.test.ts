import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
