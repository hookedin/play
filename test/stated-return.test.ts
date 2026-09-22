import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '../testing/game-wallet.ts';
import { MAX_PRIZES, MAX_ROUND_BETS, OUTCOME_SPACE } from '../protocol/risk.ts';

const SPACE = 1n << 64n;
/** A bet of `stake` that pays `payout` over the first `share` thousandths of the outcome space. */
const bet = (id: string, stake: bigint, payout: bigint, share: bigint) => ({
  id,
  stake: String(stake),
  prizes: [{ rangeStart: '0', rangeEnd: String((SPACE * share) / 1000n), payout: String(payout) }],
});

test('a game is held to the return its manifest states', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('honest', { return: 98.5 }));
  await w.setGameLimit('900000');

  // 49.5% of the outcome space paying double is 99%: more than the game said it would pay back.
  const good = await w.gameBet(bet('keeps-its-word', 1000n, 2000n, 495n));
  assert.equal(good.status, 'signed');

  // The same stake paying double only 49% of the time is 98%, under what the card says.
  await assert.rejects(
    () => w.gameBet(bet('breaks-its-word', 1000n, 2000n, 490n)),
    (error: any) => error.code === 'below-return' && /98\.5%/.test(error.message),
    'the wallet refuses a bet that pays back less than the game states',
  );

  const settled = String(await w.balance());
  // A payment and a transfer pay nothing back, so a game that states a return cannot ask for them.
  for (const charge of [
    () => w.gamePayment({ id: 'charge', amount: '1000' }),
    () => w.gameTransfer({ id: 'tip', amount: '1000' }),
  ])
    await assert.rejects(charge, (error: any) => error.code === 'below-return');

  assert.equal(String(await w.balance()), settled, 'nothing the wallet refused moved the balance');
});

test('a game that states nothing may still take money, and its card says so', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('quiet'));
  await w.setGameLimit('900000');
  // A tenth of a percent back: awful, and allowed, because this game promised nothing.
  const receipt = await w.gameBet(bet('no-promise', 1000n, 1n, 1n));
  assert.equal(receipt.status, 'signed');
  assert.equal((await w.gamePayment({ id: 'charge', amount: '10' })).status, 'signed');
});

test('only a game whose manifest declares shared rounds may bet on one', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('undeclared'));
  await w.setGameLimit('900000');
  const round = f.openRound();
  await assert.rejects(
    () => w.gameBet({ ...bet('seat', 1000n, 2000n, 495n), round }),
    (error: any) => error.code === 'rounds-undeclared',
  );

  w.closeGame();
  w.openGame(f.identity('declared', { rounds: true }));
  await w.setGameLimit('900000');
  const seated = await w.gameBet({ ...bet('seat', 1000n, 2000n, 495n), round });
  assert.equal(seated.status, 'pending', 'a declared game takes its seat with no dialog of its own');
});

test('a game reads every bound it must respect from the wallet, not from its own constants', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  assert.deepEqual(w.gameHello().limits, {
    prizes: MAX_PRIZES,
    outcomeSpace: String(OUTCOME_SPACE),
    seats: MAX_ROUND_BETS,
  });
});

test('a bet and a payment sign the game that asked for them; nothing else does', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  const identity = f.identity('named');
  const key = w.openGame(identity);
  await w.setGameLimit('900000');
  await w.gameBet(bet('one', 1000n, 2000n, 495n));
  await w.gamePayment({ id: 'two', amount: '50' });
  const signed = w.history
    .filter((receipt: any) => ['bet', 'payment'].includes(receipt.kind))
    .map((receipt: any) => receipt.proof.step.operation.game);
  assert.deepEqual(signed, [key, key], 'both name the game');
  // The name is the manifest URL, so moving the entry page keeps every receipt reachable.
  assert.equal(w.openGame({ ...identity, entryURL: 'https://named.example/play.html' }), key);
});
