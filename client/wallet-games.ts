import type {
  DeveloperBetRequest,
  CasinoBetRequest,
  GameAllowance,
  GameIdentity,
  GameReceipt,
  GameSession,
} from '../protocol/game-types.ts';
import type { Round } from '../protocol/types.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { getAddress } from 'ethers';
import { BOUNDS } from '../protocol/protocol.ts';
import { gameAmount, gameError, gameOperationKey } from './bridge.ts';
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
  // A developer bet is open until the wallet has collected what its developer paid.
  const op = receipt.request ?? receipt.proof.step.operation,
    kind: GameReceipt['kind'] = receipt.kind,
    status: GameReceipt['status'] =
      receipt.status === 'rejected'
        ? 'rejected'
        : receipt.payout === undefined && kind === 'developer-bet'
          ? 'open'
          : 'settled';
  return {
    id,
    kind,
    status,
    ...(kind !== 'payment' ? { stake: op.amount } : {}),
    ...(kind === 'casino-bet' ? { chance: op.chance, prize: op.prize } : {}),
    ...(receipt.details?.meta ? { meta: receipt.details.meta } : {}),
    ...(receipt.details?.group ? { group: receipt.details.group } : {}),
    ...(receipt.bet ? { bet: receipt.bet } : {}),
    // The outcome and what the bet paid: everything a game needs to show the result.
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(receipt.payout === undefined ? {} : { payout: receipt.payout }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  } as GameReceipt;
};

/**
 * The open game's allowance. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the allowance back to the balance it came from.
 * The signed channel balance is the money; the allowance only caps what the game may risk.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  openGame(this: CasinoWallet, identity: GameIdentity) {
    this.game = {
      key: identity.key,
      identity: { ...identity, developer: getAddress(identity.developer) },
      allowance: '0',
    };
    this.render();
  }
  closeGame(this: CasinoWallet) {
    this.game = null;
    this.render();
  }
  requireGame(this: CasinoWallet) {
    if (!this.game) throw gameError('game-closed', 'No game is open');
    return this.game;
  }
  gameAllowance(this: CasinoWallet): GameAllowance {
    const game = this.requireGame();
    return { allowance: game.allowance, pending: this.pending?.game?.key === game.key };
  }
  /** What a game page learns when it loads: every bound a bet is held to, as the protocol this wallet and its casino
   * share has them. */
  gameHello(this: CasinoWallet) {
    this.requireGame();
    return { bounds: BOUNDS };
  }
  /** Everything the open game learns about the player: the uname that is theirs for good, the alias
   * they are shown by if they took one, and what to price bets against: the virtual bankroll of the casino's quote,
   * asked for once the account plays. Their address, their channel and their balances are none of a game's business. */
  async gameInfo(this: CasinoWallet) {
    this.requireGame();
    const quote = this.funded ? await this.ownQuote().catch(() => null) : null;
    return {
      uname: this.uname,
      alias: this.alias,
      chainId: String(this.expectedChainId),
      virtualBankroll: String(quote?.message.virtualBankroll ?? 0),
      recommendedStake: this.recommendedStake,
    };
  }
  /** A developer's round as the casino shows it to anyone, read through this wallet: a game whose players share a
   * draw checks the rounds its developer walked it with here, since its page talks to nobody but its own origin. */
  gameRound(this: CasinoWallet, id: string): Promise<Round> {
    this.requireGame();
    return this.api(`/api/rounds/${id.toLowerCase()}`);
  }
  /** A game's name for an operation, for its player: the same in every channel they open, and apart for each game,
   * so a retry after a new channel finds the operation instead of repeating it. */
  gameOperationId(this: CasinoWallet, id: string) {
    gameOperationKey(id);
    return `game:${this.requireGame().key}:${id}`;
  }
  /** The receipt of one of the open game's operations, answered at once. For an open developer bet, the wallet also
   * asks the casino about it: once its developer has settled it, the wallet collects what it was paid and pushes
   * the new receipt to the game. */
  async gameReceipt(this: CasinoWallet, id: string) {
    const receipt = await this.getReceipt(this.gameOperationId(id));
    if (!receipt) return null;
    const answer = gameReceipt(id, receipt);
    if (answer.status === 'open')
      void this.collectDeveloperBet(receipt.bet).catch(error =>
        console.error(`Collecting developer bet ${receipt.bet} failed`, error),
      );
    return answer;
  }
  /** Which game asks, as its receipts remember it: its key, its own name for the operation, what it calls itself
   * and its developer. */
  gameIntent(this: CasinoWallet, id: string): GameIntent {
    const game = this.requireGame();
    return { key: game.key, id, name: game.identity.name, developer: game.identity.developer };
  }
  /** The only grant of spending authority: the open game's allowance, how much of the balance it may risk.
   * The allowance lives in this tab's memory and signs nothing, so it can be set while an operation is
   * pending; what that operation has already committed is simply not the player's to allow. */
  async setGameAllowance(this: CasinoWallet, amount: string) {
    const n = gameAmount(amount, false);
    this.requireGame();
    // It waits for the wallet's own background work rather than failing as busy.
    return this.exclusive(
      async () => {
        this.ready();
        const game = this.requireGame();
        if (n > this.playableBalance()) throw new Error('The allowance exceeds your balance');
        game.allowance = String(n);
        this.render();
      },
      { wait: true },
    );
  }
  /** A casino bet of the open game: settled at once against the bankroll, on the player's own round. The same
   * request again returns its receipt. */
  async gameCasinoBet(this: CasinoWallet, request: CasinoBetRequest) {
    const group = request.group === undefined ? {} : { group: request.group };
    return gameReceipt(
      request.id,
      await this.executeCasinoBet(
        {
          stake: gameAmount(request.stake),
          chance: gameAmount(request.chance),
          prize: gameAmount(request.prize),
          ...group,
        },
        this.gameOperationId(request.id),
        this.gameIntent(request.id),
      ),
    );
  }
  /** A developer bet of the open game: its stake goes to the bank of the game's developer at once, and the developer
   * settles it. The reply is its receipt at once; the wallet checks and collects what the developer paid once it
   * has settled the bet, and pushes the new receipt to the game. The same request again returns the receipt as it
   * stands. */
  async gameDeveloperBet(this: CasinoWallet, request: DeveloperBetRequest) {
    const group = request.group === undefined ? {} : { group: request.group };
    return gameReceipt(
      request.id,
      await this.placeDeveloperBet(
        { stake: gameAmount(request.stake), meta: request.meta, ...group },
        this.gameOperationId(request.id),
        this.gameIntent(request.id),
      ),
    );
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: string; group?: string }) {
    return gameReceipt(
      request.id,
      await this.payBankroll(
        gameAmount(request.amount),
        this.gameOperationId(request.id),
        this.gameIntent(request.id),
        request.group,
      ),
    );
  }
}
