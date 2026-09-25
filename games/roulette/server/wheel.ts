/**
 * The wheel everyone at the table shares, run by the game's developer. It keeps a round of its own open, which the
 * casino names and the wheel commits the seed of its casino bet to, so where the ball lands is fixed before anybody
 * bets, and neither the casino nor the wheel knows it until both are out. Pages bet on the round the table shows, by
 * name: each wallet places a developer bet, whose stake goes to the developer's bank. Twenty seconds after the first
 * chip is down the wheel spins: it covers every bet that is a roulette layout with one casino bet of the table's
 * layouts together against the casino's bankroll, which reveals where the ball lands, and pays each covered bet what
 * its layout pays there and every other its stake back. Everything that touches the outside world is handed in, so
 * the same wheel runs in a Worker or a test.
 */
import { owed } from '@hookedin/play/sdk/developer';
import type { AssetId, Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { isLayout, pocket, together } from '../src/table.ts';

export interface Spin {
  round: string;
  seed: string;
  secret: string;
  number: number;
  players: number;
}
export interface WheelState {
  last: Spin | null;
  /** The round the table takes bets on, saved before anybody is told of it, so a spin that stopped halfway is
   * finished on that round. */
  round: string | null;
}
export interface Deps {
  developer: Developer;
  /** What this wheel's table is played with. Every asset has a wheel of its own. */
  asset: AssetId;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Ask for `alarm()` at this time. */
  wake(at: number): void;
}
/** How long players have once the first chip is down. */
export const BETTING_MS = 20_000;
const RETRY_MS = 5_000,
  LOOK_MS = 1_000;

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The table's round and its open bets, as the casino had them when the wheel last looked. */
  private table: { at: number; round: Round | null; open: PublicDeveloperBet[] } = { at: 0, round: null, open: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = { last: saved?.last ?? null, round: saved?.round ?? null };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** What a page shows: the round to bet on, who is at the table, when the wheel spins, and where it last landed. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { open, round } = this.table;
      return {
        round: round?.id ?? null,
        closesAt: this.closesAt(),
        now: this.deps.now(),
        players: new Set(open.map(bet => bet.uname)).size,
        staked: String(open.reduce((sum, bet) => sum + BigInt(bet.stake), 0n)),
        last: this.state.last,
      };
    });
  }
  /** A page says its wallet placed a bet; the casino is asked, since a page can say anything. */
  placed() {
    this.table.at = 0;
    return this.view();
  }
  alarm() {
    return this.serialized(() => this.turn());
  }
  /** The wheel spins `BETTING_MS` after the first open bet on its round was placed, by the casino's clock. */
  private closesAt() {
    const first = this.table.open[0];
    return first && this.table.round ? first.placedAt + BETTING_MS : null;
  }
  private async turn() {
    const now = this.deps.now(),
      closesAt = this.closesAt();
    await this.look(now, closesAt !== null && now >= closesAt);
    const due = this.closesAt();
    if (due !== null && now >= due) await this.spin();
    const next = this.closesAt();
    if (next !== null) this.deps.wake(next);
  }
  /** Every open developer bet of the game, a page at a time, in the order they were placed. */
  private async openDeveloperBets() {
    const bets: PublicDeveloperBet[] = [];
    for (let after = ''; ;) {
      const page = await this.deps.developer.bets({ status: 'open', after });
      bets.push(...page.bets.filter(bet => bet.asset === this.deps.asset));
      if (!page.more) break;
      after = page.cursor;
    }
    return bets.sort((a, b) => a.placedAt - b.placedAt);
  }
  /** The table's round and its open bets, as the casino has them: asked at most once a second, and always before a
   * spin. A saved round the casino does not know, lost with its row or another deployment's, or one already revealed,
   * makes way for a new one. An open bet on any other round is what a spin left behind, or came too late for it: it
   * is settled now, from what that round's reveal says it is owed. */
  private async look(now: number, always: boolean) {
    if (now - this.table.at < LOOK_MS && !always) return;
    let round =
      this.state.round &&
      (await this.deps.developer.round(this.state.round).catch((error: any) => {
        if (error.status === 404) return null;
        throw error;
      }));
    if (!round || round.status === 'revealed') {
      // A spin that stopped halfway still shows where the ball landed.
      if (round) this.record(round, 0);
      round = await this.deps.developer.openRound(this.deps.asset);
      this.state.round = round.id;
      await this.deps.save(this.state);
    }
    const bets = await this.openDeveloperBets(),
      current = round.id;
    for (const other of new Set(bets.map(bet => bet.round ?? '').filter(id => id !== current)))
      await this.settle(
        other ? await this.deps.developer.round(other) : null,
        bets.filter(bet => (bet.round ?? '') === other),
      );
    this.table = { at: now, round, open: bets.filter(bet => bet.round === current) };
  }
  /** The spin: the wheel covers the table's layouts with one casino bet of them all together, which reveals the
   * round, and settles every bet on it. A spin that stopped halfway, its casino bet placed and its reply lost, finds
   * the round revealed and settles from what it says. */
  private async spin() {
    try {
      const developer = this.deps.developer;
      let round = await developer.round(this.state.round!);
      const bets = (await this.openDeveloperBets()).filter(bet => bet.round === round.id);
      if (round.status !== 'revealed') {
        const covered = bets
          .filter(bet => bet.prizes && isLayout({ stake: bet.stake, prizes: bet.prizes }))
          .slice(0, developer.limits.covers);
        if (covered.length)
          round = await developer.casinoBet({
            round: round.id,
            ...together(covered.map(bet => ({ stake: bet.stake, prizes: bet.prizes! }))),
            covers: covered.map(bet => bet.bet),
          });
      }
      await this.settle(round, bets);
      if (round.status === 'revealed') this.record(round, new Set(bets.map(bet => bet.uname)).size);
      this.state.round = null;
      await this.deps.save(this.state);
      this.table = { at: 0, round: null, open: [] };
    } catch (error) {
      // Tried again shortly; the same round and seed make it the same casino bet.
      this.deps.wake(this.deps.now() + RETRY_MS);
      throw error;
    }
  }
  /** Pay the open bets on a round what they are owed: what its layout pays where the ball landed, for a bet the
   * wheel's accepted casino bet covers; its stake back for every other, and for any bet on a round never revealed.
   * The casino's part is nothing: its commission is on the wheel's casino bet. */
  private async settle(round: Round | null, bets: PublicDeveloperBet[]) {
    const settlements = bets.map(bet => ({ bet: bet.bet, player: owed(bet, round), casino: 0n })),
      batch = this.deps.developer.limits.covers;
    for (let i = 0; i < settlements.length; i += batch)
      await this.deps.developer.settle(settlements.slice(i, i + batch));
  }
  /** Where a revealed round's ball landed, for the table to show, unless it is shown already. */
  private record(round: Round, players: number) {
    const { seed, secret, outcome } = round;
    if (outcome === undefined || seed === undefined || secret === undefined || this.state.last?.round === round.id)
      return;
    this.state.last = { round: round.id, seed, secret, number: pocket(BigInt(outcome)), players };
  }
}
