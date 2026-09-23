/** Optional sample-game library. This runs entirely inside the game's iframe. */
import { compileGameAsync, getNode, loadFundedGame, prepareAction, rngFromBytes } from './engine/index.ts';
import type { FundingTable, GameGraph, GamePlan } from './engine/index.ts';
import { admits } from './admits.ts';
import { playerScope } from './wire.ts';
import type { GameLimit } from '@hookedin/play/protocol/game-types.ts';
export interface RoundEvent {
  action: string;
  label?: string;
}
export interface RoundState {
  /** Unique per started round, so a game can apply a finished round to its own state exactly once. */
  id: string;
  nodeId: string;
  cash: string;
  initialCash: string;
  contributed: string;
  balance: string;
  terminal: boolean;
  actions: string[];
  actionCosts: Record<string, string>;
  events: RoundEvent[];
  pending: boolean;
  settlement: any;
}
export type Bridge = (method: string, params?: any) => Promise<any>;
/** What the helper needs from the SDK: requests, and the wallet's latest pushed limit. */
export interface RoundBridge {
  call: Bridge;
  balance: () => Promise<GameLimit>;
}
/** Where a round lives between reloads: the game's own origin storage, keyed per game, player and asset. */
export interface RoundStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const browserStore: RoundStore = {
  get: key => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
};
export class RoundClient {
  account!: GameLimit;
  data: any = null;
  plan: GamePlan | null = null;
  planKey = '';
  storageKey = '';
  /** A step is settling: the wallet's balance already holds its result, the round does not yet. */
  busy = false;
  /** Called whenever the round's cash or busy state changes. */
  changed: () => void = () => {};
  readonly call: Bridge;
  readonly balance: () => Promise<GameLimit>;
  readonly graph: (setup: any) => GameGraph;
  readonly funding?: FundingTable;
  readonly store: RoundStore;
  /** Distinguishes games that share a host origin; the page path is unique per game on one host. */
  readonly name: string;
  /** What the wallet plays with, for the sentences this helper writes to the player. */
  units = '';
  private greeting?: Promise<any>;
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
    this.balance = bridge.balance;
    this.graph = graph;
    this.funding = funding;
    this.store = store;
    this.name = name;
  }
  /** The wallet's asset, asked for once, so every sentence below names the right money. */
  greet() {
    return (this.greeting ??= this.call('wallet.hello').then(hello => {
      this.units = hello?.asset?.symbol ?? '';
      return hello;
    }));
  }
  /** An amount in the wallet's own asset. Every HookedIn asset counts in units of 10^-18. */
  amount(units: bigint) {
    const whole = units / 10n ** 18n,
      fraction = (units % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole}${fraction ? '.' + fraction : ''}${this.units ? ' ' + this.units : ''}`;
  }
  fundingScale(stake: bigint) {
    return this.funding && stake > 0n && stake % this.funding.initialCash === 0n
      ? stake / this.funding.initialCash
      : 0n;
  }
  async compile(setup: any, bankrollFloor: bigint, cashQuantum: bigint) {
    const scale = this.fundingScale(BigInt(setup.stake)),
      graph = this.graph(setup);
    if (
      this.funding &&
      scale &&
      bankrollFloor === this.funding.bankrollFloor * scale &&
      cashQuantum === this.funding.cashQuantum * scale
    )
      return loadFundedGame(graph, this.funding, scale, admits);
    return compileGameAsync(graph, { admits, bankrollFloor, cashQuantum, initialCash: BigInt(setup.stake) });
  }
  /** The cash inside an unfinished round. It is part of the wallet's balance, and not yet the player's to count. */
  inHand() {
    const state = this.state();
    return state && !state.terminal ? BigInt(state.cash) : 0n;
  }
  /** Reload the round from this origin's storage and apply any result the wallet settled meanwhile. */
  async restore(): Promise<RoundState | null> {
    try {
      return await this.load();
    } finally {
      this.changed();
    }
  }
  async load(): Promise<RoundState | null> {
    const [info, hello] = await Promise.all([this.call('wallet.info'), this.greet()]);
    this.storageKey = `hookedin:round:${this.name}:${playerScope(info, hello?.asset?.id ?? 'eth')}`;
    this.account = await this.balance();
    const saved = this.store.get(this.storageKey);
    this.data = saved ? JSON.parse(saved) : null;
    if (!this.data) {
      this.plan = null;
      return null;
    }
    if (this.data.schema !== 'HOOKEDIN/ROUND/3') {
      this.store.remove(this.storageKey);
      this.data = null;
      this.plan = null;
      return null;
    }
    const planKey = JSON.stringify([this.data.setup, this.data.bankrollFloor, this.data.cashQuantum]);
    if (!this.plan || this.planKey !== planKey)
      this.plan = await this.compile(this.data.setup, BigInt(this.data.bankrollFloor), BigInt(this.data.cashQuantum));
    this.planKey = planKey;
    // A reply may have been lost after the wallet settled; its receipt is retrievable by the round's own ID.
    if (this.data.pending && this.data.pending.ticket.kind !== 'noop') {
      const receipt = await this.call('game.receipt', { id: this.data.pending.id });
      if (receipt) await this.resolve(receipt);
    }
    return this.state();
  }
  state(): RoundState | null {
    if (!this.data || !this.plan) return null;
    const node = getNode(this.plan, this.data.nodeId);
    return {
      id: this.data.id,
      nodeId: node.id,
      cash: this.data.cash,
      initialCash: this.data.setup.stake,
      terminal: node.kind === 'terminal',
      contributed: this.data.contributed ?? this.data.setup.stake,
      balance: this.account.balance,
      events: this.data.events ?? [],
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
  save() {
    this.store.set(this.storageKey, JSON.stringify(plain(this.data)));
  }
  /**
   * Ask the wallet for money; the player decides in the wallet's own dialog. The suggestion covers a
   * few more rounds so one authorization lasts.
   */
  async ensureFunds(required: bigint, stake: bigint) {
    if (BigInt(this.account.balance) >= required) return;
    const shortfall = required - BigInt(this.account.balance);
    const result = await this.call('game.requestFunds', { amount: String(shortfall + 4n * stake) });
    this.account = { balance: result.balance, pending: result.pending };
    if (BigInt(this.account.balance) < required) throw new Error('Add enough money to this game to continue');
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
    try {
      return await this.begin(setup);
    } finally {
      this.changed();
    }
  }
  async begin(setup: { stake: string; [key: string]: unknown }) {
    await this.load();
    if (this.data?.pending) throw new Error('Recover the pending action first');
    await this.ensureFunds(BigInt(setup.stake), BigInt(setup.stake));
    const info = await this.call('wallet.info'),
      bankroll = BigInt(info.bankroll);
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
        `The casino can only back about ${this.amount(bankrollFloor)} of payouts right now. Lower your stake and try again.`,
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
      schema: 'HOOKEDIN/ROUND/3',
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
    this.busy = true;
    try {
      return await this.step(action);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async step(action: string) {
    await this.load();
    if (!this.data || !this.plan) throw new Error('Start a round first');
    if (this.state()!.terminal) return this.state()!;
    if (!this.data.pending) {
      const node = getNode(this.plan, this.data.nodeId);
      const selected = node.kind === 'decision' ? node.actions.find(a => a.id === action) : undefined;
      if (!selected) throw new Error('Illegal game action');
      await this.ensureFunds(BigInt(this.data.cash) + selected.additionalCash, BigInt(this.data.setup.stake));
      const info = await this.call('wallet.info');
      const ticket = prepareAction(
        this.plan,
        { nodeId: this.data.nodeId, cash: BigInt(this.data.cash), bankroll: BigInt(info.bankroll) },
        action,
        rngFromBytes(bytes => crypto.getRandomValues(bytes)),
      );
      // Save the step and its operation ID first, so a lost reply is recovered under the same ID.
      this.data.pending = { id: crypto.randomUUID(), ticket: plain(ticket) };
      this.save();
    }
    const { ticket, id } = this.data.pending;
    if (ticket.actionId !== action) throw new Error('Retry the pending action first');
    // Every step of one round carries the round's ID as its group, so the wallet shows them as one game.
    const group = this.data.id;
    let receipt;
    if (ticket.kind === 'bet')
      // The whole step is one bet: the stake at risk, and a prize for every better successor.
      receipt = await this.call('game.bet', { id, stake: ticket.bet.stake, prizes: ticket.bet.prizes, group });
    else if (ticket.kind === 'payment') receipt = await this.call('game.payment', { id, amount: ticket.amount, group });
    else receipt = { kind: 'noop' };
    this.account = await this.balance();
    await this.resolve(receipt);
    if (receipt.status === 'rejected')
      throw new Error(receipt.reason || 'Wager rejected; retry this action or stop the game');
    return this.state()!;
  }
  async resolve(receipt: any) {
    const ticket = this.data.pending.ticket;
    if (receipt.status === 'rejected') {
      if (receipt.verified !== true) throw new Error('A verified rejection is required');
      // Keep the same action under a fresh operation ID for the next attempt.
      this.data.pending.id = crypto.randomUUID();
      this.data.settlement = { kind: 'rejected', reason: receipt.reason };
      this.save();
      return;
    }
    let label,
      landed: { rangeStart: string; rangeEnd: string } | null = null;
    if (ticket.kind === 'bet') {
      if (receipt.verified !== true || !/^[0-9]+$/.test(String(receipt.outcome)))
        throw new Error('A verified wager result is required');
      // The round's outcome names the next state; the wallet's verified payout must agree with it.
      const outcome = BigInt(receipt.outcome),
        next = ticket.successors.find((s: any) => outcome >= BigInt(s.rangeStart) && outcome < BigInt(s.rangeEnd));
      if (!next || BigInt(next.cash) - BigInt(ticket.retained) !== BigInt(receipt.payout))
        throw new Error('The verified payout differs from this step');
      this.data.nodeId = next.next;
      this.data.cash = next.cash;
      label = next.label;
      landed = { rangeStart: next.rangeStart, rangeEnd: next.rangeEnd };
    } else {
      if (ticket.kind === 'payment' && receipt.verified !== true) throw new Error('A verified payment is required');
      this.data.nodeId = ticket.next;
      this.data.cash = ticket.cash;
      label = ticket.label;
    }
    this.data.contributed = String(
      BigInt(this.data.contributed ?? this.data.setup.stake) + BigInt(ticket.additionalCash ?? 0),
    );
    this.data.events = [
      ...(this.data.events ?? []),
      { action: ticket.actionId, ...(label === undefined ? {} : { label }) },
    ];
    this.data.pending = null;
    this.data.settlement = {
      kind: receipt.kind,
      payout: receipt.payout ?? null,
      outcome: receipt.outcome ?? null,
      // The stretch of outcomes that led to this state: where in it the outcome fell is free,
      // verifiable entropy for showing the result (which reel stops, which of several equal cards).
      ...landed,
    };
    this.save();
  }
}
