/** Plays a multi-step game as a sequence of casino bets through the wallet. It reaches `localStorage` only through its
 * default store, and holds its round with `navigator.locks`, so it runs in Node too. */
import { getNode, loadFundedGame, prepareAction, resolveTransition } from './engine/index.ts';
import type { FundingTable, GameGraph, GamePlan } from './engine/index.ts';
import { compileGameAsync, rngFromBytes } from './engine/engine.ts';
import { admits } from './admits.ts';
import { NOT_ENOUGH_ALLOWANCE, formatAmount, playerScope } from './wire.ts';
import { json, plain } from '../../protocol/protocol.ts';
import * as read from '../../protocol/read.ts';
import type { GameHistory } from '../../protocol/game-types.ts';
export interface RoundEvent {
  action: string;
  label?: string;
}
export interface RoundState {
  /** Unique per started round, so a game can apply a finished round to its own state exactly once; also the group of
   * the round's bets, which the game ends with `end(state)` once the player has seen how the round ended. */
  id: string;
  /** What `start` was given: the stake, and whatever else the game's graph is built from, as JSON holds it. */
  setup: { stake: bigint; [key: string]: unknown };
  nodeId: string;
  cash: bigint;
  contributed: bigint;
  terminal: boolean;
  actions: string[];
  actionCosts: Record<string, bigint>;
  events: RoundEvent[];
  pending: boolean;
  settlement: StepSettlement | null;
}
/** How the round's last step went: declined by the casino, or settled, with `draw`, what the page shows its result
 * with (which reel stops, which path), drawn apart from which state the step reached: by the wallet after the result
 * for a step it drew, and by the page for a step with one successor. `seededRandom(draw)` reads it. `id` names the
 * operation whose receipt in the wallet proves how the step went, which `HookedIn.showBet` shows the player: null for
 * a step the wallet was not asked about. */
export type StepSettlement =
  | { kind: 'rejected'; reason?: string }
  /** A bet: whether it won, the chance it was placed at, out of 2^64, what it paid and the round's outcome. */
  | { kind: 'casino-bet'; id: string; won: boolean; chance: bigint; payout: bigint; outcome: bigint; draw: bigint }
  | { kind: 'payment' | 'noop'; id: string | null; payout: null; outcome: null; draw: bigint };
type Setup = RoundState['setup'];
/** A round the game ended with `RoundClient.end`, as `past` reads it back: its state when the player saw how it ended,
 * which the page draws as it did then. */
export interface PastRound extends Pick<
  RoundState,
  'id' | 'setup' | 'nodeId' | 'cash' | 'contributed' | 'events' | 'settlement'
> {
  /** When it ended, in milliseconds. */
  at: number;
  /** What the page added with `end`. */
  extra?: Record<string, unknown>;
}
/** What the helper needs from the SDK: its requests. */
export interface RoundBridge {
  call: (method: string, params?: any) => Promise<any>;
}
/** Where a round lives between reloads: the game's own origin storage, keyed per game and per player. */
export interface RoundStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
/** What a saved round is played under: its format, and a hash of the graph the page builds for its setup. */
const SCHEMA = 'HOOKEDIN/ROUND/5';
type Prepared = ReturnType<typeof prepareAction>;
/** A round as this origin's storage holds it, and as it is played from memory: storage holds its JSON. */
interface Saved {
  schema: typeof SCHEMA;
  rules: string;
  id: string;
  setup: Setup;
  bankrollFloor: bigint;
  cashQuantum: bigint;
  nodeId: string;
  cash: bigint;
  contributed: bigint;
  events: RoundEvent[];
  /** The step under way: its operation ID, its action and, for a step with one successor, what the page shows its
   * result with. The step itself is the plan's, and the wallet draws it. */
  pending: { id: string; action: string; draw: bigint | null } | null;
  settlement?: StepSettlement;
}

/** The most entries a list of a saved round holds: the successors of a step, or the steps a round took. */
const MAX_LIST = 4096;
/** A setup as JSON holds it: the stake, a whole number, and the rest as it is, in its order. */
const setup = (value: unknown): Setup => {
  const fields = read.exactly(
    (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'A setup',
  )(value);
  return { ...fields, stake: read.whole(fields.stake) };
};
const event = read.object<RoundEvent>({ action: read.text, label: read.optional(read.text) });
const settlement = read.firstOf<StepSettlement>(
  read.object<Extract<StepSettlement, { kind: 'rejected' }>>({
    kind: read.oneOf('rejected'),
    reason: read.optional(read.text),
  }),
  read.object<Extract<StepSettlement, { kind: 'casino-bet' }>>({
    kind: read.oneOf('casino-bet'),
    id: read.text,
    won: read.flag,
    chance: read.whole,
    payout: read.whole,
    outcome: read.whole,
    draw: read.whole,
  }),
  read.object<Extract<StepSettlement, { kind: 'payment' | 'noop' }>>({
    kind: read.oneOf('payment', 'noop'),
    id: read.nullable(read.text),
    payout: read.oneOf(null),
    outcome: read.oneOf(null),
    draw: read.whole,
  }),
);
const saved = read.object<Saved>({
  schema: read.oneOf(SCHEMA),
  rules: read.text,
  id: read.text,
  setup,
  bankrollFloor: read.whole,
  cashQuantum: read.whole,
  nodeId: read.text,
  cash: read.whole,
  contributed: read.whole,
  events: read.list(event, MAX_LIST),
  pending: read.nullable(
    read.object<NonNullable<Saved['pending']>>({ id: read.text, action: read.text, draw: read.nullable(read.whole) }),
  ),
  settlement: read.optional(settlement),
});
/** A round the game ended, as `end` keeps it in the meta of its group. */
const ended = read.object<Omit<PastRound, 'id' | 'at'> & { schema: typeof SCHEMA; rules: string }>({
  schema: read.oneOf(SCHEMA),
  rules: read.text,
  setup,
  nodeId: read.text,
  cash: read.whole,
  contributed: read.whole,
  events: read.list(event, MAX_LIST),
  settlement: read.nullable(settlement),
  extra: read.optional(read.meta),
});
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const browserStore: RoundStore = {
  get: key => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
};
export class RoundClient {
  private data: Saved | null = null;
  private plan: GamePlan | null = null;
  private planKey = '';
  private storageKey = '';
  private readonly call: RoundBridge['call'];
  private readonly graph: (setup: any) => GameGraph;
  private readonly funding?: FundingTable;
  private readonly store: RoundStore;
  /** Distinguishes games that share a host origin; the page path is unique per game on one host. */
  private readonly name: string;
  /** The graph built for each setup, and the hash of the rules it is played under, once each per page. */
  private graphs = new Map<string, { graph: GameGraph; rules: Promise<string> }>();
  constructor(
    bridge: RoundBridge,
    graph: (setup: any) => GameGraph,
    funding?: FundingTable,
    {
      store = browserStore,
      name = typeof location === 'undefined' ? 'round' : location.pathname,
    }: {
      store?: RoundStore;
      name?: string;
    } = {},
  ) {
    this.call = bridge.call;
    this.graph = graph;
    this.funding = funding;
    this.store = store;
    this.name = name;
  }
  /** The graph this page builds for a setup, and the rules it is played under: the graph's hash. A round saved
   * under other rules is not one this page can finish. */
  private built(setup: Setup) {
    const key = json(setup);
    let found = this.graphs.get(key);
    if (!found) {
      const graph = this.graph(setup);
      found = { graph, rules: crypto.subtle.digest('SHA-256', new TextEncoder().encode(json(graph))).then(hex) };
      this.graphs.set(key, found);
    }
    return found;
  }
  private rules(setup: Setup) {
    return this.built(setup).rules;
  }
  private fundingScale(stake: bigint) {
    return this.funding && stake > 0n && stake % this.funding.initialCash === 0n
      ? stake / this.funding.initialCash
      : 0n;
  }
  private async compile(setup: Setup, bankrollFloor: bigint, cashQuantum: bigint) {
    const scale = this.fundingScale(setup.stake),
      { graph } = this.built(setup);
    if (
      this.funding &&
      scale &&
      bankrollFloor === this.funding.bankrollFloor * scale &&
      cashQuantum === this.funding.cashQuantum * scale
    )
      return loadFundedGame(graph, this.funding, scale, admits);
    return compileGameAsync(graph, { admits, bankrollFloor, cashQuantum, initialCash: setup.stake });
  }
  /** A step, from reading the round to saving where it led, holds the round's lock: `start` and `action` refuse while
   * it is held, as when a button is pressed twice, and `restore` waits for it. */
  private holding<T>(work: () => Promise<T>, ifAvailable = false): Promise<T> {
    return navigator.locks.request(`hookedin:round:${this.name}`, { ifAvailable }, lock => {
      if (!lock) throw new Error('Wait for the action under way');
      return work();
    });
  }
  /** Reload the round from this origin's storage and apply any result the wallet settled meanwhile. */
  restore(): Promise<RoundState | null> {
    return this.holding(async () => {
      await this.load();
      // A reply may have been lost after the wallet settled; its receipts are retrievable by the step's own IDs.
      if (this.data?.pending) {
        const receipts = [];
        for (const id of this.requests()) receipts.push(await this.call('game.receipt', { id }));
        if (receipts.every(Boolean)) this.resolve(receipts);
        else if (receipts[0]?.status === 'rejected') this.resolve([receipts[0]]);
      }
      return this.state();
    });
  }
  /** Read the round as this origin's storage holds it. */
  private async load() {
    const info = await this.call('wallet.info');
    this.storageKey = `hookedin:round:${this.name}:${playerScope(info)}`;
    const stored = this.store.get(this.storageKey);
    this.data = null;
    if (stored === null) {
      this.plan = null;
      return;
    }
    // A round saved in another form, or under rules this page does not play (a setup its rules refuse included),
    // cannot be finished here. Every step it took settled in the wallet, so what it held is in the player's balance:
    // it is let go, once, and the player is told.
    let data = null,
      rules = null;
    try {
      data = saved(JSON.parse(stored));
      rules = await this.rules(data.setup);
    } catch {}
    if (!data || data.rules !== rules) {
      this.store.remove(this.storageKey);
      this.plan = null;
      throw new Error('This round was started under rules this game does not play. What it held is in your balance.');
    }
    this.data = data;
    const planKey = json([data.setup, data.bankrollFloor, data.cashQuantum]);
    if (!this.plan || this.planKey !== planKey)
      this.plan = await this.compile(data.setup, data.bankrollFloor, data.cashQuantum);
    this.planKey = planKey;
  }
  state(): RoundState | null {
    const data = this.data;
    if (!data || !this.plan) return null;
    const node = getNode(this.plan, data.nodeId);
    return {
      id: data.id,
      setup: data.setup,
      nodeId: node.id,
      cash: data.cash,
      terminal: node.kind === 'terminal',
      contributed: data.contributed,
      events: data.events,
      actionCosts: Object.fromEntries(node.kind === 'terminal' ? [] : node.actions.map(a => [a.id, a.additionalCash])),
      actions:
        node.kind === 'terminal'
          ? []
          : node.actions.map(a => a.id).filter(a => !data.pending || a === data.pending.action),
      pending: Boolean(data.pending),
      settlement: data.settlement ?? null,
    };
  }
  /** Save the round, and play on from it as storage holds it, read back as a reload reads it. */
  private save() {
    this.data = saved(plain(this.data));
    this.store.set(this.storageKey, json(this.data));
  }
  /** Refuse, before anything is drawn or priced, what `group` may not stake: `required` above the allowance, which
   * only the player sets, in the wallet's top bar. */
  async checkAllowance(required: bigint, group?: string) {
    const { allowance } = await this.call('game.allowance', group === undefined ? {} : { group });
    if (allowance < required) throw new Error(NOT_ENOUGH_ALLOWANCE);
  }
  /** The player has seen how `state`'s round ended: what it won joins the allowance the wallet shows, and the casino
   * keeps the round in the player's history of the game, as the meta of its group, for `past` to read back on any
   * device: its setup, where it ended, the steps it took and how its last step settled, with `extra`, anything else the
   * page draws it with. Meta the wallet refuses, longer than its bounds allow or with numbers that are not whole, is
   * left out, and the round ends all the same. */
  async end(state: RoundState, extra?: Record<string, unknown>): Promise<null> {
    const meta = plain({
      schema: SCHEMA,
      rules: await this.rules(state.setup),
      setup: state.setup,
      nodeId: state.nodeId,
      cash: state.cash,
      contributed: state.contributed,
      events: state.events,
      settlement: state.settlement,
      ...(extra === undefined ? {} : { extra }),
    });
    try {
      return await this.call('game.end', { group: state.id, meta });
    } catch (error: any) {
      if (error?.code !== 'invalid-request') throw error;
      return this.call('game.end', { group: state.id });
    }
  }
  /** A page of the rounds this game ended with `end`, newest first, from the player's history of the game: pass
   * `cursor` back as `after` for older ones while `more` is true. A round played under rules this page does not play is
   * left out, since the page could not draw it, and so is everything else the history holds. */
  async past(page: { after?: string; limit?: number } = {}) {
    const history: GameHistory = await this.call('game.history', page),
      rounds: PastRound[] = [];
    for (const entry of history.entries) {
      if (entry.kind !== 'end') continue;
      // The round as `end` kept it, under the rules it was played by.
      let round = null,
        rules = null;
      try {
        round = ended(entry.meta);
        rules = await this.rules(round.setup);
      } catch {}
      if (!round || rules !== round.rules) continue;
      const { schema: _, rules: __, ...past } = round;
      rounds.push({ ...past, id: entry.group, at: entry.at });
    }
    return { rounds, cursor: history.cursor, more: history.more };
  }
  start(setup: Setup) {
    return this.holding(() => this.begin(setup), true);
  }
  private async begin(setup: Setup) {
    await this.load();
    if (this.data?.pending) throw new Error('Recover the pending action first');
    await this.checkAllowance(setup.stake);
    const info = await this.call('wallet.info'),
      bankroll: bigint = info.virtualBankroll;
    const reusable =
      this.plan && this.data && json(this.data.setup) === json(setup) && bankroll >= this.plan.conservativeBankroll;
    const scale = this.fundingScale(setup.stake);
    const funded = this.funding && scale && bankroll >= this.funding.conservativeBankroll * scale;
    const bankrollFloor = reusable
      ? this.plan!.bankrollFloor
      : funded
        ? this.funding!.bankrollFloor * scale
        : bankroll / 2n;
    const cashQuantum = reusable
      ? this.plan!.cashQuantum
      : funded
        ? this.funding!.cashQuantum * scale
        : setup.stake / 1000000000n || 1n;
    // Pricing fails when the casino cannot cover the round's payouts; say so in the player's terms.
    const capacity = () =>
      new Error(
        `The casino can only back about ${formatAmount(bankrollFloor)} METH of payouts right now. Lower your stake and try again.`,
      );
    if (!reusable)
      try {
        this.plan = await this.compile(setup, bankrollFloor, cashQuantum);
      } catch (error) {
        if (error instanceof RangeError) throw capacity();
        throw error;
      }
    if (!this.plan) throw new Error('Missing round plan');
    if (bankroll < this.plan.conservativeBankroll) throw capacity();
    this.data = {
      schema: SCHEMA,
      rules: await this.rules(setup),
      id: crypto.randomUUID(),
      setup,
      bankrollFloor,
      cashQuantum,
      nodeId: this.plan.root,
      cash: this.plan.initialCash,
      contributed: setup.stake,
      events: [],
      pending: null,
    };
    this.save();
    this.planKey = json([this.data.setup, this.data.bankrollFloor, this.data.cashQuantum]);
    return this.state()!;
  }
  /** One step at a time: a second press while a step runs would draw and place a bet of its own. */
  action(action: string) {
    return this.holding(() => this.step(action), true);
  }
  /** With a step pending, `action` sends that step again under the ID it was saved with, and the wallet answers an
   * operation it has carried out with its receipt: the step is played once, and `action` resolves with where it led. */
  private async step(action: string) {
    await this.load();
    if (!this.data || !this.plan) throw new Error('Start a round first');
    if (this.state()!.terminal) return this.state()!;
    if (!this.data.pending) {
      const node = getNode(this.plan, this.data.nodeId);
      const selected = node.kind === 'decision' ? node.actions.find(a => a.id === action) : undefined;
      if (!selected) throw new Error('Illegal game action');
      await this.checkAllowance(this.data.cash + selected.additionalCash, this.data.id);
      const info = await this.call('wallet.info'),
        prepared = prepareAction(
          this.plan,
          { nodeId: this.data.nodeId, cash: this.data.cash, bankroll: info.virtualBankroll },
          action,
        );
      // The wallet draws the step, and a step with one successor needs no draw: only what the page shows its result
      // with, which is the page's own. Saved with the step's operation ID before anything is signed, so a lost reply
      // sends the same step again.
      const draw = drawn(prepared) ? null : rngFromBytes(bytes => crypto.getRandomValues(bytes))(1n << 64n);
      this.data.pending = { id: crypto.randomUUID(), action, draw };
      this.save();
    }
    if (this.data.pending.action !== action) throw new Error('Retry the pending action first');
    const prepared = this.prepared(),
      ids = this.requests(),
      // Every step of one round carries the round's ID as its group, so the wallet shows them as one game, and keeps
      // what they win out of the allowance it shows until the round ends.
      group = this.data.id;
    const receipts = [];
    // What a payment leaves stays with the round. It is paid before the wallet draws which successor the step reaches,
    // so that nobody stops a step once they know where it leads.
    if (prepared.kind === 'payment')
      receipts.push(
        await this.call('game.payment', { id: ids[0], amount: prepared.amount, group, kept: prepared.cash }),
      );
    // The step's table is its last request: the wallet splits it into a bet that stakes part of the step's cash and
    // keeps the rest with the round, or none, and lands it on a successor; a step whose successors all need its cash
    // only lands.
    if (drawn(prepared) && receipts[0]?.status !== 'rejected')
      receipts.push(
        await this.call('game.casinoBet', { id: ids.at(-1), cash: prepared.cash, results: table(prepared), group }),
      );
    this.resolve(receipts);
    if (receipts[0]?.status === 'rejected')
      throw new Error(receipts[0].reason || 'The casino declined this step; retry this action or stop the game');
    return this.state()!;
  }
  /** The step under way, as the plan has it: the same table whatever the bankroll, which the wallet splits at its own
   * quote's. */
  private prepared() {
    const plan = this.plan!,
      data = this.data!;
    return prepareAction(
      plan,
      { nodeId: data.nodeId, cash: data.cash, bankroll: plan.bankrollFloor },
      data.pending!.action,
    );
  }
  /** The operation IDs the step under way is played with, in order: a payment's, then its table's when it has several
   * successors. */
  private requests() {
    const prepared = this.prepared(),
      { id } = this.data!.pending!;
    if (!drawn(prepared)) return prepared.kind === 'payment' ? [id] : [];
    return prepared.kind === 'payment' ? [id, `${id}:draw`] : [id];
  }
  /** Land the step under way on what the wallet answered for it, in the order `requests` names them. */
  private resolve(receipts: any[]) {
    const data = this.data!,
      prepared = this.prepared(),
      ids = this.requests(),
      last = receipts.at(-1);
    if (receipts[0]?.status === 'rejected') {
      // A rejection is a signed checkpoint the wallet checked: the balance is unchanged. Keep the same action under a
      // fresh operation ID for the next attempt.
      data.pending!.id = crypto.randomUUID();
      data.settlement = { kind: 'rejected', reason: receipts[0].reason };
      this.save();
      return;
    }
    if (prepared.kind === 'payment' && receipts[0]?.status !== 'settled')
      throw new Error('A settled payment is required');
    const draws = drawn(prepared);
    if (draws && !['settled', 'kept'].includes(last?.status)) throw new Error("The wallet's draw is required");
    // The wallet landed the step on a result, which leaves what its bet kept with what it paid, or all the step held
    // when it placed none.
    const result = resolveTransition(prepared, draws ? last.result : undefined),
      bet = draws && last.status === 'settled';
    if (result.state.cash !== (bet ? prepared.cash - last.stake + last.payout : prepared.cash))
      throw new Error('The verified payout differs from this step');
    data.nodeId = result.state.nodeId;
    data.cash = result.state.cash;
    data.settlement = bet
      ? {
          kind: 'casino-bet',
          id: ids[0]!,
          won: last.outcome < last.chance,
          chance: last.chance,
          payout: last.payout,
          outcome: last.outcome,
          draw: last.draw,
        }
      : {
          kind: prepared.kind === 'payment' ? 'payment' : 'noop',
          id: ids.at(-1) ?? null,
          payout: null,
          outcome: null,
          draw: draws ? last.draw : data.pending!.draw!,
        };
    data.contributed += prepared.additionalCash;
    data.events = [
      ...data.events,
      { action: prepared.actionId, ...(result.label === undefined ? {} : { label: result.label }) },
    ];
    data.pending = null;
    this.save();
  }
}
/** Whether the wallet draws a step: a step with several successors, a bet or not. */
const drawn = (prepared: Prepared) => prepared.outcomes.length > 1;
/** A step's table as the wallet takes it: each successor's weight, the cash it needs and the label the game gave it. */
const table = (prepared: Prepared) =>
  prepared.outcomes.map((outcome, i) => ({
    weight: prepared.weights[i]!,
    cash: outcome.cash,
    ...(outcome.label === undefined ? {} : { label: outcome.label }),
  }));
