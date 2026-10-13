/** HookedIn game bridge. This script runs inside a sandboxed iframe that keeps the game host's origin. */
import type {
  CasinoBetRequest,
  DeveloperBetRequest,
  GameAllowance,
  GameHistory,
  GameReceipt,
} from '../../protocol/game-types.ts';
import type { Round } from '../../protocol/types.ts';
import {
  HookedInError,
  METH,
  NOT_ENOUGH_ALLOWANCE,
  NO_DEVELOPER_BETS,
  exactAmount,
  formatAmount,
  parseAmount,
  playerScope,
  wholeStake,
} from './wire.ts';
export { HookedInError };
export type {
  CasinoBetRequest,
  DeveloperBetRequest,
  GameAllowance,
  GameHistory,
  GameReceipt,
  EndedGroup,
  PastOperation,
} from '../../protocol/game-types.ts';
export type { StepResult } from '../../protocol/types.ts';

/** Every bound a bet is held to, as the wallet reports them. They are part of the protocol revision the wallet
 * and its casino share, so read them rather than carrying copies of your own. */
export interface WalletBounds {
  /** The size of the outcome space: a bet's chance counts outcomes out of this. */
  outcomeSpace: bigint;
  /** The most a developer bet's meta takes, as canonical JSON, and the longest group label. */
  meta: number;
  group: number;
  /** The most results a step has, the most pairs of an amount below its cash and one above that they make, what
   * they weigh less than, together, and the longest label of one. */
  results: number;
  pairs: number;
  weight: bigint;
  label: number;
}
/** Everything a game learns about the player: two names for one person, and nothing else of them. */
export interface WalletInfo {
  /** Their uname, written `~uname`: theirs for good, whatever they are called today. Key anything of
   * your own by this. Every account has one from the start; null only while the wallet cannot reach the casino. */
  uname: string | null;
  /** The Discord username they are shown by, written `@bob`: the username of the Discord account that verified them;
   * null unless one did. */
  discordUsername: string | null;
  chainId: bigint;
  /** The virtual bankroll of the casino's latest quote, half the casino's bankroll when it quoted: what to price casino
   * bets against. The casino settles every casino bet its quote's virtual bankroll admits. */
  virtualBankroll: bigint;
  recommendedStake: bigint;
}

let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
const receiptListeners = new Set<(receipt: GameReceipt) => void>();
const allowanceListeners = new Set<(allowance: GameAllowance) => void>();
/** HookedIn's wallet. */
const WALLET = 'https://play.hookedin.com';
/** Whether a page at `origin` is a wallet: HookedIn's, or one the player runs on their own computer, at a loopback
 * address. A page that frames the game anywhere else is none, and the game neither hears it nor tells it anything. */
const walletOrigin = (origin: string) =>
  origin === WALLET || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$/.test(origin);
/** The wallet that answered the game's greeting: from then on the one the game hears and tells anything. */
let wallet: string | null = null;
window.addEventListener('message', event => {
  if (event.source !== window.parent || !walletOrigin(event.origin) || (wallet !== null && event.origin !== wallet))
    return;
  const message = event.data;
  if (!message || message.hookedin !== true) return;
  // A developer bet's developer has settled it, and the wallet has checked and collected what it was paid.
  if (message.event === 'game.receipt') {
    for (const listener of receiptListeners) listener(message.receipt);
    return;
  }
  // What the game may stake has changed, whatever changed it.
  if (message.event === 'game.allowance') {
    const { allowance, pending, developerBets } = message;
    for (const listener of allowanceListeners) listener({ allowance, pending, developerBets });
    return;
  }
  if (typeof message.id !== 'number') return;
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  wallet ??= event.origin;
  if (message.error)
    request.reject(new HookedInError(String(message.error.code ?? 'failed'), String(message.error.message ?? '')));
  else if (Object.prototype.hasOwnProperty.call(message, 'result')) request.resolve(message.result);
  else request.reject(new Error('The wallet returned an invalid response.'));
});

/** How long the page waits for the wallet's reply. */
const timeout = 180000;
const timedOut = () => new HookedInError('timeout', 'The wallet did not respond. Check the client, then reconnect.');
const send = (method: string, params: Record<string, unknown>) =>
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
    // Only the greeting goes out before a wallet has answered, and it says nothing.
    window.parent.postMessage({ hookedin: true, id, method, params }, wallet ?? '*');
  });

/** The page's first message, which starts it at the wallet: every bound the wallet holds a bet to. A greeting that
 * failed is forgotten, so the next call asks again. */
let greeting: Promise<{ bounds: WalletBounds }> | null = null;
const hello = (): Promise<{ bounds: WalletBounds }> =>
  (greeting ??= send('wallet.hello', {}).catch(error => {
    greeting = null;
    throw error;
  }));
/** A request to the wallet that answered the game's greeting. */
const call = async (method: string, params: Record<string, unknown> = {}) => {
  if (method !== 'wallet.hello') await hello();
  return send(method, params);
};
if (window.parent !== window) hello().catch(() => {});

/** Scope game storage to this page and to the player: games sharing a host and accounts sharing a browser must not
 * see each other's state. It keys on the player's uname, so taking or giving up a Discord username does not lose
 * what they had. */
const storageScope = (wallet: WalletInfo | null | undefined) => `hookedin:${location.pathname}:${playerScope(wallet)}`;

export const HookedIn = Object.freeze({
  call,
  hello,
  /** Who is playing and what to price bets against. */
  info: (): Promise<WalletInfo> => call('wallet.info'),
  /** A game's round as the casino shows it to anyone, read through the player's wallet: open, or revealed with its
   * seed, its secret, its outcome and the game's casino bet on it. A game whose players share a draw checks
   * its rounds here. */
  round: (id: string): Promise<Round> => call('wallet.round', { id }),
  /** What the game may stake now, whether an operation awaits recovery, and whether it may place developer bets. With
   * `group`, what a bet of that group may stake: the allowance and what the group has won and not shown yet. Only the
   * player sets it, in the wallet's top bar, and a bet it does not cover is refused with `insufficient-allowance`;
   * `onAllowance` hears whenever it changes. */
  allowance: (group?: string): Promise<GameAllowance> => call('game.allowance', group === undefined ? {} : { group }),
  /** Called with what `allowance()` answers, without a group, whenever any of it changes while the page is open:
   * the player sets the allowance or allows developer bets, a bet or a payment settles, a group ends, a withdrawal
   * leaves less in the balance, an operation of the game starts or finishes. Returns a function that stops
   * listening. */
  onAllowance(listener: (allowance: GameAllowance) => void) {
    allowanceListeners.add(listener);
    return () => {
      allowanceListeners.delete(listener);
    };
  },
  /** Say, as the page loads, that the game places developer bets: the allowance dialog the player opens from the
   * wallet's top bar then asks them to allow developer bets too, with the wallet's warning. Nothing opens. */
  placesDeveloperBets: (): Promise<null> => call('game.placesDeveloperBets'),
  /** The player has seen how `group` ended. Until then, what its bets won stays out of the allowance and the balance
   * the wallet shows, so they never give a result away before the game does; and the group's own bets may stake it.
   * A stake leaves them when it is bet. Leaving the game ends every group. With `meta`, your own JSON saying how the
   * group went, the casino keeps it in the player's history of your game, once per group, and `history` lists it. */
  end: (group: string, meta?: Record<string, unknown>): Promise<null> =>
    call('game.end', meta === undefined ? { group } : { group, meta }),
  /** The player's history of your game, newest first, from any channel or device of theirs: your operations the casino
   * carried out, as receipts the wallet checked, without your own IDs, and the groups you ended with meta. Pass the
   * page's `cursor` back as `after` for older entries while `more` is true. */
  history: (page: { after?: string; limit?: number } = {}): Promise<GameHistory> => call('game.history', { ...page }),
  /** The receipt of an earlier operation by your own `id`, or `null` if this wallet has none. For an open developer
   * bet the wallet also asks the casino: once its developer has settled it, the wallet collects it and `onReceipt`
   * hears. */
  receipt: (id: string): Promise<GameReceipt | null> => call('game.receipt', { id }),
  /** Show the player one of your operations in full, by your own `id`, in the wallet over your page: the proof of how
   * it settled, which the wallet shows and you cannot. Refused with `not-found` when this wallet keeps no receipt of
   * it, as for an operation played on another device. */
  showBet: (id: string): Promise<null> => call('wallet.showBet', { id }),
  /** A step: the `cash` it holds and the `results` it can end in, each with the probability its `weight` gives it, the
   * cash it leaves the player and a `label` the wallet shows. The wallet splits the table into casino bets its quote
   * covers, draws one with the seed of the bet it signs, which settles at once against the casino's bankroll on the
   * player's own round, and lands on a result with the same seed: the receipt's `result`, its place in the table, and
   * `draw`, a 64-bit value to show it with. A step whose results all keep its cash places no bet and only lands. A
   * single bet is a table of two results: its prize, and nothing. `group` labels bets that belong together, such as the
   * steps of one hand. */
  casinoBet: (request: CasinoBetRequest): Promise<GameReceipt> => call('game.casinoBet', { ...request }),
  /** A developer bet: a bet against your game's developer. Your game's bank takes the stake at once and your server
   * settles it, paying what its settlement says. `meta` is your game's own JSON, saying what the bet is: the casino
   * keeps it with the bet and never reads it, and your server does. `round`, if your server committed to a secret
   * before the bet, is its hash: the settlement must reveal the secret, and the wallet shows the player that it was
   * fixed before they bet. The receipt says `open`; once it is settled, `onReceipt` hears. */
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
  /** A METH, in wei. */
  METH,
  NOT_ENOUGH_ALLOWANCE,
  NO_DEVELOPER_BETS,
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
      if (
        !edited &&
        stakeInput.value === initialStake &&
        typeof wallet.recommendedStake === 'bigint' &&
        wallet.recommendedStake > 0n
      )
        stakeInput.value = exactAmount(wallet.recommendedStake);
      return started;
    } finally {
      stakeInput.removeEventListener('input', onEdit);
    }
  },
});
