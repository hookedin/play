import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGameBridge, validateRequest } from '../client/bridge.ts';
import { checkDetails, KIND } from '../protocol/protocol.ts';

const request = (id = 1, method = 'wallet.info', params = {}) => ({ hookedin: true, id, method, params });
const params = { id: 'op-1', stake: '10', chance: '100', prize: '20' };
const bet = (overrides: any = {}) => request(1, 'game.casinoBet', { ...params, ...overrides });

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
  let current = true;
  const detach = attachGameBridge({
    iframe: { contentWindow: child } as any,
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
    child,
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
  await bridge.send(request(2, 'game.casinoBet', params));
  for (const id of [2, 1, 0]) {
    await bridge.send(request(id, 'game.casinoBet', { ...params, stake: '11' }));
    assert.deepEqual(bridge.replies.at(-1).message, {
      hookedin: true,
      id,
      error: { code: 'invalid-request', message: 'A request ID must be larger than the last.' },
    });
  }
  assert.deepEqual(bridge.calls, [{ method: 'game.casinoBet', params }]);
  bridge.detach();
});

test('a page the frame loads afresh counts from its greeting and never hears an answer meant for the page before it', async () => {
  const pending = deferred();
  // Only the bet stays open; everything else is answered at once.
  const bridge = harness(method => (method === 'game.casinoBet' ? pending.promise : { cash: '200' }));
  await bridge.send(request(1, 'wallet.hello'));
  const open = bridge.send(request(7, 'game.casinoBet', params));
  const queued = bridge.send(request(8, 'game.payment', { id: 'op-2', amount: '10' }));
  // The wallet reloads the game, for instance to play with the other money, while a bet is open and a payment waits.
  // The page that follows greets it with its first ID, whenever the frame's load event comes.
  await bridge.send(request(1, 'wallet.hello'));
  assert.deepEqual(bridge.replies.at(-1).message, { hookedin: true, id: 1, result: { cash: '200' } });
  (pending.resolve! as any)({ cash: '100' });
  await Promise.all([open, queued]);
  assert.equal(bridge.replies.filter(reply => reply.message.id >= 7).length, 0, "the old page's answers are dropped");
  assert.equal(bridge.calls.filter(call => call.method === 'game.payment').length, 0, 'and its waiting payment too');
  await bridge.send(request(2));
  assert.deepEqual(bridge.replies.at(-1).message.result, { cash: '200' }, 'and did not leave the new page waiting');
  // Only a greeting starts a page: any other request whose ID does not rise is refused.
  await bridge.send(request(2));
  assert.equal(bridge.replies.at(-1).message.error.code, 'invalid-request');
  bridge.detach();
});

test('operations take their turn in the order asked, while questions are answered at once', async () => {
  const pending = deferred();
  let first = true;
  const bridge = harness(method => {
    if (method === 'game.casinoBet' && first) {
      first = false;
      return pending.promise;
    }
    return { cash: '200' };
  });
  const operation = bridge.send(request(1, 'game.casinoBet', params));
  const queued = bridge.send(request(2, 'game.casinoBet', { ...params, id: 'op-2' }));
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
  await bridge.send(request(2, 'game.casinoBet', params));
  assert.equal(bridge.replies.at(-1).message.error.code, 'invalid-request', 'an answered ID cannot be replayed');
  bridge.detach();
});

test('a game cannot pile up more operations than the wallet will hold', async () => {
  const pending = deferred();
  const bridge = harness(() => pending.promise);
  const open = Array.from({ length: 33 }, (_, i) => bridge.send(request(i + 1, 'game.casinoBet', params)));
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

test('requests still waiting their turn when their game closes never reach the wallet', async () => {
  // The wallet detaches the bridge when the player opens another game, and a channel change leaves it current no more.
  for (const close of ['detach', 'not current'] as const) {
    const pending = deferred(),
      started = deferred();
    let first = true;
    const bridge = harness(() => {
      if (!first) return { cash: '1' };
      first = false;
      started.resolve();
      return pending.promise;
    });
    const open = bridge.send(request(1, 'game.casinoBet', params));
    await started.promise;
    const queued = [
      bridge.send(request(2, 'game.payment', { id: 'op-2', amount: '10' })),
      bridge.send(request(3, 'game.requestFunds', {})),
    ];
    if (close === 'detach') bridge.detach();
    else bridge.setCurrent(false);
    (pending.resolve! as any)({ cash: '100' });
    await Promise.all([open, ...queued]);
    assert.deepEqual(
      bridge.calls.map(call => call.method),
      ['game.casinoBet'],
      close,
    );
    assert.equal(bridge.replies.length, 0, close);
  }
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
  // A round is read by its hash, and by nothing else.
  const round = '0x' + 'ab'.repeat(32);
  assert.deepEqual(validateRequest(request(1, 'wallet.round', { id: round })).params, { id: round });
  for (const params of [{}, { id: round.slice(0, 65) }, { id: 7 }, { id: round, asset: 'eth' }])
    assert.throws(() => validateRequest(request(1, 'wallet.round', params)), /32-byte hash/);
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
    assert.throws(() => validateRequest(request(1, 'game.casinoBet', value)), /parameters must be an object/);
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
  // The stake is paid to enter, and the prize comes back when the outcome is below the chance: 1 to 2^64 − 1 of the 2^64.
  assert.equal(validateRequest(bet({ chance: String((1n << 64n) - 1n) })).params.chance, String((1n << 64n) - 1n));
  for (const chance of [undefined, '0', String(1n << 64n), '-1', 5, 'half'])
    assert.throws(() => validateRequest(bet({ chance })));
  assert.throws(() => validateRequest(bet({ chance: String(1n << 64n) })), /chance/);
  for (const prize of [undefined, '0', 20, '-1']) assert.throws(() => validateRequest(bet({ prize })));
  assert.throws(() => validateRequest(bet({ prize: String(1n << 128n) })), /prize is below 2\^128/);
  for (const bad of [{ odds: '5' }, { probability: '0.5' }, { payouts: [] }])
    assert.throws(() => validateRequest(bet(bad)), /Unexpected/, 'one way to state the odds');
  // A casino bet settles now, on the wallet's own round. A developer bet is its developer's to settle, on its word, and
  // its meta is the game's own. A group labels any of them.
  assert.throws(() => validateRequest(bet({ round: '0x' + '22'.repeat(32) })), /Unexpected/);
  assert.throws(() => validateRequest(bet({ meta: { pick: 'home' } })), /Unexpected/);
  const onWord = (overrides: any) =>
    request(1, 'game.developerBet', { id: 'hand-1', stake: '10', meta: { pick: 'home' }, ...overrides });
  assert.deepEqual(validateRequest(onWord({})).params.meta, { pick: 'home' });
  for (const bad of [{ chance: '100' }, { round: '0x' + '22'.repeat(32) }, { terms: {} }])
    assert.throws(() => validateRequest(onWord(bad)), /Unexpected/);
  // Its meta is held to the rule the casino holds it to: a JSON object, whole numbers, 4,096 bytes at most.
  for (const bad of [
    { meta: 'home' },
    { meta: null },
    { meta: ['home'] },
    { meta: undefined },
    { meta: { odds: 1.5 } },
    { meta: { pick: undefined } },
    { meta: { note: 'x'.repeat(4096) } },
  ])
    assert.throws(() => validateRequest(onWord(bad)), /meta is a JSON object/);
  assert.deepEqual(validateRequest(onWord({ meta: { odds: '1.5', n: 3 } })).params.meta, { odds: '1.5', n: 3 });
  assert.equal(validateRequest(onWord({ group: 'match-9' })).params.group, 'match-9');
  for (const group of ['', 'x'.repeat(65), 7]) assert.throws(() => validateRequest(bet({ group })), /group/);
  assert.throws(() => validateRequest(request(1, 'game.enter', { id: 'hand-1', stake: '10' })), /not available/);
  const safe = Object.assign(Object.create(null), params);
  assert.equal(validateRequest(request(1, 'game.casinoBet', safe)).params.stake, '10');
});

test('a debit that names a game and carries meta is a developer bet, and nothing else carries meta', () => {
  const game = '0x' + '1'.repeat(64),
    fund = '0x' + '2'.repeat(64),
    id = '0x' + '3'.repeat(64),
    meta = { pick: 'home' };
  checkDetails(KIND.debit, { id, game, meta });
  checkDetails(KIND.debit, { id, game, group: 'match-9', meta });
  for (const [kind, details] of [
    [KIND.casinoBet, { id, game, meta }],
    [KIND.debit, { id, counterparty: fund, meta }],
    [KIND.credit, { id, counterparty: fund, meta }],
    [KIND.debit, { id, game, meta: { odds: 1.5 } }],
  ] as const)
    assert.throws(() => checkDetails(kind, details as any), /Invalid operation details/);
});
