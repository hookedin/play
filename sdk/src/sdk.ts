/** HookedIn game bridge. This script runs inside a sandboxed iframe that keeps the game host's origin. */
import type { CasinoBetRequest, DeveloperBetRequest, GameAllowance, GameReceipt } from '../../protocol/game-types.ts';
import type { Round } from '../../protocol/types.ts';
import { exactAmount, formatAmount, parseAmount, playerScope, wholeStake } from './wire.ts';
export type { CasinoBetRequest, DeveloperBetRequest, GameAllowance, GameReceipt } from '../../protocol/game-types.ts';

/** Every bound a bet is held to, as the wallet reports them. They are part of the protocol revision the wallet
 * and its casino share, so read them rather than carrying copies of your own. */
export interface WalletBounds {
  /** The size of the outcome space, as a decimal string: a bet's chance counts outcomes out of this. */
  outcomeSpace: string;
  /** The most a developer bet's meta takes, as canonical JSON, and the longest group label. */
  meta: number;
  group: number;
}
/** Everything a game learns about the player: two names for one person, and nothing else of them. */
export interface WalletInfo {
  /** Their uname, written `~uname`: theirs for good, whatever they are called today. Key anything of
   * your own by this. Null until the casino knows the player, which it does once they fund a channel. */
  uname: string | null;
  /** The alias they are shown by, written `@alias`; null unless they took one. */
  alias: string | null;
  chainId: string;
  /** The virtual bankroll of the casino's latest quote, half the casino's bankroll when it quoted: what to price casino
   * bets against. The casino settles every casino bet its quote's virtual bankroll admits. */
  virtualBankroll: string;
  recommendedStake: string;
}
/** A refusal a game can act on. `code` is stable; the message is for people. The wallet's own codes:
 * `invalid-request`, `unknown-method`, `busy`, `insufficient-allowance`, `pending-operation`, `id-conflict`, `id-used`,
 * `game-closed` and `failed`; a refusal by the casino carries the casino's code. */
export class HookedInError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HookedInError';
    this.code = code;
  }
}

let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
const receiptListeners = new Set<(receipt: GameReceipt) => void>();
window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.hookedin !== true) return;
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

/** How long the page waits for the wallet's reply. */
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

/** The page's first message, which starts it at the wallet: every bound the wallet holds a bet to. A greeting that
 * failed is forgotten, so the next call asks again. */
let greeting: Promise<{ bounds: WalletBounds }> | null = null;
const hello = (): Promise<{ bounds: WalletBounds }> =>
  (greeting ??= call('wallet.hello').catch(error => {
    greeting = null;
    throw error;
  }));
if (window.parent !== window) hello().catch(() => {});

/** Scope game storage to this page and to the player: games sharing a host and accounts sharing a browser must not
 * see each other's state. It keys on the player's uname, so taking or giving up an alias does not lose what they
 * had. */
const storageScope = (wallet: WalletInfo | null | undefined) => `hookedin:${location.pathname}:${playerScope(wallet)}`;

export const HookedIn = Object.freeze({
  call,
  hello,
  /** Who is playing and what to price bets against. */
  info: (): Promise<WalletInfo> => call('wallet.info'),
  /** A developer's round as the casino shows it to anyone, read through the player's wallet: open, or revealed with
   * its seed, its secret, its outcome and the developer's casino bet on it. A game whose players share a draw checks
   * its rounds here. */
  round: (id: string): Promise<Round> => call('wallet.round', { id }),
  /** What the game may stake now, whether an operation awaits recovery, and whether it may place developer bets. With
   * `group`, what a bet of that group may stake: the allowance and what the group has won and not shown yet. The wallet
   * shows the player the allowance itself, in its top bar. */
  allowance: (group?: string): Promise<GameAllowance> => call('game.allowance', group === undefined ? {} : { group }),
  /** Ask the player for a larger allowance: `amount` more than the game has now, and with `developerBets`, leave to
   * place developer bets too, which the wallet warns about. The wallet shows its own dialog, in its own words, where the
   * player sets the game's allowance; the reply says whether they did, and the allowance after it. */
  requestAllowance: (
    options: { amount?: bigint | string; developerBets?: boolean } = {},
  ): Promise<GameAllowance & { allowed: boolean }> =>
    call('game.requestAllowance', {
      ...(options.amount === undefined ? {} : { amount: String(options.amount) }),
      ...(options.developerBets ? { developerBets: true } : {}),
    }),
  /** The player has seen how `group` ended. Until then, what its bets won stays out of the allowance and the balance
   * the wallet shows, so they never give a result away before the game does; and the group's own bets may stake it.
   * A stake leaves them when it is bet. Leaving the game ends every group. */
  end: (group: string): Promise<null> => call('game.end', { group }),
  /** The receipt of an earlier operation by your own `id`, or `null` if this wallet has none. For an open developer
   * bet the wallet also asks the casino: once its developer has settled it, the wallet collects it and `onReceipt`
   * hears. */
  receipt: (id: string): Promise<GameReceipt | null> => call('game.receipt', { id }),
  /** A casino bet: settled at once against the casino's bankroll, on the player's own round. `stake` is paid to
   * enter, and `prize` pays when the round's outcome is below `chance`, counted in outcomes out of 2^64. `group`
   * labels bets that belong together, such as the steps of one hand. */
  casinoBet: (request: CasinoBetRequest): Promise<GameReceipt> => call('game.casinoBet', { ...request }),
  /** A developer bet: a bet against your game's developer, whose bank takes the stake at once and who settles it,
   * paying what its settlement says. `meta` is your game's own JSON, saying what the bet is: the casino keeps it with
   * the bet and never reads it, and your developer's server does. The receipt says `open`; once it is settled,
   * `onReceipt` hears. */
  developerBet: (request: DeveloperBetRequest): Promise<GameReceipt> => call('game.developerBet', { ...request }),
  /** Called with the new receipt whenever one of your developer bets has been settled and the wallet has checked
   * and collected what it was paid. Returns a function that stops listening. */
  onReceipt(listener: (receipt: GameReceipt) => void) {
    receiptListeners.add(listener);
    return () => {
      receiptListeners.delete(listener);
    };
  },
  storageScope,
  parseAmount,
  formatAmount,
  exactAmount,
  wholeStake,
  /** Read-only startup: who is playing and where to keep what the game saves for them, and the recommended stake in
   * the stake field unless the player has edited it meanwhile. */
  async initializeGame({ stakeInput }: { stakeInput: HTMLInputElement }) {
    const initialStake = stakeInput.value;
    let edited = false;
    const onEdit = () => {
      edited = true;
    };
    stakeInput.addEventListener('input', onEdit);
    try {
      const wallet: WalletInfo = await call('wallet.info');
      const started = { wallet, scope: storageScope(wallet) };
      if (!edited && stakeInput.value === initialStake && /^[1-9]\d{0,77}$/.test(String(wallet.recommendedStake)))
        stakeInput.value = exactAmount(wallet.recommendedStake);
      return started;
    } finally {
      stakeInput.removeEventListener('input', onEdit);
    }
  },
});
