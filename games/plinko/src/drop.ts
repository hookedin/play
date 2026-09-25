/**
 * One Plinko drop is one casino bet: the stake, and a prize for each bucket. The reference for a
 * one-shot prize table: build the bet, save its operation ID, settle it, and read the ball from
 * the round's outcome.
 */
import type { RoundBridge, RoundStore } from '@hookedin/play/sdk/round';
import { admits } from '@hookedin/play/sdk/admits';
import { playerScope } from '@hookedin/play/sdk/wire';
import { dropBet, landing, multipliers, payout } from './tables.ts';
import type { Risk, Rows } from './tables.ts';

export interface DropConfig {
  rows: Rows;
  risk: Risk;
  /** The bet in wei. */
  stake: string;
}
/** A drop in flight, saved before the wallet signs anything. */
interface Pending extends DropConfig {
  /** The game's durable name for the casino bet; replaced only after a verified rejection. */
  id: string;
}
export interface Landed extends DropConfig {
  payout: string;
  /** The ball's turns, true for right; their sum is the bucket. */
  turns: boolean[];
}
const eth = (wei: bigint) => {
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei / 10n ** 18n}${fraction ? '.' + fraction : ''}`;
};
const wire = (bet: ReturnType<typeof dropBet>) => ({
  stake: String(bet.stake),
  prizes: bet.prizes.map(prize => ({
    rangeStart: String(prize.rangeStart),
    rangeEnd: String(prize.rangeEnd),
    payout: String(prize.payout),
  })),
});
const browserStore: RoundStore = {
  get: key => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
};

export class DropClient {
  pending: Pending | null = null;
  private key = '';
  private bankroll = 0n;
  private sinceInfo = 0;
  readonly bridge: RoundBridge;
  readonly store: RoundStore;
  readonly name: string;
  constructor(
    bridge: RoundBridge,
    {
      store = browserStore,
      name = typeof location === 'undefined' ? 'plinko' : location.pathname,
    }: { store?: RoundStore; name?: string } = {},
  ) {
    this.bridge = bridge;
    this.store = store;
    this.name = name;
  }

  /** Load the saved drop for this player. A casino bet the wallet settled meanwhile lands now. */
  async restore(): Promise<Landed | null> {
    const info = await this.info();
    const hello = await this.bridge.call('wallet.hello');
    // Per page, player and asset: the same player's ETH and test-coin play are separate games.
    this.key = `hookedin:drop:${this.name}:${playerScope(info, hello?.asset?.id ?? 'eth')}`;
    const saved = this.store.get(this.key);
    this.pending = saved ? JSON.parse(saved) : null;
    if (!this.pending) return null;
    const receipt = await this.bridge.call('game.receipt', { id: this.pending.id });
    if (!receipt) return null;
    try {
      return this.resolve(receipt);
    } catch {
      return null; // A rejection: the drop stays, under a fresh id.
    }
  }
  private async info() {
    const info = await this.bridge.call('wallet.info');
    this.bankroll = BigInt(info?.bankroll ?? 0);
    this.sinceInfo = 0;
    return info;
  }
  private save() {
    if (this.pending) this.store.set(this.key, JSON.stringify(this.pending));
    else this.store.remove(this.key);
  }

  /**
   * Check the table against half the reported bankroll with the casino's own rule, so ordinary movement
   * between drops does not invalidate it; the casino still checks each casino bet against its live bankroll.
   */
  private bet(config: DropConfig) {
    const bet = dropBet(config.rows, config.risk, BigInt(config.stake));
    if (multipliers(config.rows, config.risk).some(hundredths => payout(bet.stake, hundredths) === 0n))
      throw new Error('This bet is too small for these multipliers. Raise it and drop again.');
    if (this.bankroll / 2n < 1n || !admits(this.bankroll / 2n, bet))
      throw new Error(
        `The casino can only back about ${eth(this.bankroll / 2n)} ETH of payouts right now. Lower your bet or the risk.`,
      );
    return bet;
  }

  /** Drop one ball. A saved drop is always finished first, with its own board and bet. */
  async drop(config: DropConfig): Promise<Landed> {
    if (!this.key) {
      const landed = await this.restore();
      if (landed) return landed;
    }
    if (!this.pending) {
      // The bankroll is only a planning hint, so it is refreshed occasionally rather than per drop.
      if (++this.sinceInfo > 50) await this.info();
      this.bet(config);
      const stake = BigInt(config.stake),
        balance = BigInt((await this.bridge.balance()).balance);
      if (balance < stake) {
        const funded = await this.bridge.call('game.requestFunds', {
          amount: String(stake - balance + 19n * stake),
        });
        if (BigInt(funded.balance) < stake) throw new Error('Add enough money to this game to drop a ball.');
      }
      // Save the drop and its operation ID first, so a lost reply is recovered under the same ID.
      this.pending = { ...config, id: crypto.randomUUID() };
      this.save();
    }
    const { rows, risk, stake, id } = this.pending;
    return this.resolve(await this.bridge.call('game.casinoBet', { id, ...wire(dropBet(rows, risk, BigInt(stake))) }));
  }

  private resolve(receipt: any): Landed {
    const drop = this.pending!;
    if (receipt.status === 'rejected') {
      // A rejection is a signed checkpoint the wallet checked: the same drop is offered again under a fresh id.
      drop.id = crypto.randomUUID();
      this.save();
      throw new Error(receipt.reason || 'The casino declined this drop. Drop again to retry the same ball.');
    }
    if (receipt.status !== 'settled' || !/^[0-9]+$/.test(String(receipt.outcome)))
      throw new Error('A settled casino bet is required');
    const { rows, risk, stake } = drop,
      { bucket, turns } = landing(rows, BigInt(receipt.outcome)),
      paid = payout(BigInt(stake), multipliers(rows, risk)[bucket]!);
    if (paid !== BigInt(receipt.payout)) throw new Error('The verified payout differs from this board');
    this.pending = null;
    this.save();
    return { rows, risk, stake, payout: String(paid), turns };
  }
}
