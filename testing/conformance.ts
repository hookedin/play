/**
 * What a game can count on from any casino it runs against, as tests. play runs them against the stub in
 * `game-wallet.ts` and the casino service runs them against itself, so the stub a game is tested with behaves as
 * the casino does wherever a game depends on it: a lost reply, a new channel, a wallet that lost its receipts,
 * a bet the bankroll cannot back, a placed bet nobody settles, a referee that restarts, and a game whose rules
 * changed under a saved round.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CasinoWallet } from '../client/wallet.ts';
import type { GameReceipt } from '../protocol/game-types.ts';
import type { AssetId } from '../protocol/protocol.ts';
import type { Referee } from '../sdk/src/referee.ts';
import type { TestBridge } from './game-wallet.ts';
import { RoundClient } from '../sdk/src/round.ts';
import { fraction } from '../sdk/src/engine/index.ts';

type Prizes = { rangeStart: string; rangeEnd: string; payout: string }[];
/** A casino to run the suite against, with a wallet playing a game that has a referee. */
export interface Casino {
  /** The wallet, with its channel funded, the game open and its spending limit set. */
  wallet: CasinoWallet;
  bridge: TestBridge;
  /** What the wallet plays with. */
  asset: AssetId;
  /** The game's referee, as its server creates it on starting. */
  referee(): Promise<Referee>;
  /** Time passes beyond `ms`, and bets past their deadlines come back. */
  advance(ms: number): Promise<void>;
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
  test(`${name}: a reply lost on the way is found by its ID, and the bet is charged once`, async t => {
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
    await assert.rejects(x.bridge.call('game.bet', bet), /lost reply/);
    assert.equal((await x.bridge.balance()).pending, true, 'the wallet holds the signed bet');
    const receipt = await x.bridge.call('game.bet', bet);
    assert.equal(receipt.status, 'settled');
    assert.deepEqual(await x.bridge.call('game.receipt', { id: 'lost' }), receipt);
    assert.equal(await w.balance(), before - BigInt(bet.stake) + BigInt(receipt.payout));
  });

  test(`${name}: an operation ID is the player's, so on a new channel it finds the bet instead of placing another`, async t => {
    const x = await open(t),
      bet = { id: 'kept', ...x.within },
      placed = await x.bridge.call('game.bet', bet);
    await x.replaceChannel();
    const before = await x.wallet.balance();
    assert.deepEqual(await x.bridge.call('game.bet', bet), placed, 'the same operation, not a second one');
    assert.deepEqual(await x.bridge.call('game.receipt', { id: 'kept' }), placed);
    assert.equal(await x.wallet.balance(), before, 'and nothing was charged');
  });

  test(`${name}: a wallet that lost its receipts is told an operation was carried out, and plays on`, async t => {
    const x = await open(t),
      bet = { id: 'once', ...x.within };
    await x.bridge.call('game.bet', bet);
    await x.replaceChannel();
    const y = await x.forget(),
      before = await y.wallet.balance();
    assert.equal(await y.bridge.call('game.receipt', { id: 'once' }), null, 'this wallet has no record of it');
    await assert.rejects(y.bridge.call('game.bet', bet), (error: any) => error.code === 'id-used');
    assert.equal(await y.wallet.balance(), before, 'no second bet');
    assert.equal((await y.bridge.balance()).pending, false, 'nothing is left pending');
    assert.equal((await y.bridge.call('game.bet', { ...bet, id: 'fresh' })).status, 'settled');
  });

  test(`${name}: a bet the bankroll cannot back is declined with the balance unchanged, and asked again the same`, async t => {
    const x = await open(t),
      before = await x.wallet.balance(),
      bet = { id: 'too-big', ...x.beyond },
      declined = await x.bridge.call('game.bet', bet);
    assert.deepEqual([declined.status, declined.payout], ['rejected', undefined]);
    assert.equal(await x.wallet.balance(), before);
    assert.deepEqual(await x.bridge.call('game.bet', bet), declined);
  });

  test(`${name}: a placed bet nobody settles comes back at its deadline, and the game hears`, async t => {
    const x = await open(t),
      before = await x.wallet.balance(),
      placed = await x.bridge.call('game.place', {
        id: 'waits',
        stake: x.within.stake,
        terms: { pick: 'home' },
        deadline: Date.now() + 1500,
      });
    assert.equal(placed.status, 'placed');
    assert.equal(await x.wallet.balance(), before - BigInt(x.within.stake));
    await x.advance(2000);
    const heard = pushed(x.bridge, 'waits');
    await x.bridge.call('game.receipt', { id: 'waits' });
    const refunded = await heard;
    assert.deepEqual([refunded.status, refunded.payout], ['refunded', x.within.stake]);
    assert.equal(await x.wallet.balance(), before);
  });

  test(`${name}: a referee that restarts draws the round it saved, and the bet on it is paid once`, async t => {
    const x = await open(t),
      referee = await x.referee(),
      round = await referee.open(x.asset),
      placed = await x.bridge.call('game.place', { id: 'spin', ...x.within, round: round.id });
    assert.deepEqual([placed.status, placed.round, placed.deadline], ['placed', round.id, round.deadline]);
    // The first draw's reply never reaches the referee, which restarts and draws the round it saved.
    const first = await referee.draw(round.id),
      again = await (await x.referee()).draw(round.id);
    assert.deepEqual(
      [again.round, again.seed, again.secret, again.outcome],
      [round.id, first.seed, first.secret, first.outcome],
    );
    assert.equal((await referee.round(round.id)).status, 'drawn');
    const heard = pushed(x.bridge, 'spin');
    await x.bridge.call('game.receipt', { id: 'spin' });
    const settled = await heard;
    assert.deepEqual([settled.status, settled.basis, settled.outcome], ['settled', 'outcome', first.outcome]);
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
