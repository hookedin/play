/**
 * The wheel everyone at the table shares. It is the game's referee at the casino: it opens a house pot
 * with the hash of a seed of its own, and resolves it with that seed when the betting time is up.
 * Players' wallets enter the pot by themselves, so the wheel never touches a bet, and it holds no money.
 * Nobody knows where the ball lands while bets are taken: only the casino has the pot's secret, and
 * only the wheel has its seed.
 * Everything that touches the outside world is handed in, so the same wheel runs in a Worker or a test.
 */
import type { AssetId, Referee } from '@hookedin/play/sdk/referee';
import { roundOutcome } from '@hookedin/play/sdk/referee';
import { pocket } from '../src/table.ts';

export interface Spin {
  pot: string;
  seed: string;
  secret: string;
  number: number;
  players: number;
}
export interface WheelState {
  /** The pot the pages enter now. It is saved before anybody is shown it. */
  pot: string | null;
  /** That pot's seed: kept here, shown to nobody, and given to the casino only to resolve the pot. */
  seed: string | null;
  openedAt: number;
  /** When the wheel spins: set once somebody is in the pot, so an empty table waits instead of spinning. */
  closesAt: number | null;
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
/** Room for the spin itself: the alarm, the request, and a retry or two. The casino voids a pot not
 * resolved within its window, which it counts from the first entry: the betting time plus this. */
export const CLOSE_MS = 20_000;
/** The casino voids a pot nobody entered; an empty one is replaced before that. */
const FRESH_MS = 480_000,
  RETRY_MS = 5_000,
  LOOK_MS = 1_000;

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  private entries = { at: 0, players: 0, staked: 0n };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = saved ?? { pot: null, seed: null, openedAt: 0, closesAt: null, last: null };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** What a page shows. Asking is what keeps a pot open to bet on. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { pot, closesAt, last } = this.state;
      return {
        pot,
        closesAt,
        now: this.deps.now(),
        players: this.entries.players,
        staked: String(this.entries.staked),
        last,
      };
    });
  }
  /** A page says its wallet entered; the casino is asked, since a page can say anything. */
  entered() {
    this.entries.at = 0;
    return this.view();
  }
  alarm() {
    return this.serialized(() => this.turn());
  }
  private due(now: number) {
    const { closesAt, openedAt } = this.state;
    return closesAt === null ? now - openedAt > FRESH_MS : now >= closesAt;
  }
  private async turn() {
    const now = this.deps.now(),
      { state } = this;
    // A pot the casino no longer has open, after a restart of its own, is no pot to bet on.
    if (state.pot && !(await this.look(now, this.due(now)))) this.clear();
    if (state.pot && this.due(now)) {
      if (state.closesAt !== null) await this.spin();
      else {
        // Nobody came: the empty pot is called off before the casino gives up on it.
        await this.deps.referee.void(state.pot).catch(() => {});
        this.clear();
      }
      await this.deps.save(state);
    }
    if (!state.pot) {
      const { pot, seed } = await this.deps.referee.open({
        bank: 'house',
        asset: this.deps.asset,
        window: BETTING_MS + CLOSE_MS,
      });
      Object.assign(state, { pot: pot.id, seed, openedAt: now, closesAt: null });
      this.entries = { at: now, players: 0, staked: 0n };
      await this.deps.save(state);
    }
    if (state.closesAt !== null) this.deps.wake(state.closesAt);
  }
  /** Who is in the pot, as the casino has it: asked at most once a second, and always before the wheel
   * spins or gives the pot up. The casino starts the window at the first entry, and the wheel spins
   * `CLOSE_MS` before it ends. */
  private async look(now: number, always: boolean) {
    if (now - this.entries.at < LOOK_MS && !always) return true;
    const pot = await this.deps.referee.pot(this.state.pot!);
    this.entries = {
      at: now,
      players: new Set(pot?.entries.map(entry => entry.uname)).size,
      staked: (pot?.entries ?? []).reduce((sum, entry) => sum + BigInt(entry.stake), 0n),
    };
    if (pot?.closesAt && this.state.closesAt === null) {
      this.state.closesAt = pot.closesAt - CLOSE_MS;
      await this.deps.save(this.state);
    }
    return pot?.status === 'unresolved';
  }
  /** The casino reveals the pot's secret and pays every entry; the ball lands where the outcome says. */
  private async spin() {
    const { state } = this,
      pot = state.pot!,
      seed = state.seed!;
    try {
      const ended = await this.deps.referee.resolve(pot, { seed });
      if (ended.resolution === 'refund') {
        this.clear();
        return;
      }
      state.last = {
        pot,
        seed,
        secret: ended.secret!,
        number: pocket(roundOutcome(seed, ended.secret!)),
        players: this.entries.players,
      };
    } catch (error: any) {
      // A pot the casino voided pays nothing here: it refunded every entry. Anything else is tried again.
      if (error.code !== 'pot-expired' && error.status !== 404) {
        this.deps.wake(this.deps.now() + RETRY_MS);
        throw error;
      }
    }
    this.clear();
  }
  private clear() {
    Object.assign(this.state, { pot: null, seed: null, closesAt: null });
  }
}
