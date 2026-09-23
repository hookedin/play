import type { GameBet, GameIdentity, GameLimit, GamePlace, GameReceipt, GameSession } from '../protocol/game-types.ts';
import type { CasinoWallet } from './wallet.ts';
import { getAddress } from 'ethers';
import { LIMITS } from '../protocol/protocol.ts';
import { gameAmount, gameOperationKey } from './game-account.ts';
import { METHODS, gameError } from './bridge.ts';
import { ChannelClient } from './wallet-channel.ts';

/** The one view a game gets of a wallet receipt, whichever request asked. The signed evidence, the
 * channel and its balance stay out: they would name the player. */
export const gameReceipt = (id: string, receipt: any): GameReceipt => {
  // Declined because the player carried it out on another channel: its result is there, and nothing here may
  // look like a rejection the game would answer by placing the same bet again.
  if (receipt.used)
    throw gameError(
      'id-used',
      'This operation was carried out on another channel, and its result is not in this wallet',
    );
  const op = receipt.request ?? receipt.proof.step.operation,
    later = receipt.details?.bet,
    kind = receipt.kind === 'payment' ? 'payment' : 'bet',
    // A bet that settles later is placed until the wallet has collected what settled it.
    status =
      receipt.status === 'rejected'
        ? 'rejected'
        : receipt.kind !== 'wager'
          ? 'settled'
          : receipt.payout === undefined
            ? 'placed'
            : receipt.refunded
              ? 'refunded'
              : 'settled';
  return {
    id,
    kind,
    status,
    // What a settled bet's payout rests on: an outcome the wallet checked, or its referee's word.
    ...(status === 'settled' && kind === 'bet' ? { basis: later?.terms ? 'referee' : 'outcome' } : {}),
    ...(kind === 'bet' ? { stake: op.amount } : {}),
    ...(receipt.kind === 'bet' ? { prizes: op.prizes } : {}),
    ...(later?.prizes ? { prizes: later.prizes, round: later.round } : {}),
    ...(later?.terms ? { terms: later.terms } : {}),
    ...(later ? { deadline: later.deadline } : {}),
    ...(receipt.details?.group ? { group: receipt.details.group } : {}),
    ...(receipt.bet ? { bet: receipt.bet } : {}),
    // The outcome and what it paid: everything a game needs to show the result.
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(receipt.payout === undefined ? {} : { payout: receipt.payout }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  } as GameReceipt;
};

/**
 * The open game's spending limit. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the limit back to the channel balance.
 * The signed channel balance is the money; the limit only caps what the game may risk.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  openGame(this: CasinoWallet, identity: GameIdentity) {
    this.game = {
      key: identity.key,
      identity: { ...identity, developer: getAddress(identity.developer) },
      asset: this.playing,
      balance: '0',
    };
    this.render();
    return identity.key;
  }
  closeGame(this: CasinoWallet) {
    this.game = null;
    this.render();
  }
  requireGame(this: CasinoWallet) {
    if (!this.game) throw gameError('game-closed', 'No game is open');
    return this.game;
  }
  gameLimit(this: CasinoWallet): GameLimit {
    const game = this.requireGame();
    return {
      balance: game.balance,
      pending: this.pending?.game?.key === game.key,
    };
  }
  /** What a game page learns when it loads: what this wallet offers, and the asset it plays with:
   * the network's ETH, or the casino's test coins. Amounts on the bridge are whole numbers of the
   * asset's smallest unit. */
  gameHello(this: CasinoWallet) {
    this.requireGame();
    return {
      methods: METHODS,
      asset: this.asset,
      chainId: String(this.expectedChainId),
      // Every bound a bet is held to, as the protocol this wallet and its casino share has them.
      limits: LIMITS,
    };
  }
  /** Everything the open game learns about the player: the uname that is theirs for good, the alias
   * they are shown by if they took one, and what to price bets against. Their address, their channel
   * and their balances are none of a game's business. */
  gameInfo(this: CasinoWallet) {
    this.requireGame();
    return {
      uname: this.uname,
      alias: this.alias,
      chainId: String(this.expectedChainId),
      bankroll: String(this.reportedBankroll),
      recommendedStake: this.playing === 'test' ? String(10n ** 18n) : this.recommendedStake,
    };
  }
  /** A game's name for an operation, for its player: the same in every channel they open, and apart for each
   * asset and each game, so a retry after a new channel finds the operation instead of repeating it. */
  gameOperationId(this: CasinoWallet, id: string) {
    gameOperationKey(id);
    return `game:${this.playing}:${this.requireGame().key}:${id}`;
  }
  /** The receipt of one of the open game's operations, answered at once. For a bet still waiting to settle,
   * the wallet also asks the casino about it: once it has settled, the wallet collects what it paid and
   * pushes the new receipt to the game. */
  async gameReceipt(this: CasinoWallet, id: string) {
    this.requireGame();
    const receipt = await this.getReceipt(this.gameOperationId(id));
    if (!receipt) return null;
    const answer = gameReceipt(id, receipt);
    if (answer.status === 'placed') void this.collectBet(receipt.bet).catch(() => {});
    return answer;
  }
  /** The only grant of spending authority: how much of the signed balance the open game may risk.
   * The limit lives in this tab's memory and signs nothing, so it can be set while an operation is
   * pending; what that operation has already committed is simply not the player's to allocate. */
  async setGameLimit(this: CasinoWallet, amount: string) {
    const n = gameAmount(amount, false);
    return this.exclusive(async () => {
      this.ready();
      const game = this.requireGame();
      if (n > this.playableBalance()) throw new Error('The limit exceeds your playing balance');
      game.balance = String(n);
      this.render();
    });
  }
  /** A bet of the open game on the player's own round, settled at once. The same request again returns its
   * receipt. */
  async gameBet(this: CasinoWallet, request: GameBet) {
    const game = this.requireGame(),
      prizes = request.prizes.map(prize => ({
        rangeStart: gameAmount(prize.rangeStart, false),
        rangeEnd: gameAmount(prize.rangeEnd),
        payout: gameAmount(prize.payout),
      }));
    return gameReceipt(
      request.id,
      await this.executeBet(
        { stake: gameAmount(request.stake), prizes, ...(request.group === undefined ? {} : { group: request.group }) },
        this.gameOperationId(request.id),
        { key: game.key, id: request.id, name: game.identity.name },
      ),
    );
  }
  /** A bet of the open game that its referee settles later: drawn on the round it names, or split by the
   * referee. The reply is its receipt at once; the wallet collects what it pays once it has settled, and
   * pushes the new receipt to the game. The same request again returns the receipt as it stands. */
  async gamePlace(this: CasinoWallet, request: GamePlace) {
    const game = this.requireGame(),
      group = request.group === undefined ? {} : { group: request.group },
      settles =
        'prizes' in request
          ? {
              round: request.round,
              prizes: request.prizes.map(prize => ({
                rangeStart: gameAmount(prize.rangeStart, false),
                rangeEnd: gameAmount(prize.rangeEnd),
                payout: gameAmount(prize.payout),
              })),
            }
          : { terms: request.terms, deadline: request.deadline };
    return gameReceipt(
      request.id,
      await this.placeLater(
        { stake: gameAmount(request.stake), ...settles, ...group },
        this.gameOperationId(request.id),
        {
          key: game.key,
          id: request.id,
          name: game.identity.name,
        },
      ),
    );
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: string; group?: string }) {
    const game = this.requireGame();
    return gameReceipt(
      request.id,
      await this.payBankroll(
        gameAmount(request.amount),
        this.gameOperationId(request.id),
        { key: game.key, id: request.id, name: game.identity.name },
        request.group,
      ),
    );
  }
}
