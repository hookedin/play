import type {
  DeveloperBetRequest,
  CasinoBetRequest,
  GameIdentity,
  GameLimit,
  GameReceipt,
  GameSession,
} from '../protocol/game-types.ts';
import type { Round } from '../protocol/types.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { getAddress } from 'ethers';
import { LIMITS, betPayout, betTerms } from '../protocol/protocol.ts';
import { assessBet, describeBet } from '../protocol/risk.ts';
import { developerBetStatus, gameAmount, gameOperationKey } from './game-account.ts';
import { METHODS, gameError } from './bridge.ts';
import { ChannelClient } from './wallet-channel.ts';

const COIN = 10n ** 18n;
/** Practice is test coins this tab keeps in memory: it starts with `PRACTICE_COINS`, and gets as many again once it
 * holds fewer than `PRACTICE_REFILL_BELOW`. Its casino bets are held to the casino's own rule against
 * `PRACTICE_BANKROLL`. */
export const PRACTICE_COINS = 100n * COIN;
export const PRACTICE_REFILL_BELOW = 10n * COIN;
export const PRACTICE_BANKROLL = 10_000_000n * COIN;
/** A practice casino bet's outcome: a uniform 64-bit number, drawn here. */
const draw = () => crypto.getRandomValues(new BigUint64Array(1))[0]!;
/** Whether the casino's own rule takes a casino bet against the practice bankroll. */
function admitted(bet: ReturnType<typeof betTerms>) {
  try {
    assessBet({ bankroll: PRACTICE_BANKROLL, bet });
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}

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
    kind: GameReceipt['kind'] = receipt.kind,
    status: GameReceipt['status'] =
      receipt.status === 'rejected' ? 'rejected' : kind === 'developer-bet' ? developerBetStatus(receipt) : 'settled';
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
 * The open game's spending limit. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the limit back to the balance it came from.
 * The signed channel balance is the money; the limit only caps what the game may risk. In practice, the limit is
 * in the test coins this tab keeps, and the wallet settles the game's casino bets and payments itself.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  /** The test coins this tab practices with. Never saved, signed or sent: a reload starts again. */
  practiceBalance = PRACTICE_COINS;
  /** Every practice operation's receipt, by the wallet's name for it, with the terms it was asked with. */
  practiced = new Map<string, { terms: string; receipt: GameReceipt }>();
  /** Choose what this tab plays with: test coins, or the channel's ETH. The open game's limit was in the other money,
   * so it goes back. */
  setPractice(this: CasinoWallet, on: boolean) {
    if (!on && !this.funded) throw new Error('Deposit ETH to play with it');
    this.preferPractice = on;
    this.render();
  }
  /** A limit belongs to the money it was granted in. When what this tab plays with has changed, the open game takes
   * the new money with a limit of nothing, before anything reads the session again. */
  syncSession(this: CasinoWallet) {
    if (this.game && this.game.practice !== this.practicing) {
      this.game.practice = this.practicing;
      this.game.balance = '0';
    }
  }
  /** More test coins, once they run low. */
  refillPractice(this: CasinoWallet) {
    if (this.practiceBalance >= PRACTICE_REFILL_BELOW)
      throw new Error('Test coins are topped up once you hold fewer than 10');
    this.practiceBalance += PRACTICE_COINS;
    this.render();
  }
  openGame(this: CasinoWallet, identity: GameIdentity) {
    this.game = {
      key: identity.key,
      identity: { ...identity, developer: getAddress(identity.developer) },
      practice: this.practicing,
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
    this.syncSession();
    return this.game;
  }
  gameLimit(this: CasinoWallet): GameLimit {
    const game = this.requireGame();
    return {
      balance: game.balance,
      pending: !game.practice && this.pending?.game?.key === game.key,
    };
  }
  /** What a game page learns when it loads: what this wallet offers, and what it plays with: test coins in practice,
   * or the network's ETH. Amounts on the bridge are whole numbers of the smallest unit. In practice the wallet takes
   * no developer bets, so it does not offer them. */
  gameHello(this: CasinoWallet) {
    const game = this.requireGame();
    return {
      methods: game.practice ? METHODS.filter(method => method !== 'game.developerBet') : METHODS,
      asset: this.asset,
      practice: game.practice,
      chainId: String(this.expectedChainId),
      // Every bound a bet is held to, as the protocol this wallet and its casino share has them.
      limits: LIMITS,
    };
  }
  /** Everything the open game learns about the player: the uname that is theirs for good, the alias
   * they are shown by if they took one, and what to price bets against. Their address, their channel
   * and their balances are none of a game's business. */
  gameInfo(this: CasinoWallet) {
    const game = this.requireGame();
    return {
      uname: this.uname,
      alias: this.alias,
      chainId: String(this.expectedChainId),
      bankroll: String(game.practice ? PRACTICE_BANKROLL : this.reportedBankroll),
      recommendedStake: game.practice ? String(COIN) : this.recommendedStake,
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
    if (this.requireGame().practice) return this.practiced.get(this.gameOperationId(id))?.receipt ?? null;
    const receipt = await this.getReceipt(this.gameOperationId(id));
    if (!receipt) return null;
    const answer = gameReceipt(id, receipt);
    if (answer.status === 'open') void this.collectDeveloperBet(receipt.bet).catch(() => {});
    return answer;
  }
  /** Which game asks, as its receipts remember it: its key, its own name for the operation, what it calls itself
   * and its developer. */
  gameIntent(this: CasinoWallet, id: string): GameIntent {
    const game = this.requireGame();
    return { key: game.key, id, name: game.identity.name, developer: game.identity.developer };
  }
  /** The only grant of spending authority: how much of the playing balance the open game may risk.
   * The limit lives in this tab's memory and signs nothing, so it can be set while an operation is
   * pending; what that operation has already committed is simply not the player's to allocate. */
  async setGameLimit(this: CasinoWallet, amount: string) {
    const n = gameAmount(amount, false);
    if (this.requireGame().practice) {
      if (n > this.practiceBalance) throw new Error('The limit exceeds your playing balance');
      this.game!.balance = String(n);
      return this.render();
    }
    return this.exclusive(async () => {
      this.ready();
      const game = this.requireGame();
      if (n > this.playableBalance()) throw new Error('The limit exceeds your playing balance');
      game.balance = String(n);
      this.render();
    });
  }
  /** A casino bet of the open game: settled at once against the bankroll, on the player's own round. The same
   * request again returns its receipt. */
  async gameCasinoBet(this: CasinoWallet, request: CasinoBetRequest) {
    const group = request.group === undefined ? {} : { group: request.group };
    if (this.requireGame().practice)
      return this.practice(request.id, 'casino-bet', {
        stake: request.stake,
        chance: request.chance,
        prize: request.prize,
        ...group,
      });
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
   * stands. A developer's server settles its bets at the casino, so they are placed with ETH, never in practice. */
  async gameDeveloperBet(this: CasinoWallet, request: DeveloperBetRequest) {
    if (this.requireGame().practice) throw gameError('practice', 'Developer bets are placed with ETH');
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
    if (this.requireGame().practice)
      return this.practice(request.id, 'payment', {
        amount: request.amount,
        ...(request.group === undefined ? {} : { group: request.group }),
      });
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
  /** A casino bet or a payment in practice, settled here in test coins: nothing is signed and nothing is sent. As with
   * money, the same request again returns its receipt, a casino bet is held to the casino's own rule, against the
   * practice bankroll, and its outcome decides it: drawn here. */
  practice(
    this: CasinoWallet,
    id: string,
    kind: 'casino-bet' | 'payment',
    request: { stake?: string; chance?: string; prize?: string; amount?: string; group?: string },
  ): GameReceipt {
    const game = this.requireGame(),
      operationId = this.gameOperationId(id),
      terms = JSON.stringify([kind, request.stake ?? request.amount, request.chance, request.prize, request.group]),
      known = this.practiced.get(operationId);
    if (known) {
      if (known.terms !== terms)
        throw gameError('id-conflict', 'Operation ID is bound to a different intent (terms or game)');
      return known.receipt;
    }
    const group = request.group === undefined ? {} : { group: request.group },
      cost = gameAmount(kind === 'payment' ? request.amount : request.stake);
    if (cost > BigInt(game.balance)) throw gameError('insufficient-funds', 'Bet exceeds the game balance');
    let receipt: GameReceipt = { id, kind, status: 'settled', ...group },
      paid = 0n;
    if (kind === 'casino-bet') {
      const bet = betTerms(request.stake!, request.chance!, request.prize!);
      try {
        describeBet(bet);
      } catch {
        throw gameError('invalid-request', 'Invalid bet terms');
      }
      receipt = {
        id,
        kind,
        status: 'settled',
        stake: request.stake,
        chance: request.chance,
        prize: request.prize,
        ...group,
      };
      if (admitted(bet)) {
        const outcome = draw();
        paid = betPayout(bet, outcome);
        receipt = { ...receipt, outcome: String(outcome), payout: String(paid) };
      } else receipt = { ...receipt, status: 'rejected', reason: 'The bankroll cannot take this casino bet' };
    }
    // A declined casino bet moves nothing.
    const change = receipt.status === 'rejected' ? 0n : paid - cost;
    game.balance = String(BigInt(game.balance) + change);
    this.practiceBalance += change;
    this.practiced.set(operationId, { terms, receipt });
    this.render();
    return receipt;
  }
}
