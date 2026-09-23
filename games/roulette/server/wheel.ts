/**
 * The wheel everyone at the table shares. It is the game's referee at the casino. It keeps a round open, which
 * the casino names and the wheel commits the seed it will draw it with to, so where the ball lands is fixed
 * before anybody bets, and neither the casino nor the wheel knows it until both are out. Pages bet on the round
 * the table shows, by name, and their wallets place the bets by themselves; the casino takes each against the
 * bankroll as it is placed. Twenty seconds after the first chip is down the wheel draws the round: every bet on
 * it rides one spin. The wheel never touches a bet, and it holds no money. Everything that touches the outside
 * world is handed in, so the same wheel runs in a Worker or a test.
 */
import type { AssetId, PublicBet, Referee, Round } from '@hookedin/play/sdk/referee';
import { pocket } from '../src/table.ts';

export interface Spin {
  round: string;
  seed: string;
  secret: string;
  number: number;
  players: number;
}
export interface WheelState {
  last: Spin | null;
  /** The round the table takes bets on, saved before anybody is told of it, so a draw whose reply was lost is
   * the round the wheel asks about again. */
  round: string | null;
}
export interface Deps {
  referee: Referee;
  /** What this wheel's table is played with. Every asset has a wheel of its own. */
  asset: AssetId;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Ask for `alarm()` at this time. */
  wake(at: number): void;
}
/** How long players have once the first chip is down. */
export const BETTING_MS = 20_000;
/** A round is drawn this long before its deadline at the latest, however late its first chip came. */
export const MARGIN_MS = 5_000;
const RETRY_MS = 5_000,
  LOOK_MS = 1_000;

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The table's round and its open bets, as the casino had them when the wheel last looked. */
  private table: { at: number; round: Round | null; open: PublicBet[] } = { at: 0, round: null, open: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = { last: null, round: null, ...saved };
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
  /** The wheel spins `BETTING_MS` after the first open bet was placed, by the casino's clock, and always before
   * the round's deadline, when its bets would come back. */
  private closesAt() {
    const first = this.table.open[0],
      round = this.table.round;
    return first && round ? Math.min(first.placedAt + BETTING_MS, round.deadline - MARGIN_MS) : null;
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
  /** The table's round and its open bets, as the casino has them: asked at most once a second, and always before
   * a spin. A saved round that is not the one taking bets was drawn, or passed its deadline; if
   * it was drawn, where the ball landed is recorded before the next round is saved. One the casino does not
   * know, lost with its row or another deployment's, has nothing to show. */
  private async look(now: number, always: boolean) {
    if (now - this.table.at < LOOK_MS && !always) return;
    const round = await this.deps.referee.open(this.deps.asset);
    if (this.state.round !== round.id) {
      const saved = this.state.round,
        known =
          saved &&
          (await this.deps.referee.round(saved).catch((error: any) => {
            if (error.status === 404) return null;
            throw error;
          }));
      if (saved && known) this.record(saved, known);
      this.state.round = round.id;
      await this.deps.save(this.state);
    }
    const open = (await this.deps.referee.bets()).filter(bet => bet.round === round.id && bet.status === 'open');
    this.table = { at: now, round, open };
  }
  /** Where a drawn round's ball landed, for the table to show, unless it is shown already. */
  private record(round: string, drawn: { seed?: string; secret?: string; outcome?: string }, players = 0) {
    const { seed, secret, outcome } = drawn;
    if (outcome === undefined || seed === undefined || secret === undefined || this.state.last?.round === round) return;
    this.state.last = { round, seed, secret, number: pocket(BigInt(outcome)), players };
  }
  /** The round is drawn: the casino reveals its secret and pays every bet on it, and the ball lands where the
   * outcome says. The next look opens the round after it. */
  private async spin() {
    try {
      const drawn = await this.deps.referee.draw(this.state.round!);
      this.record(drawn.round, drawn, new Set(drawn.bets.map(bet => bet.uname)).size);
      await this.deps.save(this.state);
      this.table = { at: 0, round: null, open: [] };
    } catch (error) {
      // Tried again shortly; the same round and seed make it the same draw.
      this.deps.wake(this.deps.now() + RETRY_MS);
      throw error;
    }
  }
}
