import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '../testing/game-wallet.ts';

const terms = (id: string) => ({
  id,
  stake: '1000',
  prizes: [{ rangeStart: '0', rangeEnd: String((1n << 64n) / 2n), payout: '1900' }],
});

test('a receipt keeps the name of the game it was placed in, after that game is closed', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('Dice'));
  await w.setGameLimit('200000');
  await w.gameCasinoBet(terms('bet-1'));
  w.closeGame();
  w.openGame(f.identity('Roulette'));
  await w.setGameLimit('200000');
  await w.gameCasinoBet(terms('bet-2'));
  w.closeGame();

  const names = w.history.filter((r: any) => r.kind === 'casino-bet').map((r: any) => r.game?.name);
  assert.deepEqual(names, ['Roulette', 'Dice'], 'every bet names its own game, newest first');
});

test('activity stays newest first when an earlier receipt is written again', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('Dice'));
  await w.setGameLimit('200000');
  await w.gameCasinoBet(terms('bet-a'));
  await w.gameCasinoBet(terms('bet-b'));
  // A receipt rewritten later keeps its own place in time.
  const first: any = w.history.find((r: any) => r.game?.id === 'bet-a');
  await w.save({ ...first, note: 'revealed later' });
  const times = w.history.map((r: any) => r.createdAt ?? 0);
  assert.deepEqual(
    times,
    [...times].sort((a: number, b: number) => b - a),
    'newest first by the clock',
  );
  assert.equal(w.history.find((r: any) => r.game?.id === 'bet-a').note, 'revealed later');
});
