/** Practice: test coins a tab keeps, with casino bets and payments the wallet settles itself, sending nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '../testing/game-wallet.ts';
import { PRACTICE_BANKROLL, PRACTICE_COINS } from '../client/wallet-games.ts';

const COIN = 10n ** 18n,
  SPACE = 1n << 64n;
/** Bets whose outcome is all but certain: one that wins back most of its stake, and one that loses it. */
const sureWin = (stake: bigint) => ({
    stake: String(stake),
    chance: String(SPACE - 1n),
    prize: String((stake * 99n) / 100n),
  }),
  sureLoss = (stake: bigint) => ({ stake: String(stake), chance: '1', prize: String(stake * 2n) });

/** A wallet practicing with the fixture's game open, and every request its stub casino is sent. */
async function practicing() {
  const f = await gameWallet(),
    w = f.wallet,
    asked: string[] = [],
    api = w.api;
  w.api = async (path, ...rest) => {
    asked.push(path);
    return api(path, ...rest);
  };
  w.setPractice(true);
  w.openGame(f.identity());
  return { f, w, asked };
}

test('a practicing wallet says so, offers no developer bets, and prices against a bankroll of its own', async () => {
  const { w, asked } = await practicing();
  const hello = w.gameHello();
  assert.equal(hello.practice, true);
  assert.deepEqual(hello.asset, { symbol: 'TEST', decimals: 18 });
  assert.equal(hello.methods.includes('game.developerBet'), false);
  assert.ok(hello.methods.includes('game.casinoBet'));
  const info = w.gameInfo();
  assert.deepEqual([info.bankroll, info.recommendedStake], [String(PRACTICE_BANKROLL), String(COIN)]);
  // A limit needs no chain observation and no casino: it is in test coins.
  await w.setGameLimit(String(10n * COIN));
  assert.deepEqual(w.gameLimit(), { balance: String(10n * COIN), pending: false });
  await assert.rejects(w.setGameLimit(String(PRACTICE_COINS + 1n)), /exceeds your playing balance/);
  assert.deepEqual(asked, []);
});

test('practice settles casino bets and payments itself, in test coins, and signs and sends nothing', async () => {
  const { f, w, asked } = await practicing(),
    channel = await w.balance();
  await w.setGameLimit(String(50n * COIN));
  const won = await w.gameCasinoBet({ id: 'win', ...sureWin(COIN), group: 'hand' });
  assert.deepEqual(
    { ...won, outcome: undefined },
    {
      id: 'win',
      kind: 'casino-bet',
      status: 'settled',
      ...sureWin(COIN),
      group: 'hand',
      outcome: undefined,
      payout: String((COIN * 99n) / 100n),
    },
  );
  assert.ok(BigInt(won.outcome!) < SPACE - 1n);
  const lost = await w.gameCasinoBet({ id: 'loss', ...sureLoss(COIN) });
  assert.deepEqual([lost.status, lost.payout], ['settled', '0']);
  // Both moved the game's limit and the test coins alike.
  const after = 50n * COIN - COIN / 100n - COIN;
  assert.equal(w.gameLimit().balance, String(after));
  assert.equal(w.practiceBalance, PRACTICE_COINS - COIN / 100n - COIN);

  // The same request again is the same receipt; other terms under its ID are refused.
  assert.deepEqual(await w.gameCasinoBet({ id: 'win', ...sureWin(COIN), group: 'hand' }), won);
  await assert.rejects(
    w.gameCasinoBet({ id: 'win', ...sureWin(2n * COIN) }),
    (error: any) => error.code === 'id-conflict',
  );
  await assert.rejects(
    w.gameCasinoBet({ id: 'big', ...sureLoss(51n * COIN) }),
    (error: any) => error.code === 'insufficient-funds',
  );
  // A bet with no edge is one the casino's rule refuses: declined, it moves nothing.
  const fair = await w.gameCasinoBet({
    id: 'fair',
    stake: String(COIN),
    chance: String(SPACE / 2n),
    prize: String(2n * COIN),
  });
  assert.deepEqual(
    [fair.status, fair.reason, fair.payout],
    ['rejected', 'The bankroll cannot take this casino bet', undefined],
  );
  assert.equal(w.gameLimit().balance, String(after));

  const paid = await w.gamePayment({ id: 'double', amount: String(COIN), group: 'hand' });
  assert.deepEqual(paid, { id: 'double', kind: 'payment', status: 'settled', group: 'hand' });
  assert.equal(w.gameLimit().balance, String(after - COIN));
  await assert.rejects(
    w.gameDeveloperBet({ id: 'spin', stake: String(COIN), meta: { chips: {} } }),
    (error: any) => error.code === 'practice',
  );
  assert.deepEqual(await w.gameReceipt('loss'), lost);
  assert.equal(await w.gameReceipt('spin'), null);

  // Nothing reached the casino, and the channel is as it was.
  assert.deepEqual(asked, []);
  assert.equal(f.settlements(), 0);
  assert.equal(await w.balance(), channel);
});

test('a practice limit holds none of the channel, and follows none of its results', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameLimit('1000');
  // A reply lost on the way leaves the casino bet pending in the channel.
  const api = w.api;
  w.api = async (path, ...rest) => {
    if (path.endsWith('/operations')) {
      w.api = api;
      await api(path, ...rest);
      throw new Error('The reply was lost');
    }
    return api(path, ...rest);
  };
  await assert.rejects(w.gameCasinoBet({ id: 'lost', ...sureLoss(10n) }), /reply was lost/);
  assert.equal(w.gameLimit().pending, true);

  // Practicing, the game's limit is in test coins, apart from the channel.
  w.setPractice(true);
  assert.deepEqual(w.gameLimit(), { balance: '0', pending: false }, 'the limit went back with the switch');
  await w.setGameLimit(String(5n * COIN));
  assert.equal(w.availableBalance(), await w.balance());
  // The recovered result moves the channel, and not the practice limit.
  const before = await w.balance();
  await w.exclusive(() => w.resume());
  assert.equal(await w.balance(), before - 10n);
  assert.equal(w.gameLimit().balance, String(5n * COIN));

  // Back to ETH, the limit goes back again.
  w.setPractice(false);
  assert.deepEqual(w.gameLimit(), { balance: '0', pending: false });
});

test('ETH needs a funded channel, and test coins come back once they run low', async () => {
  const { w } = await practicing();
  w.channelId = null;
  assert.equal(w.practicing, true);
  assert.throws(() => w.setPractice(false), /Deposit ETH/);
  assert.throws(() => w.refillPractice(), /fewer than 10/);
  await w.setGameLimit(String(PRACTICE_COINS));
  await w.gamePayment({ id: 'most', amount: String(95n * COIN) });
  w.refillPractice();
  assert.equal(w.practiceBalance, 105n * COIN);
  assert.equal(w.gameLimit().balance, String(5n * COIN), 'what the game may risk is unchanged');
});
