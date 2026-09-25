/**
 * What a game can count on from any casino it runs against, as tests. play runs them against the stub in
 * `game-wallet.ts` and the casino service runs them against itself, so the stub a game is tested with behaves as the
 * casino does wherever a game depends on it: a lost reply, a new channel, a wallet that lost its receipts, a casino
 * bet the bankroll cannot back, a developer bet on its developer's word, a developer that restarts, a developer bet
 * its developer covers, returns or pays short, a casino bet of the developer's the bankroll declines, and a game whose
 * rules changed under a saved round.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CasinoWallet } from '../client/wallet.ts';
import type { GameReceipt } from '../protocol/game-types.ts';
import type { AssetId } from '../protocol/protocol.ts';
import { outcome } from '../protocol/protocol.ts';
import { OUTCOME_SPACE } from '../protocol/risk.ts';
import type { Developer } from '../sdk/src/developer.ts';
import type { TestBridge } from './game-wallet.ts';
import { RoundClient } from '../sdk/src/round.ts';
import { fraction } from '../sdk/src/engine/index.ts';

type Prizes = { rangeStart: string; rangeEnd: string; payout: string }[];
/** A casino to run the suite against, with a wallet playing a published game. */
export interface Casino {
  /** The wallet, with its channel funded, the game open and its spending limit set. */
  wallet: CasinoWallet;
  bridge: TestBridge;
  /** What the wallet plays with. */
  asset: AssetId;
  /** The game's developer, as its server creates it on starting. */
  developer(): Promise<Developer>;
  /** The player's channel is replaced by a new one of the same asset, funded, with the game still open. */
  replaceChannel(): Promise<void>;
  /** The same player's wallet, started afresh without the receipts this one kept, with the game open. */
  forget(): Promise<{ wallet: CasinoWallet; bridge: TestBridge }>;
  /** A bet the bankroll takes, and one it cannot back. */
  within: { stake: string; prizes: Prizes };
  beyond: { stake: string; prizes: Prizes };
}

/** A heads-or-tails round for `RoundClient`, paying `hundredths` of the stake on heads. */
const flip = (hundredths: bigint) => (setup: any) => ({
  root: 'start',
  nodes: [
    {
      id: 'start',
      kind: 'decision' as const,
      actions: [
        {
          id: 'flip',
          outcomes: [
            { next: 'heads', probability: fraction(1n, 2n) },
            { next: 'tails', probability: fraction(1n, 2n) },
          ],
        },
      ],
    },
    { id: 'heads', kind: 'terminal' as const, payout: (BigInt(setup.stake) * hundredths) / 100n },
    { id: 'tails', kind: 'terminal' as const, payout: 0n },
  ],
});
const memory = () => {
  const map = new Map<string, string>();
  return {
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
};
/** The next receipt the wallet pushes for operation `id`. */
const pushed = (bridge: TestBridge, id: string) =>
  new Promise<GameReceipt>(resolve => {
    const stop = bridge.onReceipt(receipt => {
      if (receipt.id !== id) return;
      stop();
      resolve(receipt);
    });
  });

export function behaviour(name: string, open: (t: any) => Promise<Casino>) {
  test(`${name}: a reply lost on the way is found by its ID, and the casino bet is charged once`, async t => {
    const x = await open(t),
      w = x.wallet,
      api = w.api.bind(w);
    let lose = true;
    w.api = async (...args: [string, unknown?]) => {
      const value = await api(...args);
      if (lose && args[0].endsWith('/operations')) {
        lose = false;
        throw new Error('lost reply');
      }
      return value;
    };
    const before = await w.balance(),
      bet = { id: 'lost', ...x.within };
    await assert.rejects(x.bridge.call('game.casinoBet', bet), /lost reply/);
    assert.equal((await x.bridge.balance()).pending, true, 'the wallet holds the signed bet');
    const receipt = await x.bridge.call('game.casinoBet', bet);
    assert.equal(receipt.status, 'settled');
    assert.deepEqual(await x.bridge.call('game.receipt', { id: 'lost' }), receipt);
    assert.equal(await w.balance(), before - BigInt(bet.stake) + BigInt(receipt.payout));
  });

  test(`${name}: an operation ID is the player's, so on a new channel it finds the bet instead of placing another`, async t => {
    const x = await open(t),
      bet = { id: 'kept', ...x.within },
      placed = await x.bridge.call('game.casinoBet', bet);
    await x.replaceChannel();
    const before = await x.wallet.balance();
    assert.deepEqual(await x.bridge.call('game.casinoBet', bet), placed, 'the same operation, not a second one');
    assert.deepEqual(await x.bridge.call('game.receipt', { id: 'kept' }), placed);
    assert.equal(await x.wallet.balance(), before, 'and nothing was charged');
  });

  test(`${name}: a wallet that lost its receipts is told an operation was carried out, and plays on`, async t => {
    const x = await open(t),
      bet = { id: 'once', ...x.within };
    await x.bridge.call('game.casinoBet', bet);
    await x.replaceChannel();
    const y = await x.forget(),
      before = await y.wallet.balance();
    assert.equal(await y.bridge.call('game.receipt', { id: 'once' }), null, 'this wallet has no record of it');
    await assert.rejects(y.bridge.call('game.casinoBet', bet), (error: any) => error.code === 'id-used');
    assert.equal(await y.wallet.balance(), before, 'no second bet');
    assert.equal((await y.bridge.balance()).pending, false, 'nothing is left pending');
    assert.equal((await y.bridge.call('game.casinoBet', { ...bet, id: 'fresh' })).status, 'settled');
  });

  test(`${name}: a casino bet the bankroll cannot back is declined with the balance unchanged, and asked again the same`, async t => {
    const x = await open(t),
      before = await x.wallet.balance(),
      bet = { id: 'too-big', ...x.beyond },
      declined = await x.bridge.call('game.casinoBet', bet);
    assert.deepEqual([declined.status, declined.payout], ['rejected', undefined]);
    assert.equal(await x.wallet.balance(), before);
    assert.deepEqual(await x.bridge.call('game.casinoBet', bet), declined);
  });

  test(`${name}: a developer bet with terms is paid what its developer signs, and the game hears`, async t => {
    const x = await open(t),
      developer = await x.developer(),
      before = await x.wallet.balance(),
      placed = await x.bridge.call('game.developerBet', {
        id: 'match',
        stake: x.within.stake,
        terms: { pick: 'home' },
      });
    assert.equal(placed.status, 'open');
    assert.equal(await x.wallet.balance(), before - BigInt(x.within.stake), 'the stake went to the developer');
    const heard = pushed(x.bridge, 'match');
    await developer.settle([{ bet: placed.bet!, player: 3n * BigInt(x.within.stake), casino: 0n }]);
    await x.bridge.call('game.receipt', { id: 'match' });
    const settled = await heard;
    assert.deepEqual(
      [settled.status, settled.basis, settled.payout],
      ['settled', 'developer', String(3n * BigInt(x.within.stake))],
    );
    assert.equal(await x.wallet.balance(), before + 2n * BigInt(x.within.stake));
  });

  test(`${name}: a developer that restarts places the same casino bet, and the developer bet it covers is paid its prizes`, async t => {
    const x = await open(t),
      developer = await x.developer(),
      round = await developer.openRound(x.asset),
      placed = await x.bridge.call('game.developerBet', { id: 'spin', ...x.within, round: round.id });
    assert.deepEqual([placed.status, placed.round], ['open', round.id]);
    // The first casino bet's reply never reaches the developer, which restarts and places it again.
    const bet = { round: round.id, stake: x.within.stake, prizes: x.within.prizes, covers: [placed.bet!] },
      first = await developer.casinoBet(bet),
      again = await (await x.developer()).casinoBet(bet);
    assert.deepEqual(
      [again.status, again.seed, again.secret, again.outcome, again.casinoBet?.accepted],
      ['revealed', first.seed, first.secret, first.outcome, true],
    );
    const owed = outcome(
      x.within.prizes.map(prize => ({ ...prize })),
      first.seed!,
      first.secret!,
    ).payout;
    const heard = pushed(x.bridge, 'spin');
    await developer.settle([{ bet: placed.bet!, player: owed, casino: 0n }]);
    await x.bridge.call('game.receipt', { id: 'spin' });
    const settled = await heard;
    assert.deepEqual(
      [settled.status, settled.basis, settled.outcome, settled.owed, settled.payout],
      ['settled', 'outcome', first.outcome, String(owed), String(owed)],
    );
  });

  test(`${name}: a developer bet its developer does not cover is owed its stake back, and one paid less than it is owed shows`, async t => {
    const x = await open(t),
      developer = await x.developer(),
      round = await developer.openRound(x.asset),
      stake = x.within.stake,
      // Nine tenths of the stake back, whatever the outcome: owed for certain once covered.
      sure = [{ rangeStart: '0', rangeEnd: String(OUTCOME_SPACE), payout: String((BigInt(stake) * 9n) / 10n) }];
    const covered = await x.bridge.call('game.developerBet', { id: 'covered', stake, prizes: sure, round: round.id }),
      uncovered = await x.bridge.call('game.developerBet', { id: 'uncovered', stake, prizes: sure, round: round.id });
    await developer.casinoBet({ round: round.id, stake, prizes: sure, covers: [covered.bet!] });
    await developer.settle([
      { bet: covered.bet!, player: BigInt(stake) / 2n, casino: 0n },
      { bet: uncovered.bet!, player: stake, casino: 0n },
    ]);
    // Asked about one at a time, as a game would: the wallet collects each and sends its receipt.
    const collect = async (id: string) => {
      const heard = pushed(x.bridge, id);
      await x.bridge.call('game.receipt', { id });
      return heard;
    };
    const short = await collect('covered'),
      returned = await collect('uncovered');
    assert.deepEqual(
      [short.status, short.owed, short.payout],
      ['shorted', String((BigInt(stake) * 9n) / 10n), String(BigInt(stake) / 2n)],
    );
    assert.deepEqual([returned.status, returned.owed, returned.payout], ['returned', stake, stake]);
  });

  test(`${name}: a casino bet of the developer's the bankroll declines reveals its round and covers nothing`, async t => {
    const x = await open(t),
      developer = await x.developer(),
      round = await developer.openRound(x.asset),
      placed = await x.bridge.call('game.developerBet', { id: 'unbacked', ...x.beyond, round: round.id }),
      revealed = await developer.casinoBet({
        round: round.id,
        stake: x.beyond.stake,
        prizes: x.beyond.prizes,
        covers: [placed.bet!],
      });
    assert.deepEqual([revealed.status, revealed.casinoBet?.accepted], ['revealed', false]);
    const heard = pushed(x.bridge, 'unbacked');
    await developer.settle([{ bet: placed.bet!, player: x.beyond.stake, casino: 0n }]);
    await x.bridge.call('game.receipt', { id: 'unbacked' });
    assert.deepEqual((await heard).status, 'returned');
  });

  test(`${name}: a round saved under rules the game does not play is let go once, and the next one plays`, async t => {
    const x = await open(t),
      store = memory(),
      stake = x.within.stake;
    const old = new RoundClient(x.bridge, flip(190n), undefined, { store, name: 'rules' });
    await old.start({ stake });
    const changed = new RoundClient(x.bridge, flip(180n), undefined, { store, name: 'rules' });
    await assert.rejects(changed.restore(), /rules this game does not play/);
    assert.equal(await changed.restore(), null, 'it is gone');
    await changed.start({ stake });
    assert.equal((await changed.action('flip')).terminal, true);
  });
}
