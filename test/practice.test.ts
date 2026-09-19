import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '../testing/game-wallet.ts';

const WORD = 1n << 64n;
const bet = (id: string, stake: bigint, payout: bigint, rangeEnd = WORD) => ({
  id,
  stake: String(stake),
  prizes: [{ rangeStart: '0', rangeEnd: String(rangeEnd), payout: String(payout) }],
});

test('practice money settles bets in the wallet and never touches the channel', async () => {
  const { wallet, identity, settlements } = await gameWallet();
  wallet.openGame(identity());
  wallet.setPractice(true);
  const start = BigInt(wallet.gameLimit().balance),
    signed = wallet.current!.state.balance;
  assert.deepEqual(wallet.gameLimit(), { balance: String(start), pending: false, practice: true });
  assert.equal(wallet.gameInfo().practice, true);
  assert.equal(wallet.gameInfo().channelId, 'practice');
  assert.equal(wallet.availableBalance(), BigInt(signed), 'practice money reserves none of the signed balance');

  // A prize over the whole outcome space always pays; one over none of it never does.
  const won = await wallet.gameBet(bet('sure', 100n, 250n));
  assert.deepEqual(
    { status: won.status, verified: won.verified, practice: won.practice, payout: won.payout },
    { status: 'practice', verified: true, practice: true, payout: '250' },
  );
  assert.equal(wallet.gameLimit().balance, String(start + 150n));
  const lost = await wallet.gameBet(bet('never', 100n, 250n, 1n));
  assert.ok(BigInt(lost.outcome as string) >= 0n && BigInt(lost.outcome as string) < WORD);
  if (lost.payout === '0') assert.equal(wallet.gameLimit().balance, String(start + 50n));

  // An exact retry returns the saved result, and the game can look it up.
  assert.deepEqual(await wallet.gameBet(bet('sure', 100n, 250n)), won);
  assert.deepEqual(await wallet.gameReceipt('sure'), won);
  assert.equal(await wallet.gameReceipt('unknown'), null);

  await wallet.gamePayment({ id: 'pay', amount: '50' });
  await assert.rejects(wallet.gameBet(bet('big', start * 2n, 1n)), /exceeds the game balance/);
  await assert.rejects(wallet.gameTransfer({ id: 't', amount: '1' }), /practice money/);
  await assert.rejects(wallet.setGameLimit('1'), /practice money/);
  await assert.rejects(wallet.gameBet(bet('bad', 100n, 1n, 0n)), /./, 'the same terms checks as a real bet');

  assert.equal(settlements(), 0);
  assert.equal(wallet.current!.state.balance, signed);
  assert.equal(wallet.history.length, 0, 'practice results are not wallet history');
});

test('practice money is topped up on request and gone when practice ends', async () => {
  const { wallet, identity } = await gameWallet();
  wallet.openGame(identity());
  wallet.setPractice(true);
  const start = BigInt(wallet.gameLimit().balance);
  await wallet.gamePayment({ id: 'spend', amount: String(start) });
  assert.equal(wallet.gameLimit().balance, '0');
  wallet.refillPractice();
  assert.equal(wallet.gameLimit().balance, String(start));
  wallet.refillPractice(start * 3n);
  assert.equal(wallet.gameLimit().balance, String(start * 4n), 'a step that needs more gets what it needs');
  wallet.setPractice(false);
  assert.deepEqual(wallet.gameLimit(), { balance: '0', pending: false, practice: false });
  assert.equal(wallet.gameInfo().practice, false);
});

test('the spending limit is set, raised and lowered within the signed balance', async () => {
  const { wallet, identity } = await gameWallet();
  wallet.openGame(identity());
  await wallet.setGameLimit('600');
  assert.equal(wallet.availableBalance(), 1000000n - 600n);
  await wallet.setGameLimit('100');
  assert.equal(wallet.gameLimit().balance, '100');
  await wallet.setGameLimit('0');
  assert.equal(wallet.availableBalance(), 1000000n);
  await assert.rejects(wallet.setGameLimit('1000001'), /exceeds your playing balance/);
});
