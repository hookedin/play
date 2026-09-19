import type { GameIdentity, GameLimit, GameRequest, GameSession, GameStake } from '../protocol/game-types.ts';
import type { CasinoWallet } from './wallet.ts';
import { getAddress, parseEther } from 'ethers';
import { same } from '../protocol/protocol.ts';
import { describeBet } from '../protocol/risk.ts';
import { gameKey, gameAmount, gameOperationKey } from './game-account.ts';
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
        ...(receipt.matchId === undefined ? {} : { matchId: receipt.matchId }),
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      }
    : null;

/** What a practice game starts with, and is topped back up to. */
const PRACTICE_MONEY = parseEther('1');
/** The bankroll a practice game prices against when the casino has reported none. */
const PRACTICE_BANKROLL = parseEther('1000');

/**
 * The open game's spending limit. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the limit back to the channel balance.
 * The signed channel balance is the money; the limit only caps what the game may risk.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  openGame(this: CasinoWallet, identity: GameIdentity) {
    const key = gameKey(identity);
    this.game = { key, identity: { ...identity, developer: getAddress(identity.developer) }, balance: '0' };
    this.render();
    return key;
  }
  closeGame(this: CasinoWallet) {
    this.game = null;
    this.render();
  }
  requireGame(this: CasinoWallet) {
    if (!this.game) throw new Error('No game is open');
    return this.game;
  }
  gameLimit(this: CasinoWallet): GameLimit {
    const game = this.requireGame();
    return {
      balance: game.balance,
      pending: !game.practice && this.pending?.game?.key === game.key,
      practice: game.practice === true,
    };
  }
  /** What the open game learns about the wallet. A practice game sees its practice money as an open channel. */
  gameInfo(this: CasinoWallet): Record<string, unknown> {
    const game = this.requireGame();
    if (!game.practice) return { ...this.publicState, practice: false };
    return {
      ...this.publicState,
      practice: true,
      balance: game.balance,
      availableBalance: '0',
      channelId: 'practice',
      channelStatus: '1',
      bankroll: BigInt(this.reportedBankroll) > 0n ? this.reportedBankroll : String(PRACTICE_BANKROLL),
    };
  }
  gameOperationId(this: CasinoWallet, id: string) {
    gameOperationKey(id);
    return `game:${this.currentId}:${this.requireGame().key}:${id}`;
  }
  async gameReceipt(this: CasinoWallet, id: string) {
    const game = this.requireGame();
    if (game.practice) return game.practiceReceipts!.get(id) ?? null;
    return gameReceipt(await this.getReceipt(this.gameOperationId(id)));
  }
  /** The only grant of spending authority: how much of the signed balance the open game may risk. */
  async setGameLimit(this: CasinoWallet, amount: string) {
    const n = gameAmount(amount, false);
    return this.exclusive(async () => {
      this.ready();
      const game = this.requireGame();
      if (game.practice) throw new Error('This game is playing with practice money');
      if (this.pending) throw new Error('Recover the pending operation before changing the limit');
      if (n > (await this.balance())) throw new Error('The limit exceeds your playing balance');
      game.balance = String(n);
      this.render();
    });
  }
  /**
   * Practice money exists only in this tab's memory. The wallet draws every outcome itself, uniformly
   * over the same 64-bit space, and pays the same prizes, so the odds are those of real play.
   */
  setPractice(this: CasinoWallet, practice: boolean) {
    const game = this.requireGame();
    if (this.pending?.game?.key === game.key) throw new Error('Recover the pending operation first');
    game.practice = practice;
    game.balance = practice ? String(PRACTICE_MONEY) : '0';
    game.practiceReceipts = new Map();
    this.render();
  }
  /** Top a practice game back up to its starting money, or to what its next step needs. */
  refillPractice(this: CasinoWallet, amount = 0n) {
    const game = this.requireGame(),
      target = BigInt(game.balance) + amount;
    game.balance = String(target > PRACTICE_MONEY ? target : PRACTICE_MONEY);
    this.render();
  }
  practiceStep(this: CasinoWallet, id: string, kind: string, debit: bigint, settle: () => Record<string, unknown>) {
    const game = this.requireGame(),
      saved = game.practiceReceipts!.get(id);
    if (saved) return saved;
    if (debit > BigInt(game.balance)) throw new Error('Bet exceeds the game balance');
    const receipt = { id, kind, status: 'practice', verified: true, practice: true, operationId: id, ...settle() };
    game.balance = String(BigInt(game.balance) - debit + BigInt((receipt as any).payout ?? 0));
    game.practiceReceipts!.set(id, receipt);
    this.render();
    return receipt;
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
      throw new Error("Allow this game to use its host's randomness before betting on a shared round");
    const terms = {
      stake: gameAmount(request.stake),
      prizes: request.prizes.map(prize => ({
        rangeStart: gameAmount(prize.rangeStart, false),
        rangeEnd: gameAmount(prize.rangeEnd),
        payout: gameAmount(prize.payout),
      })),
      ...(request.round ? { round: request.round } : {}),
    };
    if (game.practice) {
      if (request.round) throw new Error('Shared rounds are not available with practice money');
      describeBet(terms);
      return this.practiceStep(request.id, 'bet', terms.stake, () => {
        const outcome = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0);
        const payout = terms.prizes.reduce(
          (sum, prize) => (outcome >= prize.rangeStart && outcome < prize.rangeEnd ? sum + prize.payout : sum),
          0n,
        );
        return { outcome: String(outcome), payout: String(payout) };
      });
    }
    return this.executeBet(terms, game.identity.developer, this.gameOperationId(request.id), {
      key: game.key,
      id: request.id,
    });
  }
  /** The player accepts that this oracle decides the open game's matches, with the casino holding the stakes. */
  allowOracle(this: CasinoWallet, oracle: string) {
    const game = this.requireGame();
    game.oracles = [...new Set([...(game.oracles || []), getAddress(oracle)])];
  }
  async gameStake(this: CasinoWallet, request: GameStake) {
    const game = this.requireGame();
    if (game.practice) throw new Error('Matches against other players are not available with practice money');
    if (!same(request.match?.developer, game.identity.developer))
      throw new Error('Match developer differs from the selected game');
    // Who decides a match, and that the casino holds the money meanwhile, is the player's choice.
    if (!game.oracles?.some(oracle => same(oracle, request.match.oracle)))
      throw new Error("Allow this oracle to decide the game's matches before staking");
    return this.stakeMatch(request.match, this.gameOperationId(request.id), { key: game.key, id: request.id });
  }
  /** Withdraw this game's hosted bet, or learn its result if the round's owner settled it first. */
  async gameCancel(this: CasinoWallet, request: { id: string }) {
    const game = this.requireGame();
    if (this.pending?.game?.key !== game.key || this.pending.game.id !== request.id)
      throw new Error('No pending operation with this ID');
    return this.cancelPending();
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: string }) {
    const game = this.requireGame();
    if (game.practice) return this.practiceStep(request.id, 'payment', gameAmount(request.amount), () => ({}));
    return this.payBankroll(
      gameAmount(request.amount),
      this.gameOperationId(request.id),
      { key: game.key, id: request.id },
      game.identity.developer,
    );
  }
  async gameTransfer(this: CasinoWallet, request: { id: string; amount: string }) {
    const game = this.requireGame();
    if (game.practice) throw new Error('Transfers are not available with practice money');
    return this.transfer(
      gameAmount(request.amount),
      game.identity.developer,
      this.gameOperationId(request.id),
      { key: game.key, id: request.id },
      game.identity.developer,
    );
  }
}
