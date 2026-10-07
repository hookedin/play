/**
 * One Plinko drop is a round of one step: the board is a game of one decision, the SDK collapses it into the one
 * casino bet the drop places, and the ball is drawn inside the bucket that bet reached. The reference for a one-shot
 * table: the page asks for a drop, and a drop saved before a reload lands after it, once.
 */
import { RoundClient } from '@hookedin/play/sdk/round';
import type { PastRound, RoundBridge, RoundState, RoundStore } from '@hookedin/play/sdk/round';
import { seededRandom } from '@hookedin/play/sdk/engine';
import { bucketOf, dropGraph, path } from './tables.ts';
import type { Risk, Rows } from './tables.ts';

export interface DropConfig {
  rows: Rows;
  risk: Risk;
  /** The bet in wei. */
  stake: string;
}
export interface Landed extends DropConfig {
  /** The drop's round, the group of its bet: the page ends it with `end` once the ball has landed. */
  group: string;
  payout: string;
  /** The ball's turns, true for right; their sum is the bucket. */
  turns: boolean[];
}
const browserStore: RoundStore = {
  get: key => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
};

export class DropClient {
  private readonly round: RoundClient;
  private readonly store: RoundStore;
  private readonly name: string;
  /** The rounds of the balls landed and not yet ended, by group. */
  private readonly landed = new Map<string, RoundState>();
  constructor(
    bridge: RoundBridge,
    {
      store = browserStore,
      name = typeof location === 'undefined' ? 'plinko' : location.pathname,
    }: { store?: RoundStore; name?: string } = {},
  ) {
    this.store = store;
    this.name = name;
    this.round = new RoundClient(bridge, dropGraph, undefined, { store, name });
  }
  /** The drop saved before the wallet signed it, whose result has not come back yet. */
  get pending(): DropConfig | null {
    const state = this.round.state();
    return state?.pending ? (state.setup as unknown as DropConfig) : null;
  }
  /** Load the saved drop. One the wallet settled meanwhile lands now, once. */
  async restore(): Promise<Landed | null> {
    const state = await this.round.restore();
    return state?.terminal ? this.land(state) : null;
  }
  /** Drop one ball. A ball that settled while the page was away lands first, and a saved drop is always finished
   * before another, with its own board and bet. */
  async drop(config: DropConfig): Promise<Landed> {
    const saved = await this.round.restore(),
      settled = saved?.terminal ? this.land(saved) : null;
    if (settled) return settled;
    if (!saved?.pending) await this.round.start({ ...config });
    return this.land(await this.round.action('drop'))!;
  }
  /** The ball has landed on the page: what it won joins the allowance the wallet shows, and the drop the player's
   * history, with its board and the path it fell. */
  end(landed: Landed) {
    const state = this.landed.get(landed.group)!;
    this.landed.delete(landed.group);
    return this.round.end(state);
  }
  /** The player's earlier drops, newest first, from their history on any device, each on its own board and the path
   * it fell. A history of `limit` entries holds at most half as many drops: each is a bet and the end of its group. */
  async past(limit: number): Promise<Landed[]> {
    return (await this.round.past({ limit })).rounds.map(round => drawn(round));
  }
  /** A finished drop's ball, once. */
  private land(state: RoundState): Landed | null {
    const shown = `hookedin:drop:shown:${this.name}`;
    if (this.store.get(shown) === state.id) return null;
    this.store.set(shown, state.id);
    this.landed.set(state.id, state);
    return drawn(state);
  }
}
/** A drop's ball: the bucket its bet reached, and a path into it drawn from the settled result. */
function drawn(state: RoundState | PastRound): Landed {
  const { rows, risk, stake } = state.setup as unknown as DropConfig;
  return {
    group: state.id,
    rows,
    risk,
    stake,
    payout: state.cash,
    turns: path(rows, bucketOf(state.nodeId), seededRandom(BigInt(state.settlement.draw))),
  };
}
