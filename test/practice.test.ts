/** Practice: play money a tab keeps, in ETH's amounts, with casino bets and payments the wallet settles itself, sending
 * nothing. It never runs out. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeTo, gameWallet } from '../testing/game-wallet.ts';

const SPACE = 1n << 64n;
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
  return { f, w, asked, stake: BigInt(w.recommendedStake) };
}

test('a practicing wallet says so, counts in ETH, offers no developer bets, and has no limit to set', async () => {
  const { w, asked, stake } = await practicing();
  const hello = w.gameHello();
  assert.equal(hello.practice, true);
  assert.deepEqual(hello.asset, { symbol: 'ETH', decimals: 18 });
  assert.equal(hello.methods.includes('game.developerBet'), false);
  assert.ok(hello.methods.includes('game.casinoBet'));
  // The same stakes as with money, against a practice bankroll a hundred times the play money.
  const info = w.gameInfo();
  assert.equal(w.practiceStart, 10_000n * stake);
  assert.deepEqual([info.bankroll, info.recommendedStake], [String(100n * w.practiceStart), String(stake)]);
  // The game plays with all of the play money, and no limit can be set on it.
  assert.deepEqual(w.gameLimit(), { balance: String(w.practiceStart), pending: false });
  await assert.rejects(w.setGameLimit(String(stake)), /all of its play money/);
  assert.deepEqual(asked, []);
});

test('practice settles casino bets and payments itself, in play money, and signs and sends nothing', async () => {
  const { f, w, asked, stake } = await practicing(),
    channel = await w.balance(),
    start = w.practiceStart;
  const won = await w.gameCasinoBet({ id: 'win', ...sureWin(stake), group: 'hand' });
  assert.deepEqual(
    { ...won, outcome: undefined },
    {
      id: 'win',
      kind: 'casino-bet',
      status: 'settled',
      ...sureWin(stake),
      group: 'hand',
      outcome: undefined,
      payout: String((stake * 99n) / 100n),
    },
  );
  assert.ok(BigInt(won.outcome!) < SPACE - 1n);
  const lost = await w.gameCasinoBet({ id: 'loss', ...sureLoss(stake) });
  assert.deepEqual([lost.status, lost.payout], ['settled', '0']);
  const after = start - stake / 100n - stake;
  assert.equal(w.practiceBalance, after);
  assert.equal(w.gameLimit().balance, String(after));

  // The same request again is the same receipt; other terms under its ID are refused.
  assert.deepEqual(await w.gameCasinoBet({ id: 'win', ...sureWin(stake), group: 'hand' }), won);
  await assert.rejects(
    w.gameCasinoBet({ id: 'win', ...sureWin(2n * stake) }),
    (error: any) => error.code === 'id-conflict',
  );
  // A bet with no edge is one the casino's rule refuses: declined, it moves nothing.
  const fair = await w.gameCasinoBet({
    id: 'fair',
    stake: String(stake),
    chance: String(SPACE / 2n),
    prize: String(2n * stake),
  });
  assert.deepEqual(
    [fair.status, fair.reason, fair.payout],
    ['rejected', 'The bankroll cannot take this casino bet', undefined],
  );
  assert.equal(w.practiceBalance, after);

  const paid = await w.gamePayment({ id: 'double', amount: String(stake), group: 'hand' });
  assert.deepEqual(paid, { id: 'double', kind: 'payment', status: 'settled', group: 'hand' });
  assert.equal(w.practiceBalance, after - stake);
  await assert.rejects(
    w.gameDeveloperBet({ id: 'spin', stake: String(stake), meta: { chips: {} } }),
    (error: any) => error.code === 'practice',
  );
  assert.deepEqual(await w.gameReceipt('loss'), lost);
  assert.equal(await w.gameReceipt('spin'), null);

  // Nothing reached the casino, and the channel is as it was.
  assert.deepEqual(asked, []);
  assert.equal(f.settlements(), 0);
  assert.equal(await w.balance(), channel);
});

test('play money never runs out: whatever would take more than it holds tops it back up', async () => {
  const { w, stake } = await practicing(),
    start = w.practiceStart;
  await w.gamePayment({ id: 'most', amount: String(start - stake) });
  assert.equal(w.practiceBalance, stake);
  // A bet for more than is left: the balance is topped back up to where practice starts, and the bet is placed.
  await w.gameCasinoBet({ id: 'big', ...sureLoss(2n * stake) });
  assert.equal(w.practiceBalance, start - 2n * stake);
  // One bigger than practice starts with is play money too.
  await w.gameCasinoBet({ id: 'huge', ...sureLoss(2n * start) });
  assert.equal(w.practiceBalance, 0n);
  // A game asking for more gets it: what it asked for, and never less than practice starts with.
  w.topUpPractice(stake);
  assert.equal(w.practiceBalance, start);
  w.topUpPractice(stake);
  assert.equal(w.practiceBalance, start + stake);
});

test('a game asking for play money gets it at once, through the bridge as through the page', async () => {
  const { w, stake } = await practicing(),
    start = w.practiceStart;
  const reply = await bridgeTo(w).call('game.requestFunds', { amount: String(stake) });
  assert.deepEqual(reply, {
    funded: true,
    amount: String(start + stake),
    balance: String(start + stake),
    pending: false,
  });
  assert.equal(w.practiceBalance, start + stake);
});

test('a practice game holds none of the channel, and follows none of its results', async () => {
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

  // Practicing, the game plays with play money, apart from the channel.
  w.setPractice(true);
  assert.deepEqual(w.gameLimit(), { balance: String(w.practiceStart), pending: false });
  assert.equal(w.availableBalance(), await w.balance());
  // The recovered result moves the channel, and not the play money.
  const before = await w.balance();
  await w.exclusive(() => w.resume());
  assert.equal(await w.balance(), before - 10n);
  assert.equal(w.practiceBalance, w.practiceStart);

  // Back to ETH, the limit went back with the switch.
  w.setPractice(false);
  assert.deepEqual(w.gameLimit(), { balance: '0', pending: false });
});

test('ETH needs a funded channel', async () => {
  const { w } = await practicing();
  w.channelId = null;
  assert.equal(w.practicing, true);
  assert.throws(() => w.setPractice(false), /Deposit ETH/);
});
