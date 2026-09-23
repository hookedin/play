/**
 * The wheel everyone at the table shares. It is the game's referee at the casino. It keeps a round open, which
 * the casino names and the wheel commits the seed it will draw it with to, so where the ball lands is fixed
 * before anybody bets, and neither the casino nor the wheel knows it until both are out. Players' wallets bet on
 * the open round by themselves, and twenty seconds after the first chip is down the wheel draws the round:
 * every bet on it rides one spin against the bankroll. The wheel never touches a bet, and it holds no money.
 * Everything that touches the outside world is handed in, so the same wheel runs in a Worker or a test.
 */
import type { AssetId, PublicBet, Referee } from '@hookedin/play/sdk/referee';
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
const RETRY_MS = 5_000,
  LOOK_MS = 1_000;

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The open bets on the table's round, as the casino had them when the wheel last looked. */
  private bets: { at: number; open: PublicBet[] } = { at: 0, open: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = saved ?? { last: null };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** What a page shows: who is at the table, when the wheel spins, and where it last landed. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { open } = this.bets;
      return {
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
    this.bets.at = 0;
    return this.view();
  }
  alarm() {
    return this.serialized(() => this.turn());
  }
  /** The wheel spins `BETTING_MS` after the first open bet was placed, by the casino's clock. */
  private closesAt() {
    const first = this.bets.open[0];
    return first ? first.placedAt + BETTING_MS : null;
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
  /** The open bets on the table's round, as the casino has them: asked at most once a second, and always
   * before a spin. The round is opened first, so players always have one to bet on. */
  private async look(now: number, always: boolean) {
    if (now - this.bets.at < LOOK_MS && !always) return;
    const round = await this.deps.referee.open(this.deps.asset);
    const open = (await this.deps.referee.bets()).filter(bet => bet.round === round.id && bet.status === 'open');
    this.bets = { at: now, open };
  }
  /** The round is drawn: the casino reveals its secret and pays every bet it took, and the ball lands where the
   * outcome says. A bet the draw could not take is refunded. The next round opens with it. */
  private async spin() {
    try {
      const drawn = await this.deps.referee.draw(this.deps.asset);
      if (drawn.outcome !== undefined)
        this.state.last = {
          round: drawn.round,
          seed: drawn.seed!,
          secret: drawn.secret!,
          number: pocket(drawn.outcome),
          players: new Set(drawn.bets.map(bet => bet.uname)).size,
        };
      await this.deps.save(this.state);
      this.bets = { at: 0, open: [] };
    } catch (error) {
      // Tried again shortly; the same round and seed make it the same draw.
      this.deps.wake(this.deps.now() + RETRY_MS);
      throw error;
    }
  }
}
