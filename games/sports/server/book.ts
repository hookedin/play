/**
 * A sports book: the game's referee at the casino. Each market is a developer's pot in each asset, with
 * outcomes the book names and odds it sets. The book quotes an entry at its odds, and its operator resolves
 * the market once the result is known. The book holds no money: the developer's bank at the casino pays
 * what a market owes beyond its entries, and keeps what it does not.
 * Everything that touches the outside world is handed in, so the same book runs in a Worker or a test.
 */
import type { AssetId, Referee } from '@hookedin/play/sdk/referee';

export interface Market {
  id: string;
  title: string;
  /** What can happen, by outcome number, with the book's decimal odds on each in basis points: 25000 pays
   * two and a half times the stake. */
  outcomes: { name: string; odds: number }[];
  /** No bet after `closesAt`, and every bet refunded if the market is not resolved by `deadline` (unix ms). */
  closesAt: number;
  deadline: number;
  /** The market's pot in each asset. */
  pots: Record<AssetId, string>;
  status: 'open' | 'resolved' | 'void';
  winner?: number;
}
export interface Deps {
  referee: Referee;
  now(): number;
  save(markets: Market[]): void | Promise<void>;
}
const ASSETS: AssetId[] = ['eth', 'test'];
/** How long a quote holds, in seconds: long enough for the wallet to sign and send the bet. */
const QUOTE_S = 60;
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

export class Book {
  readonly deps: Deps;
  markets: Market[];
  constructor(deps: Deps, markets: Market[] = []) {
    this.deps = deps;
    this.markets = markets;
  }
  /** Every market, with one the casino has voided at its deadline shown as void. */
  list() {
    const now = this.deps.now();
    return this.markets.map(market =>
      market.status === 'open' && market.winner === undefined && now >= market.deadline
        ? { ...market, status: 'void' as const }
        : market,
    );
  }
  /** Open a market: a pot in each asset, whose referee is this book. */
  async open(input: any) {
    const now = this.deps.now(),
      { title, outcomes, closesAt, deadline } = input ?? {};
    if (typeof title !== 'string' || !title || title.length > 120) throw invalid('A market has a title');
    if (
      !Array.isArray(outcomes) ||
      outcomes.length < 2 ||
      outcomes.length > 16 ||
      !outcomes.every(
        (o: any) =>
          typeof o?.name === 'string' &&
          o.name &&
          o.name.length <= 60 &&
          Number.isSafeInteger(o.odds) &&
          o.odds > 10000,
      )
    )
      throw invalid('A market has 2 to 16 named outcomes, each at odds above 10000 basis points');
    if (!Number.isSafeInteger(closesAt) || !Number.isSafeInteger(deadline) || closesAt <= now || deadline < closesAt)
      throw invalid('A market closes in the future, and is resolved by its deadline');
    const pots = {} as Record<AssetId, string>;
    for (const asset of ASSETS)
      pots[asset] = (
        await this.deps.referee.open({ bank: 'developer', asset, outcomes: outcomes.length, closesAt, deadline })
      ).pot.id;
    const market: Market = {
      id: crypto.randomUUID(),
      title,
      outcomes: outcomes.map(({ name, odds }: any) => ({ name, odds })),
      closesAt,
      deadline,
      pots,
      status: 'open',
    };
    this.markets.push(market);
    await this.deps.save(this.markets);
    return market;
  }
  /** The book's price for a bet: its stake, paid back at the market's odds if its outcome wins. */
  async quote(input: any) {
    const now = this.deps.now(),
      market = this.find(input?.market),
      pick = market.outcomes[input?.outcome],
      pot = market.pots[input?.asset as AssetId];
    if (market.status !== 'open' || market.winner !== undefined || now >= market.closesAt)
      throw invalid('The market takes no more bets');
    if (!pick || !pot) throw invalid('No such outcome');
    let stake: bigint;
    try {
      stake = BigInt(input.stake);
    } catch {
      throw invalid('A stake is a whole number of the smallest unit');
    }
    if (stake <= 0n) throw invalid('A stake is a whole number of the smallest unit');
    const outcome = Number(input.outcome),
      prizes = [
        {
          rangeStart: String(outcome),
          rangeEnd: String(outcome + 1),
          payout: String((stake * BigInt(pick.odds)) / 10000n),
        },
      ];
    return {
      pot,
      prizes,
      quote: await this.deps.referee.quote(pot, stake, prizes, Math.floor(now / 1000) + QUOTE_S),
    };
  }
  /** Name the winner: each pot pays its bets on it, with the developer's bank paying what the pot cannot.
   * The winner is saved first, so a resolution cut short is finished with the same one. */
  async resolve(id: string, winner: any) {
    const market = this.find(id);
    if (!Number.isSafeInteger(winner) || !market.outcomes[winner]) throw invalid('No such outcome');
    if (market.status === 'void') throw invalid('The market is void');
    if (market.winner !== undefined && market.winner !== winner) throw invalid('The market has another winner');
    market.winner = winner;
    await this.deps.save(this.markets);
    for (const asset of ASSETS) await this.deps.referee.resolve(market.pots[asset], { outcome: winner });
    market.status = 'resolved';
    await this.deps.save(this.markets);
    return market;
  }
  /** Call a market off: every bet is refunded. */
  async void(id: string) {
    const market = this.find(id);
    if (market.winner !== undefined) throw invalid('The market has a winner');
    for (const asset of ASSETS) await this.deps.referee.void(market.pots[asset]);
    market.status = 'void';
    await this.deps.save(this.markets);
    return market;
  }
  private find(id: unknown) {
    const market = this.markets.find(market => market.id === id);
    if (!market) throw Object.assign(new Error('Unknown market'), { status: 404 });
    return market;
  }
}
