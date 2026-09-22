import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyTypedData } from 'ethers';
import { domain, outcome, roundId, seedHash, PROTOCOL, HOST_ACCESS_TYPES } from '@hookedin/play/protocol/protocol.ts';
import { createHost, roundOutcome } from '../src/host.ts';

test('a host opens a round under its own key with the hash of a seed it keeps, and closes it with the seed', async t => {
  const casinoURL = 'https://casino.test',
    d = domain(31337, '0x' + 'c'.repeat(40)),
    LIMITS = { prizes: 64, outcomeSpace: String(1n << 64n), seats: 256, cells: 128, window: { min: 1000, max: 60000 } },
    secret = '0x' + '5'.repeat(64),
    calls: { path: string; body: any; host: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.slice(casinoURL.length),
      reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (path === '/api/config')
      return reply(200, {
        chainId: d.chainId,
        contractAddress: d.verifyingContract,
        protocol: PROTOCOL,
        limits: LIMITS,
      });
    if (init.method !== 'POST')
      return path.endsWith(roundId(secret))
        ? reply(200, { id: roundId(secret), seats: [] })
        : reply(404, { error: 'Unknown round' });
    const access = JSON.parse(Buffer.from((init.headers as any).authorization.slice(9), 'base64url').toString());
    calls.push({
      path,
      body: JSON.parse(String(init.body)),
      host: verifyTypedData(d, HOST_ACCESS_TYPES, access.message, access.signature),
    });
    return reply(200, { id: roundId(secret), status: 'open', secret });
  });
  const host = await createHost({ casinoURL, key: Wallet.createRandom().privateKey });
  const { round, seed } = await host.round();
  assert.equal(round.id, roundId(secret));
  assert.match(seed, /^0x[0-9a-f]{64}$/);
  assert.equal(round.seedHash, seedHash(seed));
  assert.deepEqual(
    calls.map(call => [call.path, call.body, call.host]),
    [['/api/rounds', { seedHash: round.seedHash, asset: 'eth', window: LIMITS.window.max }, host.address]],
    "one request opens the round, only the seed's hash is sent, and it is the host key's",
  );
  assert.deepEqual(await host.seats(round.id), { id: round.id, seats: [] });
  assert.equal(await host.seats('0x' + '1'.repeat(64)), null);
  const closed = await host.close(round.id, seed);
  assert.deepEqual(calls.at(-1)!, {
    path: `/api/rounds/${round.id}/close`,
    body: { seed },
    host: host.address,
  });
  // The outcome is what every seat's prizes are read against: a function of the seed and the secret alone.
  assert.equal(roundOutcome(seed, closed.secret), outcome([], seed, secret).value);
  // A round for the other asset, and one whose game needs less betting time, are asked for the same way.
  calls.length = 0;
  await host.round('test');
  await host.round('eth', 5000);
  assert.deepEqual(
    calls.map(call => [call.body.asset, call.body.window]),
    [
      ['test', LIMITS.window.max],
      ['eth', 5000],
    ],
  );
  // The casino's own bounds, so a host never opens a round on a window the casino would refuse.
  assert.deepEqual(host.window, LIMITS.window);
  for (const bad of [999, 60001])
    await assert.rejects(host.round('eth', bad), /takes a betting window of 1000 to 60000 milliseconds/);
});

test('a host refuses a casino that speaks another revision of the protocol', async t => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ chainId: '31337', contractAddress: '0x' + 'c'.repeat(40), protocol: '0x00' })),
  );
  await assert.rejects(
    createHost({ casinoURL: 'https://casino.test', key: Wallet.createRandom().privateKey }),
    (error: any) => error.code === 'protocol-mismatch',
  );
});
