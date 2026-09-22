/* HookedIn game bridge. This script runs inside a sandboxed iframe that keeps the game host's origin. */
export interface GameBalance {
  /** What this game may still risk in this tab, including its winnings, in the asset's smallest units. Released when the player leaves. */
  balance: string;
  /** A signed operation awaits recovery in the wallet; no new wager is possible. */
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
/** Every bound a game has to respect, as the wallet reports them. Read them; do not assume them:
 * a deployment can change any of these and a game built against constants of its own would not know. */
export interface WalletLimits {
  /** The most prizes one bet holds. */
  prizes: number;
  /** The size of the outcome space, as a decimal string: a prize range lies within [0, this). */
  outcomeSpace: string;
  /** The most seats one shared round holds. */
  seats: number;
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
 * `not-pending`, `declined`, `id-conflict`, `game-closed` and `failed`; a
 * refusal by the casino carries the casino's code, such as `round-not-open`. */
export class HookedInError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HookedInError';
    this.code = code;
  }
}
/** A prize on the wire: decimal strings. */
export interface WirePrize {
  rangeStart: string;
  rangeEnd: string;
  payout: string;
}
export type { Round } from './wire.ts';
export type { GameReceipt, PendingReceipt } from '@hookedin/play/protocol/game-types.ts';
import type { Round } from './wire.ts';
import type { GameReceipt, PendingReceipt } from '@hookedin/play/protocol/game-types.ts';
import { playerScope, showName } from './wire.ts';
export const HookedIn = (() => {
  'use strict';
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const balanceListeners = new Set<(balance: GameBalance) => void>();
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

  /** The last pushed balance, or the first one once the wallet has attached. */
  const balance = () =>
    new Promise<GameBalance>((resolve, reject) => {
      if (window.parent === window) {
        reject(new Error('Open this game in the HookedIn client to connect your wallet.'));
        return;
      }
      if (latest && greeted) return resolve(latest);
      const stop = onBalance(value => {
        stop();
        resolve(value);
      });
    });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      if (window.parent === window) {
        reject(new HookedInError('no-wallet', 'Open this game in the HookedIn client to connect your wallet.'));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HookedInError('timeout', 'The wallet did not respond. Check the client, then reconnect.'));
      }, 180000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ hookedin: true, id, method, params }, '*');
    });

  /** The first thing a page asks: which methods this wallet offers, and the asset it plays with. */
  let greeting: Promise<WalletHello> | null = null;
  const hello = () =>
    (greeting ??= call('wallet.hello').then((value: WalletHello) => {
      greeted = value;
      if (latest) for (const listener of balanceListeners) listener(latest);
      return value;
    }));
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

  /** The wallet persists nothing for a game, so a game keeps its round state at its own origin. */
  const receipt = (id: string): Promise<GameReceipt | null> => call('game.receipt', { id });
  /** One atomic bet: `stake` is paid to enter and every prize whose range holds the outcome pays. With
   * a `round` the game's host opened, the wallet takes a seat in that round and the reply is pending;
   * once the host has closed the round, the same call returns the verified receipt. */
  const bet = (request: {
    id: string;
    stake: string;
    prizes: WirePrize[];
    round?: Round;
  }): Promise<GameReceipt | PendingReceipt> => call('game.bet', request);
  /** Give up a seat in a round its host has not closed; if it was closed, this is the bet's result. */
  const cancel = (id: string): Promise<GameReceipt> => call('game.cancel', { id });
  /** A deterministic payment to the bankroll. */
  const payment = (id: string, amount: string): Promise<GameReceipt> => call('game.payment', { id, amount });
  /** Pay the developer named in this game's manifest. */
  const transfer = (id: string, amount: string): Promise<GameReceipt | PendingReceipt> =>
    call('game.transfer', { id, amount });
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
    balance,
    onBalance,
    requestFunds,
    receipt,
    bet,
    cancel,
    payment,
    transfer,
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
