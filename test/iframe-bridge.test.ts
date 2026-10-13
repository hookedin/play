import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGameBridge, validateRequest } from '../client/bridge.ts';
import { checkDetails, counterpartyPlayer, KIND } from '../protocol/protocol.ts';
import { MAX_BALANCE } from '../protocol/risk.ts';

const request = (id = 1, method = 'wallet.info', params = {}) => ({ hookedin: true, id, method, params });
const won = { weight: 1n, cash: 20n, label: 'win' },
  lost = { weight: 1n, cash: 0n };
const params = { id: 'op-1', cash: 10n, results: [won, lost] };
const bet = (overrides: any = {}) => request(1, 'game.casinoBet', { ...params, ...overrides });
/** A step of two results, with its first one changed. */
const result = (overrides: any = {}, step: any = {}) => bet({ results: [{ ...won, ...overrides }, lost], ...step });

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

function harness(onRequest: (...args: any[]) => any = async () => ({ cash: '100' })) {
  const target = new FakeEventTarget();
  const replies: any[] = [];
  const calls: any[] = [];
  const errors: any[] = [];
  const child = { postMessage: (message: any, destination: any) => replies.push({ message, destination }) };
  let current = true;
  const { dispose: detach, push } = attachGameBridge({
    iframe: { contentWindow: child } as any,
    origin: ORIGIN,
    target,
    isCurrent: () => current,
    onRequest: async (method, params) => {
      calls.push({ method, params });
      return onRequest(method, params);
    },
    onError: message => errors.push(message),
  });
  return {
    target,
    replies,
    calls,
    errors,
    child,
    detach,
    push,
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

  bridge.setCurrent(true);
  const operation = bridge.send(request(2));
  assert.equal(bridge.calls.length, 1);
  bridge.setCurrent(false);
  (pending.resolve! as any)({ cash: '50' });
  await operation;
  assert.equal(bridge.replies.length, 0, 'The new game must not receive the previous game result');
  bridge.detach();
});

test('bridge executes only a request ID larger than the last, whatever action it carries', async () => {
  const bridge = harness();
  await bridge.send(request(2, 'game.casinoBet', params));
  for (const id of [2, 1, 0]) {
    await bridge.send(request(id, 'game.casinoBet', { ...params, id: 'op-2' }));
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
  const queued = bridge.send(request(8, 'game.payment', { id: 'op-2', amount: 10n }));
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
  // A question never waits behind a bet.
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

test('the wallet tells only a page that greeted it, at the game origin, while its game is open', async () => {
  const bridge = harness(async () => ({ bounds: {} })),
    pushed = () => bridge.replies.filter(reply => 'event' in reply.message);
  // A page that has not greeted the wallet yet asks for what it needs once it has.
  bridge.push('game.allowance', { allowance: 5n, pending: false, developerBets: false });
  await bridge.send(request(1));
  assert.deepEqual(pushed(), []);
  await bridge.send(request(2, 'wallet.hello'));
  bridge.push('game.allowance', { allowance: 5n, pending: false, developerBets: false });
  assert.deepEqual(pushed(), [
    {
      message: { hookedin: true, event: 'game.allowance', allowance: 5n, pending: false, developerBets: false },
      destination: ORIGIN,
    },
  ]);
  // The frame loaded the page afresh, and it greeted the wallet in turn.
  await bridge.send(request(1, 'wallet.hello'));
  bridge.push('game.allowance', { allowance: 6n, pending: false, developerBets: false });
  assert.equal(pushed().length, 2);
  bridge.setCurrent(false);
  bridge.push('game.allowance', { allowance: 7n, pending: false, developerBets: false });
  bridge.setCurrent(true);
  bridge.detach();
  bridge.push('game.allowance', { allowance: 8n, pending: false, developerBets: false });
  assert.equal(pushed().length, 2);
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
      bridge.send(request(2, 'game.payment', { id: 'op-2', amount: 10n })),
      bridge.send(request(3, 'game.developerBet', { id: 'op-3', stake: 10n, meta: {} })),
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
    'bounds',
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
  bridge.detach();
});

test('a game asks for no allowance: it says it places developer bets, and nothing else', () => {
  assert.throws(() => validateRequest(request(1, 'game.requestAllowance', {})), /not available to games/);
  const say = (params: any) => validateRequest(request(1, 'game.placesDeveloperBets', params));
  assert.deepEqual(say({}).params, {});
  // Every word in the wallet's authorization is the wallet's own, and only the player sets an amount.
  for (const field of ['amount', 'reason', 'developer', 'approved', 'autoApprove', 'data'])
    assert.throws(() => say({ [field]: '1' }), /no parameters/);
});

test('the allowance is read whole or for a group, and a group ends by its label', () => {
  const check = (method: string, params: any) => validateRequest(request(1, method, params)).params;
  assert.deepEqual(check('game.allowance', {}), {});
  assert.deepEqual(check('game.allowance', { group: 'round-1' }), { group: 'round-1' });
  assert.deepEqual(check('game.end', { group: 'round-1' }), { group: 'round-1' });
  assert.throws(() => check('game.end', {}), /group is a label/);
  for (const method of ['game.allowance', 'game.end']) {
    assert.throws(() => check(method, { group: '' }), /group is a label/);
    assert.throws(() => check(method, { group: 'x'.repeat(65) }), /group is a label/);
    assert.throws(() => check(method, { group: 'a', id: 'b' }), /Unexpected game request field/);
  }
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
  // An amount is a bigint of wei, and nothing it could be read as: a decimal string or a number is refused.
  for (const cash of [0n, -1n, MAX_BALANCE, '10', 10, 1.5, null])
    assert.throws(() => validateRequest(bet({ cash })), /A step holds an amount of wei below 2\^96/);
  const paying = (kept: unknown) => request(1, 'game.payment', { id: 'op-1', amount: 10n, group: 'hand-1', kept });
  assert.throws(() => validateRequest(paying('0')), /An amount is a bigint of wei/);
  assert.equal(validateRequest(paying(0n)).params.kept, 0n);
  assert.throws(
    () => validateRequest(bet({ group: 'hand-1', kept: 0n })),
    /Unexpected/,
    'a step keeps what its results leave',
  );
  // A step is 1 to 128 results, each a whole-number weight, the cash it leaves and at most a printable label, weighing
  // less than 2^256 together, whose amounts pair up into at most 64 bets.
  for (const bad of [
    { weight: 0n },
    { weight: -1n },
    { weight: 1 },
    { weight: '1' },
    { weight: undefined },
    { cash: -1n },
    { cash: MAX_BALANCE },
    { cash: '20' },
    { cash: 20 },
    { label: '' },
    { label: 'x'.repeat(65) },
    { label: 'a\u0000b' },
    { label: 7 },
    { odds: '5' },
  ])
    assert.throws(() => validateRequest(result(bad)), /A step holds/);
  assert.equal(validateRequest(result({ label: 'x'.repeat(64) })).params.results[0].label.length, 64);
  for (const results of [[], Array(129).fill(won), 'one', [{}], [won, null]])
    assert.throws(() => validateRequest(bet({ results })), /A step holds/);
  assert.equal(validateRequest(bet({ results: [...Array(127).fill(won), lost] })).params.results.length, 128);
  assert.throws(() => validateRequest(result({ weight: (1n << 256n) - 1n })), /A step holds/);
  assert.equal(validateRequest(result({ weight: (1n << 256n) - 2n })).params.results[0].weight, (1n << 256n) - 2n);
  // Eight amounts below the cash and eight above pair into 64 bets; nine below, 72.
  const amounts = (below: number, above: number) =>
    bet({
      cash: 100n,
      results: [
        ...Array.from({ length: below }, (_, i) => ({ weight: 1n, cash: BigInt(i) })),
        ...Array.from({ length: above }, (_, i) => ({ weight: 1n, cash: 101n + BigInt(i) })),
      ],
    });
  assert.equal(validateRequest(amounts(8, 8)).params.results.length, 16);
  assert.throws(() => validateRequest(amounts(9, 8)), /at most 64/);
  // A step of one amount keeps its cash: it draws a result and bets nothing, in a group or not.
  assert.equal(validateRequest(bet({ results: [{ weight: 1n, cash: 10n }] })).params.results.length, 1);
  for (const cash of [9n, 11n])
    assert.throws(() => validateRequest(bet({ results: [{ weight: 1n, cash }] })), /keeps its cash/);
  for (const id of ['', 'x'.repeat(65), 'no spaces', 'a/b', 7])
    assert.throws(() => validateRequest(bet({ id })), /operation ID/);
  assert.throws(() => validateRequest(bet({ revision: 1 })), /Unexpected/);
  assert.equal(validateRequest(request(1, 'game.receipt', { id: 'round-1:attempt-2' })).params.id, 'round-1:attempt-2');
  assert.throws(() => validateRequest(request(1, 'game.receipt', {})), /operation ID/);
  assert.throws(() => validateRequest(bet({ outcome: 'win' })), /Unexpected/);
  assert.equal(validateRequest(bet()).params.cash, 10n);
  for (const bad of [{ odds: '5' }, { probability: '0.5' }, { payouts: [] }, { branches: [] }])
    assert.throws(() => validateRequest(bet(bad)), /Unexpected/, 'one way to state the odds');
  // A casino bet settles now, on the wallet's own round. A developer bet is its developer's to settle, on its word, and
  // its meta is the game's own; it may ride on a round its developer committed to. A group labels any of them.
  assert.throws(() => validateRequest(bet({ round: '0x' + '22'.repeat(32) })), /Unexpected/);
  assert.throws(() => validateRequest(bet({ meta: { pick: 'home' } })), /Unexpected/);
  const onWord = (overrides: any) =>
    request(1, 'game.developerBet', { id: 'hand-1', stake: 10n, meta: { pick: 'home' }, ...overrides });
  assert.deepEqual(validateRequest(onWord({})).params.meta, { pick: 'home' });
  assert.equal(validateRequest(onWord({ round: '0x' + '22'.repeat(32) })).params.round, '0x' + '22'.repeat(32));
  for (const round of ['0x' + '2'.repeat(63), '0x' + 'AB'.repeat(32), 7])
    assert.throws(() => validateRequest(onWord({ round })), /A round is the hash/);
  for (const bad of [{ chance: '100' }, { terms: {} }]) assert.throws(() => validateRequest(onWord(bad)), /Unexpected/);
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
    assert.throws(() => validateRequest(onWord(bad)), /Meta is a JSON object/);
  assert.deepEqual(validateRequest(onWord({ meta: { odds: '1.5', n: 3 } })).params.meta, { odds: '1.5', n: 3 });
  // A group ends with meta held to the same rule, and a history is read a page of 1 to 100 entries at a time.
  const ended = (meta: unknown) => request(1, 'game.end', { group: 'hand-1', meta });
  assert.deepEqual(validateRequest(ended({ cards: ['K', '7'] })).params.meta, { cards: ['K', '7'] });
  for (const meta of ['K', null, { odds: 1.5 }]) assert.throws(() => validateRequest(ended(meta)), /Meta is a JSON/);
  const page = (params: any) => request(1, 'game.history', params);
  assert.deepEqual(validateRequest(page({ after: '', limit: 100 })).params, { after: '', limit: 100 });
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: '5' }, { after: 7 }, { after: 'x' }, { game: 'other' }])
    assert.throws(() => validateRequest(page(bad)));
  assert.equal(validateRequest(onWord({ group: 'match-9' })).params.group, 'match-9');
  for (const group of ['', 'x'.repeat(65), 7]) assert.throws(() => validateRequest(bet({ group })), /group/);
  assert.throws(() => validateRequest(request(1, 'game.enter', { id: 'hand-1', stake: 10n })), /not available/);
  const safe = Object.assign(Object.create(null), params);
  assert.equal(validateRequest(request(1, 'game.casinoBet', safe)).params.cash, 10n);
});

test('a debit that names a game and carries meta is a developer bet, and nothing else carries meta', () => {
  const game = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
    fund = '0x' + '2'.repeat(64),
    id = '0x' + '3'.repeat(64),
    meta = { pick: 'home' };
  checkDetails(KIND.debit, { id, game, meta });
  checkDetails(KIND.debit, { id, game, group: 'match-9', meta });
  checkDetails(KIND.debit, { id, game, meta, round: id });
  // A casino bet drawn from a step signs its table: a step of several amounts with the bankroll it was split at.
  const results = [
    { weight: 1n, cash: 20n },
    { weight: 1n, cash: 0n },
  ];
  checkDetails(KIND.casinoBet, { id, game, table: { cash: 10n, bankroll: 10n ** 9n, results } });
  checkDetails(KIND.casinoBet, { id, game, table: { cash: 10n, results: [{ weight: 1n, cash: 10n }] } });
  // A game's payment in a group signs what it leaves with the group.
  checkDetails(KIND.debit, { id, game, group: 'hand-1', kept: 0n });
  for (const [kind, details] of [
    [KIND.casinoBet, { id, game, meta }],
    [KIND.debit, { id, counterparty: fund, meta }],
    [KIND.credit, { id, counterparty: fund, meta }],
    [KIND.debit, { id, game, meta: { odds: 1.5 } }],
    [KIND.debit, { id, game, round: id }],
    [KIND.casinoBet, { id, game, round: id }],
    [KIND.debit, { id, game, meta, round: '0x' + '3'.repeat(63) }],
    [KIND.casinoBet, { id, game, table: { cash: 10n, results } }],
    [KIND.casinoBet, { id, game, table: { cash: 10n, bankroll: 1n, results: [{ weight: 1n, cash: 10n }] } }],
    [KIND.debit, { id, game, table: { cash: 10n, results: [{ weight: 1n, cash: 10n }] } }],
    [KIND.debit, { id, game, kept: 1n }],
    [KIND.debit, { id, game, group: 'hand-1', meta, kept: 1n }],
    [KIND.casinoBet, { id, game, group: 'hand-1', kept: 1n }],
    [KIND.debit, { id, game, group: 'hand-1', kept: -1n }],
  ] as const)
    assert.throws(() => checkDetails(kind, details as any), /Invalid operation details/);
});

test('a transfer is a debit naming the player it pays and collected with a credit naming the player it came from, each by their uname', () => {
  const id = '0x' + '3'.repeat(64),
    uname = '3byt9ocwnnzaxanmiz3stocj';
  checkDetails(KIND.debit, { id, counterparty: '~' + uname });
  checkDetails(KIND.credit, { id, counterparty: '~' + uname });
  assert.equal(counterpartyPlayer('~' + uname), uname);
  // A uname has one form: lowercase, 24 characters of its alphabet, written with its tilde. Nothing else names a player.
  for (const counterparty of [
    uname,
    '~' + uname.toUpperCase(),
    '~' + uname.slice(1),
    '~' + uname + 'k',
    '~' + uname.slice(1) + 'l',
    '@bob',
    '0x' + '2'.repeat(64),
  ])
    assert.equal(counterpartyPlayer(counterparty), null, counterparty);
  for (const [kind, details] of [
    [KIND.debit, { id, counterparty: '~' + uname.toUpperCase() }],
    [KIND.debit, { id, counterparty: '@bob' }],
    [KIND.debit, { id, game: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', counterparty: '~' + uname }],
    [KIND.deposit, { id, counterparty: '~' + uname }],
    [KIND.withdrawal, { id, counterparty: '~' + uname }],
    [KIND.lockIn, { id, counterparty: '~' + uname }],
  ] as const)
    assert.throws(() => checkDetails(kind, details as any), /Invalid operation details/);
});
