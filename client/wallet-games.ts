import type {
  DeveloperBetRequest,
  CasinoBetRequest,
  GameAllowance,
  GameHistory,
  GameIdentity,
  GameReceipt,
  GameSession,
} from '../protocol/game-types.ts';
import type { AccountHistory, AccountHistoryEntry, Operation, Round } from '../protocol/types.ts';
import type { CasinoWallet, GameIntent, Receipt } from './wallet.ts';
import { ZeroAddress, getAddress } from 'ethers';
import * as read from '../protocol/read.ts';
import {
  BOUNDS,
  KIND,
  betPayout,
  hashOperation,
  landStep,
  outcome,
  same,
  verifyEvidence,
} from '../protocol/protocol.ts';
import { gameAmount, gameError, gameOperationKey } from './bridge.ts';
import { ChannelClient } from './wallet-channel.ts';

/** A page of the account's history of a game, as `GET /api/account/game-history` gives it, newest first. */
const historyPage = read.object<AccountHistory>({
  entries: read.list(
    read.firstOf<AccountHistoryEntry>(
      read.object<Extract<AccountHistoryEntry, { type: 'operation' }>>({
        type: read.oneOf('operation'),
        at: read.time,
        details: read.details,
        evidence: read.evidence,
        bet: read.optional(read.publicDeveloperBet),
      }),
      read.object<Extract<AccountHistoryEntry, { type: 'end' }>>({
        type: read.oneOf('end'),
        at: read.time,
        game: read.gameId,
        group: read.group,
        meta: read.meta,
      }),
    ),
    100,
  ),
  cursor: read.text,
  more: read.flag,
});

/** The one view a game gets of a wallet receipt, whichever request asked. The signed evidence, the
 * channel and its balance stay out: they would name the player. */
export const gameReceipt = (id: string, receipt: Receipt): GameReceipt => {
  // Declined because the player carried it out on another channel: its result is there, and nothing here may
  // look like a rejection the game would answer by placing the same bet again.
  if (receipt.used)
    throw gameError(
      'id-used',
      'This operation was carried out on another channel, and its result is not in this wallet',
    );
  return { id, ...receiptView(receipt) } as GameReceipt;
};
/** Where a step landed, from the seed the wallet drew it with: the result it reached, which leaves the cash its bet
 * kept with what it paid, or all the step held when it drew no bet, and the value the game shows it with. */
export const landed = (receipt: Partial<Receipt>) => {
  const table = receipt.details?.table,
    seed = receipt.seed ?? receipt.proof?.step.seed,
    op: Operation | undefined = receipt.proof?.step.operation;
  if (!table || !seed || (!op && receipt.status !== 'kept')) return null;
  return landStep(seed, table.results, op ? table.cash - op.amount + (receipt.payout ?? 0n) : table.cash);
};
/** How an operation ended, as a receipt says it to a game under whichever name. */
const receiptView = (receipt: Partial<Receipt>) => {
  // A developer bet is open until the wallet has collected what its developer paid. A step that drew no bet signed
  // nothing.
  const op = receipt.request ?? receipt.proof?.step.operation,
    kind = receipt.kind as GameReceipt['kind'],
    status: GameReceipt['status'] =
      receipt.status === 'rejected' || receipt.status === 'kept'
        ? receipt.status
        : receipt.payout === undefined && kind === 'developer-bet'
          ? 'open'
          : 'settled';
  return {
    kind,
    status,
    ...(op && kind !== 'payment' ? { stake: op.amount } : {}),
    ...(op && kind === 'casino-bet' ? { chance: op.chance, prize: op.prize } : {}),
    ...(receipt.details?.meta ? { meta: receipt.details.meta } : {}),
    ...(receipt.details?.group ? { group: receipt.details.group } : {}),
    ...(receipt.bet ? { bet: receipt.bet } : {}),
    ...(status === 'rejected' ? {} : (landed(receipt) ?? {})),
    // The outcome and what the bet paid: everything a game needs to show the result.
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(receipt.payout === undefined ? {} : { payout: receipt.payout }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  };
};

/**
 * The open game's allowance. It lives only in this tab's memory: the wallet persists no game
 * state, and leaving the game or closing the tab releases the allowance back to the balance it came from.
 * The signed channel balance is the money; the allowance only caps what the game may risk.
 */
export class GameSessions extends ChannelClient {
  game: GameSession | null = null;
  /** What a game was last told it may stake, and the session it was told in. */
  told: { game: GameSession; allowance: GameAllowance } | null = null;
  /** A game opens with nothing to play with, every time: only the player's own word in the wallet's dialog gives it
   * an allowance. */
  openGame(this: CasinoWallet, identity: GameIdentity) {
    this.game = {
      identity: { ...identity, developer: getAddress(identity.developer) },
      allowance: 0n,
      allowed: 0n,
      net: 0n,
      developerBets: false,
      table: {},
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
  /** What the open game may stake; with `group`, what a bet of that group may: the allowance and what the group has
   * won and the game has not shown yet. */
  gameAllowance(this: CasinoWallet, group?: string): GameAllowance {
    const game = this.requireGame();
    return {
      allowance: game.allowance + (group !== undefined && Object.hasOwn(game.table, group) ? game.table[group]! : 0n),
      pending: this.pending?.game?.id === game.identity.id,
      developerBets: game.developerBets,
    };
  }
  /** Tell the open game what `game.allowance` answers, without a group, whenever any of it changes: every change the
   * wallet makes ends in `render`, which calls this, so the game hears of each, whatever made it. */
  tellAllowance(this: CasinoWallet) {
    const game = this.game;
    if (!game) return;
    const allowance = this.gameAllowance(),
      told = this.told?.game === game ? this.told.allowance : null;
    if (told && (['allowance', 'pending', 'developerBets'] as const).every(key => told[key] === allowance[key])) return;
    this.told = { game, allowance };
    this.onGameAllowance(game.identity, allowance);
  }
  /** The open game's visit so far: what the player allowed it, what they took back, what its bets won or lost, and
   * the allowance left. What its groups hold counts as staked until the game has shown how they ended. */
  gameVisit(this: CasinoWallet) {
    const { allowed, net, allowance: left } = this.requireGame(),
      result = net - this.inPlay();
    return { allowed, takenBack: allowed + result - left, result, left };
  }
  /** What the open game's groups have won and it has not shown yet: still the player's, and in their balance. */
  inPlay(this: CasinoWallet) {
    return Object.values(this.game?.table ?? {}).reduce((sum, amount) => sum + amount, 0n);
  }
  /** The open game has shown how a group ended: what the group won joins its allowance. With `meta`, the game's own
   * JSON saying how the group went, the casino keeps it in the player's history of the game. */
  async gameEnd(this: CasinoWallet, group: string, meta?: Record<string, unknown>) {
    const game = this.requireGame(),
      { [group]: won, ...rest } = game.table;
    if (Object.hasOwn(game.table, group)) {
      game.table = rest;
      game.allowance += won!;
      this.render();
    }
    if (meta) await this.api('/api/account/game-history', { game: game.identity.id, group, meta });
  }
  /** A page of the open game's history for its player, newest first, as the casino keeps it for the account, whichever
   * channel and device played it: the game's operations the casino carried out, each a receipt this wallet checked
   * against the evidence the account and the casino signed, and the groups the game ended with meta. */
  async gameHistory(this: CasinoWallet, after = '', limit = 50): Promise<GameHistory> {
    const identity = this.requireGame().identity;
    // A guest has no account, and so no history.
    if (!this.signer) return { entries: [], cursor: after, more: false };
    const page = historyPage(
      await this.api(`/api/account/game-history?game=${identity.id}&after=${encodeURIComponent(after)}&limit=${limit}`),
    );
    return {
      entries: page.entries.map(entry =>
        entry.type === 'operation'
          ? { ...receiptView(this.pastReceipt(entry, identity)), at: entry.at }
          : { kind: 'end', group: entry.group, meta: entry.meta, at: entry.at },
      ) as GameHistory['entries'],
      cursor: page.cursor,
      more: page.more,
    };
  }
  /** An operation of a game as the casino kept it, checked as a reply is: the account signed the operation and the
   * checkpoint it follows, the casino signed both checkpoints, the details are the ones the operation signed and name
   * the game, and a casino bet's outcome is the one its seed and its round's secret make. A developer bet's payout is
   * what its settlement says, signed by a server its developer named. */
  pastReceipt(this: CasinoWallet, entry: Extract<AccountHistoryEntry, { type: 'operation' }>, identity: GameIdentity) {
    const { details, evidence } = entry,
      op = evidence.step.operation,
      { kind } = op;
    verifyEvidence({
      chainId: this.expectedChainId,
      casino: this.config.contractAddress,
      operator: this.operator,
      evidence,
      details,
    });
    if (
      !same(evidence.base.player, this.address) ||
      details.game !== identity.id ||
      (kind !== KIND.casinoBet && kind !== KIND.debit)
    )
      throw new Error("The casino lists an operation of another account or game as this game's");
    const receipt = { status: 'signed', proof: evidence, details };
    if (kind === KIND.casinoBet) {
      const { value } = outcome(evidence.step.seed, evidence.step.secret);
      return { ...receipt, kind: 'casino-bet', outcome: value, payout: betPayout(op, value) };
    }
    if (!details.meta) return { ...receipt, kind: 'payment' };
    const bet = {
      ...receipt,
      kind: 'developer-bet',
      bet: hashOperation(this.domain, op).toLowerCase(),
      stake: op.amount,
      game: { id: identity.id, developer: identity.developer },
    };
    return entry.bet?.status === 'settled' ? { ...bet, ...this.developerBetPaid(bet, entry.bet) } : bet;
  }
  /** The account's bets as the casino keeps them, whichever device played them, newest first: a page of its history of
   * the game `game`, or of every game, each operation checked as `pastReceipt` checks it, as a receipt the wallet shows
   * in full. `games` names the games this wallet knows, with their developers: a developer bet is a bet once its
   * developer has settled it, and is shown only for a game whose developer the wallet knows, whose settlement it checks.
   * The casino keeps a game's own name for an operation only as a hash, which names it here; a step that drew no bet
   * never reached the casino. */
  async recordedBets(
    this: CasinoWallet,
    games: ReadonlyMap<string, { name: string; developer: string }>,
    game = '',
    limit = 100,
  ): Promise<Partial<Receipt>[]> {
    if (!this.signer) return [];
    const page = historyPage(await this.api(`/api/account/game-history?game=${game}&after=&limit=${limit}`));
    return page.entries.flatMap(entry => {
      if (entry.type !== 'operation') return [];
      const id = entry.details.game!,
        known = games.get(id);
      if (entry.details.meta && !known) return [];
      const identity = { id, url: '', name: known?.name ?? '', developer: known?.developer ?? ZeroAddress },
        receipt: Partial<Receipt> = this.pastReceipt(entry, identity),
        op = entry.evidence.step.operation;
      if (receipt.kind === 'developer-bet' && receipt.payout === undefined) return [];
      return [
        {
          ...receipt,
          operationId: entry.details.id,
          game: { id, operation: '', name: identity.name, developer: identity.developer },
          stake: op.amount,
          ...(receipt.kind === 'casino-bet' ? { maxPayout: op.prize, expectedPayout: op.prize * op.chance } : {}),
          createdAt: new Date(entry.at).toISOString(),
        },
      ];
    });
  }
  /** An operation of the open game settled, `spent` taken and `won` paid, with `kept` of its group's cash staying out
   * of it: a bet in a group takes what it stakes and keeps from what the group holds first, and leaves what it kept
   * and won with the group, so a round's whole stake leaves the allowance with its first step; anything else takes
   * from and pays into the allowance at once. */
  gameSettled(this: CasinoWallet, spent: bigint, won: bigint, group?: string, kept = 0n) {
    const game = this.game!,
      held = group !== undefined && Object.hasOwn(game.table, group) ? game.table[group]! : 0n,
      needed = spent + (group ? kept : 0n),
      drawn = needed < held ? needed : held,
      allowance = game.allowance - (needed - drawn) + (group ? 0n : won);
    game.allowance = allowance < 0n ? 0n : allowance;
    game.net += won - spent;
    if (group) game.table = { ...game.table, [group]: held - drawn + kept + won };
  }
  /** What a game page learns when it loads: every bound a bet is held to, as the protocol this wallet and its casino
   * share has them. */
  gameHello(this: CasinoWallet) {
    this.requireGame();
    return { bounds: BOUNDS };
  }
  /** Everything the open game learns about the player: the uname that is theirs for good, the Discord username
   * they are shown by if they verified one, and what to price bets against: the virtual bankroll of the casino's quote,
   * asked for once the account plays. Their address, their channel and their balances are none of a game's business. */
  async gameInfo(this: CasinoWallet) {
    this.requireGame();
    const quote = this.playable ? await this.ownQuote().catch(() => null) : null;
    return {
      uname: this.uname,
      discordUsername: this.discordUsername,
      chainId: this.expectedChainId,
      virtualBankroll: quote?.message.virtualBankroll ?? 0n,
      recommendedStake: this.recommendedStake,
    };
  }
  /** A developer's round as the casino shows it to anyone, read through this wallet: a game whose players share a
   * draw checks the rounds its developer walked it with here, since its page talks to nobody but its own origin. */
  async gameRound(this: CasinoWallet, id: string): Promise<Round> {
    this.requireGame();
    return read.round(await this.api(`/api/rounds/${id}`));
  }
  /** A game's name for an operation, for its player: the same in every channel they open, and apart for each game,
   * so a retry after a new channel finds the operation instead of repeating it. */
  gameOperationId(this: CasinoWallet, id: string) {
    gameOperationKey(id);
    return `game:${this.requireGame().identity.id}:${id}`;
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
  /** The receipt of one of the open game's operations, to show the player in full: the proof is the wallet's to
   * show, never the game's. */
  async gameBet(this: CasinoWallet, id: string) {
    const receipt = await this.getReceipt(this.gameOperationId(id));
    if (!receipt) throw gameError('not-found', 'This wallet keeps no receipt of that operation');
    return receipt;
  }
  /** A game's latest bet whose result the player has seen, as this browser keeps it: a casino bet, a step that drew no
   * bet, or a developer bet once what it paid is collected; outside a group, or in one the game has ended. A group the
   * open game has not ended holds a result it has not shown, which this never gives away. */
  lastShownBet(this: CasinoWallet, gameId: string) {
    const held = this.game?.identity.id === gameId ? this.game.table : {};
    return (
      this.history.find(
        receipt =>
          receipt.game?.id === gameId &&
          (receipt.kind === 'casino-bet'
            ? receipt.status === 'signed' || receipt.status === 'kept'
            : receipt.kind === 'developer-bet' && receipt.status === 'signed' && receipt.payout !== undefined) &&
          !(receipt.details?.group && Object.hasOwn(held, receipt.details.group)),
      ) ?? null
    );
  }
  /** The round the channel's next casino bet settles on, in whatever game: the hash of a secret the casino fixed before
   * the bet, which its quote for the latest state names. Null while the account cannot play, and while an operation is
   * under way, since the next bet follows it. */
  async nextRound(this: CasinoWallet) {
    if (!this.playable || this.pending) return null;
    return (await this.ownQuote().catch(() => null))?.message.round ?? null;
  }
  /** Which game asks, as its receipts remember it: its ID, its own name for the operation, what it calls itself
   * and its developer. */
  gameIntent(this: CasinoWallet, operation: string, group?: string, kept?: bigint): GameIntent {
    const game = this.requireGame();
    return {
      id: game.identity.id,
      operation,
      name: game.identity.name,
      developer: game.identity.developer,
      ...(group ? { group } : {}),
      ...(group && kept !== undefined ? { kept } : {}),
    };
  }
  /** The only grant of spending authority: the open game's allowance, how much of the balance it may risk, and
   * whether it may place developer bets with it, which only a published game can. The allowance lives in this tab's
   * memory and signs nothing, so it can be set while an operation is pending; what that operation has already
   * committed is simply not the player's to allow. What the game's groups hold stays with them. */
  async setGameAllowance(this: CasinoWallet, amount: bigint, developerBets = this.game?.developerBets ?? false) {
    const n = gameAmount(amount, false);
    this.requireGame();
    // It waits for the wallet's own background work rather than failing as busy.
    return this.exclusive(
      async () => {
        await this.ready();
        const game = this.requireGame();
        if (n > this.playableBalance() - this.inPlay()) throw new Error('The allowance exceeds your balance');
        if (developerBets && game.identity.developer === ZeroAddress)
          throw new Error('Only a published game places developer bets');
        if (n > game.allowance) game.allowed += n - game.allowance;
        game.allowance = n;
        // Taking the whole allowance back takes back every permission with it.
        game.developerBets = n > 0n && developerBets;
        this.render();
      },
      { wait: true },
    );
  }
  /** A step of the open game: the wallet splits its table into casino bets and draws one, which settles at once against
   * the bankroll, on the player's own round, and lands it on a result. The same request again returns its receipt. */
  async gameCasinoBet(this: CasinoWallet, request: CasinoBetRequest) {
    const group = request.group === undefined ? {} : { group: request.group };
    return gameReceipt(
      request.id,
      await this.playStep(
        { cash: request.cash, results: request.results, ...group },
        this.gameOperationId(request.id),
        this.gameIntent(request.id, request.group),
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
        {
          stake: gameAmount(request.stake),
          meta: request.meta,
          ...(request.round === undefined ? {} : { round: request.round }),
          ...group,
        },
        this.gameOperationId(request.id),
        this.gameIntent(request.id, request.group),
      ),
    );
  }
  async gamePayment(this: CasinoWallet, request: { id: string; amount: bigint; group?: string; kept?: bigint }) {
    return gameReceipt(
      request.id,
      await this.payBankroll(
        gameAmount(request.amount),
        this.gameOperationId(request.id),
        this.gameIntent(request.id, request.group, request.kept),
        request.group,
      ),
    );
  }
}
