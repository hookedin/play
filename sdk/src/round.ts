/** Plays a multi-step game as a sequence of casino bets through the wallet. It reaches `localStorage` only through its
 * default store and `window` only in `watch`, so it runs in Node too. */
import { fraction, getNode, loadFundedGame, prepareAction } from './engine/index.ts';
import type { FundingTable, GameGraph, GamePlan } from './engine/index.ts';
import { compileGameAsync, landing, rngFromBytes } from './engine/engine.ts';
import type { CashClass } from './engine/transition.ts';
import { admits } from './admits.ts';
import { formatAmount, playerScope } from './wire.ts';
export interface RoundEvent {
  action: string;
  label?: string;
}
export interface RoundState {
  /** Unique per started round, so a game can apply a finished round to its own state exactly once; also the group of
   * the round's bets, which the game ends with `HookedIn.end(id)` once the player has seen how the round ended. */
  id: string;
  /** What `start` was given: the stake, and whatever else the game's graph is built from. */
  setup: { stake: string; [key: string]: unknown };
  nodeId: string;
  cash: string;
  contributed: string;
  terminal: boolean;
  actions: string[];
  actionCosts: Record<string, string>;
  events: RoundEvent[];
  pending: boolean;
  settlement: any;
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
const text = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const plain = (value: unknown) => JSON.parse(text(value));
/** A class of successors as a saved step keeps it, back as the engine reads it. */
const revive = (side: any): CashClass => ({
  cash: BigInt(side.cash),
  probability: fraction(BigInt(side.probability.n), BigInt(side.probability.d)),
  outcomes: side.outcomes.map((o: any) => ({
    next: o.next,
    ...(o.label === undefined ? {} : { label: o.label }),
    cash: BigInt(o.cash),
    probability: fraction(BigInt(o.probability.n), BigInt(o.probability.d)),
  })),
});
/** What a saved round is played under: its format, and a hash of the graph the page builds for its setup. */
const SCHEMA = 'HOOKEDIN/ROUND/5';
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const browserStore: RoundStore = {
  get: key => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
};
export class RoundClient {
  private data: any = null;
  private plan: GamePlan | null = null;
  private planKey = '';
  private storageKey = '';
  /** A step is settling. */
  private busy = false;
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
  private built(setup: any) {
    const key = text(setup);
    let found = this.graphs.get(key);
    if (!found) {
      const graph = this.graph(setup);
      found = { graph, rules: crypto.subtle.digest('SHA-256', new TextEncoder().encode(text(graph))).then(hex) };
      this.graphs.set(key, found);
    }
    return found;
  }
  private rules(setup: any) {
    return this.built(setup).rules;
  }
  private fundingScale(stake: bigint) {
    return this.funding && stake > 0n && stake % this.funding.initialCash === 0n
      ? stake / this.funding.initialCash
      : 0n;
  }
  private async compile(setup: any, bankrollFloor: bigint, cashQuantum: bigint) {
    const scale = this.fundingScale(BigInt(setup.stake)),
      { graph } = this.built(setup);
    if (
      this.funding &&
      scale &&
      bankrollFloor === this.funding.bankrollFloor * scale &&
      cashQuantum === this.funding.cashQuantum * scale
    )
      return loadFundedGame(graph, this.funding, scale, admits);
    return compileGameAsync(graph, { admits, bankrollFloor, cashQuantum, initialCash: BigInt(setup.stake) });
  }
  /** Reload the round from this origin's storage and apply any result the wallet settled meanwhile. */
  async restore(): Promise<RoundState | null> {
    await this.load();
    // A reply may have been lost after the wallet settled; its receipt is retrievable by the step's own ID.
    if (this.data?.pending && this.data.pending.ticket.kind !== 'noop') {
      const receipt = await this.call('game.receipt', { id: this.data.pending.id });
      if (receipt) await this.resolve(receipt);
    }
    return this.state();
  }
  /** Read the round as this origin's storage holds it. */
  private async load() {
    const info = await this.call('wallet.info');
    this.storageKey = `hookedin:round:${this.name}:${playerScope(info)}`;
    const saved = this.store.get(this.storageKey);
    this.data = saved ? JSON.parse(saved) : null;
    if (!this.data) {
      this.plan = null;
      return;
    }
    // A round saved in another format, or under rules this page does not play (a setup its rules refuse included),
    // cannot be finished here. Every step it took settled in the wallet, so what it held is in the player's balance:
    // it is let go, once, and the player is told.
    let rules = null;
    try {
      rules = await this.rules(this.data.setup);
    } catch {}
    if (this.data.schema !== SCHEMA || rules === null || this.data.rules !== rules) {
      this.store.remove(this.storageKey);
      this.data = null;
      this.plan = null;
      throw new Error('This round was started under rules this game does not play. What it held is in your balance.');
    }
    const planKey = JSON.stringify([this.data.setup, this.data.bankrollFloor, this.data.cashQuantum]);
    if (!this.plan || this.planKey !== planKey)
      this.plan = await this.compile(this.data.setup, BigInt(this.data.bankrollFloor), BigInt(this.data.cashQuantum));
    this.planKey = planKey;
  }
  state(): RoundState | null {
    if (!this.data || !this.plan) return null;
    const node = getNode(this.plan, this.data.nodeId);
    return {
      id: this.data.id,
      setup: this.data.setup,
      nodeId: node.id,
      cash: this.data.cash,
      terminal: node.kind === 'terminal',
      contributed: this.data.contributed,
      events: this.data.events,
      actionCosts: Object.fromEntries(
        node.kind === 'terminal' ? [] : node.actions.map(a => [a.id, String(a.additionalCash)]),
      ),
      actions:
        node.kind === 'terminal'
          ? []
          : node.actions.map(a => a.id).filter(a => !this.data.pending || a === this.data.pending.ticket.actionId),
      pending: Boolean(this.data.pending),
      settlement: this.data.settlement ?? null,
    };
  }
  private save() {
    this.store.set(this.storageKey, JSON.stringify(plain(this.data)));
  }
  /**
   * Ask the wallet for a larger allowance when `group` may stake less than `required`; the player decides in the
   * wallet's own dialog. The suggestion covers a few more rounds so one authorization lasts.
   */
  async ensureAllowance(required: bigint, stake: bigint, group?: string) {
    const available = async () =>
      BigInt((await this.call('game.allowance', group === undefined ? {} : { group })).allowance);
    const before = await available();
    if (before >= required) return;
    await this.call('game.requestAllowance', { amount: String(required - before + 4n * stake) });
    if ((await available()) < required)
      throw new Error('Allow this game more ETH to play, or deposit if your balance is empty.');
  }
  /** Another tab of this game changed the round: reload it and tell the caller. Browser only. */
  watch(listener: () => void) {
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', event => {
      if (event.key !== this.storageKey || event.storageArea !== localStorage) return;
      void this.restore().then(listener, () => {});
    });
  }
  async start(setup: { stake: string; [key: string]: unknown }) {
    await this.load();
    if (this.data?.pending) throw new Error('Recover the pending action first');
    await this.ensureAllowance(BigInt(setup.stake), BigInt(setup.stake));
    const info = await this.call('wallet.info'),
      bankroll = BigInt(info.virtualBankroll);
    const reusable =
      this.plan &&
      JSON.stringify(this.data?.setup) === JSON.stringify(setup) &&
      bankroll >= this.plan.conservativeBankroll;
    const scale = this.fundingScale(BigInt(setup.stake));
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
        : BigInt(setup.stake) / 1000000000n || 1n;
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
    this.data = plain({
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
    });
    this.save();
    this.planKey = JSON.stringify([this.data.setup, this.data.bankrollFloor, this.data.cashQuantum]);
    return this.state()!;
  }
  async action(action: string) {
    // One step at a time: a second press while a step runs would draw and place a bet of its own.
    if (this.busy) throw new Error('Wait for the action under way');
    this.busy = true;
    try {
      return await this.step(action);
    } finally {
      this.busy = false;
    }
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
      await this.ensureAllowance(
        BigInt(this.data.cash) + selected.additionalCash,
        BigInt(this.data.setup.stake),
        this.data.id,
      );
      const info = await this.call('wallet.info'),
        random = rngFromBytes(bytes => crypto.getRandomValues(bytes));
      // The page draws the step's branch now, and a step without a bet its successor. Both are saved with the step's
      // operation ID before anything is signed, so a lost reply or a rejection offers the same bet again: drawing
      // again would change the game's odds.
      const ticket = prepareAction(
        this.plan,
        { nodeId: this.data.nodeId, cash: BigInt(this.data.cash), bankroll: BigInt(info.virtualBankroll) },
        action,
        random,
      );
      // What a step without a bet shows its result with, in place of a round's outcome.
      const draw = ticket.kind === 'casino-bet' ? null : String(random(1n << 64n));
      this.data.pending = { id: crypto.randomUUID(), ticket: plain(ticket), draw };
      this.save();
    }
    const { ticket, id } = this.data.pending;
    if (ticket.actionId !== action) throw new Error('Retry the pending action first');
    // Every step of one round carries the round's ID as its group, so the wallet shows them as one game, and keeps
    // what they win out of the allowance it shows until the round ends.
    const group = this.data.id;
    let receipt;
    // What the step keeps of the round's cash stays out of the allowance the wallet shows, with the round: the cash of
    // the lower of the classes a bet goes between, which the round has whatever the outcome, or what a payment leaves.
    if (ticket.kind === 'casino-bet')
      // The branch drawn is one bet: the stake at risk, and the prize it pays below its chance.
      receipt = await this.call('game.casinoBet', {
        id,
        stake: ticket.bet.stake,
        chance: ticket.bet.chance,
        prize: ticket.bet.prize,
        group,
        kept: ticket.lose.cash,
      });
    else if (ticket.kind === 'payment')
      receipt = await this.call('game.payment', { id, amount: ticket.amount, group, kept: ticket.cash });
    else receipt = { kind: 'noop' };
    await this.resolve(receipt);
    if (receipt.status === 'rejected')
      throw new Error(receipt.reason || 'The casino declined this step; retry this action or stop the game');
    return this.state()!;
  }
  private async resolve(receipt: any) {
    const { ticket, draw } = this.data.pending;
    if (receipt.status === 'rejected') {
      // A rejection is a signed checkpoint the wallet checked: the balance is unchanged. Keep the same action
      // under a fresh operation ID for the next attempt.
      this.data.pending.id = crypto.randomUUID();
      this.data.settlement = { kind: 'rejected', reason: receipt.reason };
      this.save();
      return;
    }
    let label,
      won: boolean | null = null,
      shown = draw;
    if (ticket.kind === 'casino-bet') {
      if (receipt.status !== 'settled' || !/^[0-9]+$/.test(String(receipt.outcome)))
        throw new Error('A settled casino bet is required');
      // The round's outcome decides the bet, and with it which class of successors the step reached; the wallet's
      // verified payout must agree. Which state of that class, when several need its cash, is drawn from the outcome,
      // and so is what the page shows it with.
      const outcome = BigInt(receipt.outcome);
      won = outcome < BigInt(ticket.bet.chance);
      if ((won ? BigInt(ticket.bet.prize) : 0n) !== BigInt(receipt.payout))
        throw new Error('The verified payout differs from this step');
      const side = won ? ticket.win : ticket.lose,
        landed = landing(revive(side), outcome);
      this.data.nodeId = landed.next.next;
      this.data.cash = side.cash;
      label = landed.next.label;
      shown = String(landed.draw);
    } else {
      if (ticket.kind === 'payment' && receipt.status !== 'settled') throw new Error('A settled payment is required');
      this.data.nodeId = ticket.next;
      this.data.cash = ticket.cash;
      label = ticket.label;
    }
    this.data.contributed = String(BigInt(this.data.contributed) + BigInt(ticket.additionalCash ?? 0));
    this.data.events = [...this.data.events, { action: ticket.actionId, ...(label === undefined ? {} : { label }) }];
    this.data.pending = null;
    this.data.settlement = {
      kind: receipt.kind,
      // A bet: whether it won, and the chance it was placed at, out of 2^64.
      ...(won === null ? {} : { won, chance: ticket.bet.chance }),
      payout: receipt.payout ?? null,
      outcome: receipt.outcome ?? null,
      // What the page shows the result with (which reel stops, which path), drawn apart from which state the step
      // reached: from the round's outcome for a bet, and when it was prepared for a step without one.
      // `seededRandom(BigInt(draw))` reads it.
      draw: shown,
    };
    this.save();
  }
}
