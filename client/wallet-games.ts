import type { GameIdentity, GameLimit, GameRequest, GameSession } from '../protocol/game-types.ts';
import type { CasinoWallet } from './wallet.ts';
import { getAddress } from 'ethers';
import { describeBet } from '../protocol/risk.ts';
import { gameKey, gameAmount, gameOperationKey } from './game-account.ts';
import { METHODS, gameError } from './bridge.ts';
import { ChannelClient } from './wallet-channel.ts';

/** What a game learns about an operation: the outcome, never the signed evidence. */
export const gameReceipt = (receipt: any) =>
  receipt
    ? {
        id: receipt.game?.id ?? null,
        kind: receipt.kind,
        status: receipt.status,
        verified: receipt.verified,
        // The round's 64-bit outcome and the total its prizes paid: everything a game needs to show the result.
        outcome: receipt.outcome,
        payout: receipt.payout,
        operationId: receipt.operationId,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      }
    : null;

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
    return { methods: METHODS, asset: this.asset, chainId: String(this.expectedChainId) };
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
    return gameReceipt(await this.getReceipt(this.gameOperationId(id)));
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
  /** The player accepts that this game's host, not this wallet, draws the seed of its shared rounds. */
  allowHostedRounds(this: CasinoWallet) {
    this.requireGame().hostedRounds = true;
  }
  async gameBet(this: CasinoWallet, request: GameRequest) {
    const game = this.requireGame();
    // In the wallet's own rounds neither side can choose the outcome. In a hosted round the host and
    // the casino together could, so a game never moves a player onto one without the player's consent.
    if (request.round && !game.hostedRounds)
      throw gameError('declined', "Allow this game to use its host's randomness before betting on a shared round");
    const terms = {
      stake: gameAmount(request.stake),
      prizes: request.prizes.map(prize => ({
        rangeStart: gameAmount(prize.rangeStart, false),
        rangeEnd: gameAmount(prize.rangeEnd),
        payout: gameAmount(prize.payout),
      })),
      ...(request.round ? { round: request.round } : {}),
    };
    return this.executeBet(terms, game.identity.developer, this.gameOperationId(request.id), {
      key: game.key,
      id: request.id,
      name: game.identity.name,
    });
  }
  /** Withdraw this game's hosted bet, or learn its result if the round's owner settled it first. */
  async gameCancel(this: CasinoWallet, request: { id: string }) {
    const game = this.requireGame();
    if (this.pending?.game?.key !== game.key || this.pending.game.id !== request.id)
      throw gameError('not-pending', 'No pending operation with this ID');
    return this.cancelPending();
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: string }) {
    const game = this.requireGame();
    return this.payBankroll(
      gameAmount(request.amount),
      this.gameOperationId(request.id),
      { key: game.key, id: request.id, name: game.identity.name },
      game.identity.developer,
    );
  }
  async gameTransfer(this: CasinoWallet, request: { id: string; amount: string }) {
    const game = this.requireGame();
    return this.transfer(
      gameAmount(request.amount),
      game.identity.developer,
      this.gameOperationId(request.id),
      { key: game.key, id: request.id, name: game.identity.name },
      game.identity.developer,
    );
  }
}
