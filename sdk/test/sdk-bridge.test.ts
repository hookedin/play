import test from 'node:test';
import assert from 'node:assert/strict';

/** HookedIn's wallet, the origin its replies come from. */
const WALLET = 'https://play.hookedin.com';
/** Until the requests a call makes wait for have gone out. */
const sent = () => new Promise(resolve => setImmediate(resolve));

test('the game SDK greets the wallet, hears only the wallet that answered, sends its typed methods to it and numbers its requests upwards', async () => {
  const posted: any[] = [],
    targets: string[] = [],
    listeners: ((event: any) => void)[] = [];
  const parent = {
    postMessage: (message: any, target: string) => {
      posted.push(message);
      targets.push(target);
    },
  };
  (globalThis as any).window = { parent, addEventListener: (_: string, fn: any) => listeners.push(fn) };
  try {
    const { HookedIn, HookedInError } = await import('../src/sdk.ts');
    const deliver = (source: unknown, data: any, origin = WALLET) =>
      listeners.forEach(listener => listener({ source, data, origin }));
    // The page greets whatever frames it as it loads, and only a wallet's answer counts: HookedIn's, or one at a
    // loopback address on the player's own computer.
    assert.deepEqual([...posted], [{ hookedin: true, id: 1, method: 'wallet.hello', params: {} }]);
    const hello = { bounds: { outcomeSpace: String(1n << 64n), meta: 4096, group: 64 } };
    deliver(parent, { hookedin: true, id: 1, result: { forged: true } }, 'https://play.hookedin.com.example');
    deliver(parent, { hookedin: true, id: 1, result: hello });
    assert.deepEqual(await HookedIn.hello(), hello);
    // Amounts are METH, counted in wei: shown grouped and cut off at a gwei, typed as whole METH.
    assert.equal(HookedIn.parseAmount(' 15 '), '15000000000000');
    assert.throws(() => HookedIn.parseAmount('1.5'), /whole number of METH/);
    assert.equal(HookedIn.formatAmount('1234567891999999999999'), '1,234,567,891.999');
    assert.equal(HookedIn.formatAmount('-1500000000000'), '-1.5');
    assert.equal(HookedIn.formatAmount('1'), '<0.001');
    // A balance reads in whole METH.
    assert.equal(HookedIn.formatAmount('48710895123456789', 0), '48,710');
    assert.equal(HookedIn.formatAmount('1', 0), '<1');
    assert.equal(HookedIn.exactAmount('1234567891999999999999'), '1234567891.999999999999');
    assert.throws(() => HookedIn.parseAmount('0'), /greater than zero/);
    // A stake halved stays whole METH, at least one.
    assert.equal(HookedIn.wholeStake(1500000000000n), 1000000000000n);
    assert.equal(HookedIn.wholeStake(500000000000n), 1000000000000n);
    // A refusal carries a code the game can act on.
    const refused = HookedIn.call('game.casinoBet');
    await sent();
    deliver(parent, {
      hookedin: true,
      id: posted.at(-1).id,
      error: {
        code: 'insufficient-allowance',
        message: 'Not enough allowance for this bet. Set one, or deposit, in the top bar.',
      },
    });
    await assert.rejects(
      refused,
      (error: any) =>
        error instanceof HookedInError && error.code === 'insufficient-allowance' && /top bar/.test(error.message),
    );
    const reply = HookedIn.info();
    await sent();
    const { id, method } = posted.at(-1);
    assert.equal(method, 'wallet.info');
    // Only the parent window, at the origin of the wallet that answered the greeting: not another frame, not another
    // origin, not even another wallet's.
    for (const [source, result, origin] of [
      [{}, 'forged', WALLET],
      [parent, 'forged', 'https://evil.example'],
      [parent, 'forged', 'http://127.0.0.1:4184'],
      [parent, 'real', WALLET],
    ] as const)
      deliver(source, { hookedin: true, id, result }, origin);
    assert.equal(await reply, 'real');
    // The allowance is read, the whole of it or what one group may stake; a game says it places developer bets; and
    // a group the player has seen ends.
    const asks = [
      HookedIn.allowance(),
      HookedIn.allowance('hand-1'),
      HookedIn.placesDeveloperBets(),
      HookedIn.end('hand-1'),
    ];
    await sent();
    assert.deepEqual(
      posted.slice(-4).map(({ method, params }) => ({ method, params })),
      [
        { method: 'game.allowance', params: {} },
        { method: 'game.allowance', params: { group: 'hand-1' } },
        { method: 'game.placesDeveloperBets', params: {} },
        { method: 'game.end', params: { group: 'hand-1' } },
      ],
    );
    for (const { id } of posted.slice(-4)) deliver(parent, { hookedin: true, id, result: null });
    assert.deepEqual(await Promise.all(asks), [null, null, null, null]);
    // Typed methods send their bridge method, and every envelope ID is a safe integer above the last.
    const bet = { id: 'coin', stake: '5', chance: '9', prize: '10', group: 'hand-1' };
    const calls = [HookedIn.casinoBet(bet), HookedIn.developerBet({ id: 'seat', stake: '5', meta: { seat: 2 } })];
    await sent();
    assert.deepEqual(
      posted.slice(-2).map(({ method, params }) => ({ method, params })),
      [
        { method: 'game.casinoBet', params: bet },
        { method: 'game.developerBet', params: { id: 'seat', stake: '5', meta: { seat: 2 } } },
      ],
    );
    for (const { id } of posted.slice(-2)) deliver(parent, { hookedin: true, id, result: id });
    assert.deepEqual(
      await Promise.all(calls),
      posted.slice(-2).map(message => message.id),
    );
    // A developer bet its developer settled reaches the game by itself, once the wallet has collected it.
    const heard: any[] = [];
    const deaf = HookedIn.onReceipt(receipt => heard.push(receipt));
    deliver(parent, { hookedin: true, event: 'game.receipt', receipt: { id: 'seat', status: 'settled' } });
    deaf();
    deliver(parent, { hookedin: true, event: 'game.receipt', receipt: { id: 'later', status: 'settled' } });
    assert.deepEqual(heard, [{ id: 'seat', status: 'settled' }]);
    const ids = posted.map(message => message.id);
    assert.ok(ids.every((id, i) => Number.isSafeInteger(id) && id > (ids[i - 1] ?? 0)));
    // The greeting went to whatever frames the page, and every request after it to the wallet that answered it alone.
    assert.deepEqual(targets, ['*', ...targets.slice(1).map(() => WALLET)]);
  } finally {
    delete (globalThis as any).window;
  }
});

test('allowance() refuses outside a frame as call does, a greeting that failed is asked again, and a silent wallet times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: any[] = [],
    listeners: ((event: any) => void)[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  // A page on its own, with no wallet around it.
  const page: any = { addEventListener: (_: string, fn: any) => listeners.push(fn) };
  page.parent = page;
  (globalThis as any).window = page;
  try {
    // A module of its own: the test above has greeted the one this file imported.
    const fresh = '../src/sdk.ts?again';
    const { HookedIn, HookedInError }: typeof import('../src/sdk.ts') = await import(fresh);
    const refused = (code: string) => (error: any) => error instanceof HookedInError && error.code === code;
    await assert.rejects(HookedIn.allowance(), refused('no-wallet'));
    assert.equal(posted.length, 0);
    // In a wallet's frame, a greeting the wallet refused is forgotten, and the next call asks again.
    page.parent = parent;
    const deliver = (data: any) =>
      listeners.forEach(listener => listener({ source: parent, data, origin: 'http://localhost:4184' }));
    const refusedGreeting = HookedIn.hello();
    deliver({ hookedin: true, id: posted.at(-1).id, error: { code: 'game-closed', message: 'No game is open' } });
    await assert.rejects(refusedGreeting, refused('game-closed'));
    const greeting = HookedIn.hello();
    assert.deepEqual(
      posted.map(message => message.method),
      ['wallet.hello', 'wallet.hello'],
    );
    const hello = { bounds: { outcomeSpace: String(1n << 64n), meta: 4096, group: 64 } };
    deliver({ hookedin: true, id: posted.at(-1).id, result: hello });
    assert.deepEqual(await greeting, hello);
    // A wallet that never answers: the request gives up.
    const silent = HookedIn.allowance();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(180000);
    await assert.rejects(silent, refused('timeout'));
  } finally {
    delete (globalThis as any).window;
  }
});
