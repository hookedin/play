/**
 * One Plinko drop is a round of one step: the board is a game of one decision, the SDK collapses it into the one
 * casino bet the drop places, and the ball is drawn inside the bucket that bet reached. The reference for a one-shot
 * table: the page asks for a drop, and a drop saved before a reload lands after it, once.
 */
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundBridge, RoundState, RoundStore } from '@hookedin/play/sdk/round';
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
  /** A finished drop's ball, once: the bucket its bet reached, and a path into it drawn from the settled result. */
  private land(state: RoundState): Landed | null {
    const shown = `hookedin:drop:shown:${this.name}`;
    if (this.store.get(shown) === state.id) return null;
    this.store.set(shown, state.id);
    const { rows, risk, stake } = state.setup as unknown as DropConfig;
    return {
      rows,
      risk,
      stake,
      payout: state.cash,
      turns: path(rows, bucketOf(state.nodeId), seededRandom(BigInt(state.settlement.draw))),
    };
  }
}
