/* HookedIn game bridge. This script runs inside a sandboxed iframe that keeps the game host's origin. */
export interface GameBalance {
  /** What this game may still risk in this tab, including its winnings, in the asset's smallest units. Released when the player leaves. */
  balance: string;
  /** A signed operation awaits recovery in the wallet; no new bet or payment is possible. */
  pending: boolean;
}
/** What the wallet plays with: the network's ETH, or `test`, the casino's test coins, which every
 * wallet has and nobody can win or lose anything real with. Amounts on the bridge are whole numbers
 * of the asset's smallest unit, as decimal strings. */
export interface Asset {
  id: 'eth' | 'test';
  symbol: string;
  decimals: number;
}
/** Every bound a bet is held to, as the wallet reports them. They are part of the protocol revision the wallet
 * and its casino share, so read them rather than carrying copies of your own. */
export interface WalletLimits {
  /** The size of the outcome space, as a decimal string: a bet's chance counts outcomes out of this. */
  outcomeSpace: string;
  /** The most a developer bet's meta takes, as canonical JSON, and the longest group label. */
  meta: number;
  group: number;
}
/** What a wallet says when a game page loads: the methods it offers, the money it plays with, and
 * every bound it holds a bet to. */
export interface WalletHello {
  methods: string[];
  asset: Asset;
  chainId: string;
  limits: WalletLimits;
}
/** Everything a game learns about the player: two names for one person, and nothing else of them. */
export interface WalletInfo {
  /** Their uname, written `~uname`: theirs for good, whatever they are called today. Key anything of
   * your own by this. Null in a wallet no casino has answered yet. */
  uname: string | null;
  /** The alias they are shown by, written `@alias`; null unless they took one. */
  alias: string | null;
  chainId: string;
  /** The casino's bankroll as last reported: what to price bets against, not a promise to admit them. */
  bankroll: string;
  recommendedStake: string;
}
/** A refusal a game can act on. `code` is stable; the message is for people. The wallet's own codes:
 * `invalid-request`, `unknown-method`, `busy`, `no-channel`, `insufficient-funds`, `pending-operation`,
 * `id-conflict`, `id-used`, `game-closed` and `failed`; a refusal by the casino carries the
 * casino's code. */
export class HookedInError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HookedInError';
    this.code = code;
  }
}
export type { CasinoBetRequest, DeveloperBetRequest, GameReceipt } from '../../protocol/game-types.ts';
import type { CasinoBetRequest, DeveloperBetRequest, GameReceipt } from '../../protocol/game-types.ts';
import type { Round } from '../../protocol/types.ts';
import { playerScope, showName } from './wire.ts';
export const HookedIn = (() => {
  'use strict';
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const balanceListeners = new Set<(balance: GameBalance) => void>();
  const receiptListeners = new Set<(receipt: GameReceipt) => void>();
  // The wallet pushes the balance right after the iframe loads and on every change; there is nothing to poll.
  let latest: GameBalance | null = null;
  // What the wallet said when this page loaded. Balances reach the game only after it, so whatever
  // shows one can also format it.
  let greeted: WalletHello | null = null;
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.hookedin !== true) return;
    if (message.event === 'game.balance') {
      latest = {
        balance: String(message.balance),
        pending: message.pending === true,
      };
      if (greeted) for (const listener of balanceListeners) listener(latest);
      return;
    }
    // A developer bet's developer has settled it, and the wallet has checked and collected what it was paid.
    if (message.event === 'game.receipt') {
      for (const listener of receiptListeners) listener(message.receipt);
      return;
    }
    if (typeof message.id !== 'number') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error)
      request.reject(new HookedInError(String(message.error.code ?? 'failed'), String(message.error.message ?? '')));
    else if (Object.prototype.hasOwnProperty.call(message, 'result')) request.resolve(message.result);
    else request.reject(new Error('The wallet returned an invalid response.'));
  });

  /** How long the page waits for the wallet: for a reply, or for the first balance it pushes. */
  const timeout = 180000;
  const timedOut = () => new HookedInError('timeout', 'The wallet did not respond. Check the client, then reconnect.');
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      if (window.parent === window) {
        reject(new HookedInError('no-wallet', 'Open this game in the HookedIn client to connect your wallet.'));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(timedOut());
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ hookedin: true, id, method, params }, '*');
    });

  /** The first thing a page asks: which methods this wallet offers, and the asset it plays with. A greeting that
   * failed is forgotten, so the next call asks again. */
  let greeting: Promise<WalletHello> | null = null;
  const hello = () =>
    (greeting ??= call('wallet.hello').then(
      (value: WalletHello) => {
        greeted = value;
        if (latest) for (const listener of balanceListeners) listener(latest);
        return value;
      },
      error => {
        greeting = null;
        throw error;
      },
    ));
  if (window.parent !== window) hello().catch(() => {});
  /** Every HookedIn asset counts in units of 10^-18, so an amount can be read and written before the
   * wallet has said which one this is; only its name has to wait for the greeting. */
  const asset = (): Asset => greeted?.asset ?? { id: 'eth', symbol: '', decimals: 18 };

  /** The wallet pushes the game's spendable balance whenever it changes, including stops and top-ups. */
  const onBalance = (listener: (balance: GameBalance) => void) => {
    balanceListeners.add(listener);
    return () => {
      balanceListeners.delete(listener);
    };
  };
  /** The last pushed balance, once the wallet has greeted the page; the first push if none has come yet. */
  const balance = async (): Promise<GameBalance> => {
    await hello();
    return (
      latest ??
      new Promise((resolve, reject) => {
        const stop = onBalance(value => {
          clearTimeout(timer);
          stop();
          resolve(value);
        });
        const timer = setTimeout(() => {
          stop();
          reject(timedOut());
        }, timeout);
      })
    );
  };

  /**
   * Ask the player for more money: `amount` more than the game has now. The wallet shows its own
   * dialog, in its own words, where the player sets the game's spending limit; the reply says
   * whether they did, the limit they chose, and the new state.
   */
  const requestFunds = (
    options: { amount?: bigint | string } = {},
  ): Promise<GameBalance & { funded: boolean; amount: string | null }> =>
    call('game.requestFunds', options.amount === undefined ? {} : { amount: String(options.amount) });

  /** What the player typed, as whole smallest units of the wallet's asset. */
  function parseAmount(value: string) {
    const { decimals } = asset();
    if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`).test(value.trim())) {
      throw new Error(`Enter a positive stake with up to ${decimals} decimal places.`);
    }
    const [whole, fractional = ''] = value.trim().split('.');
    const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional.padEnd(decimals, '0') || 0);
    if (units <= 0n) throw new Error('Your stake must be greater than zero.');
    return units.toString();
  }

  /** Smallest units as the player reads them, to `places` decimal places. */
  function formatAmount(value: string | number | bigint, places = 6) {
    const { decimals } = asset();
    try {
      const units = BigInt(value);
      const sign = units < 0n ? '-' : '';
      const positive = units < 0n ? -units : units;
      const one = 10n ** BigInt(decimals);
      const whole = positive / one;
      const fractional = (positive % one).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
      if (positive > 0n && whole === 0n && !fractional) return `${sign}<0.${'0'.repeat(places - 1)}1`;
      return `${sign}${whole}${fractional ? '.' + fractional : ''}`;
    } catch {
      return '—';
    }
  }

  /** Every digit of an amount: what belongs in a field the player edits. */
  const exactAmount = (value: string | number | bigint) => formatAmount(value, asset().decimals);

  /** Move a stake field one step along a 1-2-5 ladder; an unreadable value is left alone. */
  function stepStake(input: HTMLInputElement, up: boolean) {
    let wei: bigint;
    try {
      wei = BigInt(parseAmount(input.value));
    } catch {
      return;
    }
    const magnitude = 10n ** BigInt(wei.toString().length - 1);
    const next = up
      ? [1n, 2n, 5n, 10n].map(m => m * magnitude).find(value => value > wei)!
      : ([5n, 2n, 1n].map(m => m * magnitude).find(value => value < wei) ?? (magnitude > 1n ? magnitude / 2n : wei));
    input.value = exactAmount(next);
  }

  /** The receipt of an earlier operation by your own `id`, or `null` if this wallet has none. For an open developer bet
   * the wallet also asks the casino: once its developer has settled it, the wallet collects it and `onReceipt`
   * hears. */
  const receipt = (id: string): Promise<GameReceipt | null> => call('game.receipt', { id });
  /** A casino bet: settled at once against the casino's bankroll, on the player's own round. `stake` is paid to
   * enter, and `prize` pays when the round's outcome is below `chance`, counted in outcomes out of 2^64. `group`
   * labels bets that belong together, such as the steps of one hand. */
  const casinoBet = (request: CasinoBetRequest): Promise<GameReceipt> => call('game.casinoBet', { ...request });
  /** A developer bet: a bet against your game's developer, whose bank takes the stake at once and who settles it,
   * paying what its settlement says. `meta` is your game's own JSON, saying what the bet is: the casino keeps it with
   * the bet and never reads it, and your developer's server does. The receipt says `open`; once it is settled,
   * `onReceipt` hears. */
  const developerBet = (request: DeveloperBetRequest): Promise<GameReceipt> =>
    call('game.developerBet', { ...request });
  /** Called with the new receipt whenever one of your developer bets has been settled and the wallet has checked and
   * collected what it was paid. Returns a function that stops listening. */
  const onReceipt = (listener: (receipt: GameReceipt) => void) => {
    receiptListeners.add(listener);
    return () => {
      receiptListeners.delete(listener);
    };
  };
  /** A deterministic payment to the bankroll. */
  const payment = (id: string, amount: string, group?: string): Promise<GameReceipt> =>
    call('game.payment', { id, amount, ...(group === undefined ? {} : { group }) });
  /** Scope game storage to this page, player and asset: games sharing a host, accounts sharing a
   * browser, and the same player's ETH and test-coin play must not see each other's state. It keys
   * on the player's uname, so taking or giving up an alias does not lose what they had. */
  const storageScope = (wallet: WalletInfo | null | undefined) =>
    `hookedin:${location.pathname}:${playerScope(wallet, asset().id)}`;

  /** Read-only startup: what the wallet offers, who is playing and what the game may spend. */
  async function initializeGame({
    stakeInput,
    assetLabels = [],
  }: {
    stakeInput: HTMLInputElement;
    assetLabels?: Iterable<Element>;
  }) {
    const initialStake = stakeInput.value;
    let edited = false;
    const onEdit = () => {
      edited = true;
    };
    stakeInput.addEventListener('input', onEdit);
    try {
      const { asset } = await hello();
      const wallet: WalletInfo = await call('wallet.info');
      const state = await balance();
      for (const label of assetLabels) label.textContent = asset.symbol;
      stakeInput.setAttribute('aria-label', `Stake in ${asset.symbol}`);
      const suggestedStake = wallet.recommendedStake;
      if (
        !edited &&
        stakeInput.value === initialStake &&
        typeof suggestedStake === 'string' &&
        /^[1-9]\d{0,77}$/.test(suggestedStake)
      ) {
        stakeInput.value = exactAmount(suggestedStake);
      }
      return { wallet, state, asset: asset.symbol, assetId: asset.id, scope: storageScope(wallet) };
    } finally {
      stakeInput.removeEventListener('input', onEdit);
    }
  }

  /** Every bound this wallet holds a bet to, once the page has greeted it. */
  const limits = async () => (await hello()).limits;
  return Object.freeze({
    call,
    hello,
    limits,
    /** Who is playing and what to price bets against. */
    info: (): Promise<WalletInfo> => call('wallet.info'),
    /** A developer's round as the casino shows it to anyone, read through the player's wallet: open, or revealed with
     * its seed, its secret, its outcome and the developer's casino bet on it. A game whose players share a draw checks
     * its rounds here. */
    round: (id: string): Promise<Round> => call('wallet.round', { id }),
    balance,
    onBalance,
    requestFunds,
    receipt,
    casinoBet,
    developerBet,
    onReceipt,
    payment,
    storageScope,
    /** How a player is written: an alias wears `@`, a uname wears `~`. */
    showName,
    parseAmount,
    formatAmount,
    exactAmount,
    stepStake,
    initializeGame,
  });
})();
