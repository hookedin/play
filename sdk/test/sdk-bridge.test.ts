import test from 'node:test';
import assert from 'node:assert/strict';

test('the game SDK greets the wallet, accepts only parent-window replies, delivers balance pushes and numbers its requests upwards', async () => {
  const posted: any[] = [],
    listeners: ((event: any) => void)[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  (globalThis as any).window = { parent, addEventListener: (_: string, fn: any) => listeners.push(fn) };
  try {
    const { HookedIn, HookedInError } = await import('../src/sdk.ts');
    const deliver = (source: unknown, data: any) => listeners.forEach(listener => listener({ source, data }));
    // The page greets the wallet as it loads, and a balance the wallet pushes reaches the game at once.
    assert.deepEqual([...posted], [{ hookedin: true, id: 1, method: 'wallet.hello', params: {} }]);
    const early: any[] = [];
    const stopEarly = HookedIn.onBalance(balance => early.push(balance));
    deliver(parent, { hookedin: true, event: 'game.balance', balance: '3', pending: false });
    assert.deepEqual(early, [{ balance: '3', pending: false }]);
    stopEarly();
    const hello = { limits: { outcomeSpace: String(1n << 64n), meta: 4096, group: 64 } };
    deliver(parent, { hookedin: true, id: 1, result: hello });
    assert.deepEqual(await HookedIn.hello(), hello);
    // Amounts are ETH, counted in wei.
    assert.equal(HookedIn.parseAmount('1.5'), '1500000000000000000');
    assert.equal(HookedIn.formatAmount('1500000000000000000'), '1.5');
    assert.equal(HookedIn.formatAmount('1', 2), '<0.01');
    assert.throws(() => HookedIn.parseAmount('0.0000000000000000001'), /18 decimal places/);
    // A refusal carries a code the game can act on.
    const refused = HookedIn.call('game.casinoBet');
    deliver(parent, {
      hookedin: true,
      id: posted.at(-1).id,
      error: { code: 'insufficient-funds', message: 'Bet exceeds the game balance' },
    });
    await assert.rejects(
      refused,
      (error: any) =>
        error instanceof HookedInError && error.code === 'insufficient-funds' && /exceeds/.test(error.message),
    );
    const reply = HookedIn.info();
    const { id, method } = posted.at(-1);
    assert.equal(method, 'wallet.info');
    for (const [source, result] of [
      [{}, 'forged'],
      [parent, 'real'],
    ] as const)
      listeners.forEach(listener => listener({ source, data: { hookedin: true, id, result } }));
    assert.equal(await reply, 'real');
    const balances: any[] = [];
    const stop = HookedIn.onBalance(balance => balances.push(balance));
    deliver({}, { hookedin: true, event: 'game.balance', balance: '7', enabled: true, pending: false });
    deliver(parent, { hookedin: true, event: 'game.balance', balance: '7', pending: false, stray: true });
    deliver(parent, { hookedin: true, event: 'game.balance', balance: '0', pending: 'yes' });
    assert.deepEqual(balances, [
      { balance: '7', pending: false },
      { balance: '0', pending: false },
    ]);
    stop();
    deliver(parent, { hookedin: true, event: 'game.balance', balance: '9', enabled: true, pending: false });
    assert.equal(balances.length, 2);
    const funding = HookedIn.requestFunds({ amount: 12n });
    const sent = posted.at(-1);
    assert.equal(sent.method, 'game.requestFunds');
    assert.deepEqual(sent.params, { amount: '12' });
    deliver(parent, {
      hookedin: true,
      id: sent.id,
      result: { funded: false, amount: null, balance: '7', enabled: true },
    });
    assert.equal((await funding).funded, false);
    // Typed methods send their bridge method, and every envelope ID is a safe integer above the last.
    const bet = { id: 'coin', stake: '5', chance: '9', prize: '10', group: 'hand-1' };
    const calls = [HookedIn.casinoBet(bet), HookedIn.developerBet({ id: 'seat', stake: '5', meta: { seat: 2 } })];
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
  } finally {
    delete (globalThis as any).window;
  }
});

test('balance() refuses outside a frame as call does, a greeting that failed is asked again, and a silent wallet times out', async t => {
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
    await assert.rejects(HookedIn.balance(), refused('no-wallet'));
    assert.equal(posted.length, 0);
    // In a wallet's frame, a greeting the wallet refused is forgotten, and the next call asks again.
    page.parent = parent;
    const deliver = (data: any) => listeners.forEach(listener => listener({ source: parent, data }));
    const refusedGreeting = HookedIn.hello();
    deliver({ hookedin: true, id: posted.at(-1).id, error: { code: 'game-closed', message: 'No game is open' } });
    await assert.rejects(refusedGreeting, refused('game-closed'));
    const greeting = HookedIn.hello();
    assert.deepEqual(
      posted.map(message => message.method),
      ['wallet.hello', 'wallet.hello'],
    );
    const hello = { limits: { outcomeSpace: String(1n << 64n), meta: 4096, group: 64 } };
    deliver({ hookedin: true, id: posted.at(-1).id, result: hello });
    assert.deepEqual(await greeting, hello);
    // Greeted, with nothing pushed: balance() waits as long as a request would, then gives up.
    const silent = HookedIn.balance();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(180000);
    await assert.rejects(silent, refused('timeout'));
    // A push ends the wait.
    const pushed = HookedIn.balance();
    deliver({ hookedin: true, event: 'game.balance', balance: '5', pending: false });
    assert.deepEqual(await pushed, { balance: '5', pending: false });
  } finally {
    delete (globalThis as any).window;
  }
});
