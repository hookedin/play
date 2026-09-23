import type {
  EntryRequest,
  GameIdentity,
  GameLimit,
  GameReceipt,
  GameRequest,
  GameSession,
} from '../protocol/game-types.ts';
import type { CasinoWallet } from './wallet.ts';
import { getAddress } from 'ethers';
import { MAX_PRIZES, MAX_ROUND_BETS, OUTCOME_SPACE } from '../protocol/risk.ts';
import { gameKey, gameAmount, gameOperationKey } from './game-account.ts';
import { METHODS, gameError } from './bridge.ts';
import { ChannelClient } from './wallet-channel.ts';

/** The one view a game gets of a wallet receipt, whichever request asked. The signed evidence, the
 * channel and its balance stay out: they would name the player. */
export const gameReceipt = (id: string, receipt: any): GameReceipt => {
  const op = receipt.request ?? receipt.proof.step.operation;
  return {
    id,
    kind: receipt.kind,
    status: receipt.status,
    verified: receipt.verified,
    ...(receipt.kind === 'bet' ? { stake: op.amount, prizes: op.prizes } : {}),
    ...(receipt.kind === 'entry'
      ? {
          stake: op.amount,
          pot: receipt.details.counterparty,
          ...(receipt.details.entry?.prizes ? { prizes: receipt.details.entry.prizes } : {}),
        }
      : {}),
    // The outcome and what it paid: everything a game needs to show the result.
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(receipt.payout === undefined ? {} : { payout: receipt.payout }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  };
};

/**
 * The open game's spending limit. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the limit back to the channel balance.
 * The signed channel balance is the money; the limit only caps what the game may risk.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  openGame(this: CasinoWallet, identity: GameIdentity) {
    const key = gameKey(identity);
    this.game = {
      key,
      identity: { ...identity, developer: getAddress(identity.developer) },
      asset: this.playing,
      balance: '0',
    };
    this.render();
    return key;
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
      // Every bound a game has to respect, so none of them is a number compiled into the game.
      limits: { prizes: MAX_PRIZES, outcomeSpace: String(OUTCOME_SPACE), entries: MAX_ROUND_BETS },
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
  gameOperationId(this: CasinoWallet, id: string) {
    gameOperationKey(id);
    return `game:${this.channelId}:${this.requireGame().key}:${id}`;
  }
  async gameReceipt(this: CasinoWallet, id: string) {
    this.requireGame();
    const receipt = await this.getReceipt(this.gameOperationId(id));
    return receipt ? (gameReceipt(id, receipt) as GameReceipt) : null;
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
  async gameBet(this: CasinoWallet, request: GameRequest) {
    const game = this.requireGame();
    const terms = {
      stake: gameAmount(request.stake),
      prizes: request.prizes.map(prize => ({
        rangeStart: gameAmount(prize.rangeStart, false),
        rangeEnd: gameAmount(prize.rangeEnd),
        payout: gameAmount(prize.payout),
      })),
    };
    return gameReceipt(
      request.id,
      await this.executeBet(terms, this.gameOperationId(request.id), {
        key: game.key,
        id: request.id,
        name: game.identity.name,
      }),
    );
  }
  /** Enter a pot of this game. The entry is final; the same request again finds it, and once the pot
   * has ended, what it paid. */
  async gameEnter(this: CasinoWallet, request: EntryRequest) {
    const game = this.requireGame();
    return gameReceipt(
      request.id,
      await this.enterPot(
        {
          pot: request.pot.toLowerCase(),
          stake: gameAmount(request.stake),
          ...(request.prizes ? { prizes: request.prizes } : {}),
          ...(request.quote ? { quote: request.quote } : {}),
        },
        this.gameOperationId(request.id),
        { key: game.key, id: request.id, name: game.identity.name },
      ),
    );
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: string }) {
    const game = this.requireGame();
    return gameReceipt(
      request.id,
      await this.payBankroll(gameAmount(request.amount), this.gameOperationId(request.id), {
        key: game.key,
        id: request.id,
        name: game.identity.name,
      }),
    );
  }
}
