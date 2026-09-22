import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGameBridge, validateRequest } from '../client/bridge.ts';

const request = (id = 1, method = 'wallet.info', params = {}) => ({ hookedin: true, id, method, params });
const prize = { rangeStart: '0', rangeEnd: '100', payout: '20' };
const params = { id: 'op-1', stake: '10', prizes: [prize] };
const bet = (overrides: any = {}) => request(1, 'game.bet', { ...params, ...overrides });

class FakeEventTarget {
  listeners = new Set<(event: any) => unknown>();
  addEventListener(type: any, listener: any) {
    assert.equal(type, 'message');
    this.listeners.add(listener);
  }
  removeEventListener(type: any, listener: any) {
    assert.equal(type, 'message');
    this.listeners.delete(listener);
  }
  async dispatch(event: any) {
    await Promise.all([...this.listeners].map(listener => listener(event)));
  }
}

const deferred = <T = void>() => Promise.withResolvers<T>();
const ORIGIN = 'https://game.example';

function harness(
  onRequest: (...args: any[]) => any = async () => ({ cash: '100' }),
  onActivity: () => void = () => {},
) {
  const target = new FakeEventTarget();
  const replies: any[] = [];
  const calls: any[] = [];
  const errors: any[] = [];
  const activity: any[] = [];
  const child = { postMessage: (message: any, destination: any) => replies.push({ message, destination }) };
  // The frame tells the bridge when it has loaded a page afresh.
  let loaded = () => {};
  const iframe = {
    contentWindow: child,
    addEventListener: (_: string, listener: () => void) => (loaded = listener),
    removeEventListener: () => {},
  };
  let current = true;
  const detach = attachGameBridge({
    iframe: iframe as any,
    origin: ORIGIN,
    target,
    isCurrent: () => current,
    onRequest: async (method, params) => {
      calls.push({ method, params });
      return onRequest(method, params);
    },
    onError: message => errors.push(message),
    onActivity: (type, data) => {
      activity.push({ type, data });
      onActivity();
    },
  });
  return {
    target,
    replies,
    calls,
    errors,
    activity,
    iframe,
    child,
    reload: () => loaded(),
    detach,
    setCurrent: (value: any) => {
      current = value;
    },
    send: (data: any, source = child, origin = ORIGIN) => target.dispatch({ data, source, origin }),
  };
}

test('bridge accepts requests only from the bound iframe window at the game origin, and answers only that origin', async () => {
  const bridge = harness();
  await bridge.send(request(1), {
    postMessage() {
      throw new Error('Spoofed window must not receive a response');
    },
  });
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.replies.length, 0);
  assert.equal(bridge.activity.length, 0, 'Other windows cannot write to the game log');

  // The frame navigated away from the game: whatever page it shows now is not the game the player opened.
  await bridge.send(request(1), bridge.child, 'https://elsewhere.example');
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.replies.length, 0);

  await bridge.send(request(2));
  assert.deepEqual(bridge.calls, [{ method: 'wallet.info', params: {} }]);
  assert.deepEqual(bridge.replies, [
    { message: { hookedin: true, id: 2, result: { cash: '100' } }, destination: ORIGIN },
  ]);
  bridge.detach();
});

test('bridge rejects stale game requests and suppresses results completed after game replacement', async () => {
  const pending = deferred();
  const bridge = harness(() => pending.promise);
  bridge.setCurrent(false);
  await bridge.send(request(1));
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.activity.length, 0);

  bridge.setCurrent(true);
  const operation = bridge.send(request(2));
  assert.equal(bridge.calls.length, 1);
  bridge.setCurrent(false);
  (pending.resolve! as any)({ cash: '50' });
  await operation;
  assert.equal(bridge.replies.length, 0, 'The new game must not receive the previous game result');
  assert.deepEqual(
    bridge.activity,
    [{ type: 'request', data: request(2) }],
    'Late results must not enter a replacement game log',
  );
  bridge.detach();
});

test('activity includes requests, successful results and every rejection path', async () => {
  const bridge = harness(() => ({ cash: '75' }));
  await bridge.send(request(1));
  await bridge.send(request(1));
  await bridge.send(request(3, 'wallet.sign'));
  await bridge.send(null);
  assert.deepEqual(
    bridge.activity.map(entry => entry.type),
    ['request', 'response', 'request', 'error', 'request', 'error', 'request', 'error'],
  );
  assert.deepEqual(bridge.activity[0].data, request(1));
  assert.deepEqual(bridge.activity[1].data, { hookedin: true, id: 1, result: { cash: '75' } });
  assert.deepEqual(bridge.activity[3].data.error, {
    code: 'invalid-request',
    message: 'A request ID must be larger than the last.',
  });
  assert.equal(bridge.activity[5].data.error.code, 'unknown-method');
  assert.match(bridge.activity[7].data.error, /Invalid HookedIn request/);
  bridge.detach();
});

test('diagnostic failures cannot interrupt request execution, error replies or later requests', async () => {
  let failing = true;
  const bridge = harness(
    () => {
      if (failing) {
        failing = false;
        throw new Error('Settlement failed');
      }
      return { cash: '100' };
    },
    () => {
      throw new Error('Log unavailable');
    },
  );
  await bridge.send(request(1));
  await bridge.send(request(2));
  assert.deepEqual(bridge.replies[0].message.error, { code: 'failed', message: 'Settlement failed' });
  assert.deepEqual(bridge.replies[1].message.result, { cash: '100' });
  assert.equal(bridge.calls.length, 2);
  assert.deepEqual(
    bridge.activity.map(entry => entry.type),
    ['request', 'error', 'request', 'response'],
  );
  bridge.detach();
});

test('bridge executes only a request ID larger than the last, whatever action it carries', async () => {
  const bridge = harness();
  await bridge.send(request(2, 'game.bet', params));
  for (const id of [2, 1, 0]) {
    await bridge.send(request(id, 'game.bet', { ...params, stake: '11' }));
    assert.deepEqual(bridge.replies.at(-1).message, {
      hookedin: true,
      id,
      error: { code: 'invalid-request', message: 'A request ID must be larger than the last.' },
    });
  }
  assert.deepEqual(bridge.calls, [{ method: 'game.bet', params }]);
  bridge.detach();
});

test('a page the frame loads afresh counts from the start and never hears an answer meant for the page before it', async () => {
  const pending = deferred();
  // Only the bet stays open; everything else is answered at once.
  const bridge = harness(method => (method === 'game.bet' ? pending.promise : { cash: '200' }));
  await bridge.send(request(1));
  // The wallet reloads the game, for instance to play with another asset, while a request is still open.
  const open = bridge.send(request(7, 'game.bet', params));
  bridge.reload();
  await bridge.send(request(1));
  assert.deepEqual(bridge.replies.at(-1).message, { hookedin: true, id: 1, result: { cash: '200' } });
  (pending.resolve! as any)({ cash: '100' });
  await open;
  assert.equal(bridge.replies.filter(reply => reply.message.id === 7).length, 0, "the old page's answer is dropped");
  await bridge.send(request(2));
  assert.deepEqual(bridge.replies.at(-1).message.result, { cash: '200' }, 'and did not leave the new page waiting');
  bridge.detach();
});

test('operations take their turn in the order asked, while questions are answered at once', async () => {
  const pending = deferred();
  let first = true;
  const bridge = harness(method => {
    if (method === 'game.bet' && first) {
      first = false;
      return pending.promise;
    }
    return { cash: '200' };
  });
  const operation = bridge.send(request(1, 'game.bet', params));
  const queued = bridge.send(request(2, 'game.bet', { ...params, id: 'op-2' }));
  await Promise.resolve();
  assert.equal(bridge.calls.length, 1, 'the second bet waits for the first');
  // A question never waits behind a bet or the player's dialog.
  await bridge.send(request(3, 'game.receipt', { id: 'op-1' }));
  assert.deepEqual(bridge.replies.at(-1).message, { hookedin: true, id: 3, result: { cash: '200' } });
  assert.equal(bridge.calls.length, 2);

  (pending.resolve! as any)({ cash: '100' });
  await Promise.all([operation, queued]);
  assert.deepEqual(
    bridge.replies.map(reply => reply.message.id),
    [3, 1, 2],
  );
  assert.deepEqual(
    bridge.calls.map(call => call.params.id),
    ['op-1', 'op-1', 'op-2'],
  );
  await bridge.send(request(2, 'game.bet', params));
  assert.equal(bridge.replies.at(-1).message.error.code, 'invalid-request', 'an answered ID cannot be replayed');
  bridge.detach();
});

test('a game cannot pile up more operations than the wallet will hold', async () => {
  const pending = deferred();
  const bridge = harness(() => pending.promise);
  const open = Array.from({ length: 33 }, (_, i) => bridge.send(request(i + 1, 'game.bet', params)));
  assert.deepEqual(
    bridge.replies.map(reply => [reply.message.id, reply.message.error.code]),
    [[33, 'busy']],
    'the thirty-third is refused while thirty-two wait',
  );
  (pending.resolve! as any)({ cash: '1' });
  await Promise.all(open);
  assert.equal(bridge.calls.length, 32);
  bridge.detach();
});

test('bridge reports operation failure and releases the operation lock', async () => {
  let failing = true;
  const bridge = harness(() => {
    if (failing) {
      failing = false;
      throw Object.assign(new Error('Detailed internal error'), { shortMessage: 'Approval rejected' });
    }
    return null;
  });
  await bridge.send(request(1));
  assert.deepEqual(bridge.replies[0].message.error, { code: 'failed', message: 'Approval rejected' });
  assert.deepEqual(bridge.errors, ['Approval rejected']);
  await bridge.send(request(2));
  assert.equal(bridge.replies[1].message.result, null);
  assert.equal(bridge.calls.length, 2);
  bridge.detach();
});

test('detaching a bridge removes its listener and prevents further dispatch', async () => {
  const bridge = harness();
  assert.equal(bridge.target.listeners.size, 1);
  bridge.detach();
  assert.equal(bridge.target.listeners.size, 0);
  await bridge.send(request());
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.replies.length, 0);
});

test('validation excludes wallet signing and private key methods from the iframe API', () => {
  for (const method of [
    'wallet.privateKey',
    'wallet.sign',
    'wallet.signMessage',
    'wallet.sendTransaction',
    'eth_sendTransaction',
    'eth_sign',
    'personal_sign',
    'wallet.authorize',
    'wallet.approve',
    'wallet.setLimits',
    'wallet.resume',
  ]) {
    assert.throws(() => validateRequest(request(1, method)), /not available to games/, method);
  }
});

test('validation rejects developer and wallet-field injection before dispatch', async () => {
  const bridge = harness();
  for (const field of [
    'developer',
    'developerFeeRecipient',
    'recipient',
    'privateKey',
    'transaction',
    'to',
    'value',
    'signature',
    'autoApprove',
    'approved',
    'limits',
    'grant',
  ]) {
    const message = bet({ [field]: 'attacker-controlled' });
    assert.throws(() => validateRequest(message), /Unexpected game request field/);
    await bridge.send(message);
    assert.match(bridge.replies.at(-1).message.error.message, /Unexpected game request field/);
    assert.equal(bridge.replies.at(-1).message.error.code, 'invalid-request');
  }
  assert.equal(bridge.calls.length, 0);
  assert.throws(() => validateRequest({ ...request(), developer: 'attacker' }), /Invalid HookedIn request/);
  assert.throws(() => validateRequest(request(1, 'wallet.info', { privateKey: true })), /takes no parameters/);
  assert.throws(() => validateRequest(request(1, 'wallet.hello', { privateKey: true })), /takes no parameters/);
  assert.throws(
    () => validateRequest(bet({ options: { chanceBps: 4950, developer: 'attacker' } })),
    /Unexpected game request field/,
  );
  bridge.detach();
});

test('oversized requests never reach wallet logic', async () => {
  const message = bet({ data: 'x'.repeat(70000) });
  assert.throws(() => validateRequest(message), /too large/);
  const bridge = harness();
  await bridge.send(message);
  assert.equal(bridge.calls.length, 0);
  assert.match(bridge.replies[0].message.error.message, /too large/);
  bridge.detach();
});

test('the envelope is bounded structurally, without serializing wide or deep payloads', () => {
  assert.throws(() => validateRequest(bet({ data: Array.from({ length: 20000 }, () => 'wide') })), /too large/);
  let deep: any = null;
  for (let i = 0; i < 100; i++) deep = { deep };
  assert.throws(() => validateRequest(bet({ data: deep })), /too large/);
});

test('a message relayed by a frame nested inside the game iframe is ignored', async () => {
  const bridge = harness();
  const nested = { postMessage: () => assert.fail('A nested frame must not receive a reply') };
  await bridge.send(request(1), nested);
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.replies.length, 0);
  assert.equal(bridge.activity.length, 0);
  bridge.detach();
});

test('a funding request carries a suggested amount and nothing else', () => {
  const fund = (params: any) => validateRequest(request(1, 'game.requestFunds', params));
  assert.deepEqual(fund({}).params, {});
  assert.equal(fund({ amount: '5' }).params.amount, '5');
  assert.throws(() => fund({ amount: '0' }), /range/);
  assert.throws(() => fund({ amount: 5 }), /wei/);
  // Every word in the wallet's authorization is the wallet's own.
  for (const field of ['reason', 'developer', 'approved', 'autoApprove', 'revision', 'data'])
    assert.throws(() => fund({ [field]: '1' }), /Unexpected game request field/);
});

test('a wallet offers games only the methods it lists', () => {
  for (const method of ['game.buyIn', 'game.table', 'game.identify', 'wallet.keys'])
    assert.throws(() => validateRequest(request(1, method, {})), /not available to games/);
});

test('validation accepts only plain parameter records and bounded exact terms', () => {
  for (const value of [[], new Date(), 'params', 1, true, Object.create({ revision: 0 })])
    assert.throws(() => validateRequest(request(1, 'game.bet', value)), /parameters must be an object/);
  for (const id of ['1', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null, {}])
    assert.throws(() => validateRequest(request(id as any)), /Invalid request ID/);
  assert.equal(validateRequest(request(0)).id, 0);
  for (const stake of ['0', '-1', '1.1', '1e18', '01', 1, '1'.repeat(79)])
    assert.throws(() => validateRequest(bet({ stake })));
  for (const id of ['', 'x'.repeat(65), 'no spaces', 'a/b', 7])
    assert.throws(() => validateRequest(bet({ id })), /operation ID/);
  assert.throws(() => validateRequest(bet({ revision: 1 })), /Unexpected/);
  assert.equal(validateRequest(request(1, 'game.receipt', { id: 'round-1:attempt-2' })).params.id, 'round-1:attempt-2');
  assert.throws(() => validateRequest(request(1, 'game.receipt', {})), /operation ID/);
  assert.throws(() => validateRequest(bet({ outcome: 'win' })), /Unexpected/);
  assert.equal(validateRequest(bet()).params.stake, '10');
  // The stake is paid to enter; up to 64 prizes, which may overlap, each pay within [0, 2^64).
  const whole = { rangeStart: '0', rangeEnd: String(1n << 64n), payout: '1' };
  assert.equal(validateRequest(bet({ prizes: [prize, prize, whole] })).params.prizes.length, 3);
  assert.equal(validateRequest(bet({ prizes: Array(64).fill(prize) })).params.prizes.length, 64);
  for (const prizes of [undefined, [], Array(65).fill(prize), 'prizes', [null], [[0, 100, 20]]])
    assert.throws(() => validateRequest(bet({ prizes })), /prize/i);
  for (const bad of [
    { rangeStart: '100' },
    { rangeEnd: String((1n << 64n) + 1n) },
    { payout: '0' },
    { payout: 20 },
    { rangeStart: '-1' },
    { netWin: '5' },
  ])
    assert.throws(() => validateRequest(bet({ prizes: [{ ...prize, ...bad }] })));
  assert.throws(() => validateRequest(bet({ winThreshold: '5' })), /Unexpected/, 'one way to state the odds');
  // A bet on a shared round names the round its host opened, and the hash of the host's seed.
  const round = { id: '0x' + '22'.repeat(32), seedHash: '0x' + '33'.repeat(32) };
  const shared = (overrides: any) => request(1, 'game.bet', { ...params, round, ...overrides });
  assert.equal(validateRequest(shared({})).params.round.id, round.id);
  assert.throws(() => validateRequest(shared({ round: { ...round, seedHash: '0x12' } })), /Invalid round/);
  assert.throws(() => validateRequest(shared({ round: { id: round.id, seed: round.seedHash } })), /Invalid round/);
  assert.throws(() => validateRequest(shared({ round: { ...round, id: '0x12' } })), /Invalid round/);
  assert.throws(() => validateRequest(shared({ round: { ...round, host: 'x' } })), /Invalid round/);
  assert.equal(validateRequest(request(1, 'game.cancel', { id: 'hand-1' })).params.id, 'hand-1');
  assert.throws(() => validateRequest(request(1, 'game.cancel', { id: 'hand-1', stake: '1' })), /Unexpected/);
  const safe = Object.assign(Object.create(null), params);
  assert.equal(validateRequest(request(1, 'game.bet', safe)).params.stake, '10');
});
