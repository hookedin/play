import { parseEther, ZeroAddress } from 'ethers';
import qrcode from 'qrcode-generator';
import { CasinoWallet } from './wallet.ts';
import { validateWithdrawal } from './withdrawal.ts';
import { passkeyKey } from './passkey.ts';
import { playControls, depositRemaining } from './play-controls.ts';
import { gameReceipt } from './wallet-games.ts';
import { OPERATIONS } from './wallet-channel.ts';
import { inbound } from './wallet-transactions.ts';
import { withLock } from './storage.ts';
import { json, same, verifyEvidence, gameKey, collateralPrice } from '../protocol/protocol.ts';
import { attachGameBridge, gameError } from './bridge.ts';
import {
  activityJSON,
  createActivityEntry,
  ether,
  developerBetSummary,
  h,
  percent,
  receiptSummary,
  signedEth,
} from './activity.ts';
import { betDetail, betRowElement, betTotals, groupRowElement, groupRows, measuredReturn, totalCards } from './bets.ts';
import type { BetRow } from './bets.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import config from './config.ts';

interface ActiveGame {
  /** The channel this game is bound to; null until a channel is open. */
  channelId: string | null;
  /** The uname the page was told, once it asked: a game keys what it saves by it, so it restarts when that changes, as
   * it does with a first deposit. */
  uname?: string | null;
  identity: GameIdentity;
  /** Who publishes it, written as they are written (`@alias` or `~uname`); none for a game opened by its URL. */
  publisher: string | null;
  /** The wallet path that reopens this game. */
  path: string;
  frame: HTMLIFrameElement;
  dispose: () => void;
  /** The last allowance pushed into the iframe, so unchanged renders stay quiet; empty until the entry has loaded. */
  pushed: string | null;
}
/** A published game is `@alias/name` or `~uname/name`: its owner, written as they are written, and
 * the name it has in their profile. Any other game is linkable by its URL alone. */
type GameRoute = { owner: string; name: string } | { url: string };
/** What a profile records of a game it publishes: its key, and its developer, the account that publishes it. */
type Published = { key: string; developer: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const eth = (value: string | number | bigint | undefined, precision = networkDefaults.precision) => {
  const wei = BigInt(value || 0),
    smallest = 10n ** BigInt(18 - precision);
  if (wei > 0n && wei < smallest) return `<${ether(smallest)}`;
  // Truncated, never rounded: the game shows the same digits of the same money.
  return Number(ether(wei - (wei % smallest))).toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
};
/** One amount on its own or in a sentence: truncated as `eth` truncates it, without the zeros after it. */
const plainEth = (value: string | number | bigint | undefined) =>
  eth(value)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
const short = (value: string | null | undefined) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—');
/** Where a claim pays, as a sentence says it: paying the contract puts it into the account's own channel. */
const paidTo = (to: string) =>
  same(to, wallet.config.contractAddress)
    ? 'into your balance'
    : same(to, wallet.address)
      ? 'to your address'
      : `to ${short(to)}`;
/** A typed amount of ETH, in wei: null for anything that is not an amount above zero. */
const ethAmount = (text: string) => {
  try {
    const value = parseEther(text);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
};
/** A saved operation in words: what it is, the ID the casino knows it by and the sequence it was signed at, and what the
 * last attempt to send it ran into. */
function pendingSummary({ kind, request, details, game, operationId }: any) {
  const what = `${ether(request.amount)} ETH ${OPERATIONS[kind]!.name}${game ? ` in ${game.name}` : ''}`,
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
const networkDefaults =
  network === 'local' ? { precision: 4, total: '100000000000000000' } : { precision: 6, total: '100000000000000' };
let active: ActiveGame | null = null,
  uiBusy = false,
  toastTimer: ReturnType<typeof setTimeout> | undefined,
  statusTimer: ReturnType<typeof setTimeout> | undefined;
let historyBusy = false,
  historyError: any = null;
const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The casino's own profile: the games it ships with are published there. */
const HOUSE = 'hookedin';
/** How many games one profile holds. */
const MAX_GAMES = 100;
const wallet = new CasinoWallet({
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
    if (!active || active.identity.key !== game.key || !active.frame.contentWindow || active.pushed === null) return;
    const message = { hookedin: true, event: 'game.receipt', receipt: gameReceipt(game.id, receipt) };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.url).origin);
  },
});

/** A withdrawal from the open balance, as Withdraw has it. */
const withdrawalRequest = () =>
  validateWithdrawal({
    destination: $<HTMLInputElement>('withdraw-to').value,
    ownAddress: wallet.address,
    contractAddress: wallet.config.contractAddress,
    amount: $<HTMLInputElement>('withdraw-amount').value,
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
/** The play limits and breaks, the deposit address, and whether this account's key is saved outside this browser. */
function renderSafety() {
  const controls = playControls(wallet.controls),
    limits = controls.limits;
  const describeLimit = (value: string | null) => (value === null ? 'no limit' : `${ether(value)} ETH`);
  $('play-limits-status').textContent =
    `Today: ${plainEth(controls.deposited)} ETH deposited; ${plainEth(controls.lost)} ETH in losses. Limits: deposits ${describeLimit(limits.deposit)}, losses ${describeLimit(limits.loss)}, session ${limits.minutes === null ? 'no limit' : `${limits.minutes} minutes`}.${controls.pending ? ` Requested increases take effect ${new Date(controls.pending.at).toLocaleString()}.` : ''}`;
  const now = Date.now(),
    sessionEnd = controls.sessionStarted + (limits.minutes ?? 0) * 60000;
  const sessionMessage =
    controls.sessionStarted && limits.minutes !== null && now < sessionEnd + 15 * 60000
      ? now < sessionEnd
        ? `Your play session ends at ${new Date(sessionEnd).toLocaleTimeString()}. A 15-minute break follows.`
        : `Your session has ended. Take a break until ${new Date(sessionEnd + 15 * 60000).toLocaleTimeString()}.`
      : '';
  const pauseMessage =
    controls.pausedUntil > now
      ? `Play and deposits paused until ${new Date(controls.pausedUntil).toLocaleString()}. Withdrawals and recovery are available.`
      : sessionMessage;
  $('play-pause-banner').classList.toggle('hidden', !pauseMessage);
  $('play-pause-banner').textContent = pauseMessage;
  if (safetyAccount !== wallet.storageKey) {
    safetyAccount = wallet.storageKey;
    $<HTMLTextAreaElement>('exported-key').value = '';
    $('exported-key').classList.add('hidden');
    $('export-key').textContent = "Show this wallet's private key";
    for (const id of ['withdraw-to', 'withdraw-amount', 'address-send-to']) $<HTMLInputElement>(id).value = '';
    $<HTMLInputElement>('withdraw-into').checked = false;
    $<HTMLInputElement>('limit-deposit').value = limits.deposit === null ? '' : ether(limits.deposit);
    $<HTMLInputElement>('limit-loss').value = limits.loss === null ? '' : ether(limits.loss);
    $<HTMLInputElement>('limit-minutes').value = String(limits.minutes ?? '');
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
  const remaining = depositRemaining(controls);
  const whole = fee > 0n && held > fee ? held - fee : 0n,
    net = remaining !== null && whole > remaining ? remaining : whole,
    // Only a deposit of everything at the address is lent its fee: not one the daily limit cuts short.
    lent = net === whole ? wallet.feeLoan(net, fee) : 0n;
  $('deposit-fee').textContent =
    remaining === 0n
      ? 'Your play break or daily deposit limit keeps incoming ETH at this address. You can withdraw it.'
      : fee > 0n
        ? `Address balance ${ether(held)} ETH. Estimated maximum network fee ${ether(fee)} ETH. Up to ${ether(net + lent)} ETH can be added now${remaining !== null ? ' within your daily limit' : ''}${lent ? ': the casino lends you the network fee, and your next withdrawal pays it back' : ''}. The final fee is recorded in Activity.`
        : 'The network fee is estimated when ETH arrives. Small deposits may not cover that fee.';
}
$('play-limits-form').addEventListener('submit', event => {
  event.preventDefault();
  void task(async () => {
    const value = (id: string) => {
      const typed = $<HTMLInputElement>(id).value.trim();
      if (!typed) return null;
      const amount = ethAmount(typed);
      if (amount === null) throw new Error('Enter a positive ETH limit or leave it empty.');
      return String(amount);
    };
    const minutes = $<HTMLInputElement>('limit-minutes').value.trim();
    await wallet.setPlayLimits({
      deposit: value('limit-deposit'),
      loss: value('limit-loss'),
      minutes: minutes ? Number(minutes) : null,
    });
    toast('Limits saved. Reductions apply now; increases or removal wait 24 hours.');
  });
});
act(
  'pause-play',
  async () => {
    await wallet.pausePlay(Number($<HTMLSelectElement>('play-pause').value));
    abandonGame();
  },
  'Your break has started. You can still withdraw or recover your balance.',
);

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
/** The wallet's tabs, each with a path of its own: Deposit is `/wallet`, the others `/wallet/<tab>`. */
type WalletTab = 'deposit' | 'withdraw' | 'activity' | 'settings';
const walletPath = (tab: WalletTab) => (tab === 'deposit' ? '/wallet' : `/wallet/${tab}`);
/** The wallet tab the URL names, if it names one. */
function walletRoute() {
  const target = parseRoute(new URL(location.href));
  return typeof target === 'object' && 'wallet' in target ? target.wallet : null;
}
const gamePath = (route: GameRoute) =>
  'url' in route ? `/games/custom?url=${encodeURIComponent(route.url)}` : `/${route.owner}/${route.name}`;
/** How a player is written: an alias wears `@`, a uname wears `~`. */
const showName = (names: { uname?: string | null; alias?: string | null } | null) =>
  names?.alias ? '@' + names.alias : names?.uname ? '~' + names.uname : '—';
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
    open = wallet.funded && !wallet.recoveryOnly,
    shares = BigInt(wallet.fund?.shares || 0);
  $('fund-value').textContent = f ? eth(f.value, 6) : '—';
  $('fund-equity').textContent = f ? eth(f.equity, 4) : '—';
  // Shares are counted like ETH, in units of 10^18: one began at 1 ETH, and the price is what the
  // bankroll has made or lost since.
  $('fund-price').textContent =
    f && BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.equity) * 1000000n) / BigInt(f.totalShares)) / 1000000).toFixed(6)} ETH`
      : '1.000000 ETH';
  $('fund-house').textContent = !f
    ? '—'
    : BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.houseShares) * 10000n) / BigInt(f.totalShares)) / 100).toFixed(2)}%`
      : '100.00%';
  $('fund-note').textContent = wallet.fund?.alert
    ? `Your wallet refused a share statement: ${wallet.fund.alert}`
    : f && BigInt(f.overdrawn) > 0n
      ? `The casino's owner has withdrawn ${eth(f.overdrawn, 4)} ETH more than its own shares covered. Holders bore that loss.`
      : f?.owed?.length
        ? 'Money from shares you sold is on its way to your balance.'
        : !f
          ? 'The casino is not reporting its bankroll right now.'
          : shares
            ? `You hold ${ether(shares)} shares under the casino's signed statement number ${wallet.fund.sequence}.`
            : open
              ? ''
              : 'Deposit into your balance to buy shares.';
  $<HTMLButtonElement>('invest').disabled = uiBusy || !open || !f;
  for (const id of ['divest', 'divest-all']) $<HTMLButtonElement>(id).disabled = uiBusy || !open || !f || !shares;
}
function navigate(page: string, push = true, path = PAGES[page]!.path) {
  if (wallet.busy && active && wallet.pending?.game?.key === active.identity.key) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current operation to finish before leaving the game.', true);
  }
  $<HTMLDialogElement>('wallet-dialog').close();
  showPage(page);
  closeGame();
  if (push && location.pathname !== path) history.pushState(null, '', path);
}
/** Every page has a URL: `/`, `/games`, `/bets`, `/bankroll`, `/@<alias>` or `/~<uname>` for a player, the same and
 * `/<game>` for a game they publish, `/games/<key>` for a game's public record, and `/games/custom?url=<url>`; and the
 * wallet over a page, `/wallet` and `/wallet/<tab>`. */
function parseRoute(
  url: URL,
): string | GameRoute | { profile: string } | { record: string } | { wallet: WalletTab } | { unknown: string } {
  // A player's sigil survives a link that encodes it: `encodeURIComponent` writes `@` as `%40`, and the
  // static host decodes the path the same way before it serves this page.
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const tab = /^\/wallet(?:\/(withdraw|activity|settings))?$/.exec(pathname);
  if (tab) return { wallet: (tab[1] ?? 'deposit') as WalletTab };
  const named = /^\/([~@][A-Za-z0-9_]{3,24})(?:\/([a-z0-9][a-z0-9-]{0,31}))?$/.exec(pathname);
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
  if (typeof target === 'string') return navigate(target, push);
  if ('unknown' in target) {
    navigate('library', false, '/');
    history.replaceState(null, '', '/');
    return void toast(`Nothing lives at ${target.unknown}. A player is @alias or ~uname.`, true);
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

/** The total wallet balance stays visible while games display their own allowance. */
function renderMoney() {
  const funded = wallet.funded,
    balance = BigInt(wallet.publicState?.balance || 0);
  $('wallet-button-amount').replaceChildren(plainEth(balance), h('small', null, 'ETH'));
  $('wallet-button-amount').classList.toggle('hidden', !funded);
  $('wallet-button-label').textContent = funded && balance > 0n ? 'Wallet' : 'Deposit';
  $('hero-deposit').classList.toggle('hidden', funded || !wallet.address);
}
/** The top bar, and the game's own view of its money, which the wallet pushes to it. */
function renderGameAccount() {
  renderMoney();
  if (!active || !wallet.game) return;
  // A game opened before a channel adopts the first one; a game bound to a channel closes with it.
  if (active.channelId === null && wallet.channelId) active.channelId = wallet.channelId;
  if (active.uname !== undefined && wallet.uname !== active.uname) {
    active.uname = undefined;
    active.pushed = null;
    // In place of its history entry: Back still leaves the game, and a close of the wallet over it comes back to it.
    active.frame.contentWindow?.location.replace(active.frame.src);
  }
  if ($<HTMLDialogElement>('allowance-dialog').open) renderAllowanceDialog();
  // The game's own allowance view follows the wallet: top-ups and recoveries push without polling.
  const allowance = wallet.gameAllowance();
  const pushed = JSON.stringify(allowance);
  if (active.pushed !== null && pushed !== active.pushed && active.frame.contentWindow) {
    active.pushed = pushed;
    const message = { hookedin: true, event: 'game.allowance', ...allowance };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.url).origin);
  }
}
/** The slider runs linearly from nothing to the whole playable balance, a hundredth of it a step. */
const SLIDER_STEPS = 100n;
const sliderAmount = (total: bigint, value: string) => (total * BigInt(value)) / SLIDER_STEPS;
// The last allowance the player chose for a game is only the next suggestion; authority comes from the dialog alone.
const allowanceSetting = () => `hookedin:${network}:game-allowance:${active?.identity.key}`;
/** The wallet's own dialog: the sole grant of spending authority over ETH. It says what the game may play with now,
 * what it would, and out of how much, because those are the whole of what is being authorized. */
function renderAllowanceDialog() {
  if (!active) return;
  const name = active.identity.name;
  const allowance = BigInt(wallet.game?.allowance || '0');
  $('allowance-title').textContent = allowance > 0n ? `Change ${name}'s allowance` : `Play ${name} with ETH`;
  const total = wallet.playableBalance(),
    slider = $<HTMLInputElement>('allowance-slider');
  let amount = -1n;
  try {
    amount = parseEther($<HTMLInputElement>('allowance-amount').value.trim() || '0');
  } catch {}
  const valid = amount >= 0n && amount <= total;
  $('allowance-total').textContent = `${plainEth(total)} ETH, your balance`;
  $<HTMLButtonElement>('allowance-take-all').classList.toggle('hidden', allowance === 0n);
  slider.value = String(valid && total > 0n ? (amount * SLIDER_STEPS) / total : 0n);
  $('allowance-help').textContent = !valid
    ? amount > total
      ? `That is more than your balance of ${ether(total)} ETH.`
      : 'Enter an amount in ETH.'
    : total === 0n
      ? 'Your balance is empty. Deposit to play with ETH.'
      : amount === allowance
        ? `This is ${name}'s allowance now.`
        : amount > allowance
          ? `${name} may play with ${ether(amount - allowance)} ETH more.`
          : `${ether(allowance - amount)} ETH comes back to your balance.`;
  $('allowance-help').classList.toggle('check-failed', !valid);
  $<HTMLButtonElement>('allowance-confirm').disabled = !valid || amount === allowance || uiBusy || wallet.busy;
  $('allowance-confirm').textContent = !valid
    ? 'Allow'
    : amount < allowance
      ? `Take back ${ether(allowance - amount)} ETH`
      : `Allow ${ether(amount)} ETH`;
}
let allowanceRequest: { resolve: (amount: bigint | null) => void } | null = null;
/** Opened by the game's request for a larger allowance, which may suggest how much more. With nothing in the balance
 * to allow, the wallet opens on Deposit instead, and the game hears that it has no more. */
function openAllowanceDialog(amount?: bigint) {
  if (!active) return Promise.resolve<bigint | null>(null);
  allowanceRequest?.resolve(null);
  if (wallet.playableBalance() === 0n && BigInt(wallet.game?.allowance || '0') === 0n) {
    openWallet('deposit', `${active.identity.name} plays with ETH from your balance. Deposit some to play.`);
    return Promise.resolve<bigint | null>(null);
  }
  const dialog = $<HTMLDialogElement>('allowance-dialog');
  // The game page shows nothing but the game, so the dialog that grants it money says who it is.
  const host = new URL(active.frame.src).host;
  $('allowance-who').textContent = active.publisher
    ? `Published by ${active.publisher}, served from ${host}. Its developer earns half of each casino bet's commission, and takes and settles its developer bets.`
    : `Served from ${host}. Nobody publishes it, so nobody earns from it.`;
  const total = wallet.playableBalance(),
    allowance = BigInt(wallet.game?.allowance || '0'),
    // What the game asked for, never more; or the allowance as it is, or what the player last chose.
    suggested =
      amount && amount > 0n
        ? allowance + amount
        : allowance > 0n
          ? allowance
          : BigInt(localStorage.getItem(allowanceSetting()) || networkDefaults.total);
  $<HTMLInputElement>('allowance-amount').value = ether(suggested > total ? total : suggested);
  renderAllowanceDialog();
  if (!dialog.open) dialog.showModal();
  $<HTMLInputElement>('allowance-amount').select();
  return new Promise<bigint | null>(resolve => {
    allowanceRequest = { resolve };
  });
}

// --- The wallet: the balance, what comes in at the deposit address, withdrawals, activity and settings ----------

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
/** The wallet on `tab`. A tab has a path, but no step in the history of its own: Back closes the wallet. */
function showWallet(tab: WalletTab) {
  walletTab = tab;
  if (location.pathname !== walletPath(tab)) history.replaceState(history.state, '', walletPath(tab));
  document.title = 'Wallet · HookedIn';
  for (const button of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-tab]'))
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const panel of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-panel]'))
    panel.hidden = panel.dataset.panel !== tab;
  const dialog = $<HTMLDialogElement>('wallet-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  // What sending a withdrawal costs now, for Max and the help to count with.
  if (tab === 'withdraw' && wallet.channel) void wallet.quoteWithdrawalFee().catch(() => {});
  if (tab === 'activity') void refreshActivity();
  renderWallet();
}
/** Once money has moved, the wallet has done its work. */
function funded(message: string) {
  $<HTMLDialogElement>('wallet-dialog').close();
  toast(message);
}
function renderWallet() {
  renderFund();
  renderProfile();
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
  $('balance-amount').textContent = plainEth(balance);
  renderCollateral();
  renderSafety();
  $('balance-note').textContent = arriving
    ? `${plainEth(arriving)} ETH of it is on its way into your balance.`
    : state.closingChannelId && !state.channelId
      ? 'Your last balance is closing: finish the close under Settings → Recovery once its deadline passes, and collect it. A deposit opens your next balance.'
      : loan
        ? `What games play with. The casino lent you the ${plainEth(loan)} ETH network fee of your deposits: your next withdrawal pays it back.`
        : 'What games play with.';
  const earnings = state.developerEarnings;
  // The tally the casino keeps for this account, collected into its balance.
  $('developer-earnings').classList.toggle('hidden', !BigInt(earnings?.earned || 0));
  $('developer-earnings').textContent = earnings
    ? `Your games have earned ${ether(earnings.earned)} ETH in commission; ${ether(earnings.collected)} ETH of it is collected into your balance.`
    : '';
  $('faucet-link').classList.toggle('hidden', wallet.expectedChainId !== 11155111n);
  $('wallet-address').textContent = wallet.address;

  // Deposit: ETH sent to the address goes into the balance by itself, unless something the player should decide on
  // is in the way.
  const held = atAddress ? ` It holds ${plainEth(atAddress)} ETH.` : '';
  const depositStatus = !ready
    ? 'Connecting to your wallet…'
    : !observed
      ? 'Checking your deposit address…'
      : wallet.depositing
        ? `Adding ${plainEth(wallet.depositing)} ETH to your balance…`
        : arriving
          ? `${plainEth(arriving)} ETH is on its way into your balance.`
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
                    : `Waiting for ETH. Deposits are added after network confirmation, within your daily limit.${wallet.config.loanLimit == null ? ' The network fee of adding them comes out of them.' : ' The casino lends you the network fee of adding them, and your next withdrawal pays it back.'}`;
  if ($('deposit-status').textContent !== depositStatus) $('deposit-status').textContent = depositStatus;
  const addable = (wallet.forceClosed || !wallet.autoDeposit) && !wallet.recoveryOnly && !closing && atAddress > 0n;
  $('add-to-balance').classList.toggle('hidden', !addable);
  $<HTMLButtonElement>('add-to-balance').disabled = busy || !ready;
  $<HTMLButtonElement>('copy-address').disabled = !ready;
  $('setup-wallet').classList.toggle('hidden', !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('setup-wallet').disabled = busy;

  // Withdraw: part of the signed balance, or all of it with Max, which the casino then pays to the address entered.
  const open = status === 1 && !closing,
    request = withdrawalRequest(),
    amount = request.amount,
    into = $<HTMLInputElement>('withdraw-into').checked,
    // What the balance pays beside the amount: the casino's fee for sending it, and back what the casino lent it.
    charges = [
      wallet.withdrawalFee ? `the casino ${plainEth(wallet.withdrawalFee)} ETH for sending it` : '',
      loan ? `back the ${plainEth(loan)} ETH network fee the casino lent you` : '',
    ].filter(Boolean);
  $('withdraw-form').classList.toggle('hidden', !open);
  // A withdrawal signs the casino's fee only once it is shown.
  $<HTMLButtonElement>('withdraw').disabled =
    busy ||
    !ready ||
    !open ||
    !wallet.withdrawalFee ||
    Boolean(request.error) ||
    Boolean(wallet.transactionIntent) ||
    Boolean(wallet.pending) ||
    wallet.recoveryOnly;
  $('withdraw').textContent = `${into ? 'Transfer' : 'Withdraw'}${amount === null ? '' : ` ${ether(amount)} ETH`}`;
  $('withdraw-help').textContent = !ready
    ? 'Connecting to your wallet…'
    : closing
      ? 'Your balance is closing: once its 24-hour window ends, finish the close under Settings → Recovery and collect it.'
      : !open
        ? 'No balance is open: your first deposit opens one.'
        : wallet.recoveryOnly
          ? 'The casino is unavailable: close without it under Settings → Recovery.'
          : inbound(wallet.pending?.kind)
            ? 'A deposit is on its way into your balance. Withdraw once it has arrived.'
            : wallet.transactionIntent || wallet.pending
              ? 'Finish the operation in flight first.'
              : request.error ||
                `${into ? "That account's HookedIn balance receives" : 'The address receives'} ${ether(amount!)} ETH.${charges.length ? ` Your balance also pays ${charges.join(' and pays ')}.` : ''} Check the full address before confirming.`;
  $('withdraw-help').classList.toggle('check-failed', open && Boolean(request.error));

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
        : `Your deposit address holds ${plainEth(atAddress)} ETH. Check the full address before confirming.`;
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
    amount = ethAmount($<HTMLInputElement>('collateral-buy-amount').value.trim()),
    buying = state.buying;
  $('held-deposits').textContent = plainEth(p.deposits);
  $('collateral-amount').textContent = plainEth(p.collateral);
  $('protected-amount').textContent = plainEth(p.covered);
  $('collateral-rate').textContent = rate === null ? '—' : `${rateText(rate)} once`;
  $('balance-protection').textContent = [
    missing > 0n
      ? `${plainEth(missing)} ETH of your balance is deposits the chain does not hold: a close is owed them only once they land again.`
      : '',
    uncovered > 0n
      ? `${plainEth(uncovered)} ETH of your balance is winnings above them, which the bankroll pays only as it has the cash until you lock it in under Recovery or buy collateral for it.`
      : `${missing > 0n ? 'The rest' : 'All'} of your balance is protected${spare > 0n ? `, and ${plainEth(spare)} ETH more that you win would be too` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const button = $<HTMLButtonElement>('buy-collateral');
  button.disabled = uiBusy || wallet.busy || !wallet.funded || rate === null || !amount || Boolean(buying);
  button.textContent =
    amount && rate !== null ? `Buy for ${plainEth(collateralPrice(amount, rate))} ETH` : 'Buy collateral';
  $('collateral-help').textContent = buying
    ? `Send ${plainEth(BigInt(buying.price) + 2n * wallet.depositFee)} ETH or more to your deposit address by ${new Date(Number(buying.expiresAt) * 1000).toLocaleTimeString()}, the price and its network fee: the wallet buys ${plainEth(buying.amount)} ETH of collateral with it before it adds anything to your balance.`
    : !wallet.funded
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
  $<HTMLButtonElement>('refresh-developer-bets').disabled = historyBusy || wallet.busy || !wallet.channel;
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
  $<HTMLButtonElement>('refresh-wallet').disabled = historyBusy || !wallet.address;
  const refreshError = historyError?.shortMessage || historyError?.message || historyError || wallet.detailsError;
  $('history-status').textContent =
    historyError || wallet.detailsError
      ? `This may be out of date; your saved proofs are safe. ${refreshError}`
      : historyBusy || wallet.detailsRefreshing
        ? 'Checking the chain and the casino…'
        : 'Every signed result, deposit and withdrawal, with the JSON behind it.' +
          (wallet.detailsObservedAt
            ? ` Checked ${new Date(wallet.detailsObservedAt).toLocaleTimeString([], { hour12: false })}.`
            : '');
  $('history-status').classList.toggle('check-failed', Boolean(historyError || wallet.detailsError));
  // A deposit taken into the balance is the deposit's own bookkeeping: the deposit is what the player sees.
  syncRows(
    $('activity-list'),
    wallet.history.filter(receipt => receipt.kind !== 'taken-in'),
    receipt => receipt.operationId,
    activityJSON,
    activityEntry,
  );
  filterList('activity');
}
/** One receipt as Activity lists it, with the facts behind it. */
function activityEntry(receipt: any) {
  // A declined operation's proof is the checkpoint above it, with no step: the operation is the one it declined.
  const operation = receipt.request ?? receipt.proof?.step?.operation;
  const channelId = operation?.channelId || receipt.proof?.base?.channelId;
  const presentation = receiptSummary(receipt, wallet.config.contractAddress);
  const facts: [string, string | Node][] = [['Operation ID', receipt.operationId]];
  if (channelId) facts.push(['Channel', channelId]);
  if (operation?.sequence !== undefined) facts.push(['Sequence', String(operation.sequence)]);
  if (receipt.commission !== undefined) facts.push(['Commission', `${ether(receipt.commission)} ETH`]);
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
  if (receipt.fee !== undefined) facts.push(['Network fee', `${ether(receipt.fee)} ETH`]);
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
      ? `The contract holds ${plainEth(state.principal || '0')} ETH of your deposits and ${plainEth(state.collateral || '0')} ETH of collateral for this balance, at saved sequence ${state.savedSequence || '0'}.`
      : '',
    open && wallet.withdrawalFee
      ? `Locking in pays the casino ${plainEth(wallet.withdrawalFee)} ETH for sending it.`
      : '',
    closing
      ? BigInt(state.disputedPrize || 0) > 0n
        ? `The close disputes your casino bet at sequence ${state.closingSequence}: the casino has until the deadline to settle it on-chain, or it counts as won and pays ${plainEth(state.disputedPrize)} ETH. Meanwhile the contract holds ${plainEth(state.disputeHold || '0')} ETH of house cash for it, which the casino cannot take.`
        : `The close proposes sequence ${state.closingSequence || '0'} where you saved ${state.closingSaved || '0'}, ${plainEth(state.balanceAtRisk || '0')} ETH less than yours${state.challengePending ? '; a challenge is on its way' : ''}.`
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
    `Your deposit address holds ${plainEth(state.nativeBalance || 0)} ETH for network fees. Closing, challenging and finishing need ETH at this address. Starting a close pauses automatic deposits so gas top-ups stay here.${!wallet.autoDeposit ? ' Automatic deposits are paused; turn them back on under Deposits when ready.' : ''}`;
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
      `${claim.channelId ? `Channel ${short(claim.channelId)}` : 'A withdrawal'}, paid ${paidTo(claim.to)}: ${plainEth(unpaid)} ETH still owed of ${plainEth(claim.amount)} ETH. ` +
      (ready > 0n
        ? `${plainEth(ready)} ETH can be collected now.`
        : `Its ${plainEth(claim.winningsRemaining)} ETH of winnings wait for the bankroll to have the cash.`)
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
              ? `Collected ${plainEth(collected)} ETH.`
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

/** The user-initiated refresh; the wallet's own loop observes, polls and audits otherwise. */
async function refreshActivity() {
  if (historyBusy || !wallet.address || !wallet.reader) return;
  historyBusy = true;
  historyError = null;
  renderActivity();
  try {
    await wallet.refresh();
    await wallet.refreshDetails();
    await wallet.collectPayouts();
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
    pushed: null,
  };
  frame.addEventListener('load', () => {
    if (!isCurrent()) return;
    active!.pushed = '';
    renderGameAccount();
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
      // What the player is doing in the wallet comes first; the wallet's own checks finish and the game's request
      // follows.
      if (uiBusy) throw gameError('busy', 'The wallet is processing another operation.');
      await wallet.actionDone;
      if (method === 'game.requestAllowance') {
        const amount = await openAllowanceDialog(params.amount === undefined ? undefined : BigInt(params.amount));
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
    const mine = wallet.alias === HOUSE ? [] : (wallet.profile?.games ?? []);
    list.replaceChildren(...profileCards('@' + HOUSE, house.games), ...profileCards(showName(wallet.profile), mine));
  } catch {
    list.textContent = 'The games could not be loaded. You can still open a game by its URL below.';
  }
  list.setAttribute('aria-busy', 'false');
}
/** Anybody's page: their names, what they have played, and the games they publish. */
async function openProfile(name: string, push = true) {
  $('profile-name').textContent = name;
  $('profile-uname').textContent = '';
  $('profile-since').textContent = '';
  $('profile-stats').replaceChildren();
  const games = $('profile-games');
  games.textContent = 'Loading…';
  $('profile-games-heading').classList.remove('hidden');
  navigate('profile', push, `/${name}`);
  try {
    const profile = await wallet.api(`/api/players/${name}`);
    $('profile-name').textContent = showName(profile);
    // An alias is what they are called; the uname is who they are, and is shown beside it.
    $('profile-uname').textContent = profile.alias ? '~' + profile.uname : '';
    document.title = `${showName(profile)} · HookedIn`;
    $('profile-since').textContent = `Playing here since ${new Date(profile.since).toLocaleDateString()}.`;
    $('profile-stats').replaceChildren(
      h(
        'div',
        { className: 'money-card' },
        h('span', { className: 'label' }, 'Bets'),
        h('strong', null, String(profile.stats.plays)),
        h(
          'span',
          { className: 'muted' },
          `Staked ${eth(profile.stats.staked, 4)} ETH · won ${eth(profile.stats.won, 4)} ETH`,
        ),
      ),
    );
    const cards = profileCards(showName(profile), profile.games);
    if (cards.length) games.replaceChildren(...cards);
    else games.textContent = `${showName(profile)} publishes no games.`;
  } catch (error: any) {
    $('profile-since').textContent = error.code === 'not-found' ? 'Nobody goes by that name.' : error.message;
    games.replaceChildren();
    // Nobody is here, so neither is anything of theirs.
    $('profile-games-heading').classList.add('hidden');
  }
}
/** The lobby is loaded again whenever what this account publishes changes. */
let libraryKey = '';
/** The account the saved-accounts list was last set to, so a render only moves it when that changes. */
let shownAccount: string | null = null;
/** The account's own names, in the top bar, its menu and Settings, and the games it publishes. */
function renderProfile() {
  const name = wallet.uname ? showName(wallet) : null,
    open = wallet.funded && !wallet.recoveryOnly;
  $('account-name').textContent = name ?? 'Account';
  $('menu-name').textContent = name ?? 'Your account';
  // The uname is always there; when an alias covers it up, it is shown underneath.
  const uname = wallet.alias && wallet.uname ? '~' + wallet.uname : '';
  $('menu-uname').textContent = uname;
  $('wallet-uname').textContent = uname;
  $<HTMLAnchorElement>('menu-profile').href = name ? `/${name}` : '/';
  $('menu-profile').classList.toggle('hidden', !name);
  $('wallet-name').textContent = name ?? 'No name yet: your first deposit gives you one.';
  $<HTMLAnchorElement>('wallet-name-link').href = name ? `/${name}` : '/';
  for (const id of ['pick-alias', 'publish-game']) $<HTMLButtonElement>(id).disabled = uiBusy || !open;
  for (const id of ['bank-deposit', 'bank-withdraw'])
    $<HTMLButtonElement>(id).disabled = uiBusy || !wallet.funded || Boolean(wallet.pending);
  $<HTMLButtonElement>('clear-alias').disabled = uiBusy || !open;
  $('clear-alias').classList.toggle('hidden', !wallet.alias);
  $('alias-note').textContent = !open
    ? 'Deposit into your balance to take an alias or publish games.'
    : 'An alias is unique, and two that read alike are the same alias. Your uname stays yours either way.';
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
  $('bank-balance').textContent = `${ether(balance)} ETH`;
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
  if (!$<HTMLDialogElement>('bet-dialog').open) $<HTMLDialogElement>('bet-dialog').showModal();
}
/** A list is rebuilt only when what it shows has changed. The wallet renders on every poll, and a
 * row replaced under the player's cursor takes their click with it. */
const betSignature = (rows: readonly BetRow[], extra = '') =>
  extra + rows.map(row => `${row.operation}:${row.payout}`).join(',');
let shownBets = '\u0000',
  shownPlayed = '\u0000';
const NO_BETS = 'No bets yet. Play a game with ETH, and your bets show here.';
function renderBets() {
  const rows = ownBets();
  $<HTMLButtonElement>('refresh-bets').disabled = historyBusy || !wallet.address;
  const signature = betSignature(rows);
  if (signature === shownBets) return;
  shownBets = signature;
  $('bet-list').replaceChildren(...betElements(rows, showBet));
  filterList('bet');
}
/** A list of bets, the ones a game grouped standing together as one row. */
function betElements(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  return groupRows(rows).map(group =>
    group.length === 1 ? betRowElement(group[0]!, onOpen) : groupRowElement(group, bets => showGroup(bets, onOpen)),
  );
}
/** The bets of one group, each opening in full where this wallet kept its receipt. */
function showGroup(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  const last = rows.at(-1)!;
  $('bet-detail-eyebrow').textContent = `One group, ${rows.length} bets`;
  $('bet-detail-title').textContent = `${last.game} · ${last.group}`;
  $('bet-detail').replaceChildren(h('div', { className: 'bet-table' }, ...rows.map(row => betRowElement(row, onOpen))));
  $('bet-dialog').scrollTop = 0;
  if (!$<HTMLDialogElement>('bet-dialog').open) $<HTMLDialogElement>('bet-dialog').showModal();
}
/** Show the rows of a list, of bets or events, that hold every word typed in its search, and count them. */
function filterList(name: 'activity' | 'bet' | 'gamebets') {
  const terms = $<HTMLInputElement>(`${name}-search`).value.trim().toLowerCase().split(/\s+/).filter(Boolean),
    events = name === 'activity';
  let visible = 0,
    total = 0;
  for (const row of $(`${name}-list`).children as HTMLCollectionOf<HTMLElement>) {
    const text = `${row.textContent} ${row.dataset.search ?? ''}`.toLowerCase(),
      matches = terms.every(term => text.includes(term)),
      // A group's row stands for every bet in it.
      count = Number(row.dataset.bets ?? 1);
    row.classList.toggle('hidden', !matches);
    total += count;
    if (matches) visible += count;
  }
  $(`${name}-visible-count`).textContent =
    `${terms.length ? `${visible} / ` : ''}${total} ${events ? 'event' : 'bet'}${total === 1 ? '' : 's'}`;
  const empty = $(`${name}-empty`);
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? events
      ? 'No matching events. Try a method, amount, operation ID or transaction hash.'
      : 'No bet matches that. Try a game, an amount, a bet number or an operation ID.'
    : events
      ? 'No activity yet. Events will appear here as you use the wallet and games.'
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
        ['At risk', `${ether(totals.staked)} ETH`],
        ['Paid back', `${ether(totals.paid)} ETH`],
        ['Your result', signedEth(totals.net), totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : ''],
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
      const who = bet.alias ? '@' + bet.alias : bet.uname ? '~' + bet.uname : 'a player';
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
for (const id of ['refresh-bets', 'refresh-developer-bets', 'refresh-wallet'])
  $(id).addEventListener('click', () => void refreshActivity());
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
    const amount = parseEther($<HTMLInputElement>('allowance-amount').value.trim() || '0');
    // An allowance is held against other tabs.
    await holdGameAllowance();
    await wallet.setGameAllowance(String(amount));
    localStorage.setItem(allowanceSetting(), String(amount));
    toast(`${active.identity.name} may play with up to ${ether(amount)} ETH.`);
    $<HTMLDialogElement>('allowance-dialog').close(String(amount));
  });
});
$<HTMLDialogElement>('allowance-dialog').addEventListener('close', () => {
  const value = $<HTMLDialogElement>('allowance-dialog').returnValue;
  const request = allowanceRequest;
  allowanceRequest = null;
  request?.resolve(value ? BigInt(value) : null);
  $<HTMLDialogElement>('allowance-dialog').returnValue = '';
});
$<HTMLButtonElement>('bet-detail-close').addEventListener('click', () => $<HTMLDialogElement>('bet-dialog').close());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-allowance-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('allowance-dialog').close(''));
$<HTMLButtonElement>('allowance-deposit').addEventListener('click', () => {
  $<HTMLDialogElement>('allowance-dialog').close('');
  openWallet('deposit');
});
for (const id of ['wallet-button', 'hero-deposit']) $(id).addEventListener('click', () => openWallet('deposit'));
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
  if (!walletRoute()) return;
  if (history.state?.over) history.back();
  else {
    history.replaceState(null, '', '/');
    void route();
  }
});
$<HTMLInputElement>('allowance-slider').addEventListener('input', () => {
  $<HTMLInputElement>('allowance-amount').value = ether(
    sliderAmount(wallet.playableBalance(), $<HTMLInputElement>('allowance-slider').value),
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
  act(
    id,
    () => wallet.startClose(),
    'Close started. It can be challenged for 24 hours; keep watching until it is done.',
  );
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
  funded(`Added ${plainEth(BigInt(wallet.publicState.balance || 0) - before)} ETH to your balance.`);
});
for (const id of ['withdraw-to', 'withdraw-amount', 'withdraw-into', 'address-send-to', 'collateral-buy-amount'])
  $<HTMLInputElement>(id).addEventListener('input', () => renderWallet());
$<HTMLButtonElement>('withdraw-max').addEventListener('click', () => {
  $<HTMLInputElement>('withdraw-amount').value = ether(wallet.withdrawable());
  renderWallet();
});
act('withdraw', async () => {
  const { to, amount, error } = withdrawalRequest();
  if (error || !to || amount === null) throw new Error(error || 'Enter a destination address.');
  const into = $<HTMLInputElement>('withdraw-into').checked;
  // A partial withdrawal leaves the open game its allowance; a whole one takes back what the game holds.
  if (amount >= wallet.withdrawable()) abandonGame();
  const receipt = await wallet.withdraw(to, amount, { into });
  $<HTMLInputElement>('withdraw-to').value = '';
  $<HTMLInputElement>('withdraw-amount').value = '';
  $<HTMLInputElement>('withdraw-into').checked = false;
  $<HTMLDialogElement>('wallet-dialog').close();
  toast(
    into
      ? `Transferred ${ether(receipt.amount)} ETH: the contract puts it into the HookedIn balance of ${short(to)}.`
      : `Withdrew ${ether(receipt.amount)} ETH: the contract pays it to ${short(to)}, and Activity shows when it has.`,
  );
});
act('address-send', async () => {
  const { to, error } = addressSendRequest();
  if (error || !to) throw new Error(error || 'Enter a destination address.');
  const receipt = await wallet.withdrawAddress(to);
  $<HTMLInputElement>('address-send-to').value = '';
  toast(`Sent ${ether(receipt.amount)} ETH to ${short(to)}. Activity shows the transaction and its fee.`);
});
act('buy-collateral', async () => {
  const amount = ethAmount($<HTMLInputElement>('collateral-buy-amount').value.trim());
  if (!amount) throw new Error('Enter how much collateral to buy.');
  const bought = await wallet.buyCollateral(amount);
  $<HTMLInputElement>('collateral-buy-amount').value = '';
  toast(
    bought
      ? `Bought ${plainEth(amount)} ETH of collateral: the contract holds it for your balance.`
      : 'Send its price to your deposit address: the wallet buys the collateral as soon as it arrives.',
  );
});
act('invest', async () => {
  const amount = parseEther($<HTMLInputElement>('invest-amount').value.trim());
  if (wallet.pending) throw new Error('Finish the operation in flight before buying shares.');
  const receipt = await wallet.invest(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this investment.');
  toast(`Bought ${ether(receipt.shares)} shares for ${ether(amount)} ETH.`);
  await refreshFund();
});
$<HTMLButtonElement>('divest-all').addEventListener('click', () => {
  if (fundStatus) $<HTMLInputElement>('divest-amount').value = ether(fundStatus.value);
});
act('divest', async () => {
  const status = await wallet.fundStatus(),
    held = BigInt(wallet.fund.shares),
    wanted = parseEther($<HTMLInputElement>('divest-amount').value.trim());
  if (wanted <= 0n || BigInt(status.equity) <= 0n) throw new Error('Enter what the shares you sell should be worth.');
  // Shares worth the amount asked for at the stated price; everything, when that is all of them.
  const shares = wanted >= BigInt(status.value) ? held : (wanted * BigInt(status.totalShares)) / BigInt(status.equity);
  if (!shares) throw new Error('That is less than one share.');
  const receipt = await wallet.redeem(shares);
  toast(`Sold ${ether(shares)} shares for ${ether(receipt.amount)} ETH. It is on its way to your balance.`);
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
// What locking in costs now, shown before it is signed.
$('channel-lock')
  .closest('details')!
  .addEventListener('toggle', event => {
    if ((event.target as HTMLDetailsElement).open && wallet.channel) void wallet.quoteWithdrawalFee().catch(() => {});
  });
for (const id of ['channel-challenge', 'challenge-now'])
  act(id, () => wallet.challengeClose(), 'Your latest saved balance is submitted.');
act(
  'channel-finalize',
  () => wallet.finalizeClose(),
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
// A field with a button beside it does what the button does on Enter.
for (const [field, button] of [
  ['alias-input', 'pick-alias'],
  ['import-key', 'import-wallet'],
])
  $(field).addEventListener('keydown', event => {
    if (event.key === 'Enter') $(button).click();
  });
act(
  'pick-alias',
  async () => {
    const input = $<HTMLInputElement>('alias-input');
    await wallet.pickAlias(input.value);
    input.value = '';
  },
  () => `You are @${wallet.alias}.`,
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
  const amount = parseEther($<HTMLInputElement>('bank-amount').value.trim());
  if (amount <= 0n) throw new Error('Enter how much to put in your bank.');
  const receipt = await wallet.depositBank(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Put ${ether(amount)} ETH in your bank.`);
  await refreshBank();
});
act('bank-withdraw', async () => {
  const amount = parseEther($<HTMLInputElement>('bank-amount').value.trim());
  await wallet.withdrawBank(amount);
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Took ${ether(amount)} ETH out of your bank. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshBank();
});
act(
  'clear-alias',
  () => wallet.pickAlias(null),
  () => `You are ~${wallet.uname}.`,
);
for (const id of ['wallet-name-link', 'menu-profile'])
  $(id).addEventListener('click', event => {
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
      'The casino is unavailable or has changed. Your balance stays safe in the contract: export, close, challenge and collect all work from Wallet → Settings → Recovery. Playing and depositing need the casino. Reload to reconnect.',
    );
  // Everything with ETH waits for the deployment check, and a failed one shows here.
  wallet.verified.catch((error: any) => warn(`${error.shortMessage || error.message} Reload to check again.`));
  renderWallet();
  renderActivity();
  void refreshActivity();
  if (wallet.pending && !inbound(wallet.pending.kind))
    toast('An operation is saved and unfinished. Use Retry above to finish it safely.');
  await route();
} catch (error: any) {
  warn(`${error.shortMessage || error.message} Reload this page.`);
  for (const id of ['setup-wallet', 'add-to-balance', 'withdraw', 'address-send', 'import-wallet'])
    $<HTMLButtonElement>(id).disabled = true;
}
