/**
 * The wheel everyone at the table shares. It is the round's host at the casino: it opens a round with
 * the hash of a seed of its own, and closes it with that seed when the betting time is up. Players' wallets join the round by themselves, so the wheel never touches a bet, and it holds
 * no money. Nobody knows where the ball lands while bets are taken: only the casino has the round's
 * secret, and only the wheel has its seed.
 * Everything that touches the outside world is handed in, so the same wheel runs in a Worker or a test.
 */
import type { AssetId, RoundHost, Round } from '@hookedin/play/sdk/host';
import { roundOutcome } from '@hookedin/play/sdk/host';
import { pocket } from '../src/table.ts';

export interface Spin {
  round: string;
  seed: string;
  secret: string;
  number: number;
  players: number;
}
export interface WheelState {
  /** The round the pages bet on now. It is saved before anybody is shown it. */
  round: Round | null;
  /** That round's seed: kept here, shown to nobody, and given to the casino only to close the round. */
  seed: string | null;
  openedAt: number;
  /** When the round closes: set once somebody has a seat, so an empty table waits instead of spinning. */
  closesAt: number | null;
  last: Spin | null;
}
export interface Deps {
  host: RoundHost;
  /** What this wheel's table is played with. Every asset has a wheel of its own. */
  asset: AssetId;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Ask for `alarm()` at this time. */
  wake(at: number): void;
}
/** How long players have once the first chip is down. */
export const BETTING_MS = 20_000;
/** Room for the close itself: the alarm, the request, and a retry or two. The casino holds every
 * seat until the round closes, so the window it is given is the betting time plus this and no more. */
const CLOSE_MS = 20_000;
/** The casino reveals a round nobody has joined; an empty one is replaced before that. */
const FRESH_MS = 480_000,
  RETRY_MS = 5_000,
  SEATS_MS = 1_000;

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  private seats = { at: 0, players: 0, staked: 0n };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = saved ?? { round: null, seed: null, openedAt: 0, closesAt: null, last: null };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** What a page shows. Asking is what keeps a round open to bet on. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { round, closesAt, last } = this.state;
      return {
        round,
        closesAt,
        now: this.deps.now(),
        players: this.seats.players,
        staked: String(this.seats.staked),
        last,
      };
    });
  }
  /** A page says its wallet took a seat; the casino is asked, since a page can say anything. */
  seated() {
    this.seats.at = 0;
    return this.view();
  }
  alarm() {
    return this.serialized(() => this.turn());
  }
  private async turn() {
    const now = this.deps.now(),
      { state } = this;
    // A round the casino no longer has open, after a restart of its own, is no round to bet on.
    if (state.round && !(await this.look(now))) Object.assign(state, { round: null, seed: null, closesAt: null });
    if (state.round) {
      // The clock runs while somebody is seated: it starts with the first seat and stops if the last one leaves.
      if (Boolean(this.seats.players) !== (state.closesAt !== null)) {
        state.closesAt = this.seats.players ? now + BETTING_MS : null;
        await this.deps.save(state);
      }
      // An empty round is swapped for a fresh one before the casino gives up on it.
      if (state.closesAt === null ? now - state.openedAt > FRESH_MS : now >= state.closesAt) await this.close();
    }
    if (!state.round) {
      Object.assign(state, {
        ...(await this.deps.host.round(this.deps.asset, BETTING_MS + CLOSE_MS)),
        openedAt: now,
      });
      this.seats = { at: now, players: 0, staked: 0n };
      await this.deps.save(state);
    }
    if (state.closesAt !== null) this.deps.wake(state.closesAt);
  }
  /** Who is seated, as the casino has it: asked at most once a second, and always before the round closes. */
  private async look(now: number) {
    const closing = this.state.closesAt !== null && now >= this.state.closesAt;
    if (now - this.seats.at < SEATS_MS && !closing) return true;
    const status = await this.deps.host.seats(this.state.round!.id);
    this.seats = {
      at: now,
      players: status?.seats.length ?? 0,
      staked: (status?.seats ?? []).reduce((sum, seat) => sum + BigInt(seat.stake), 0n),
    };
    return status?.status === 'open';
  }
  /** The casino reveals the round's secret and settles every seat; the ball lands where the outcome says. */
  private async close() {
    const { state } = this,
      round = state.round!,
      seed = state.seed!;
    try {
      const closed = await this.deps.host.close(round.id, seed);
      state.last = {
        round: round.id,
        seed,
        secret: closed.secret,
        number: pocket(roundOutcome(seed, closed.secret)),
        players: this.seats.players,
      };
    } catch (error: any) {
      // A round the casino no longer has open settles nobody; anything else is tried again.
      if (error.code !== 'round-not-open' && error.status !== 404) {
        this.deps.wake(this.deps.now() + RETRY_MS);
        throw error;
      }
    }
    Object.assign(state, { round: null, seed: null, closesAt: null });
    await this.deps.save(state);
  }
}
