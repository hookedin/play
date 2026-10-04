import { parseUnits, ZeroAddress } from 'ethers';
import qrcode from 'qrcode-generator';
import { CasinoWallet } from './wallet.ts';
import { inUnit, typedIn, validateWithdrawal, type Unit } from './withdrawal.ts';
import { passkeyKey } from './passkey.ts';
import { gameReceipt } from './wallet-games.ts';
import { OPERATIONS } from './wallet-channel.ts';
import { inbound } from './wallet-transactions.ts';
import { BrowserStore, withLock } from './storage.ts';
import { json, same, verifyEvidence, gameKey, collateralPrice } from '../protocol/protocol.ts';
import { attachGameBridge, gameError } from './bridge.ts';
import {
  activityJSON,
  createActivityEntry,
  developerBetSummary,
  exact,
  h,
  percent,
  receiptSummary,
  signedAmount,
} from './activity.ts';
import { exactAmount, formatAmount, MICRO_ETH } from '../sdk/src/wire.ts';
import {
  betDetail,
  betRowElement,
  betTotals,
  groupRowElement,
  groupRows,
  measuredReturn,
  putIn,
  totalCards,
} from './bets.ts';
import type { BetRow } from './bets.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import config from './config.ts';

interface ActiveGame {
  /** The channel this game is bound to; null until a channel is open. */
  channelId: string | null;
  /** The uname the page was told, once it asked: a game keys what it saves by it, so it restarts when that changes, as
   * it does with the account. */
  uname?: string | null;
  identity: GameIdentity;
  /** Who publishes it, written as they are written (`@username` or `~uname`); none for a game opened by its URL. */
  publisher: string | null;
  /** The wallet path that reopens this game. */
  path: string;
  frame: HTMLIFrameElement;
  dispose: () => void;
  /** Whether the game's page has loaded, so the wallet's receipts have somewhere to go. */
  loaded: boolean;
}
/** A published game is `@username/name` or `~uname/name`: its owner, written as they are written, and
 * the name it has in their profile. Any other game is linkable by its URL alone. */
type GameRoute = { owner: string; name: string } | { url: string };
/** What a profile records of a game it publishes: its key, and its developer, the account that publishes it. */
type Published = { key: string; developer: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (value: string | null | undefined) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—');
/** Where a claim pays, as a sentence says it: paying the contract puts it into the account's own channel. */
const paidTo = (to: string) =>
  same(to, wallet.config.contractAddress)
    ? 'into your balance'
    : same(to, wallet.address)
      ? 'to your address'
      : `to ${short(to)}`;
/** A typed amount of µETH, in wei. */
const typedAmount = (text: string) => parseUnits(text, 12);
/** A typed amount of µETH, in wei: null for anything that is not an amount above zero. */
const positiveAmount = (text: string) => {
  try {
    const value = typedAmount(text);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
};
/** A saved operation in words: what it is, the ID the casino knows it by and the sequence it was signed at, and what the
 * last attempt to send it ran into. */
function pendingSummary({ kind, request, details, game, operationId }: any) {
  const what = `${exact(request.amount)} µETH ${OPERATIONS[kind]!.name}${game ? ` in ${game.name}` : ''}`,
    failed = wallet.pendingError?.operationId === operationId ? wallet.pendingError : null;
  return (
    `Your ${what} is saved and unanswered (operation ${short(details.id)}, sequence ${request.sequence}). ` +
    'Retry sends exactly the same request again.' +
    (wallet.disputable()
      ? ` The casino's quote covers this bet until ${new Date(Number(wallet.pending.quote.message.expiresAt) * 1000).toLocaleString()}: Close without the casino disputes it, and the casino then has 7 days to settle it on-chain, or it counts as won.`
      : wallet.bound()
        ? ' The casino left this bet unanswered until its quote expired, so it can no longer be disputed, and the wallet takes no decline of it: Close without the casino ends this balance, and the bet with it.'
        : '') +
    (failed ? ` Last attempt: ${failed.message}${failed.code ? ` (${failed.code})` : ''}.` : '')
  );
}
// The launcher names the network and the casino in config.js.
const { network, casino: casinoURL } = config;
let active: ActiveGame | null = null,
  uiBusy = false,
  toastTimer: ReturnType<typeof setTimeout> | undefined,
  statusTimer: ReturnType<typeof setTimeout> | undefined;
let historyBusy = false,
  historyError: any = null;
const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The casino's own profile, its account on X: the games it ships with are published there. */
const HOUSE = 'hookedin';
/** How many games one profile holds. */
const MAX_GAMES = 100;
const storage = new BrowserStore();
const wallet = new CasinoWallet({
  storage,
  casinoURL,
  network,
  trustedDeployment: config.deployment,
  onChange: () => renderWallet(),
  onProgress: message => {
    $('operation-text').textContent = message;
    showOnTop($('operation-status'));
    clearTimeout(statusTimer);
    statusTimer = undefined;
  },
  // A developer bet's receipt reaches the game that placed it as soon as the wallet has collected what it was paid.
  onGameReceipt: (game, receipt) => {
    if (!active || active.identity.key !== game.key || !active.frame.contentWindow || !active.loaded) return;
    const message = { hookedin: true, event: 'game.receipt', receipt: gameReceipt(game.id, receipt) };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.url).origin);
  },
});

/** Money out of the open balance: Withdraw pays it to an address, and Settings → Transfer into another account's
 * balance. */
type Send = 'withdraw' | 'transfer';
/** What a form's amount is typed in: Withdraw's in the unit the player chooses, a transfer's in µETH. */
const sendUnit = (send: Send) => (send === 'withdraw' ? ($<HTMLSelectElement>('withdraw-unit').value as Unit) : 'µETH');
/** Money out of the open balance, as its form has it. */
const sendRequest = (send: Send) =>
  validateWithdrawal({
    destination: $<HTMLInputElement>(`${send}-to`).value,
    ownAddress: wallet.address,
    contractAddress: wallet.config.contractAddress,
    amount: $<HTMLInputElement>(`${send}-amount`).value,
    unit: sendUnit(send),
    maximum: wallet.withdrawable(),
    channel: true,
  });
/** Everything at the deposit address, to the address Settings names. */
const addressSendRequest = () =>
  validateWithdrawal({
    destination: $<HTMLInputElement>('address-send-to').value,
    ownAddress: wallet.address,
    contractAddress: wallet.config.contractAddress,
    amount: '',
    maximum: BigInt(wallet.publicState.nativeBalance || 0),
    channel: false,
  });
let safetyAccount = '',
  depositURI = '';
/** Whether the player has this account's key outside this browser: a passkey, a key file or their own import. */
const savedSetting = () => `hookedin:saved:${wallet.address.toLowerCase()}`;
function markSaved() {
  localStorage.setItem(savedSetting(), '1');
  renderWallet();
}
/** The deposit address, and whether this account's key is saved outside this browser. */
function renderSafety() {
  if (safetyAccount !== wallet.storageKey) {
    safetyAccount = wallet.storageKey;
    $<HTMLTextAreaElement>('exported-key').value = '';
    $('exported-key').classList.add('hidden');
    $('export-key').textContent = "Show this wallet's private key";
    for (const id of ['withdraw-to', 'withdraw-amount', 'transfer-to', 'transfer-amount', 'address-send-to'])
      $<HTMLInputElement>(id).value = '';
  }
  const saved = localStorage.getItem(savedSetting()) !== null;
  $('deposit-save').hidden = saved;
  $('deposit-ready').hidden = !saved;
  $('key-status').textContent = saved
    ? 'Saved. Sign in with your passkey, or import your key, to open this account on another device.'
    : "This account's key is only in this browser. Save it with a passkey or a key file before you deposit.";
  for (const button of document.querySelectorAll<HTMLElement>('[data-key="create"], #menu-sign-in'))
    button.hidden = saved;
  const uri = `ethereum:${wallet.address}@${wallet.expectedChainId}`;
  if (uri !== depositURI) {
    depositURI = uri;
    const code = qrcode(0, 'M');
    code.addData(uri);
    code.make();
    $<HTMLImageElement>('deposit-qr').src = code.createDataURL(4, 16);
    $<HTMLAnchorElement>('deposit-link').href = uri;
  }
  const held = BigInt(wallet.publicState.nativeBalance || 0),
    fee = wallet.depositFee;
  const whole = fee > 0n && held > fee ? held - fee : 0n,
    lent = wallet.feeLoan(whole, fee);
  $('deposit-fee').textContent =
    fee > 0n
      ? `Address balance ${exact(held)} µETH. Estimated maximum network fee ${exact(fee)} µETH. Up to ${exact(whole + lent)} µETH can be added now${lent ? ': the casino lends you the network fee, and your next withdrawal pays it back' : ''}. The final fee is recorded in Activity.`
      : 'The network fee is estimated when ETH arrives. Small deposits may not cover that fee.';
}

/** Open a sheet over the page, and take the focus into it: a game frame that had it is inert under the sheet, and keys
 * and clicks would go nowhere. */
function showSheet(dialog: HTMLDialogElement) {
  if (!dialog.open) dialog.showModal();
  if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('.close')?.focus();
}
/** Show a notice above everything, an open dialog too: the top layer stacks in the order things are shown. */
function showOnTop(notice: HTMLElement) {
  if (notice.matches(':popover-open')) notice.hidePopover();
  notice.showPopover();
}
function toast(message: string, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  showOnTop($('toast'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidePopover(), error ? 7500 : 4500);
}

/** One user action at a time. A background poll holding the wallet finishes first. */
async function task(callback: () => unknown | Promise<unknown>) {
  if (uiBusy) return toast('Wait for the current wallet operation to finish.', true);
  uiBusy = true;
  renderWallet();
  try {
    await wallet.actionDone;
    return await callback();
  } catch (error: any) {
    toast(error.shortMessage || error.message || String(error), true);
  } finally {
    uiBusy = false;
    renderWallet();
  }
}
/** A button that runs one wallet action, then says what it did. */
function act(id: string, run: () => unknown, done?: string | (() => string)) {
  $(id).addEventListener('click', () =>
    task(async () => {
      await run();
      if (done) toast(typeof done === 'string' ? done : done());
    }),
  );
}
/** Save `text` as a file the player downloads. */
function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** One game with an allowance per wallet across tabs, so no two tabs show allowances against the same balance. */
let allowanceLock: (() => void) | null = null;
async function holdGameAllowance() {
  if (allowanceLock) return;
  const acquired = Promise.withResolvers<boolean>(),
    released = Promise.withResolvers<void>();
  void withLock(`hookedin:game-allowance:${wallet.storageKey}`, false, async held => {
    acquired.resolve(held);
    if (held) await released.promise;
  });
  if (!(await acquired.promise))
    throw new Error('Another tab already has a game playing with this balance. Finish or leave it there first.');
  allowanceLock = () => released.resolve();
}
/** Leaving a game releases its allowance: the money was always in the balance. */
function closeGame() {
  if (!active) return;
  active.dispose();
  active.frame.remove();
  active = null;
  wallet.closeGame();
  allowanceLock?.();
  allowanceLock = null;
  if ($<HTMLDialogElement>('allowance-dialog').open) $<HTMLDialogElement>('allowance-dialog').close('');
}
/** The game went away without navigation (a balance or account change): the lobby replaces its URL, or the wallet open
 * over it closes onto the lobby. */
function abandonGame() {
  closeGame();
  if (!$('page-play').classList.contains('hidden')) {
    showPage('library');
    history.replaceState(null, '', walletRoute() ? location.pathname : '/');
  }
}

/** The pages with a path of their own, and what they are called. */
const PAGES: Record<string, { path: string; title: string }> = {
  library: { path: '/', title: 'Games' },
  games: { path: '/games', title: 'My games' },
  bets: { path: '/bets', title: 'Bets' },
  bankroll: { path: '/bankroll', title: 'Bankroll' },
};
/** The sheet's tabs, each with a path of its own: the wallet's money under `/wallet`, and Settings, a tab for each thing
 * they are for, under `/settings`. */
const SHEET_TABS = {
  deposit: '/wallet',
  withdraw: '/wallet/withdraw',
  activity: '/wallet/activity',
  keys: '/settings',
  deposits: '/settings/deposits',
  transfer: '/settings/transfer',
  protection: '/settings/protection',
  recovery: '/settings/recovery',
};
type WalletTab = keyof typeof SHEET_TABS;
const walletPath = (tab: WalletTab) => SHEET_TABS[tab];
const inSettings = (tab: WalletTab) => SHEET_TABS[tab].startsWith('/settings');
/** The wallet tab the URL names, if it names one. */
function walletRoute() {
  const target = parseRoute(new URL(location.href));
  return typeof target === 'object' && 'wallet' in target ? target.wallet : null;
}
const gamePath = (route: GameRoute) =>
  'url' in route ? `/games/custom?url=${encodeURIComponent(route.url)}` : `/${route.owner}/${route.name}`;
/** How a player is written: a Discord username wears `@`, a uname wears `~`. */
const showName = (names: { uname?: string | null; discordUsername?: string | null } | null) =>
  names?.discordUsername ? '@' + names.discordUsername : names?.uname ? '~' + names.uname : '—';
/** Show a section; the URL is the caller's responsibility. */
function showPage(page: string) {
  for (const section of document.querySelectorAll<HTMLElement>('.page'))
    section.classList.toggle('hidden', section.id !== `page-${page}`);
  for (const link of document.querySelectorAll<HTMLElement>('.nav-link'))
    link.classList.toggle('active', link.dataset.page === page || (page === 'play' && link.dataset.page === 'library'));
  document.title =
    page === 'library'
      ? 'HookedIn'
      : `${page === 'play' && active ? active.identity.name : page === 'profile' ? $('profile-name').textContent : (PAGES[page]?.title ?? page)} · HookedIn`;
  if (page === 'bets') renderBets();
  if (page === 'games') {
    renderMyGames();
    void refreshBank().catch(() => {});
  }
  if (page === 'bankroll') void refreshFund();
  renderGameAccount();
}
/** The bankroll fund as the casino states it, signed, against the shares this wallet can prove it holds. */
let fundStatus: Record<string, any> | null = null;
async function refreshFund() {
  try {
    fundStatus = await wallet.fundStatus();
  } catch {
    fundStatus = null;
  }
  renderFund();
}
function renderFund() {
  const f = fundStatus,
    open = wallet.playable && !wallet.recoveryOnly,
    shares = BigInt(wallet.fund?.shares || 0);
  $('fund-value').textContent = f ? formatAmount(f.value, 0) : '—';
  $('fund-equity').textContent = f ? formatAmount(f.equity, 0) : '—';
  // Shares are counted like µETH, in units of 10^12: one began at 1 µETH, and the price is what the bankroll has made
  // or lost since.
  $('fund-price').textContent =
    f && BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.equity) * 1000000n) / BigInt(f.totalShares)) / 1000000).toFixed(6)} µETH`
      : '1.000000 µETH';
  $('fund-house').textContent = !f
    ? '—'
    : BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.houseShares) * 10000n) / BigInt(f.totalShares)) / 100).toFixed(2)}%`
      : '100.00%';
  $('fund-note').textContent = wallet.fund?.alert
    ? `Your wallet refused a share statement: ${wallet.fund.alert}`
    : f && BigInt(f.overdrawn) > 0n
      ? `The casino's owner has withdrawn ${formatAmount(f.overdrawn)} µETH more than its own shares covered. Holders bore that loss.`
      : f?.owed?.length
        ? 'Money from shares you sold is on its way to your balance.'
        : !f
          ? 'The casino is not reporting its bankroll right now.'
          : shares
            ? `You hold ${exact(shares)} shares under the casino's signed statement number ${wallet.fund.sequence}.`
            : open
              ? ''
              : 'Deposit into your balance to buy shares.';
  $<HTMLButtonElement>('invest').disabled = uiBusy || !open || !f;
  for (const id of ['divest', 'divest-all']) $<HTMLButtonElement>(id).disabled = uiBusy || !open || !f || !shares;
}
function navigate(page: string, push = true, path = PAGES[page]!.path) {
  // The bets page shows the game its path names, or every game.
  if (page === 'bets') betGame = new URL(path, location.origin).searchParams.get('game')?.toLowerCase() ?? '';
  if (wallet.busy && active && wallet.pending?.game?.key === active.identity.key) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current operation to finish before leaving the game.', true);
  }
  $<HTMLDialogElement>('wallet-dialog').close();
  showPage(page);
  closeGame();
  if (push && location.pathname !== path) history.pushState(null, '', path);
}
/** Every page has a URL: `/`, `/games`, `/bets`, `/bankroll`, `/@<username>` or `/~<uname>` for a player, the same and
 * `/<game>` for a game they publish, `/games/<key>` for a game's public record, `/games/custom?url=<url>`, and
 * `/bets?game=<key>` for the bets of one game; and the wallet or Settings over a page, `/wallet[/<tab>]` and
 * `/settings[/<tab>]`. */
function parseRoute(
  url: URL,
): string | GameRoute | { profile: string } | { record: string } | { wallet: WalletTab } | { unknown: string } {
  // A player's sigil survives a link that encodes it: `encodeURIComponent` writes `@` as `%40`, and the
  // static host decodes the path the same way before it serves this page.
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const tab = (Object.keys(SHEET_TABS) as WalletTab[]).find(tab => SHEET_TABS[tab] === pathname);
  if (tab) return { wallet: tab };
  const named = /^\/([~@][A-Za-z0-9_.]{1,32})(?:\/([a-z0-9][a-z0-9-]{0,31}))?$/.exec(pathname);
  if (named) return named[2] ? { owner: named[1]!, name: named[2] } : { profile: named[1]! };
  if (pathname === '/games/custom') return { url: url.searchParams.get('url') || '' };
  const record = /^\/games\/(0x[0-9a-fA-F]{64})$/.exec(pathname);
  if (record) return { record: record[1]!.toLowerCase() };
  return Object.entries(PAGES).find(([, page]) => page.path === pathname)?.[0] ?? { unknown: pathname };
}
async function route(push = false) {
  const target = parseRoute(new URL(location.href));
  if (typeof target === 'object' && 'wallet' in target) return showWallet(target.wallet);
  // Anywhere else, the wallet is closed.
  $<HTMLDialogElement>('wallet-dialog').close();
  if (typeof target === 'string')
    return navigate(target, push, target === 'bets' ? location.pathname + location.search : undefined);
  if ('unknown' in target) {
    navigate('library', false, '/');
    history.replaceState(null, '', '/');
    return void toast(`Nothing lives at ${target.unknown}. A player is @username or ~uname.`, true);
  }
  if ('profile' in target) return void openProfile(target.profile, push);
  if ('record' in target) return void openGameRecord(target.record, push);
  if (active && active.path === gamePath(target)) return showPage('play');
  if (!(await openGame(target, push))) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}
/** Open the game a route names: true once it is open. */
const openGame = (target: GameRoute, push = false) =>
  task(async () => {
    if ('url' in target) await loadGame(target.url, target, push);
    else {
      const published = await wallet.api(`/api/players/${target.owner}/${target.name}`);
      if (!published.url) throw new Error('This game is not published at that name.');
      await loadGame(published.url, target, push, published);
    }
    return true;
  });

/** The top bar: the open game, by the wallet's name for it, and its allowance, which takes the balance's place, so the
 * bar shows one amount. Until it is set, setting it is all the bar offers. What the game's groups have won and it has
 * not shown yet is in neither. */
function renderGameAccount() {
  const playable = wallet.playable,
    game = active ? wallet.game : null,
    allowance = BigInt(game?.allowance ?? 0),
    balance = BigInt(wallet.publicState?.balance || 0) - wallet.inPlay(),
    unset = Boolean(game) && playable && !allowance;
  $('game-title').classList.toggle('hidden', !game);
  $('game-allowance').classList.toggle('hidden', !game || !playable);
  $('game-allowance').classList.toggle('unset', unset);
  $('wallet-button').classList.toggle('hidden', unset);
  // Balances read in whole µETH, cut off, with every digit on hover.
  $('game-allowance-amount').replaceChildren(
    ...(allowance
      ? [formatAmount(allowance, 0), h('small', { title: 'A millionth of an ETH' }, 'µETH')]
      : ['Set allowance']),
  );
  $('game-allowance-amount').title = allowance ? `${exact(allowance)} µETH` : '';
  $('wallet-button-amount').replaceChildren(
    formatAmount(balance, 0),
    h('small', { title: 'A millionth of an ETH' }, 'µETH'),
  );
  $('wallet-button-amount').title = `${exact(balance)} µETH`;
  $('wallet-button-amount').classList.toggle('hidden', !wallet.publicState?.address || allowance > 0n);
  $('wallet-button-label').textContent = playable && balance > 0n ? 'Wallet' : 'Deposit';
  $('hero-deposit').classList.toggle('hidden', playable || !wallet.address);
  if (!active || !game) return;
  // A game opened before a channel adopts the first one; a game bound to a channel closes with it.
  if (active.channelId === null && wallet.channelId) active.channelId = wallet.channelId;
  if (active.uname !== undefined && wallet.uname !== active.uname) {
    active.uname = undefined;
    active.loaded = false;
    // In place of its history entry: Back still leaves the game, and a close of the wallet over it comes back to it.
    active.frame.contentWindow?.location.replace(active.frame.src);
  }
  if ($<HTMLDialogElement>('allowance-dialog').open) renderAllowanceDialog();
}
/** The slider runs linearly from nothing to the whole playable balance, a hundredth of it a step. */
const SLIDER_STEPS = 100n;
const sliderAmount = (total: bigint, value: string) => wholeMicro((total * BigInt(value)) / SLIDER_STEPS);
/** An allowance is whole µETH: wei cut down to them. */
const wholeMicro = (wei: bigint) => wei - (wei % MICRO_ETH);
/** A whole number of µETH the player typed, as wei: null for anything else. */
const typedWhole = (text: string) => (/^\d{1,30}$/.test(text.trim()) ? BigInt(text.trim()) * MICRO_ETH : null);
/** The wallet's own dialog: the sole grant of spending authority over ETH. It says what the game may play with now,
 * what it would, and out of how much, because those are the whole of what is being authorized. */
function renderAllowanceDialog() {
  if (!active) return;
  const name = active.identity.name;
  // The dialog deals in whole µETH: the allowance as it stands reads cut down to them, as the top bar shows it.
  const allowance = wholeMicro(BigInt(wallet.game?.allowance || '0'));
  $('allowance-title').textContent = allowance > 0n ? `Change the allowance for ${name}` : `Play ${name} with ETH`;
  const total = allowable(),
    slider = $<HTMLInputElement>('allowance-slider'),
    amount = typedWhole($<HTMLInputElement>('allowance-amount').value || '0') ?? -1n,
    valid = amount >= 0n && amount <= total,
    shown = formatAmount(amount, 0),
    // A game that asks to place developer bets as well is allowed them at the allowance it has.
    granting = allowingDeveloperBets && !wallet.game?.developerBets && amount > 0n,
    unchanged = amount === allowance && !granting;
  $('allowance-total').textContent = `${formatAmount(total, 0)} µETH, your balance`;
  $<HTMLButtonElement>('allowance-take-all').classList.toggle('hidden', allowance === 0n);
  slider.value = String(valid && total > 0n ? (amount * SLIDER_STEPS) / total : 0n);
  $('allowance-help').textContent = !valid
    ? amount > total
      ? `That is more than your balance of ${formatAmount(total, 0)} µETH.`
      : 'Enter a whole number of µETH.'
    : total === 0n
      ? 'Your balance is empty. Deposit to play with ETH.'
      : unchanged
        ? `This is ${name}'s allowance now.`
        : amount === allowance
          ? `${name} keeps its allowance of ${shown} µETH, and may place developer bets too.`
          : amount > allowance
            ? `${name} may play with up to ${shown} µETH.`
            : `${name} may play with up to ${shown} µETH, and the rest stays in your balance.`;
  $('allowance-help').classList.toggle('check-failed', !valid);
  $<HTMLButtonElement>('allowance-confirm').disabled = !valid || unchanged || uiBusy || wallet.busy;
  $('allowance-confirm').textContent =
    !valid || unchanged
      ? 'Allow'
      : amount === 0n
        ? 'Take it all back'
        : amount === allowance
          ? 'Allow developer bets'
          : amount < allowance
            ? `Lower to ${shown} µETH`
            : `Allow ${shown} µETH`;
}
/** What the player may allow the open game: the playable balance less what its groups hold, which stays theirs. */
const allowable = () => {
  const total = wallet.playableBalance() - wallet.inPlay();
  return total < 0n ? 0n : total;
};
let allowanceRequest: { resolve: (amount: bigint | null) => void } | null = null,
  /** Whether confirming the dialog lets the game place developer bets: it asked to, or already may. */
  allowingDeveloperBets = false;
/** Opened from the top bar, or by the game's request for a larger allowance, which may suggest how much more, and ask
 * to place developer bets too. With nothing in the balance to allow, the wallet opens on Deposit instead, and the game
 * hears that it has no more. */
function openAllowanceDialog(amount?: bigint, developerBets = false) {
  if (!active || !wallet.game) return Promise.resolve<bigint | null>(null);
  allowanceRequest?.resolve(null);
  if (allowable() === 0n && BigInt(wallet.game.allowance) === 0n) {
    openWallet('deposit', `${active.identity.name} plays with ETH from your balance. Deposit some to play.`);
    return Promise.resolve<bigint | null>(null);
  }
  const dialog = $<HTMLDialogElement>('allowance-dialog');
  // The game page shows nothing but the game, so the dialog that grants it money says who it is, and what it may do.
  const host = new URL(active.frame.src).host;
  $('allowance-who').textContent = active.publisher
    ? `Published by ${active.publisher}, served from ${host}.`
    : `Served from ${host}.`;
  // Only a published game has a developer to bet against.
  allowingDeveloperBets = Boolean(active.publisher) && (developerBets || wallet.game.developerBets);
  $('allowance-developer').hidden = !allowingDeveloperBets;
  $('allowance-developer-text').textContent =
    `${active.identity.name} also bets against its developer, ${active.publisher}: your stake goes into their bank at once, and they decide what each bet pays. Neither the casino nor your wallet can check that result, so allow this only for a developer you trust.`;
  // The dialog starts at the allowance as it stands, nothing for a game just opened, or at what the game asked for,
  // in whole µETH that cover it.
  const total = wholeMicro(allowable()),
    allowance = BigInt(wallet.game?.allowance || '0'),
    asked = amount && amount > 0n ? allowance + amount : allowance,
    suggested = amount && amount > 0n ? wholeMicro(asked + MICRO_ETH - 1n) : wholeMicro(asked);
  $<HTMLInputElement>('allowance-amount').value = String((suggested > total ? total : suggested) / MICRO_ETH);
  renderAllowanceDialog();
  if (!dialog.open) dialog.showModal();
  $<HTMLInputElement>('allowance-amount').select();
  return new Promise<bigint | null>(resolve => {
    allowanceRequest = { resolve };
  });
}

// --- The wallet: the balance, what comes in at the deposit address, withdrawals and activity; and Settings ---------

let walletTab: WalletTab = 'deposit';
/** The wallet's dialog on one of its tabs, over the page it opens on, and why it opened when it was not the player's own
 * click. Opening it is a step in the history, which closing it goes back from. */
function openWallet(tab: WalletTab = 'deposit', reason = '') {
  $('account-menu').hidePopover?.();
  $('wallet-reason').textContent = reason;
  $('wallet-reason').hidden = !reason;
  if (!$<HTMLDialogElement>('wallet-dialog').open) history.pushState({ over: true }, '', walletPath(tab));
  showWallet(tab);
}
/** The wallet, or Settings, on `tab`. A tab has a path, but no step in the history of its own: Back closes the sheet. */
function showWallet(tab: WalletTab) {
  walletTab = tab;
  if (location.pathname !== walletPath(tab)) history.replaceState(history.state, '', walletPath(tab));
  const section = inSettings(tab) ? 'Settings' : 'Wallet';
  $('wallet-dialog').dataset.section = section.toLowerCase();
  $('wallet-title').textContent = section;
  document.title = `${section} · HookedIn`;
  for (const button of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-tab]'))
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const panel of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-panel]'))
    panel.hidden = panel.dataset.panel !== tab;
  const dialog = $<HTMLDialogElement>('wallet-dialog');
  showSheet(dialog);
  // On a phone the tabs scroll sideways: the one shown is never cut off.
  dialog.querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  dialog.scrollTop = 0;
  // What sending a withdrawal costs now, for Max and the help to count with, and what locking in costs, shown before it
  // is signed.
  if (['withdraw', 'transfer', 'recovery'].includes(tab) && wallet.channel)
    void wallet.quoteWithdrawalFee().catch(() => {});
  if (tab === 'activity') void refreshWallet();
  // The deposit address is checked for ETH every 20 seconds while it is shown.
  wallet.showDeposit(tab === 'deposit');
  renderWallet();
}
/** Once money has moved, the wallet has done its work. */
function funded(message: string) {
  $<HTMLDialogElement>('wallet-dialog').close();
  toast(message);
}
/** Withdraw, or Settings → Transfer: part of the signed balance, or all of it with Max, which the casino then pays to the
 * address entered, or into the balance of the account it names. */
function renderSend(
  send: Send,
  {
    open,
    busy,
    ready,
    closing,
    loan,
  }: { open: boolean; busy: boolean; ready: boolean; closing: boolean; loan: bigint },
) {
  const request = sendRequest(send),
    amount = request.amount,
    unit = sendUnit(send),
    verb = send === 'withdraw' ? 'Withdraw' : 'Transfer',
    // What the balance pays beside the amount: the casino's fee for sending it, and back what the casino lent it.
    charges = [
      wallet.withdrawalFee ? `the casino ${formatAmount(wallet.withdrawalFee)} µETH for sending it` : '',
      loan ? `back the ${formatAmount(loan)} µETH the casino lent you` : '',
    ].filter(Boolean);
  $(`${send}-form`).classList.toggle('hidden', !open);
  // Money goes out signing the casino's fee only once it is shown.
  $<HTMLButtonElement>(send).disabled =
    busy ||
    !ready ||
    !open ||
    !wallet.withdrawalFee ||
    Boolean(request.error) ||
    Boolean(wallet.transactionIntent) ||
    Boolean(wallet.pending) ||
    wallet.recoveryOnly;
  $(send).textContent = `${verb}${amount === null ? '' : ` ${inUnit(amount, unit)} ${unit}`}`;
  // A withdrawal leaves for a wallet that may count in ETH: what it receives is said in both units.
  const receives =
    amount === null
      ? ''
      : send === 'transfer'
        ? `That account's HookedIn balance receives ${exact(amount)} µETH.`
        : `The address receives ${inUnit(amount, unit)} ${unit} (${unit === 'ETH' ? `${exact(amount)} µETH` : `${inUnit(amount, 'ETH')} ETH`}).`;
  $(`${send}-help`).textContent = !ready
    ? 'Connecting to your wallet…'
    : closing
      ? 'Your balance is closing: once its 7-day window ends, finish the close under Settings → Recovery and collect it.'
      : !open
        ? 'No balance is open: your first deposit opens one.'
        : wallet.recoveryOnly
          ? 'The casino is unavailable: close without it under Settings → Recovery.'
          : inbound(wallet.pending?.kind)
            ? `A deposit is on its way into your balance. ${verb} once it has arrived.`
            : wallet.transactionIntent || wallet.pending
              ? 'Finish the operation in flight first.'
              : request.error ||
                `${receives}${charges.length ? ` Your balance also pays ${charges.join(' and pays ')}.` : ''} Check the full address before confirming.`;
  // A form not yet touched is told what it needs, not that it is wrong.
  const touched = Boolean(
    $<HTMLInputElement>(`${send}-to`).value.trim() || $<HTMLInputElement>(`${send}-amount`).value.trim(),
  );
  $(`${send}-help`).classList.toggle('check-failed', open && touched && Boolean(request.error));
  if (
    ready &&
    open &&
    !touched &&
    request.error &&
    !wallet.pending &&
    !wallet.transactionIntent &&
    !wallet.recoveryOnly
  )
    $(`${send}-help`).textContent =
      send === 'withdraw'
        ? 'Enter an amount, or Max, and the address that should receive it.'
        : 'Enter an amount, or Max, and the deposit address of the account that should receive it.';
}
function renderWallet() {
  renderFund();
  renderProfile();
  $<HTMLButtonElement>('refresh-wallet').disabled = historyBusy || !wallet.address;
  if (!wallet.address) return;
  const state = wallet.publicState;
  if (active?.channelId && active.channelId !== wallet.channelId) abandonGame();
  const busy = uiBusy || wallet.busy;
  const ready = state.address === wallet.address;
  const observed = Boolean(state.observedAt);
  const balance = BigInt(state.balance || 0),
    arriving = BigInt(state.arriving || 0),
    loan = BigInt(state.loan || 0),
    // What the deposit address holds, read from the chain: until it has been, there is nothing to show.
    atAddress = observed ? BigInt(state.nativeBalance || '0') : 0n,
    status = Number(state.channelStatus),
    closing = status === 2 || Boolean(wallet.channel?.closing);
  $('balance-amount').textContent = formatAmount(balance, 0);
  $('balance-amount').title = `${exact(balance)} µETH`;
  renderCollateral();
  renderSafety();
  const inPlay = wallet.inPlay();
  $('balance-note').textContent = inPlay
    ? `${formatAmount(inPlay)} µETH of it is in play in ${active?.identity.name}: it joins the game's allowance once the game has shown how its round ended.`
    : arriving
      ? `${formatAmount(arriving)} µETH of it is on its way into your balance.`
      : state.closingChannelId && !state.channelId
        ? 'Your last balance is closing: finish the close under Settings → Recovery once its deadline passes, and collect it. A deposit opens your next balance.'
        : loan
          ? `What games play with. The casino lent you ${formatAmount(loan)} µETH of it: your next withdrawal or transfer pays it back first.`
          : 'What games play with.';
  const earnings = state.developerEarnings;
  // The tally the casino keeps for this account, collected into its balance.
  $('developer-earnings').classList.toggle('hidden', !BigInt(earnings?.earned || 0));
  $('developer-earnings').textContent = earnings
    ? `Your games have earned ${exact(earnings.earned)} µETH in commission; ${exact(earnings.collected)} µETH of it is collected into your balance.`
    : '';
  $('wallet-address').textContent = wallet.address;

  // Deposit: ETH sent to the address goes into the balance by itself, unless something the player should decide on
  // is in the way.
  const held = atAddress ? ` It holds ${formatAmount(atAddress)} µETH.` : '';
  const depositStatus = !ready
    ? 'Connecting to your wallet…'
    : !observed
      ? 'Checking your deposit address…'
      : wallet.depositing
        ? `Adding ${formatAmount(wallet.depositing)} µETH to your balance…`
        : arriving
          ? `${formatAmount(arriving)} µETH is on its way into your balance.`
          : wallet.transactionIntent?.method === 'deposit'
            ? `Deposit sent. Waiting for ${wallet.config.confirmations} network confirmation${wallet.config.confirmations === 1 ? '' : 's'} before crediting your balance. Check the pending transaction above.`
            : wallet.recoveryOnly
              ? `The casino is unavailable, so ETH sent here waits at this address.${held}`
              : wallet.forceClosed
                ? `Your last balance is closed or closing, so ETH here waits for you to add it to a new balance or withdraw it.${held}`
                : closing
                  ? `Your balance is closing: ETH sent here waits until you choose what to do with it.${held}`
                  : !wallet.autoDeposit
                    ? `ETH sent here stays at this address: adding it to your balance by itself is off in Settings.${held}`
                    : `Waiting for ETH. Deposits are added after network confirmation.${wallet.config.loanLimit == null ? ' The network fee of adding them comes out of them.' : ' The casino lends you the network fee of adding them, and your next withdrawal pays it back.'}`;
  if ($('deposit-status').textContent !== depositStatus) $('deposit-status').textContent = depositStatus;
  const addable = (wallet.forceClosed || !wallet.autoDeposit) && !wallet.recoveryOnly && !closing && atAddress > 0n;
  $('add-to-balance').classList.toggle('hidden', !addable);
  $<HTMLButtonElement>('add-to-balance').disabled = busy || !ready;
  $<HTMLButtonElement>('copy-address').disabled = !ready;
  $('setup-wallet').classList.toggle('hidden', !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('setup-wallet').disabled = busy;

  const open = status === 1 && !closing;
  for (const send of ['withdraw', 'transfer'] as const) renderSend(send, { open, busy, ready, closing, loan });

  // Settings → Deposits: everything at the deposit address, out to another address.
  const send = addressSendRequest(),
    typed = Boolean($<HTMLInputElement>('address-send-to').value.trim());
  $<HTMLButtonElement>('address-send').disabled =
    busy || !ready || !observed || Boolean(send.error) || Boolean(wallet.transactionIntent);
  $('address-send-help').textContent = !observed
    ? 'Checking your deposit address…'
    : !atAddress
      ? 'Your deposit address is empty.'
      : typed && send.error
        ? send.error
        : `Your deposit address holds ${formatAmount(atAddress)} µETH. Check the full address before confirming.`;
  $('address-send-help').classList.toggle('check-failed', typed && Boolean(send.error));

  $('pending-banner').classList.toggle(
    'hidden',
    !((wallet.pending && !inbound(wallet.pending.kind)) || wallet.transactionIntent) || busy,
  );
  const challengeExpired = Date.now() / 1000 >= Number(state.deadline);
  $('challenge-banner').classList.toggle('hidden', !state.needsChallenge);
  $('challenge-summary').textContent = state.needsChallenge
    ? challengeExpired
      ? 'The challenge deadline has passed. The casino closed with an older balance; keep your recovery bundle.'
      : state.challengeDisputes
        ? `The casino is closing your balance without settling your casino bet. Challenge it before ${new Date(Number(state.deadline) * 1000).toLocaleString()}, which disputes the bet.`
        : `The casino is closing your balance with an older state. Challenge it before ${new Date(Number(state.deadline) * 1000).toLocaleString()}.`
    : '';
  $<HTMLButtonElement>('challenge-now').disabled = busy || !state.needsChallenge || challengeExpired;
  $('pending-summary').textContent = wallet.transactionIntent
    ? 'A transaction is waiting for confirmation. Retry checks it, and Speed up resends it with a higher fee.'
    : wallet.pending
      ? pendingSummary(wallet.pending)
      : '';
  $<HTMLButtonElement>('speed-up-transaction').classList.toggle('hidden', !wallet.transactionIntent);
  $<HTMLButtonElement>('speed-up-transaction').disabled = busy || !wallet.transactionIntent;
  $<HTMLInputElement>('auto-deposit').checked = wallet.autoDeposit;
  $<HTMLInputElement>('auto-deposit').disabled = busy;
  $<HTMLButtonElement>('export-evidence').disabled = busy || !wallet.channel;
  $<HTMLButtonElement>('start-close').disabled = busy || !wallet.channel || Number(state.channelStatus) !== 1;
  for (const id of ['import-wallet', 'recover-wallet']) $<HTMLButtonElement>(id).disabled = busy;
  const accounts = $<HTMLSelectElement>('saved-wallets');
  const addresses = wallet.savedAddresses || [];
  const account = wallet.address;
  if (JSON.stringify([...accounts.options].map(o => o.value)) !== JSON.stringify(addresses))
    accounts.replaceChildren(...addresses.map(address => new Option(address, address)));
  // The list follows the account in use, and leaves alone one the player has picked and not yet switched to.
  if (shownAccount !== account || !addresses.includes(accounts.value)) accounts.value = account;
  shownAccount = account;
  accounts.disabled = busy;
  $<HTMLButtonElement>('select-saved-wallet').disabled = busy || !addresses.length;
  // The notice of what the wallet was doing goes a moment after it is done, however often the page renders meanwhile.
  if (!busy && !statusTimer && $('operation-status').matches(':popover-open'))
    statusTimer = setTimeout(() => {
      $('operation-status').hidePopover();
      statusTimer = undefined;
    }, 2200);
  if (!$('page-bets').classList.contains('hidden')) renderBets();
  if (!$('page-games').classList.contains('hidden')) renderMyGames();
  renderDeveloperBets();
  if (walletTab === 'activity' && $<HTMLDialogElement>('wallet-dialog').open) renderActivity();
  renderClaims();
  renderRecovery();
  renderGameAccount();
}

/** A rate in millionths, as a percentage with no trailing zeros. */
const rateText = (rate: bigint) => percent(rate).replace(/\.?0+%$/, '%');
/** What the contract holds for the balance, its deposits and collateral, and collateral to buy at the casino's rate. */
function renderCollateral() {
  const state = wallet.publicState,
    p = state.protection || { deposits: 0, collateral: 0, covered: 0, uncovered: 0, missing: 0, spare: 0 },
    [uncovered, missing, spare] = [p.uncovered, p.missing, p.spare].map(BigInt),
    rate = state.collateralRate == null ? null : BigInt(state.collateralRate),
    amount = positiveAmount($<HTMLInputElement>('collateral-buy-amount').value.trim()),
    buying = state.buying;
  $('held-deposits').textContent = formatAmount(p.deposits, 0);
  $('collateral-amount').textContent = formatAmount(p.collateral, 0);
  $('protected-amount').textContent = formatAmount(p.covered, 0);
  $('collateral-rate').textContent = rate === null ? '—' : `${rateText(rate)} once`;
  $('balance-protection').textContent = [
    missing > 0n
      ? `${formatAmount(missing)} µETH of your balance is deposits the chain does not hold: a close is owed them only once they land again.`
      : '',
    uncovered > 0n
      ? `${formatAmount(uncovered)} µETH of your balance is winnings above them, which the bankroll pays only as it has the cash until you lock it in under Recovery or buy collateral for it.`
      : `${missing > 0n ? 'The rest' : 'All'} of your balance is protected${spare > 0n ? `, and ${formatAmount(spare)} µETH more that you win would be too` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const button = $<HTMLButtonElement>('buy-collateral');
  button.disabled = uiBusy || wallet.busy || !wallet.playable || rate === null || !amount || Boolean(buying);
  button.textContent =
    amount && rate !== null ? `Buy for ${formatAmount(collateralPrice(amount, rate))} µETH` : 'Buy collateral';
  $('collateral-help').textContent = buying
    ? `Send ${formatAmount(BigInt(buying.price) + 2n * wallet.depositFee)} µETH or more to your deposit address by ${new Date(Number(buying.expiresAt) * 1000).toLocaleTimeString()}, the price and its network fee: the wallet buys ${formatAmount(buying.amount)} µETH of collateral with it before it adds anything to your balance.`
    : !wallet.playable
      ? 'Deposit to open a balance, then buy collateral for it.'
      : rate === null
        ? 'The casino offers no collateral right now.'
        : `Collateral costs ${rateText(rate)} of its amount, once, paid from your deposit address with the network fee. Your withdrawals use it up after your deposits, and it lasts until your balance closes, which the casino can do at any time; the price is never refunded.`;
}
/** What each row of a list was built from, so that a row that has not changed is not built again. */
const signatures = new WeakMap<Element, string>();
/** Keep a list's rows in step with `items`, by key. A row whose signature is unchanged stays mounted, keeping its open
 * details, selection and focus while the wallet renders on every poll. */
function syncRows<T>(
  list: HTMLElement,
  items: T[],
  key: (item: T) => string,
  signature: (item: T) => string,
  build: (item: T) => HTMLElement,
) {
  const existing = new Map([...list.children].map(row => [(row as HTMLElement).dataset.key, row as HTMLElement]));
  items.forEach((item, index) => {
    const id = key(item),
      sign = signature(item);
    let row = existing.get(id);
    existing.delete(id);
    if (!row || signatures.get(row) !== sign) {
      const built = build(item);
      built.dataset.key = id;
      signatures.set(built, sign);
      if (row instanceof HTMLDetailsElement && built instanceof HTMLDetailsElement) built.open = row.open;
      row?.replaceWith(built);
      row = built;
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  for (const row of existing.values()) row.remove();
}

function renderDeveloperBets() {
  const receiptsById = new Map(wallet.history.map(receipt => [receipt.operationId, receipt]));
  const bets = Object.entries(wallet.developerBets).map(([hash, tracked]) => {
    const receipt = tracked.operationId ? receiptsById.get(tracked.operationId) : undefined,
      state: PlayerDeveloperBet = tracked.state ?? {
        bet: hash,
        game: tracked.game,
        status: 'open',
        stake: String(receipt?.stake ?? 0),
        collected: false,
      };
    return { hash, tracked, receipt, state, payload: activityJSON({ ...state, error: tracked.error }) };
  });
  $('developer-bets').classList.toggle('hidden', !bets.length && !wallet.developerBetError);
  $('developer-bets-status').textContent = wallet.developerBetError
    ? `This may be out of date. ${wallet.developerBetError}`
    : 'Bets waiting for their developers, and what they were paid on its way to your balance.';
  $('developer-bets-status').classList.toggle('check-failed', Boolean(wallet.developerBetError));
  syncRows(
    $('wallet-developer-bets'),
    bets,
    bet => bet.hash,
    bet => bet.payload,
    ({ hash, tracked, receipt, state, payload }) => {
      const presentation = developerBetSummary(state, receipt?.game?.name);
      return createActivityEntry({
        ...presentation,
        timestamp: state.settledAt ? new Date(state.settledAt).toISOString() : (receipt?.createdAt ?? ''),
        description: [
          tracked.state ? presentation.description : 'Waiting for the casino to report this bet.',
          tracked.error,
        ]
          .filter(Boolean)
          .join(' '),
        payload,
        facts: [['Bet', hash], ...(state.group ? [['Group', state.group] as [string, string]] : [])],
      });
    },
  );
}

function renderActivity() {
  const refreshError = historyError?.shortMessage || historyError?.message || historyError || wallet.detailsError;
  $('history-status').textContent =
    historyError || wallet.detailsError
      ? `This may be out of date; your saved proofs are safe. ${refreshError}`
      : historyBusy || wallet.detailsRefreshing
        ? 'Checking the chain and the casino…'
        : 'Everything your wallet signed, sent and found, with the JSON behind it.' +
          (wallet.detailsObservedAt
            ? ` Checked ${new Date(wallet.detailsObservedAt).toLocaleTimeString([], { hour12: false })}.`
            : '');
  $('history-status').classList.toggle('check-failed', Boolean(historyError || wallet.detailsError));
  syncRows($('activity-list'), wallet.history, receipt => receipt.operationId, activityJSON, activityEntry);
  filterList('activity');
}
/** One receipt as Activity lists it, with the facts behind it. */
function activityEntry(receipt: any) {
  // A declined operation's proof is the checkpoint above it, with no step: the operation is the one it declined.
  const operation = receipt.request ?? receipt.proof?.step?.operation;
  const channelId = operation?.channelId || receipt.proof?.base?.channelId || receipt.channelId;
  const presentation = receiptSummary(receipt, wallet.config.contractAddress);
  const facts: [string, string | Node][] = [['Operation ID', receipt.operationId]];
  if (channelId) facts.push(['Channel', channelId]);
  if (operation?.sequence !== undefined) facts.push(['Sequence', String(operation.sequence)]);
  if (receipt.commission !== undefined) facts.push(['Commission', `${exact(receipt.commission)} µETH`]);
  if (receipt.to)
    facts.push([
      'To',
      same(receipt.to, wallet.config.contractAddress)
        ? 'Your own channel, as deposits'
        : receipt.kind === 'transfer'
          ? `The HookedIn balance of ${receipt.to}`
          : receipt.to,
    ]);
  if (receipt.withdrawal) facts.push(['Withdrawal ID', receipt.withdrawal]);
  // One the contract has not made a claim yet can be sent by this account too, as the casino does straight away: the
  // oldest of its channel first, since the contract records them in order.
  if (receipt.withdrawal && !receipt.recorded && !receipt.returned && wallet.nextToRecord(receipt))
    facts.push([
      'Payment',
      h(
        'button',
        {
          type: 'button',
          className: 'button small',
          onclick: () =>
            task(async () => {
              await wallet.sendWithdrawal(receipt.operationId);
              toast('Sent: the contract has it.');
            }),
        },
        'Send it now',
      ),
    ]);
  if (receipt.fee !== undefined) facts.push(['Network fee', `${exact(receipt.fee)} µETH`]);
  if (receipt.txHash) facts.push(['Transaction', transactionLink(receipt.txHash)]);
  if (receipt.recordedIn) facts.push(['Recorded in', transactionLink(receipt.recordedIn)]);
  if (receipt.blockNumber !== undefined) facts.push(['Block', String(receipt.blockNumber)]);
  return createActivityEntry({
    ...presentation,
    timestamp: receipt.createdAt,
    payload: activityJSON(receipt),
    facts,
    description: receipt.game?.name || (receipt.to ? `To ${short(receipt.to)}` : undefined),
    notice: [presentation.description, presentation.notice].filter(Boolean).join(' '),
  });
}
/** The balance's channel and any whose close is under way, for recovery: their state on the chain, and the lock in,
 * close, challenge and collect a player can do without the casino. */
function renderRecovery() {
  const state = wallet.publicState,
    busy = uiBusy || wallet.busy,
    open = Number(state.channelStatus) === 1 && !wallet.channel?.closing,
    closing = state.closingChannelId,
    deadline = Number(state.deadline);
  $('channel-status').textContent = wallet.missingChannel
    ? 'The casino holds another state of this balance than this browser: import its recovery bundle.'
    : [
        state.channelId
          ? `Channel ${short(state.channelId)} · ${Number(state.channelStatus) === 1 ? (wallet.channel?.closing ? 'close signed; retry submission' : 'open') : 'closing'}`
          : 'No balance open',
        closing ? `channel ${short(closing)} · closing` : '',
      ]
        .filter(Boolean)
        .join(' · ');
  $('channel-observation').classList.toggle('hidden', !state.channelId && !closing);
  $('channel-observation').textContent = [
    open
      ? `The contract holds ${formatAmount(state.principal || '0')} µETH of your deposits and ${formatAmount(state.collateral || '0')} µETH of collateral for this balance, at saved sequence ${state.savedSequence || '0'}.`
      : '',
    open && wallet.withdrawalFee
      ? `Locking in pays the casino ${formatAmount(wallet.withdrawalFee)} µETH for sending it.`
      : '',
    closing
      ? BigInt(state.disputedPrize || 0) > 0n
        ? `The close disputes your casino bet at sequence ${state.closingSequence}: the casino has until the deadline to settle it on-chain, or it counts as won and pays ${formatAmount(state.disputedPrize)} µETH. Meanwhile the contract holds ${formatAmount(state.disputeHold || '0')} µETH of house cash for it, which the casino cannot take.`
        : `The close proposes sequence ${state.closingSequence || '0'} where you saved ${state.closingSaved || '0'}, ${formatAmount(state.balanceAtRisk || '0')} µETH less than yours${state.challengePending ? '; a challenge is on its way' : ''}.`
      : '',
    `Last checked ${state.observedAt ? new Date(state.observedAt).toLocaleString() : 'never: refresh before acting'}.`,
  ]
    .filter(Boolean)
    .join(' ');
  $('challenge-deadline').textContent =
    closing && deadline ? `The close can be challenged until ${new Date(deadline * 1000).toLocaleString()}.` : '';
  $<HTMLButtonElement>('channel-export').disabled = !(wallet.channel || wallet.closingChannel) || busy;
  // Locking in moves winnings into the deposits: with all of the balance protected, there is nothing to lock in.
  $<HTMLButtonElement>('channel-lock').disabled =
    !open || !BigInt(state.protection?.uncovered || 0) || !wallet.withdrawalFee || Boolean(wallet.pending) || busy;
  $<HTMLButtonElement>('channel-start-close').disabled =
    Number(state.channelStatus) !== 1 || Boolean(wallet.transactionIntent) || busy;
  $('channel-start-close').textContent =
    wallet.channel?.closing && Number(state.channelStatus) === 1 ? 'Retry close' : 'Close without the casino';
  $('recovery-gas').textContent =
    `Your deposit address holds ${formatAmount(state.nativeBalance || 0)} µETH for network fees. Closing, challenging and finishing need ETH at this address. Starting a close pauses automatic deposits so gas top-ups stay here.${!wallet.autoDeposit ? ' Automatic deposits are paused; turn them back on under Deposits when ready.' : ''}`;
  $<HTMLButtonElement>('channel-challenge').disabled = !state.needsChallenge || Date.now() / 1000 >= deadline || busy;
  $<HTMLButtonElement>('channel-finalize').disabled = !closing || Date.now() / 1000 < deadline || busy;
}
let claimsShown = '';
const claimRecipients = new Map<string, string>();
/** What closed balances are still owed: shown only while something is. */
function renderClaims() {
  const claims = [...(wallet.publicState.claims || [])].filter(
    (claim: any) => BigInt(claim.amount) > BigInt(claim.paid),
  );
  $('claims').classList.toggle('hidden', !claims.length);
  const describe = (claim: any) => {
    const unpaid = BigInt(claim.amount) - BigInt(claim.paid),
      ready = BigInt(claim.collectable || '0');
    return (
      `${claim.channelId ? `Channel ${short(claim.channelId)}` : 'A withdrawal'}, paid ${paidTo(claim.to)}: ${formatAmount(unpaid)} µETH still owed of ${formatAmount(claim.amount)} µETH. ` +
      (ready > 0n
        ? `${formatAmount(ready)} µETH can be collected now.`
        : `Its ${formatAmount(claim.winningsRemaining)} µETH of winnings wait for the bankroll to have the cash.`)
    );
  };
  // The wallet re-renders on every observation. Rebuild the rows only when they differ, so a recipient
  // address being typed keeps its text and focus.
  const disabled = wallet.busy || uiBusy,
    shown = JSON.stringify([claims.map(describe), disabled]);
  if (shown === claimsShown) return;
  claimsShown = shown;
  $('claim-list').replaceChildren(
    ...claims.map((claim: any) => {
      const destination = h('input', {
        placeholder: 'Or another address, 0x…',
        ariaLabel: 'Collect to another address',
        value: claimRecipients.get(claim.id) ?? '',
      });
      destination.oninput = () => claimRecipients.set(claim.id, destination.value);
      const collect = () =>
        task(async () => {
          const before = BigInt(claim.paid);
          await wallet.claim(claim.id);
          // A withdrawal paid in full leaves the list.
          const after = wallet.publicState.claims.find((c: any) => c.id === claim.id);
          const collected = BigInt(after?.paid ?? claim.amount) - before;
          toast(
            collected > 0n
              ? `Collected ${formatAmount(collected)} µETH.`
              : 'Nothing could be paid yet: the bankroll has no cash for these winnings.',
          );
        });
      const redirect = () =>
        task(async () => {
          const recipient = destination.value.trim();
          await wallet.claim(claim.id, recipient);
          toast(`Collected what could be paid to ${short(recipient)}.`);
        });
      const row = h(
        'div',
        { className: 'claim-row' },
        h('p', null, describe(claim)),
        h('button', { type: 'button', className: 'button small', disabled, onclick: collect }, 'Collect'),
        destination,
        h('button', { type: 'button', className: 'text-button', disabled, onclick: redirect }, 'Collect there'),
      );
      // A closed balance's claim rests on its channel's evidence; a withdrawal's is on-chain already.
      const exportEvidence = () => task(async () => downloadEvidence(await wallet.exportEvidence(claim.channelId)));
      if (claim.channelId)
        row.append(
          h('button', { type: 'button', className: 'text-button', onclick: exportEvidence }, 'Export evidence'),
        );
      return row;
    }),
  );
}

function transactionLink(hash: string) {
  if (wallet.expectedChainId !== 11155111n || !/^0x[0-9a-f]{64}$/i.test(hash)) return h('span', null, hash);
  return h(
    'a',
    {
      href: `https://sepolia.etherscan.io/tx/${hash}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'View this transaction on Sepolia Etherscan',
      onclick: event => event.stopPropagation(),
    },
    hash,
  );
}

/** Check now what the wallet's own loop checks every 10 minutes, and the activity's details with it. */
async function refreshWallet() {
  if (historyBusy || !wallet.address || !wallet.reader) return;
  historyBusy = true;
  historyError = null;
  renderWallet();
  try {
    await wallet.check();
    await wallet.refreshDetails();
  } catch (error) {
    historyError = error;
  } finally {
    historyBusy = false;
    renderWallet();
  }
}

/** Files a player picks are read here, so a damaged one says so instead of showing a parser's error. */
async function readJSONFile(file: File, what: string) {
  if (file.size > 24 * 1024 * 1024) throw new Error(`A ${what} is at most 24 MiB.`);
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error(`That file is not a ${what}. Pick the JSON file this wallet wrote.`);
  }
}
/** A game's address, checked before the wallet frames it: HTTP(S) without credentials, and never the wallet's own
 * origin, where a frame could lift its own sandbox and read the wallet's storage. */
function gameURL(value: string) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter the full URL of the game, starting with https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Games must use an HTTP or HTTPS URL without credentials.');
  if (url.origin === location.origin) throw new Error('Games cannot be served from the wallet’s own origin.');
  return url;
}
/** How a game is named in the wallet: the name it is published under, in words. */
const gameTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

/** A game's icon: icon.svg beside its page, over the game's initial, which shows when it has none. */
function gameIcon(url: string, name: string) {
  const image = h('img', { src: new URL('icon.svg', url).href, alt: '', loading: 'lazy', decoding: 'async' });
  image.onerror = () => image.remove();
  const tile = h('span', { className: 'game-icon' }, image);
  tile.dataset.initial = name.charAt(0).toUpperCase();
  return tile;
}

/** Open a game. A published one comes with what its profile records: its key, and its developer, the account that
 * publishes it. A game opened by its URL alone is nobody's: it has the key of that URL, and takes no developer bets. */
async function loadGame(url: string, gameRoute: GameRoute, push = true, published?: Published) {
  const entry = gameURL(url);
  const slug = 'url' in gameRoute ? undefined : gameRoute.name;
  closeGame();
  const frame = h('iframe', { referrerPolicy: 'no-referrer' });
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'",
  );
  const identity: GameIdentity = {
    url: entry.href,
    key: published?.key ?? gameKey({ developer: ZeroAddress, name: entry.href }),
    developer: published?.developer ?? ZeroAddress,
    ...(slug === undefined ? {} : { slug }),
    name: slug === undefined ? entry.host : gameTitle(slug),
  };
  frame.title = `${identity.name}, a sandboxed game`;
  // A game bound to a channel closes with it; a game opened without one adopts the first channel that opens.
  const isCurrent = () =>
    active?.frame === frame && (active.channelId === null || active.channelId === wallet.channelId);
  const path = gamePath(gameRoute);
  await walletStarted;
  wallet.openGame(identity);
  active = {
    channelId: wallet.channelId,
    identity,
    publisher: 'owner' in gameRoute ? gameRoute.owner : null,
    path,
    frame,
    dispose: () => {},
    loaded: false,
  };
  frame.addEventListener('load', () => {
    if (!isCurrent()) return;
    active!.loaded = true;
    // The game's own keys, such as Space to play, work without a click into it first.
    if (!document.querySelector('dialog[open]')) frame.focus();
  });
  active.dispose = attachGameBridge({
    iframe: frame,
    origin: entry.origin,
    isCurrent,
    onRequest: async (method, params) => {
      if (method === 'wallet.hello') return wallet.gameHello();
      // The player is named once the wallet has heard from the casino, and a game finds its saved rounds by that name:
      // after a reload it waits for it.
      if (method === 'wallet.info') {
        await wallet.synced?.catch(() => {});
        const info = await wallet.gameInfo();
        if (isCurrent()) active!.uname = info.uname;
        return info;
      }
      if (method === 'wallet.round') return wallet.gameRound(params.id);
      if (method === 'game.receipt') return wallet.gameReceipt(params.id);
      if (method === 'game.allowance') return wallet.gameAllowance(params.group);
      if (method === 'game.end') {
        wallet.gameEnd(params.group);
        return null;
      }
      // What the player is doing in the wallet comes first; the wallet's own checks finish and the game's request
      // follows.
      if (uiBusy) throw gameError('busy', 'The wallet is processing another operation.');
      await wallet.actionDone;
      if (method === 'game.requestAllowance') {
        const amount = await openAllowanceDialog(
          params.amount === undefined ? undefined : BigInt(params.amount),
          params.developerBets === true,
        );
        if (!isCurrent()) throw gameError('game-closed', 'The game was closed.');
        return { allowed: amount !== null, ...wallet.gameAllowance() };
      }
      if (method === 'game.casinoBet') return wallet.gameCasinoBet(params);
      if (method === 'game.developerBet') return wallet.gameDeveloperBet(params);
      return wallet.gamePayment(params);
    },
    onError: message => toast(message, true),
  });
  frame.src = entry.href;
  // The game's icon stands in for it until its page has loaded.
  const loading = h(
    'div',
    { className: 'game-loading' },
    gameIcon(entry.href, identity.name),
    h('p', null, `Loading ${identity.name}…`),
  );
  frame.addEventListener('load', () => loading.remove(), { once: true });
  $('frame-slot').replaceChildren(loading, frame);
  $('game-title').replaceChildren(
    gameIcon(entry.href, identity.name),
    h('strong', null, identity.name),
    ...(active.publisher ? [h('span', { className: 'handle' }, active.publisher)] : []),
  );
  $('game-my-bets').textContent = `Your bets in ${identity.name}`;
  $('game-all-bets').textContent = `Everyone's bets in ${identity.name}`;
  $<HTMLAnchorElement>('game-all-bets').href = `/games/${identity.key.toLowerCase()}`;
  showPage('play');
  if (push && location.pathname + location.search !== path) history.pushState(null, '', path);
  renderGameAccount();
}

for (const link of document.querySelectorAll<HTMLElement>('[data-page]'))
  link.addEventListener('click', event => {
    event.preventDefault();
    $('account-menu').hidePopover?.();
    navigate(link.dataset.page!);
  });
/** One card for a published game: its icon and the name it is published under. */
function gameCard(route: { owner: string; name: string }, game: Published & { name: string; url: string }) {
  const name = gameTitle(game.name),
    key = game.key.toLowerCase();
  // A bet's receipt names its game only by this key, so remembering the card is what lets a line of
  // history be opened again, and its public record found.
  knownGames.set(key, { route, ...game, name });
  return h(
    'a',
    {
      className: 'game-card',
      href: gamePath(route),
      onclick: event => {
        event.preventDefault();
        task(() => loadGame(game.url, route, true, game));
      },
    },
    gameIcon(game.url, name),
    h('h3', null, name),
    h('span', { className: 'catalog-link' }, `${route.owner}/${route.name}`),
  );
}
/** Every game a profile publishes, as cards. */
const profileCards = (owner: string, games: (Published & { name: string; url: string })[]) =>
  games.map(game => gameCard({ owner, name: game.name }, game));
/** The lobby is what `@hookedin` publishes, and whatever this account publishes itself. It needs nothing of the
 * wallet but the casino's address, so it shows before the wallet has started. */
async function loadLibrary() {
  const list = $('game-library');
  try {
    const house = await wallet.api(`/api/players/@${HOUSE}`);
    const mine = wallet.discordUsername === HOUSE ? [] : (wallet.profile?.games ?? []);
    list.replaceChildren(...profileCards('@' + HOUSE, house.games), ...profileCards(showName(wallet.profile), mine));
  } catch {
    list.textContent = 'The games could not be loaded. You can still open a game by its URL below.';
  }
  list.setAttribute('aria-busy', 'false');
}
/** The page at a player's name: the name, and their profile once the casino answers, or `missing` when nobody goes by
 * it. */
let shown: { name: string; profile: any; missing: boolean } | null = null;
/** The code Settings shows to run /verify with in the HookedIn Discord, while it lasts. */
let verifying: { code: string; expires: number } | null = null;
/** Ask the casino every few seconds, while the code lasts, whether its member ran /verify with it: the account then goes
 * by their Discord username. */
async function watchVerify(code: { code: string; expires: number }, before: number | null) {
  while (verifying === code && Date.now() < code.expires) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const profile = await wallet.refreshOwnProfile().catch(() => null);
    if (verifying === code && profile?.discordUsername && profile.discordVerified !== before) {
      toast(`You go by @${profile.discordUsername} now.`);
      break;
    }
  }
  if (verifying === code) verifying = null;
  renderWallet();
}
/** Whether the page shown is this account's own. */
const ownPage = () =>
  Boolean(wallet.uname) &&
  (shown?.profile?.uname === wallet.uname || (Boolean(shown?.missing) && shown?.name === `~${wallet.uname}`));
const shortDate = (time: number) =>
  new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
/** Anybody's page: their names, what they have played, and the games they publish. */
async function openProfile(name: string, push = true) {
  const page: typeof shown = { name, profile: null, missing: false };
  shown = page;
  $('profile-name').textContent = name;
  $('profile-meta').textContent = '';
  $('profile-stats').textContent = 'Loading…';
  $('profile-games-heading').classList.add('hidden');
  $('profile-games').replaceChildren();
  navigate('profile', push, `/${name}`);
  try {
    const profile = await wallet.api(`/api/players/${name}`);
    if (shown !== page) return;
    drawProfile((page.profile = profile));
  } catch (error: any) {
    if (shown !== page) return;
    page.missing = error.code === 'not-found';
    $('profile-meta').textContent = page.missing ? 'Nobody goes by that name.' : error.message;
    $('profile-stats').textContent = '';
  }
  renderWallet();
}
/** A player's profile, as anybody sees it. One with no `since` is your own before the casino has met you. */
function drawProfile(profile: any) {
  const name = showName(profile);
  document.title = `${name} · HookedIn`;
  $('profile-name').textContent = name;
  // The uname a Discord username covers up, when they last verified it, and when the casino met them.
  const meta = profile.discordUsername ? ['~' + profile.uname] : [];
  if (profile.discordVerified) meta.push(`Verified on Discord ${shortDate(profile.discordVerified)}`);
  meta.push(
    profile.since
      ? `Joined ${shortDate(profile.since)}`
      : 'Others see your page from your first deposit, or once you verify your Discord account.',
  );
  $('profile-meta').textContent = meta.join(' · ');
  const plays = profile.stats.plays,
    net = BigInt(profile.stats.net);
  $('profile-stats').replaceChildren(
    ...(plays
      ? [
          h('strong', null, String(plays)),
          plays === 1 ? ' bet · ' : ' bets · ',
          h('strong', { className: net < 0n ? 'negative' : net > 0n ? 'positive' : '' }, signedAmount(net)),
          ' net',
        ]
      : ['No bets yet.']),
  );
  $('profile-game-total').textContent = String(profile.games.length);
  $('profile-games-heading').classList.toggle('hidden', !profile.games.length);
  $('profile-games').replaceChildren(...profileCards(name, profile.games));
}
/** The lobby is loaded again whenever what this account publishes changes. */
let libraryKey = '';
/** The account the saved-accounts list was last set to, so a render only moves it when that changes. */
let shownAccount: string | null = null;
/** The account's own names, in the top bar, its menu and its own page, and the games it publishes. */
function renderProfile() {
  const name = wallet.uname ? showName(wallet) : null,
    open = wallet.playable && !wallet.recoveryOnly,
    // A name is the account's from the start, and so is its page: others see it once the casino has met the account.
    page = name ? `/${name}` : null;
  $('account-name').textContent = name ?? 'Account';
  $('menu-name').textContent = name ?? 'Your account';
  // The uname is always there; when a Discord username covers it up, it is shown underneath.
  const uname = wallet.discordUsername && wallet.uname ? '~' + wallet.uname : '';
  $('menu-uname').textContent = uname;
  if (page) $<HTMLAnchorElement>('menu-profile').href = page;
  else $('menu-profile').removeAttribute('href');
  // Your own page: the way to your name, and before the casino has met you, the page itself.
  if (shown?.missing && ownPage()) {
    shown.missing = false;
    drawProfile(
      (shown.profile = {
        uname: wallet.uname,
        discordUsername: null,
        discordVerified: null,
        since: null,
        stats: { plays: 0, net: '0' },
        games: [],
      }),
    );
  }
  $<HTMLButtonElement>('publish-game').disabled = uiBusy || !open;
  for (const id of ['bank-deposit', 'bank-withdraw'])
    $<HTMLButtonElement>(id).disabled = uiBusy || !wallet.playable || Boolean(wallet.pending);
  // Your own page, while it shows, follows the name /verify gives you, or unlinking takes away.
  const own = wallet.profile;
  if (
    own &&
    ownPage() &&
    !$('page-profile').classList.contains('hidden') &&
    (shown!.profile.discordUsername !== own.discordUsername || shown!.profile.discordVerified !== own.discordVerified)
  )
    drawProfile((shown!.profile = own));
  // Your own page: how to go by your Discord username. A member of the HookedIn Discord gives it to the account by
  // running /verify there with a code the casino gives here.
  const discord = wallet.config?.discord ?? null,
    verified = Boolean(wallet.discordUsername),
    when = wallet.profile?.discordVerified;
  $('discord').hidden = !ownPage() || !discord || wallet.discordUsername === HOUSE;
  if (discord) $<HTMLAnchorElement>('open-discord').href = discord;
  $('discord-text').textContent = verifying
    ? 'Discord tells the casino your username as you run /verify, and at no other time.'
    : verified
      ? `You go by your Discord username, @${wallet.discordUsername}${when ? `, verified ${shortDate(when)}` : ''}. Discord tells the casino your username only as you run /verify: verify again after you change it there.`
      : `Go by your Discord username here instead of your uname, ~${wallet.uname}. It takes no deposit.`;
  $('discord-steps').hidden = verified && !verifying;
  $('verify').hidden = !verifying;
  if (verifying) $('verify-code').textContent = verifying.code;
  $('verify-discord').textContent = verified ? 'Verify again' : 'Verify with Discord';
  $('verify-discord').classList.toggle('primary', !verified);
  $('verify-discord').classList.toggle('hidden', Boolean(verifying));
  $<HTMLButtonElement>('verify-discord').disabled = uiBusy || !wallet.uname;
  $('unlink-discord').classList.toggle('hidden', !verified || Boolean(verifying));
  $<HTMLButtonElement>('unlink-discord').disabled = uiBusy;
  const games = wallet.profile?.games ?? [];
  $('profile-game-count').textContent = `${games.length}/${MAX_GAMES}`;
  const key = json([name, games]);
  if (libraryKey && libraryKey !== key) void loadLibrary();
  libraryKey = key;
  $('my-games').replaceChildren(
    ...games.map(game =>
      h(
        'div',
        { className: 'game-row' },
        h('span', null, `${name}/${game.name} · ${game.url}`),
        h(
          'button',
          {
            type: 'button',
            className: 'text-button',
            title: `Take ${name}/${game.name} out of the lobby`,
            disabled: uiBusy,
            onclick: () =>
              task(async () => {
                await wallet.publishGame(game.name, null);
                await loadLibrary();
                toast(`${name}/${game.name} is taken down.`);
              }),
          },
          'Take down',
        ),
      ),
    ),
  );
}
/** This account's bank as a developer, as the casino has it now. */
async function refreshBank() {
  if (!wallet.channel?.registered) return void ($('bank-balance').textContent = '—');
  const { balance } = await wallet.bankBalance();
  $('bank-balance').textContent = `${formatAmount(balance, 0)} µETH`;
  $('bank-balance').title = `${exact(balance)} µETH`;
}

// --- What you play, and what it paid ---------------------------------------------------------

/** Games this wallet can reopen, by their key: whatever the lobby showed.
 * A bet's receipt carries only the game's key and the name it went by, so this is what turns a
 * line of history back into something to play. */
const knownGames = new Map<string, Published & { route: GameRoute; url: string; name: string }>();
const favouriteSetting = `hookedin:${network}:favourite-games`;
function favourites(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(favouriteSetting) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((key: unknown) => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}
/** A favourite is this browser's own note about a game. It is never signed and never leaves here. */
function toggleFavourite(key: string) {
  const saved = favourites();
  if (!saved.delete(key)) saved.add(key);
  localStorage.setItem(favouriteSetting, JSON.stringify([...saved]));
  renderMyGames();
}
/** Every settled bet this wallet signed, and every payment a game's round made beside its bets. A rejected request
 * never became a bet, so it stays in Activity; only a bet whose odds the wallet recorded can say what it was worth, and
 * a payment pays nothing back. */
function ownBets(): BetRow[] {
  return wallet.history
    .filter(
      (receipt: any) =>
        receipt.status === 'signed' &&
        ((receipt.kind === 'casino-bet' && receipt.expectedPayout !== undefined) ||
          // A developer bet is one once what it was paid is collected.
          (receipt.kind === 'developer-bet' && receipt.payout !== undefined) ||
          // A round pays the house what cashing out leaves of what its bet paid, so the round comes to what it showed.
          (receipt.kind === 'payment' && receipt.details?.group)),
    )
    .map((receipt: any) => ({
      at: Date.parse(receipt.createdAt),
      game: receipt.game?.name || 'Unnamed game',
      key: receipt.game?.key ?? null,
      ...(receipt.details?.group ? { group: receipt.details.group } : {}),
      stake: BigInt(receipt.stake),
      payout: BigInt(receipt.payout ?? 0),
      expected:
        receipt.kind === 'payment' ? 0n : receipt.expectedPayout === undefined ? null : BigInt(receipt.expectedPayout),
      maxPayout: receipt.maxPayout === undefined ? null : BigInt(receipt.maxPayout),
      operation: receipt.operationId,
      receipt,
    }));
}
/** One bet in full: the odds it rode, where its round landed, and the preimages that fixed
 * it. Everything shown comes out of the receipt this wallet kept. */
function showBet(row: BetRow) {
  $('bet-detail-eyebrow').textContent = 'One bet';
  $('bet-detail-title').textContent = row.game;
  $('bet-detail').replaceChildren(
    betDetail(row, opened => {
      $<HTMLDialogElement>('bet-dialog').close();
      if (opened.key) void openGameRecord(opened.key);
    }),
  );
  $('bet-dialog').scrollTop = 0;
  // A bet opened from its group's list replaces the list in the dialog already open.
  showSheet($<HTMLDialogElement>('bet-dialog'));
}
/** A list is rebuilt only when what it shows has changed. The wallet renders on every poll, and a
 * row replaced under the player's cursor takes their click with it. */
const betSignature = (rows: readonly BetRow[], extra = '') =>
  extra + rows.map(row => `${row.operation}:${row.payout}`).join(',');
let shownBets = '\u0000',
  shownPlayed = '\u0000';
const NO_BETS = 'No bets yet. Play a game with ETH, and your bets show here.';
/** The game the bets page shows, by its key, as `/bets?game=<key>` names it; every game when empty. */
let betGame = '';
const betsPath = () => (betGame ? `/bets?game=${betGame}` : '/bets');
function renderBets() {
  const rows = ownBets();
  $<HTMLButtonElement>('refresh-bets').disabled = historyBusy || !wallet.address;
  // A game to choose for every game played, and the one asked for even before it has a bet.
  const games = new Map(rows.flatMap(row => (row.key ? [[row.key.toLowerCase(), row.game] as const] : [])));
  if (betGame && !games.has(betGame)) games.set(betGame, knownGames.get(betGame)?.name ?? 'This game');
  const select = $<HTMLSelectElement>('bet-game'),
    options = [['', 'All games'], ...[...games].sort((a, b) => a[1].localeCompare(b[1]))];
  if (json(options) !== json([...select.options].map(option => [option.value, option.text])))
    select.replaceChildren(...options.map(([key, name]) => new Option(name, key)));
  select.value = betGame;
  const signature = betSignature(rows);
  if (signature !== shownBets) {
    shownBets = signature;
    $('bet-list').replaceChildren(...betElements(rows, showBet));
  }
  filterList('bet');
}
/** A list of bets, the ones a game grouped standing together as one row, each knowing its game. */
function betElements(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  return groupRows(rows).map(group => {
    const element =
      group.length === 1 ? betRowElement(group[0]!, onOpen) : groupRowElement(group, bets => showGroup(bets, onOpen));
    element.dataset.game = group[0]!.key?.toLowerCase() ?? '';
    return element;
  });
}
/** The bets of one group, each opening in full where this wallet kept its receipt. */
function showGroup(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  const last = rows.at(-1)!,
    net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n);
  $('bet-detail-eyebrow').textContent = `One round, ${rows.length} bets`;
  $('bet-detail-title').textContent = last.game;
  // The round first, as the player played it; then its bets, each staking what the last one paid.
  $('bet-detail').replaceChildren(
    h(
      'p',
      { className: 'bet-round-summary', title: `Group ${last.group}` },
      `You put in ${formatAmount(putIn(rows))} µETH and ${net < 0n ? 'lost' : net > 0n ? 'won' : 'broke even'}${net ? ` ${formatAmount(net < 0n ? -net : net)} µETH` : ''}. Each bet below stakes what the bet before it paid.`,
    ),
    h('div', { className: 'bet-table' }, ...rows.map(row => betRowElement(row, onOpen))),
  );
  $('bet-dialog').scrollTop = 0;
  showSheet($<HTMLDialogElement>('bet-dialog'));
}
/** Show the rows of a list, of bets or events, that hold every word typed in its search, and count them. */
function filterList(name: 'activity' | 'bet' | 'gamebets') {
  const terms = $<HTMLInputElement>(`${name}-search`).value.trim().toLowerCase().split(/\s+/).filter(Boolean),
    events = name === 'activity',
    game = name === 'bet' ? betGame : '';
  let visible = 0,
    total = 0;
  for (const row of $(`${name}-list`).children as HTMLCollectionOf<HTMLElement>) {
    const text = `${row.textContent} ${row.dataset.search ?? ''}`.toLowerCase(),
      matches = (!game || row.dataset.game === game) && terms.every(term => text.includes(term));
    // A round's row counts once, as the player played it.
    row.classList.toggle('hidden', !matches);
    total++;
    if (matches) visible++;
  }
  $(`${name}-visible-count`).textContent =
    `${terms.length || game ? `${visible} / ` : ''}${total} ${events ? 'event' : 'bet'}${total === 1 ? '' : 's'}`;
  const empty = $(`${name}-empty`);
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? events
      ? 'No matching events. Try a method, amount, operation ID or transaction hash.'
      : 'No bet matches that. Try a game, an amount, a bet number or an operation ID.'
    : events
      ? 'No activity yet. Events will appear here as you use the wallet and games.'
      : game
        ? 'No bets in this game yet.'
        : name === 'bet'
          ? NO_BETS
          : 'Nobody has placed a bet in this game yet.';
}
/** One line per game: what this wallet staked in it, what came back, and what its bets were worth. */
function renderMyGames() {
  const all = ownBets(),
    starred = favourites(),
    played = new Map<string, { key: string | null; name: string; last: number; rows: BetRow[] }>();
  const signature = betSignature(all, [...starred].sort().join(',') + '|' + knownGames.size + '|');
  if (signature === shownPlayed) return;
  shownPlayed = signature;
  for (const row of all) {
    const id = row.key || `name:${row.game}`,
      entry = played.get(id) ?? { key: row.key ?? null, name: row.game, last: row.at, rows: [] };
    entry.rows.push(row);
    entry.last = Math.max(entry.last, row.at);
    played.set(id, entry);
  }
  const staked = (rows: BetRow[]) => rows.reduce((sum, row) => sum + row.stake, 0n);
  const list = [...played.values()].sort((a, b) => {
    const star = Number(starred.has(b.key || '')) - Number(starred.has(a.key || ''));
    if (star) return star;
    const difference = staked(b.rows) - staked(a.rows);
    return difference > 0n ? 1 : difference < 0n ? -1 : b.last - a.last;
  });
  $('played-count').textContent = String(list.length);
  $('games-totals').replaceChildren(...totalCards(betTotals(all)));
  $('played-games').replaceChildren(
    ...list.map(({ key, name, last, rows }) => {
      const favourite = key !== null && starred.has(key),
        totals = betTotals(rows),
        expected = measuredReturn(totals.priced, totals.expected),
        known = key ? knownGames.get(key) : undefined;
      const figures: [string, string, string?][] = [
        ['Bets', String(totals.bets)],
        ['Put in', `${formatAmount(totals.putIn)} µETH`],
        ['Paid back', `${formatAmount(totals.putIn + totals.net)} µETH`],
        ['Your result', signedAmount(totals.net), totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : ''],
        ['Return of your bets', expected === null ? '—' : percent(expected)],
      ];
      return h(
        'div',
        { className: 'played-game' },
        h(
          'div',
          { className: 'played-heading' },
          h(
            'button',
            {
              type: 'button',
              className: 'played-star',
              disabled: !key,
              ariaPressed: String(favourite),
              title: !key
                ? 'This game has no key on its bets, so it cannot be starred.'
                : favourite
                  ? `Take ${name} out of your favourites`
                  : `Keep ${name} at the top`,
              onclick: () => key && toggleFavourite(key),
            },
            favourite ? '★' : '☆',
          ),
          h('h3', null, name),
          h('span', { className: 'played-when' }, `Last played ${new Date(last).toLocaleDateString()}`),
        ),
        h(
          'dl',
          { className: 'played-figures' },
          ...figures.flatMap(([label, value, className]) => [
            h('dt', null, label),
            h('dd', { className: className ?? '' }, value),
          ]),
        ),
        h(
          'div',
          { className: 'played-actions' },
          ...(known
            ? [
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'button small primary',
                    onclick: () => task(() => loadGame(known.url, known.route, true, known)),
                  },
                  'Play',
                ),
              ]
            : []),
          ...(key
            ? [
                h(
                  'button',
                  { type: 'button', className: 'button small', onclick: () => void openGameRecord(key) },
                  'Every bet in it ↗',
                ),
              ]
            : []),
        ),
      );
    }),
  );
  $('played-empty').classList.toggle('hidden', list.length !== 0);
}
/** A game's public record: every bet anyone has placed in it, straight from the casino. */
async function openGameRecord(key: string, push = true) {
  const known = knownGames.get(key),
    mine = ownBets().find(row => row.key === key),
    path = `/games/${key.toLowerCase()}`;
  const name = known?.name || mine?.game || 'This game';
  $('gamebets-name').textContent = name;
  $('gamebets-key').textContent = key;
  $('gamebets-list').replaceChildren();
  $('gamebets-totals').replaceChildren();
  $('gamebets-developer-bets').classList.add('hidden');
  $('gamebets-empty').classList.add('hidden');
  $<HTMLInputElement>('gamebets-search').value = '';
  navigate('gamebets', push, path);
  document.title = `${name} · HookedIn`;
  const play = $<HTMLButtonElement>('gamebets-play');
  play.classList.toggle('hidden', !known);
  play.onclick = known ? () => task(() => loadGame(known.url, known.route, true, known)) : null;
  try {
    const record = await wallet.api(`/api/games/${key}?limit=200`);
    if (location.pathname !== path) return;
    const rows: BetRow[] = record.bets.map((bet: any) => {
      const who = bet.discordUsername ? '@' + bet.discordUsername : bet.uname ? '~' + bet.uname : 'a player';
      return {
        at: Number(bet.at),
        game: name,
        // A developer's casino bet from its bank is listed beside its players' bets, and counted in no total.
        who: bet.kind === 'bank' ? `${who}'s bank` : who,
        ...(bet.group === undefined ? {} : { group: bet.group }),
        stake: BigInt(bet.stake),
        payout: BigInt(bet.payout),
        expected: bet.chance === undefined ? null : BigInt(bet.prize) * BigInt(bet.chance),
        maxPayout: bet.prize === undefined ? null : BigInt(bet.prize),
        index: Number(bet.index),
      };
    });
    const totals = record.totals;
    $('gamebets-totals').replaceChildren(
      ...totalCards({
        bets: Number(totals.bets),
        staked: BigInt(totals.staked),
        paid: BigInt(totals.paid),
        expected: BigInt(totals.expected),
        priced: BigInt(totals.priced),
        net: BigInt(totals.paid) - BigInt(totals.staked),
      }),
    );
    // How the game's developer bets stand: a developer that leaves bets unsettled shows here.
    const developerBets: { open: number; settled: number } = record.developerBets;
    if (developerBets.open + developerBets.settled) {
      $('gamebets-developer-bets').textContent =
        `Developer bets: ${developerBets.open} open, and ${developerBets.settled} its developer settled.`;
      $('gamebets-developer-bets').classList.remove('hidden');
    }
    $('gamebets-list').replaceChildren(...betElements(rows));
    filterList('gamebets');
  } catch (error: any) {
    $('gamebets-empty').classList.remove('hidden');
    $('gamebets-empty').textContent =
      error.code === 'not-found'
        ? 'The casino holds no record under that name.'
        : `The casino did not answer for this game. ${error.shortMessage || error.message}`;
  }
}
window.addEventListener('popstate', () => void route(false));
for (const name of ['activity', 'bet', 'gamebets'] as const)
  $(`${name}-search`).addEventListener('input', () => filterList(name));
$<HTMLSelectElement>('bet-game').addEventListener('change', () => {
  betGame = $<HTMLSelectElement>('bet-game').value;
  history.replaceState(null, '', betsPath());
  filterList('bet');
});
/** The open game's own bets, over it, so the game plays on; and everyone's, on its public record. */
$('game-my-bets').addEventListener('click', () => {
  $('game-menu').hidePopover();
  if (!active) return;
  const { key, name } = active.identity,
    rows = ownBets().filter(row => row.key?.toLowerCase() === key.toLowerCase());
  $('bet-detail-eyebrow').textContent = 'Your bets';
  $('bet-detail-title').textContent = name;
  $('bet-detail').replaceChildren(
    rows.length
      ? h('div', { className: 'bet-table' }, ...betElements(rows, showBet))
      : h('p', { className: 'empty' }, `No bets in ${name} yet.`),
  );
  $('bet-dialog').scrollTop = 0;
  showSheet($<HTMLDialogElement>('bet-dialog'));
});
$('game-all-bets').addEventListener('click', event => {
  event.preventDefault();
  $('game-menu').hidePopover();
  if (active) void openGameRecord(active.identity.key.toLowerCase());
});
for (const id of ['refresh-bets', 'refresh-wallet']) $(id).addEventListener('click', () => void refreshWallet());
$<HTMLFormElement>('custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $<HTMLInputElement>('custom-url').value.trim();
  task(() => loadGame(url, { url }));
});
act('setup-wallet', async () => {
  await wallet.setupDemo();
  funded('Demo ETH added: games play with ETH.');
});
$<HTMLFormElement>('allowance-form').addEventListener('submit', event => {
  event.preventDefault();
  void task(async () => {
    if (!active) return;
    const amount = typedWhole($<HTMLInputElement>('allowance-amount').value || '0');
    if (amount === null) throw new Error('Enter a whole number of µETH.');
    // An allowance is held against other tabs.
    await holdGameAllowance();
    await wallet.setGameAllowance(String(amount), allowingDeveloperBets);
    toast(
      amount
        ? `${active.identity.name} may play with up to ${formatAmount(amount, 0)} µETH${allowingDeveloperBets ? ', developer bets included' : ''}.`
        : `${active.identity.name} may play with nothing.`,
    );
    $<HTMLDialogElement>('allowance-dialog').close(String(amount));
  });
});
$<HTMLDialogElement>('allowance-dialog').addEventListener('close', () => {
  const dialog = $<HTMLDialogElement>('allowance-dialog'),
    value = dialog.returnValue;
  dialog.returnValue = '';
  // The close is heard a moment after it: a game's request can have opened the dialog again by then, and this close
  // belongs to the request before.
  if (dialog.open) return;
  const request = allowanceRequest;
  allowanceRequest = null;
  request?.resolve(value ? BigInt(value) : null);
});
$<HTMLButtonElement>('bet-detail-close').addEventListener('click', () => $<HTMLDialogElement>('bet-dialog').close());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-allowance-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('allowance-dialog').close(''));
$<HTMLButtonElement>('allowance-deposit').addEventListener('click', () => {
  $<HTMLDialogElement>('allowance-dialog').close('');
  openWallet('deposit');
});
for (const id of ['wallet-button', 'hero-deposit']) $(id).addEventListener('click', () => openWallet('deposit'));
$('game-allowance').addEventListener('click', () => void openAllowanceDialog());
for (const link of document.querySelectorAll<HTMLElement>('[data-wallet-tab]'))
  link.addEventListener('click', event => {
    event.preventDefault();
    openWallet(link.dataset.walletTab as WalletTab);
  });
for (const button of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-tab]'))
  button.addEventListener('click', () => showWallet(button.dataset.tab as WalletTab));
$('wallet-dialog')
  .querySelector('[data-close]')!
  .addEventListener('click', () => $<HTMLDialogElement>('wallet-dialog').close());
// The player closed the wallet, where a route did not: the page it opened over comes back, as Back brings it, or the
// lobby, under a wallet opened by its link.
$('wallet-dialog').addEventListener('close', () => {
  $('wallet-reason').hidden = true;
  wallet.showDeposit(false);
  if (!walletRoute()) return;
  if (history.state?.over) history.back();
  else {
    history.replaceState(null, '', '/');
    void route();
  }
});
$<HTMLInputElement>('allowance-slider').addEventListener('input', () => {
  $<HTMLInputElement>('allowance-amount').value = String(
    sliderAmount(allowable(), $<HTMLInputElement>('allowance-slider').value) / MICRO_ETH,
  );
  renderAllowanceDialog();
});
$<HTMLInputElement>('allowance-amount').addEventListener('input', renderAllowanceDialog);
$<HTMLButtonElement>('allowance-take-all').addEventListener('click', () => {
  $<HTMLInputElement>('allowance-amount').value = '0';
  renderAllowanceDialog();
});
function downloadEvidence(report: any) {
  download(`hookedin-channel-${report.opening.channelId}.json`, json(report));
  const { state } = verifyEvidence(report);
  toast(`Exported the recovery bundle of channel ${short(state.channelId)}, sequence ${state.sequence}.`);
}
act('export-evidence', async () => downloadEvidence(await wallet.exportEvidence()));
for (const id of ['start-close', 'channel-start-close'])
  act(id, () => wallet.startClose(), 'Close started. It can be challenged for 7 days; keep watching until it is done.');
act('recover-wallet', () => wallet.recover(), 'The saved operation is finished. Reopen its game to carry on.');
act(
  'speed-up-transaction',
  () => wallet.speedUpTransaction(),
  'Sent again with a higher fee. Retry to check for confirmation.',
);
$<HTMLInputElement>('auto-deposit').addEventListener('change', () => {
  // Read before the task renders the page again from the wallet, which still has the old setting.
  const on = $<HTMLInputElement>('auto-deposit').checked;
  void task(async () => {
    await wallet.setAutoDeposit(on);
    toast(
      on ? 'ETH that arrives goes into your balance by itself.' : 'ETH that arrives stays at your deposit address.',
    );
  });
});
act('estimate-deposit-fee', () => wallet.depositable());
act('add-to-balance', async () => {
  const before = BigInt(wallet.publicState.balance || 0);
  await wallet.deposit();
  funded(`Added ${formatAmount(BigInt(wallet.publicState.balance || 0) - before)} µETH to your balance.`);
});
for (const id of [
  'withdraw-to',
  'withdraw-amount',
  'transfer-to',
  'transfer-amount',
  'address-send-to',
  'collateral-buy-amount',
])
  $<HTMLInputElement>(id).addEventListener('input', () => renderWallet());
// Switching Withdraw's unit keeps the amount typed, written in the other unit.
$<HTMLSelectElement>('withdraw-unit').addEventListener('change', () => {
  const input = $<HTMLInputElement>('withdraw-amount'),
    unit = sendUnit('withdraw'),
    wei = typedIn(input.value, unit === 'ETH' ? 'µETH' : 'ETH');
  if (wei !== null) input.value = inUnit(wei, unit, true);
  renderWallet();
});
for (const send of ['withdraw', 'transfer'] as const) {
  $<HTMLButtonElement>(`${send}-max`).addEventListener('click', () => {
    $<HTMLInputElement>(`${send}-amount`).value = inUnit(wallet.withdrawable(), sendUnit(send), true);
    renderWallet();
  });
  act(send, async () => {
    const { to, amount, error } = sendRequest(send);
    if (error || !to || amount === null) throw new Error(error || 'Enter a destination address.');
    // Money partly out leaves the open game its allowance; all of it takes back what the game holds.
    if (amount >= wallet.withdrawable()) abandonGame();
    const receipt = await wallet.withdraw(to, amount, { into: send === 'transfer' });
    $<HTMLInputElement>(`${send}-to`).value = '';
    $<HTMLInputElement>(`${send}-amount`).value = '';
    $<HTMLDialogElement>('wallet-dialog').close();
    toast(
      send === 'transfer'
        ? `Transferred ${exact(receipt.amount)} µETH: the contract puts it into the HookedIn balance of ${short(to)}.`
        : `Withdrew ${exact(receipt.amount)} µETH: the contract pays it to ${short(to)}, and Activity shows when it has.`,
    );
  });
}
act('address-send', async () => {
  const { to, error } = addressSendRequest();
  if (error || !to) throw new Error(error || 'Enter a destination address.');
  const receipt = await wallet.withdrawAddress(to);
  $<HTMLInputElement>('address-send-to').value = '';
  toast(`Sent ${exact(receipt.amount)} µETH to ${short(to)}. Activity shows the transaction and its fee.`);
});
act('buy-collateral', async () => {
  const amount = positiveAmount($<HTMLInputElement>('collateral-buy-amount').value.trim());
  if (!amount) throw new Error('Enter how much collateral to buy.');
  const bought = await wallet.buyCollateral(amount);
  $<HTMLInputElement>('collateral-buy-amount').value = '';
  toast(
    bought
      ? `Bought ${formatAmount(amount)} µETH of collateral: the contract holds it for your balance.`
      : 'Send its price to your deposit address: the wallet buys the collateral as soon as it arrives.',
  );
});
act('invest', async () => {
  const amount = typedAmount($<HTMLInputElement>('invest-amount').value.trim());
  if (wallet.pending) throw new Error('Finish the operation in flight before buying shares.');
  const receipt = await wallet.invest(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this investment.');
  toast(`Bought ${exact(receipt.shares)} shares for ${exact(amount)} µETH.`);
  await refreshFund();
});
$<HTMLButtonElement>('divest-all').addEventListener('click', () => {
  if (fundStatus) $<HTMLInputElement>('divest-amount').value = exactAmount(fundStatus.value);
});
act('divest', async () => {
  const status = await wallet.fundStatus(),
    held = BigInt(wallet.fund.shares),
    wanted = typedAmount($<HTMLInputElement>('divest-amount').value.trim());
  if (wanted <= 0n || BigInt(status.equity) <= 0n) throw new Error('Enter what the shares you sell should be worth.');
  // Shares worth the amount asked for at the stated price; everything, when that is all of them.
  const shares = wanted >= BigInt(status.value) ? held : (wanted * BigInt(status.totalShares)) / BigInt(status.equity);
  if (!shares) throw new Error('That is less than one share.');
  const receipt = await wallet.redeem(shares);
  toast(`Sold ${exact(shares)} shares for ${exact(receipt.amount)} µETH. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshFund();
});
// The open balance's bundle, and the bundle of any channel still closing beside it.
act('channel-export', async () => {
  for (const channelId of new Set([wallet.channelId, wallet.closingChannel?.state.channelId]))
    if (channelId) downloadEvidence(await wallet.exportEvidence(channelId));
});
/** Whether the browser keeps the wallet's data or may clear it to free disk space; `ask` asks it to keep it. */
async function renderStorage(ask: boolean) {
  const kept = Boolean(await (ask ? navigator.storage?.persist?.() : navigator.storage?.persisted?.()));
  $('keep-storage').hidden = kept;
  $('storage-status').textContent = kept
    ? "This browser keeps the wallet's data."
    : ask
      ? "This browser declined to keep the wallet's data, so a full disk can erase your evidence with it. Your recovery bundle is the copy that lasts: export it after you play or withdraw."
      : "This browser may clear the wallet's data, your evidence with it, to free disk space.";
}
void renderStorage(false);
$('keep-storage').addEventListener('click', () => void renderStorage(true));
act(
  'channel-lock',
  async () => {
    // All of the balance goes out and back in: the open game gives back what it holds.
    closeGame();
    await wallet.lockIn();
  },
  'Locking in: your balance, less the fee for sending it and what the casino lent you, goes into deposits the contract holds, in one transaction the casino sends.',
);
for (const id of ['channel-challenge', 'challenge-now'])
  act(id, () => wallet.challengeClose(), 'Your latest saved balance is submitted.');
act(
  'channel-finalize',
  async () => {
    await wallet.finalizeClose();
    // What the close is owed waits in the wallet, to collect.
    showWallet('deposit');
  },
  'The close is done. Collect what it is owed under Waiting to be paid.',
);
$<HTMLInputElement>('channel-import').addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file)
    void task(async () => {
      closeGame();
      await wallet.importEvidence(await readJSONFile(file, 'recovery bundle'));
      toast('Recovery bundle checked and imported.');
    });
});
$<HTMLButtonElement>('copy-address').addEventListener('click', async () => {
  if (!wallet.address || wallet.publicState.address !== wallet.address) return;
  try {
    await navigator.clipboard.writeText(wallet.address);
    toast(`Address copied. Send ETH on ${wallet.networkName}.`);
  } catch {
    const selection = window.getSelection(),
      range = document.createRange();
    range.selectNodeContents($('wallet-address'));
    selection?.removeAllRanges();
    selection?.addRange(range);
    toast('Your address is selected. Copy it with your browser’s copy command.');
  }
});
act('export-key', async () => {
  const field = $<HTMLTextAreaElement>('exported-key');
  const hiding = !field.classList.contains('hidden');
  if (!hiding) {
    if (!confirm('Show this wallet’s private key? Anyone who sees it can take everything this wallet holds.')) return;
  }
  field.classList.toggle('hidden', hiding);
  field.value = hiding ? '' : wallet.exportKey();
  $<HTMLButtonElement>('export-key').textContent = hiding
    ? "Show this wallet's private key"
    : "Hide this wallet's private key";
});
act(
  'import-wallet',
  async () => {
    closeGame();
    await wallet.importKey($<HTMLInputElement>('import-key').value);
    $<HTMLInputElement>('import-key').value = '';
    markSaved();
  },
  'Account imported.',
);
act(
  'select-saved-wallet',
  async () => {
    closeGame();
    await wallet.selectSavedAccount($<HTMLSelectElement>('saved-wallets').value);
  },
  'Switched account.',
);
/** Delete everything the wallet keeps in this browser, in every tab, and load it again, which opens a new account. */
act('start-over', async () => {
  const accounts = wallet.savedAddresses?.length ?? 0,
    held = BigInt(wallet.publicState.balance || 0) + BigInt(wallet.publicState.nativeBalance || 0);
  const warning = [
    'Start over? This deletes everything this wallet keeps in this browser and opens a new, empty account.',
    `It deletes the private key of ${accounts > 1 ? `all ${accounts} accounts` : 'the account'} saved here, with their evidence, receipts, activity and game allowances.${held ? ` This account holds ${formatAmount(held)} µETH.` : ''}`,
    `${wallet.address && localStorage.getItem(savedSetting()) === null ? 'This account’s key is saved nowhere else. ' : ''}An account whose key you have not saved with a passkey or a key file is lost for good, with all its money. A passkey stays on your device, and signing in with it opens its account again.`,
    'This cannot be undone.',
  ].join('\n\n');
  if (!confirm(warning)) return;
  wallet.destroy();
  localStorage.clear();
  await storage.clear();
  location.replace('/');
});
// A field with a button beside it does what the button does on Enter.
$('import-key').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('import-wallet').click();
});
act('verify-discord', async () => {
  verifying = await wallet.discordCode();
  void watchVerify(verifying, wallet.profile?.discordVerified ?? null);
});
$('copy-verify-code').addEventListener('click', async () => {
  if (!verifying) return;
  try {
    await navigator.clipboard.writeText(verifying.code);
    toast('Code copied. Paste it into /verify in the HookedIn Discord.');
  } catch {
    getSelection()?.selectAllChildren($('verify-code'));
    toast('The code is selected. Copy it with your browser’s copy command.');
  }
});
act(
  'unlink-discord',
  () => wallet.unlinkDiscord(),
  () => `You go by ~${wallet.uname} again.`,
);
act('publish-game', async () => {
  const name = $<HTMLInputElement>('game-name-input'),
    url = $<HTMLInputElement>('game-url-input');
  const published = name.value.trim();
  if (!GAME_NAME.test(published)) throw new Error('A game name is 1 to 32 lowercase letters, digits or hyphens.');
  await wallet.publishGame(published, gameURL(url.value.trim()).href);
  name.value = url.value = '';
  await loadLibrary();
  toast(`Published at ${showName(wallet)}/${published}.`);
});
act('bank-deposit', async () => {
  const amount = typedAmount($<HTMLInputElement>('bank-amount').value.trim());
  if (amount <= 0n) throw new Error('Enter how much to put in your bank.');
  const receipt = await wallet.depositBank(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Put ${exact(amount)} µETH in your bank.`);
  await refreshBank();
});
act('bank-withdraw', async () => {
  const amount = typedAmount($<HTMLInputElement>('bank-amount').value.trim());
  await wallet.withdrawBank(amount);
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Took ${exact(amount)} µETH out of your bank. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshBank();
});
$('menu-profile').addEventListener('click', event => {
  event.preventDefault();
  $('account-menu').hidePopover?.();
  if (wallet.uname) void openProfile(showName(wallet));
});
$('network-name').textContent = wallet.networkName;
// The account is saved with a passkey, whose secret is its key, or as the key itself in a file.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]'))
  button.addEventListener('click', async () => {
    $('account-menu').hidePopover?.();
    const how = button.dataset.key,
      playing = how === 'file' ? null : (active?.path ?? null);
    await task(async () => {
      if (how === 'file') {
        download(`hookedin-${wallet.address}.txt`, wallet.exportKey() + '\n', 'text/plain');
        markSaved();
        return toast('Key file saved. Anyone who has it can take everything this account holds: keep it private.');
      }
      const key = await passkeyKey(how === 'create');
      closeGame();
      await wallet.importKey(key);
      markSaved();
      toast(how === 'create' ? 'Your wallet is saved with your passkey.' : 'Signed in with your passkey.');
    });
    // A game open under the account it replaced opens again under this one, under the wallet if that is open.
    if (playing && !active) void openGame(parseRoute(new URL(playing, location.origin)) as GameRoute);
  });
$('deposit-instructions').textContent =
  `Send test ETH on ${wallet.networkName} to your deposit address, never real ETH`;
$<HTMLAnchorElement>('casino-status').href = casinoURL + '/api/status';
// Show the addressed page immediately; a game route waits for the wallet and the lobby.
const initialRoute = parseRoute(new URL(location.href));
showPage(typeof initialRoute === 'string' ? initialRoute : 'library');
if (typeof initialRoute === 'object' && 'wallet' in initialRoute) showWallet(initialRoute.wallet);
const startup = Promise.withResolvers<void>();
/** Games opened by an early click wait here, so their session opens against the started wallet. */
const walletStarted = startup.promise;
/** Something the player should know about the casino, above every page. */
function warn(message: string) {
  $('connection-banner').textContent = message;
  $('connection-banner').classList.add('warning');
  $('connection-banner').classList.remove('hidden');
}

void loadLibrary();
try {
  await wallet.start().finally(startup.resolve);
  if (wallet.recoveryOnly)
    warn(
      'The casino is unavailable or has changed. Your balance stays safe in the contract: export, close, challenge and collect all work from Settings → Recovery. Playing and depositing need the casino. Reload to reconnect.',
    );
  // Everything with ETH waits for the deployment check, and a failed one shows here.
  wallet.verified.catch((error: any) => warn(`${error.shortMessage || error.message} Reload to check again.`));
  renderWallet();
  renderActivity();
  void refreshWallet();
  if (wallet.pending && !inbound(wallet.pending.kind))
    toast('An operation is saved and unfinished. Use Retry above to finish it safely.');
  await route();
} catch (error: any) {
  warn(`${error.shortMessage || error.message} Reload this page.`);
  for (const id of ['setup-wallet', 'add-to-balance', 'withdraw', 'transfer', 'address-send', 'import-wallet'])
    $<HTMLButtonElement>(id).disabled = true;
}
