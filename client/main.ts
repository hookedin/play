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
  generation: number;
  dispose: () => void;
  key: string;
  /** The last balance pushed into the iframe, so unchanged renders stay quiet; empty until the entry has loaded. */
  pushed: string | null;
}
/** A published game is `@alias/name` or `~uname/name`: its owner, written as they are written, and
 * the name it has in their profile. Any other game is linkable by its URL alone. */
type GameRoute = { owner: string; name: string } | { url: string };
/** What a profile records of a game it publishes: its key, and its developer, the account that publishes it. */
type Published = { key: string; developer: string };
import { formatEther, getAddress, parseEther, ZeroAddress } from 'ethers';
import { CasinoWallet } from './wallet.ts';
import { gameReceipt } from './wallet-games.ts';
import { developerBetStatus } from './game-account.ts';
import { withLock } from './storage.ts';
import { json, verifyEvidence, gameKey } from '../protocol/protocol.ts';
import { attachGameBridge, gameError } from './bridge.ts';
import { activityJSON, createActivityEntry, filterActivity, receiptSummary, developerBetSummary } from './activity.ts';
import type { BetRow } from './bets.ts';
import {
  betDetail,
  betRowElement,
  filterBets,
  groupRowElement,
  groupRows,
  percent,
  measuredReturn,
  totalCards,
  betTotals,
} from './bets.ts';
import { createGameLog, describeReceipt } from './game-log.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import type { LogKind } from './game-log.ts';
import config from './config.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const eth = (value: string | number | bigint | undefined, precision = networkDefaults.precision) => {
  const wei = BigInt(value || 0),
    smallest = 10n ** BigInt(18 - precision);
  if (wei > 0n && wei < smallest) return `<${formatEther(smallest)}`;
  // Truncated, never rounded: the game shows the same digits of the same money.
  return Number(formatEther(wei - (wei % smallest))).toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
};
const short = (value: string | null | undefined) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—');
let settingsWarning = null;
// Each launcher supplies its defaults; manual settings stay in the browser.
const networkSetting = `hookedin:${config.network}:selected-network`;
const network = localStorage.getItem(networkSetting) || config.network;
const networkDefaults =
  network === 'local'
    ? { precision: 4, total: '100000000000000000', deposit: '0.1' }
    : { precision: 6, total: '100000000000000', deposit: '0.001' };
function configuredEndpoint(name: string, fallback: string) {
  try {
    return endpoint(localStorage.getItem(`hookedin:${network}:${name}-url`) || fallback);
  } catch {
    settingsWarning = `The saved ${name} address is invalid. Change it in Settings.`;
    return fallback;
  }
}
const casinoURL = configuredEndpoint('casino', config.casino);
let active: ActiveGame | null = null,
  generation = 0,
  uiBusy = false,
  toastTimer: ReturnType<typeof setTimeout> | undefined,
  statusTimer: ReturnType<typeof setTimeout> | undefined;
let maxDepositEstimate: Awaited<ReturnType<CasinoWallet['maxDeposit']>> | null = null;
let historyBusy = false,
  historyError: any = null;
const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The casino's own profile: the games it ships with are published there. */
const HOUSE = 'hookedin';
/** How many games one profile holds. */
const MAX_GAMES = 100;
// A developer's diagnostic: the game page shows it below the game only when the wallet was opened with ?log.
$('game-activity').classList.toggle('hidden', !new URLSearchParams(location.search).has('log'));
const gameLog = createGameLog({
  list: $('game-activity-list'),
  search: $<HTMLInputElement>('game-activity-search'),
  empty: $('game-activity-empty'),
  count: $('game-activity-count'),
  filters: document.querySelectorAll<HTMLInputElement>('input[name="game-log-filter"]'),
});
const wallet = new CasinoWallet({
  casinoURL,
  network,
  trustedDeployment: config.deployment || null,
  onChange: () => renderWallet(),
  onProgress: message => {
    $('operation-text').textContent = message;
    $('operation-status').classList.remove('hidden');
    clearTimeout(statusTimer);
    statusTimer = undefined;
  },
  // A developer bet's receipt reaches the game that placed it as soon as the wallet has collected what it was paid.
  onGameReceipt: (game, receipt) => {
    if (!active || active.key !== game.key || !active.frame.contentWindow || active.pushed === null) return;
    const message = { hookedin: true, event: 'game.receipt', receipt: gameReceipt(game.id, receipt) };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.url).origin);
    gameLog.log('event', 'game.receipt', { description: describeReceipt(message.receipt), payload: message });
  },
});

function toast(message: string, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7500 : 4500);
}

function logGameActivity(title: string, payload?: unknown, kind: LogKind = 'client') {
  if (active) gameLog.log(kind, title, { payload });
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
    const message = error.shortMessage || error.message || String(error);
    logGameActivity(message, undefined, 'error');
    toast(message, true);
  } finally {
    uiBusy = false;
    renderWallet();
  }
}

/** One funded game per wallet across tabs, so no two tabs show limits against the same balance. */
let limitLock: (() => void) | null = null;
async function holdGameLimit() {
  if (limitLock) return;
  const acquired = Promise.withResolvers<boolean>(),
    released = Promise.withResolvers<void>();
  void withLock(`hookedin:game-limit:${wallet.storageKey}`, false, async held => {
    acquired.resolve(held);
    if (held) await released.promise;
  });
  if (!(await acquired.promise))
    throw new Error('Another tab already has a game playing with this balance. Finish or leave it there first.');
  limitLock = () => released.resolve();
}
/** Leaving a game releases its limit: the money was always in the balance. */
function closeGame() {
  if (!active) return;
  active.dispose();
  active.frame.remove();
  active = null;
  generation += 1;
  wallet.closeGame();
  limitLock?.();
  limitLock = null;
  if ($<HTMLDialogElement>('fund-dialog').open) $<HTMLDialogElement>('fund-dialog').close('');
}
/** The game went away without navigation (a balance or account change): the lobby replaces its URL. */
function abandonGame() {
  closeGame();
  if (!$('page-play').classList.contains('hidden')) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}

const pagePaths: Record<string, string> = {
  library: '/',
  wallet: '/wallet',
  games: '/games',
  bets: '/bets',
  bankroll: '/bankroll',
  settings: '/settings',
  activity: '/activity',
};
const gamePath = (route: GameRoute) =>
  'url' in route ? `/games/custom?url=${encodeURIComponent(route.url)}` : `/${route.owner}/${route.name}`;
/** How a player is written: an alias wears `@`, a uname wears `~`. */
const showName = (names: { uname?: string | null; alias?: string | null } | null) =>
  names?.alias ? '@' + names.alias : names?.uname ? '~' + names.uname : '—';
/** A player's page: everything the casino says about them, as anyone sees it. */
const profilePath = (name: string) => `/${name}`;
/** A game's public record: every bet anyone has placed in it, under its key. */
const gameBetsPath = (key: string) => `/games/${key.toLowerCase()}`;
const PAGE_TITLES: Record<string, string> = {
  library: 'Games',
  wallet: 'Wallet',
  games: 'My games',
  bets: 'Bets',
  bankroll: 'Bankroll',
  settings: 'Settings',
  activity: 'Activity',
  gamebets: 'Game record',
};
/** Show a section; the URL is the caller's responsibility. */
function showPage(page: string) {
  for (const section of document.querySelectorAll<HTMLElement>('.page'))
    section.classList.toggle('hidden', section.id !== `page-${page}`);
  for (const link of document.querySelectorAll<HTMLElement>('.nav-link'))
    link.classList.toggle('active', link.dataset.page === page || (page === 'play' && link.dataset.page === 'library'));
  document.title =
    page === 'play' && active
      ? `${active.identity.name} · HookedIn`
      : page === 'profile'
        ? `${$('profile-name').textContent} · HookedIn`
        : page === 'library'
          ? 'HookedIn'
          : `${PAGE_TITLES[page] ?? page} · HookedIn`;
  if (page === 'activity') {
    renderActivity();
    void refreshActivity();
  }
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
            ? `You hold ${formatEther(shares)} shares under the casino's signed statement number ${wallet.fund.sequence}.`
            : open
              ? ''
              : 'Deposit into your balance to buy shares.';
  $<HTMLButtonElement>('invest').disabled = uiBusy || !open || !f;
  for (const id of ['divest', 'divest-all']) $<HTMLButtonElement>(id).disabled = uiBusy || !open || !f || !shares;
}
function navigate(page: string, push = true, path = pagePaths[page]) {
  if (wallet.busy && active && wallet.pending?.game?.key === active.key) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current operation to finish before leaving the game.', true);
  }
  showPage(page);
  closeGame();
  if (push && location.pathname !== path) history.pushState(null, '', path);
}
/** Every page has a URL: `/`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`, `/activity`, `/@<alias>` or
 * `/~<uname>` for a player, the same and `/<game>` for a game they publish, `/games/<key>` for a game's public record,
 * and `/games/custom?url=<url>`. */
function parseRoute(url: URL): string | GameRoute | { profile: string } | { record: string } | { unknown: string } {
  // A player's sigil survives a link that encodes it: `encodeURIComponent` writes `@` as `%40`, and the
  // static host decodes the path the same way before it serves this page.
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const named = /^\/([~@][A-Za-z0-9_]{3,24})(?:\/([a-z0-9][a-z0-9-]{0,31}))?$/.exec(pathname);
  if (named) return named[2] ? { owner: named[1]!, name: named[2] } : { profile: named[1]! };
  if (pathname === '/games/custom') return { url: url.searchParams.get('url') || '' };
  const record = /^\/games\/(0x[0-9a-fA-F]{64})$/.exec(pathname);
  if (record) return { record: record[1]!.toLowerCase() };
  const page = Object.entries(pagePaths).find(([, path]) => path === pathname)?.[0];
  if (page) return page;
  return pathname === '/' ? 'library' : { unknown: pathname };
}
async function route(push = false) {
  const target = parseRoute(new URL(location.href));
  if (typeof target === 'string') return navigate(target, push);
  if ('unknown' in target) {
    navigate('library', false, '/');
    history.replaceState(null, '', '/');
    return void toast(`Nothing lives at ${target.unknown}. A player is @alias or ~uname.`, true);
  }
  if ('profile' in target) return void openProfile(target.profile, push);
  if ('record' in target) return void openGameRecord(target.record, push);
  if (active && active.path === gamePath(target)) return showPage('play');
  const opened = await task(async () => {
    if ('url' in target) await loadGame(target.url, target, push);
    else {
      const published = await wallet.api(`/api/players/${target.owner}/${target.name}`);
      if (!published.url) throw new Error('This game is not published at that name.');
      await loadGame(published.url, target, push, published);
    }
    return true;
  });
  if (!opened) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}

/**
 * The top bar holds the balance and the way into the wallet, or for an account with none, the way to deposit. An open
 * game hides the figure: the game shows its own money, as its animations reveal it.
 */
function renderMoney() {
  const funded = wallet.funded,
    balance = BigInt(wallet.publicState?.balance || 0);
  $('wallet-button-amount').innerHTML = '';
  $('wallet-button-amount').append(
    eth(balance),
    Object.assign(document.createElement('small'), { textContent: 'ETH' }),
  );
  $('wallet-button-amount').classList.toggle('hidden', Boolean(active) || !funded);
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
    logGameActivity('Player named', { uname: wallet.uname });
    active.pushed = null;
    active.frame.src = active.frame.src;
  }
  if ($<HTMLDialogElement>('fund-dialog').open) renderFundDialog();
  // The game's own balance view follows the wallet: top-ups and recoveries push without polling.
  const balance = wallet.gameLimit();
  const pushed = JSON.stringify(balance);
  if (active.pushed !== null && pushed !== active.pushed && active.frame.contentWindow) {
    active.pushed = pushed;
    const message = { hookedin: true, event: 'game.balance', ...balance };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.url).origin);
    gameLog.log('event', 'game.balance', {
      description: `balance ${formatEther(balance.balance)} ETH${balance.pending ? ' · pending operation' : ''}`,
      payload: message,
    });
  }
}
/** The slider runs linearly from nothing to the whole playable balance, a hundredth of it a step. */
const SLIDER_STEPS = 100n;
const sliderAmount = (total: bigint, value: string) => (total * BigInt(value)) / SLIDER_STEPS;
// The last limit the player chose for a game is only the next suggestion; authority comes from the dialog alone.
const limitSetting = () => `hookedin:${network}:game-limit:${active?.key}`;
/** The wallet's own dialog: the sole grant of spending authority over ETH. It says what the game may play with now,
 * what it would, and out of how much, because those are the whole of what is being authorized. */
function renderFundDialog() {
  if (!active) return;
  const name = active.identity.name;
  const limit = BigInt(wallet.game?.balance || '0');
  $('fund-title').textContent = limit > 0n ? `Change ${name}'s limit` : `Play ${name} with ETH`;
  const total = wallet.playableBalance(),
    slider = $<HTMLInputElement>('fund-slider');
  let amount = -1n;
  try {
    amount = parseEther($<HTMLInputElement>('fund-amount').value.trim() || '0');
  } catch {}
  const valid = amount >= 0n && amount <= total;
  $('fund-total').textContent = `${formatEther(total)} ETH, your balance`;
  $<HTMLButtonElement>('fund-take-all').classList.toggle('hidden', limit === 0n);
  slider.value = String(valid && total > 0n ? (amount * SLIDER_STEPS) / total : 0n);
  $('fund-help').textContent = !valid
    ? amount > total
      ? `That is more than your balance of ${formatEther(total)} ETH.`
      : 'Enter an amount in ETH.'
    : total === 0n
      ? 'Your balance is empty. Deposit to play with ETH.'
      : amount === limit
        ? `This is ${name}'s limit now.`
        : amount > limit
          ? `${name} may play with ${formatEther(amount - limit)} ETH more.`
          : `${formatEther(limit - amount)} ETH comes back to your balance.`;
  $('fund-help').classList.toggle('check-failed', !valid);
  $<HTMLButtonElement>('fund-confirm').disabled = !valid || amount === limit || uiBusy || wallet.busy;
  $('fund-confirm').textContent = !valid
    ? 'Allow'
    : amount < limit
      ? `Take back ${formatEther(limit - amount)} ETH`
      : `Allow ${formatEther(amount)} ETH`;
}
let fundRequest: { resolve: (amount: bigint | null) => void } | null = null;
/** Opened by the game's request for money. With nothing in the balance to allow, the wallet opens on Deposit
 * instead, and the game hears that it has no more. */
function openFundDialog({ amount, asked = false }: { amount?: bigint; asked?: boolean }) {
  if (!active) return Promise.resolve<bigint | null>(null);
  fundRequest?.resolve(null);
  if (wallet.playableBalance() === 0n && BigInt(wallet.game?.balance || '0') === 0n) {
    openWallet('deposit');
    return Promise.resolve<bigint | null>(null);
  }
  const dialog = $<HTMLDialogElement>('fund-dialog');
  // The game page shows nothing but the game, so the dialog that grants it money says who it is.
  const host = new URL(active.frame.src).host;
  $('fund-who').textContent = active.publisher
    ? `Published by ${active.publisher}, served from ${host}. Its developer earns half of each casino bet's commission, and takes and settles its developer bets.`
    : `Served from ${host}. Nobody publishes it, so nobody earns from it.`;
  const total = wallet.playableBalance(),
    limit = BigInt(wallet.game?.balance || '0'),
    requested = amount && amount > 0n ? limit + amount : 0n,
    remembered = BigInt(localStorage.getItem(limitSetting()) || networkDefaults.total),
    // The player's own visit shows the limit as it is, or what they last chose; a game's request
    // suggests exactly what it asked for, never more.
    suggested = asked && requested ? requested : limit > 0n ? limit : remembered;
  $<HTMLInputElement>('fund-amount').value = formatEther(suggested > total ? total : suggested);
  renderFundDialog();
  if (!dialog.open) dialog.showModal();
  $<HTMLInputElement>('fund-amount').select();
  return new Promise<bigint | null>(resolve => {
    fundRequest = { resolve };
  });
}

// --- The wallet: the balance, the vault, and moving money between them and out ---------------------------

type WalletTab = 'deposit' | 'withdraw' | 'send';
/** The wallet's dialog, on one of its tabs. */
function openWallet(tab: WalletTab = 'deposit') {
  $('account-menu').hidePopover?.();
  selectTab(tab);
  const dialog = $<HTMLDialogElement>('wallet-dialog');
  if (!dialog.open) dialog.showModal();
  renderWallet();
}
function selectTab(tab: WalletTab) {
  if (tab === 'send' && wallet.mode !== 'demo') tab = 'deposit';
  for (const button of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-tab]'))
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const panel of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-panel]'))
    panel.hidden = panel.dataset.panel !== tab;
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
  renderMoney();
  const busy = uiBusy || wallet.busy;
  const ready = state.address === wallet.address;
  const observed = Boolean(state.observedAt);
  const balance = BigInt(state.balance || 0),
    arriving = BigInt(state.arriving || 0),
    vault = BigInt(state.nativeBalance || '0');
  for (const id of ['balance-amount', 'sheet-balance']) $(id).textContent = eth(balance);
  // The vault is read from the chain: until it has been, there is no figure to show.
  for (const id of ['vault-amount', 'sheet-vault']) $(id).textContent = observed ? eth(vault) : '—';
  $('balance-note').textContent = arriving
    ? `${eth(arriving)} ETH of it is arriving from your vault.`
    : Number(state.channelStatus) === 2
      ? 'Closing: once its 24-hour window ends, finish the close under Recovery and collect it.'
      : 'What games play with.';
  const earnings = state.developerEarnings;
  // The tally the casino keeps for this account, collected into its balance.
  $('developer-earnings').classList.toggle('hidden', !BigInt(earnings?.earned || 0));
  $('developer-earnings').textContent = earnings
    ? `Your games have earned ${formatEther(earnings.earned)} ETH in commission; ${formatEther(earnings.collected)} ETH of it is collected into your balance.`
    : '';
  $('faucet-link').classList.toggle('hidden', wallet.expectedChainId !== 11155111n);
  $('wallet-address').textContent = wallet.address;
  $('wallet-mode').textContent =
    `${wallet.mode === 'demo' ? 'A wallet made in this browser' : 'Your connected browser wallet'} · ${wallet.networkName}`;
  $('chain-id').textContent = state.chainId;

  // Deposit: from the vault into the balance. An empty vault asks for ETH first.
  if (
    maxDepositEstimate &&
    (maxDepositEstimate.address !== wallet.address || maxDepositEstimate.nativeBalance !== vault)
  )
    maxDepositEstimate = null;
  let depositAmount = 0n;
  try {
    depositAmount = parseEther($<HTMLInputElement>('deposit-amount').value.trim());
  } catch {}
  const aboveReserve = vault > wallet.gasReserve,
    closing = Boolean(wallet.channel) && !wallet.funded,
    depositTooLarge = aboveReserve && depositAmount >= vault - wallet.gasReserve;
  $('receive').closest<HTMLElement>('[data-panel]')!.toggleAttribute('data-empty', !aboveReserve);
  $('deposit-help').textContent = !ready
    ? 'Connecting to your wallet…'
    : closing
      ? 'Your balance is closing. Deposit once the close is done.'
      : !aboveReserve
        ? `Your vault needs more than ${formatEther(wallet.gasReserve)} ETH, which it keeps for network fees.`
        : depositTooLarge
          ? `Too much: your vault keeps ${formatEther(wallet.gasReserve)} ETH for network fees. Use Max.`
          : maxDepositEstimate
            ? `Most you can deposit: ${eth(maxDepositEstimate.amount)} ETH, after up to ${eth(maxDepositEstimate.maxFee)} ETH in fees.`
            : `One transaction from your vault. It keeps ${formatEther(wallet.gasReserve)} ETH for network fees.`;
  $('deposit-help').classList.toggle('check-failed', depositTooLarge);
  $<HTMLButtonElement>('deposit').disabled =
    busy ||
    !ready ||
    !observed ||
    closing ||
    Boolean(wallet.pending && wallet.pending.kind !== 'taken-in') ||
    !aboveReserve ||
    depositTooLarge ||
    depositAmount <= 0n ||
    wallet.recoveryOnly;
  $<HTMLButtonElement>('max-deposit').disabled = busy || !ready || !observed || closing || !aboveReserve;
  $('deposit').textContent = depositAmount > 0n ? `Deposit ${formatEther(depositAmount)} ETH` : 'Deposit';
  $<HTMLButtonElement>('copy-address').disabled = !ready;
  const receiveStatus = !ready
    ? 'Connecting to your wallet…'
    : vault > 0n
      ? `${eth(vault)} ETH in your vault${observed ? `, checked ${new Date(state.observedAt).toLocaleTimeString()}` : ''}.`
      : 'Waiting for ETH at this address. It shows here on its own.';
  if ($('receive-status').textContent !== receiveStatus) $('receive-status').textContent = receiveStatus;
  $('setup-wallet').classList.toggle('hidden', wallet.mode !== 'demo' || !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('setup-wallet').disabled = busy;

  // Withdraw: the whole balance to the vault, in one transaction.
  const withdrawable = wallet.funded && !wallet.recoveryOnly;
  $<HTMLButtonElement>('withdraw').disabled =
    busy || !ready || !withdrawable || Boolean(wallet.pending) || balance === 0n;
  $('withdraw').textContent = balance > 0n ? `Withdraw ${eth(balance)} ETH to your vault` : 'Withdraw';
  $('withdraw-help').textContent = wallet.recoveryOnly
    ? 'The casino is unavailable: close without it under Wallet → Recovery.'
    : closing
      ? 'Your balance is closing: once its 24-hour window ends, finish the close under Recovery and collect it.'
      : !wallet.funded || balance === 0n
        ? 'Nothing to withdraw: your balance is empty.'
        : wallet.pending?.kind === 'taken-in'
          ? 'A deposit is on its way into your balance. Withdraw once it has arrived.'
          : wallet.pending
            ? 'Finish the operation in flight first.'
            : active
              ? 'The open game gives back what it holds.'
              : '';

  // Send: from the vault to any address, for a wallet made in this browser; a connected wallet sends itself.
  $('send-tab').classList.toggle('hidden', wallet.mode !== 'demo');
  $('send-open').classList.toggle('hidden', wallet.mode !== 'demo');
  let sendAmount = 0n;
  try {
    sendAmount = parseEther($<HTMLInputElement>('send-amount').value.trim());
  } catch {}
  $<HTMLButtonElement>('send').disabled =
    busy || !ready || sendAmount <= 0n || !$<HTMLInputElement>('send-to').value.trim();
  $<HTMLButtonElement>('max-send').disabled = busy || !ready || vault === 0n;
  $('send').textContent = sendAmount > 0n ? `Send ${formatEther(sendAmount)} ETH` : 'Send';
  $('send-help').textContent = wallet.channel
    ? `Your vault keeps ${formatEther(wallet.gasReserve)} ETH while your balance is open, for the fees closing it needs.`
    : 'Sends from your vault on ' + wallet.networkName + '.';

  $('pending-banner').classList.toggle(
    'hidden',
    !((wallet.pending && wallet.pending.kind !== 'taken-in') || wallet.needsOpening || wallet.transactionIntent) ||
      busy,
  );
  const challengeExpired = Date.now() / 1000 >= Number(state.deadline);
  $('challenge-banner').classList.toggle('hidden', !state.needsChallenge);
  $('challenge-summary').textContent = state.needsChallenge
    ? challengeExpired
      ? 'The challenge deadline has passed. The casino closed with an older balance; keep your recovery bundle.'
      : `The casino is closing your balance with an older state. Challenge it before ${new Date(Number(state.deadline) * 1000).toLocaleString()}.`
    : '';
  $<HTMLButtonElement>('challenge-now').disabled = busy || !state.needsChallenge || challengeExpired;
  $('pending-summary').textContent = wallet.transactionIntent
    ? wallet.transactionIntent.hash
      ? 'A transaction is waiting for confirmation. Retry checks it, and Speed up resends it with a higher fee.'
      : 'Your browser wallet did not return a transaction. Retry checks what happened, then asks to send the same transaction again.'
    : wallet.needsOpening
      ? 'Your deposit needs finishing. Its keys are saved: retry to complete it.'
      : 'An operation is saved and unanswered. Retry sends exactly the same request again.';
  $<HTMLButtonElement>('speed-up-transaction').classList.toggle('hidden', !wallet.transactionIntent);
  $<HTMLButtonElement>('speed-up-transaction').disabled = busy || !wallet.transactionIntent;
  $<HTMLButtonElement>('export-evidence').disabled = busy || !wallet.channel;
  $<HTMLButtonElement>('start-close').disabled = busy || !wallet.channel || Number(state.channelStatus) !== 1;
  for (const id of ['connect-browser', 'import-wallet', 'recover-wallet']) $<HTMLButtonElement>(id).disabled = busy;
  $('wallet-caption').textContent =
    wallet.mode === 'demo'
      ? 'This wallet was made in this browser, and its key is stored only here.'
      : 'Your connected browser wallet holds the key; this is its address.';
  const accounts = $<HTMLSelectElement>('saved-wallets');
  const addresses = wallet.savedFundingAddresses || [];
  const account = wallet.mode === 'demo' ? wallet.address : '';
  if (JSON.stringify([...accounts.options].map(o => o.value)) !== JSON.stringify(addresses))
    accounts.replaceChildren(...addresses.map(address => new Option(address, address)));
  // The list follows the account in use, but an account the player has picked and not yet
  // selected is theirs: a background observation re-renders every few seconds, and setting the
  // value every time took their choice back before they could act on it.
  if (shownAccount !== account || !addresses.includes(accounts.value)) accounts.value = account;
  shownAccount = account;
  accounts.disabled = busy;
  $<HTMLButtonElement>('select-saved-wallet').disabled = busy || !addresses.length;
  $<HTMLButtonElement>('export-key').disabled = wallet.mode !== 'demo';
  // The notice of what the wallet was doing goes a moment after it is done, however often the page renders meanwhile.
  if (!busy && !statusTimer && !$('operation-status').classList.contains('hidden'))
    statusTimer = setTimeout(() => {
      $('operation-status').classList.add('hidden');
      statusTimer = undefined;
    }, 2200);
  if (!$('page-bets').classList.contains('hidden')) renderBets();
  if (!$('page-games').classList.contains('hidden')) renderMyGames();
  renderDeveloperBets();
  if (!$('page-activity').classList.contains('hidden')) renderActivity();
  renderClaims();
  renderRecovery();
  renderGameAccount();
}

function renderDeveloperBets() {
  const list = $('wallet-developer-bets'),
    developerBets = Object.entries(wallet.developerBets),
    receiptsById = new Map(wallet.history.map(receipt => [receipt.operationId, receipt]));
  $('developer-bets').classList.toggle('hidden', !developerBets.length && !wallet.developerBetError);
  $('developer-bets-status').textContent = wallet.developerBetError
    ? `This may be out of date. ${wallet.developerBetError}`
    : 'Bets waiting for their developers, and what they were paid on its way to your balance.';
  $('developer-bets-status').classList.toggle('check-failed', Boolean(wallet.developerBetError));
  $<HTMLButtonElement>('refresh-developer-bets').disabled = historyBusy || wallet.busy || !wallet.channel;
  const existing = new Map(
    [...list.children].map(row => [(row as HTMLElement).dataset.bet, row as HTMLDetailsElement]),
  );
  list.replaceChildren(
    ...developerBets.map(([hash, tracked]) => {
      const receipt = tracked.operationId ? receiptsById.get(tracked.operationId) : undefined;
      const state: PlayerDeveloperBet = tracked.state ?? {
        bet: hash,
        game: tracked.game,
        status: 'open',
        stake: String(receipt?.stake ?? 0),
        collected: false,
      };
      const presentation = developerBetSummary(state, receipt?.game?.name);
      const payload = activityJSON({ ...state, error: tracked.error }),
        previous = existing.get(hash);
      if (previous?.querySelector('.activity-payload')?.textContent === payload) return previous;
      const item = createActivityEntry({
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
      item.dataset.bet = hash;
      (item as HTMLDetailsElement).open = previous?.open ?? false;
      return item;
    }),
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
  const list = $('activity-list');
  const existing = new Map(
    [...list.children].map(row => [(row as HTMLElement).dataset.operationId, row as HTMLDetailsElement]),
  );
  // A deposit taken into the balance is the deposit's own bookkeeping: the deposit is what the player sees.
  const receipts = wallet.history.filter(receipt => receipt.kind !== 'taken-in');
  for (const [index, receipt] of receipts.entries()) {
    const payload = activityJSON(receipt),
      previous = existing.get(receipt.operationId);
    let item: HTMLElement | undefined = previous;
    // Keep unchanged rows mounted so polling preserves open details, selection and focus.
    if (!previous || previous.querySelector('.activity-payload')?.textContent !== payload) {
      const operation = receipt.proof?.step?.operation;
      const channelId = operation?.channelId || receipt.proof?.base?.channelId;
      const gameName = receipt.game?.name;
      const presentation = receiptSummary(receipt);
      const facts: [string, string | Node][] = [['Operation ID', receipt.operationId]];
      if (channelId) facts.push(['Channel', channelId]);
      if (operation?.sequence !== undefined) facts.push(['Sequence', String(operation.sequence)]);
      if (receipt.commission !== undefined) facts.push(['Commission', `${formatEther(receipt.commission)} ETH`]);
      if (receipt.to) facts.push(['To', receipt.to]);
      if (receipt.txHash) facts.push(['Transaction', transactionLink(receipt.txHash, receipt.txHash)]);
      if (receipt.blockNumber !== undefined) facts.push(['Block', String(receipt.blockNumber)]);
      item = createActivityEntry({
        ...presentation,
        timestamp: receipt.createdAt,
        payload,
        facts,
        description: [gameName, presentation.description].filter(Boolean).join(' · '),
      });
      item.dataset.operationId = receipt.operationId;
      (item as HTMLDetailsElement).open = previous?.open || false;
      previous?.replaceWith(item);
    }
    if (list.children[index] !== item) list.insertBefore(item!, list.children[index] || null);
    existing.delete(receipt.operationId);
  }
  for (const row of existing.values()) row.remove();
  filterActivity(list, $<HTMLInputElement>('activity-search').value, $('activity-empty'), $('activity-visible-count'));
}
/** The balance's channel, for recovery: its state on the chain, and the close, challenge and collect a player can do
 * without the casino. */
function renderRecovery() {
  const state = wallet.publicState;
  const open = Boolean(state.channelId),
    status = Number(state.channelStatus);
  $('channel-status').textContent = state.channelId
    ? `Channel ${short(state.channelId)} · ${status === 2 ? 'closing' : status === 1 ? 'open' : 'opening'}`
    : wallet.missingChannel
      ? 'This account has a balance open that this browser has no evidence for: import its recovery bundle.'
      : 'No balance open.';
  $('channel-observation').classList.toggle('hidden', !open);
  $('channel-observation').textContent =
    `Deposited ${eth(state.protectedDeposit || '0')} ETH, protected by the contract. Last checked ${state.observedAt ? new Date(state.observedAt).toLocaleString() : 'never: refresh before acting'} · saved sequence ${state.savedSequence || '0'}${status === 2 ? ` · the close proposes sequence ${state.closingSequence || '0'}, ${eth(state.balanceAtRisk || '0')} ETH less than yours` : ''}${state.challengePending ? ' · a challenge is on its way' : ''}.`;
  $('challenge-deadline').textContent = Number(state.deadline)
    ? `The close can be challenged until ${new Date(Number(state.deadline) * 1000).toLocaleString()}.`
    : '';
  const busy = uiBusy || wallet.busy;
  $<HTMLButtonElement>('channel-export').disabled = !wallet.channel || busy;
  $<HTMLButtonElement>('channel-start-close').disabled = !wallet.channel || status !== 1 || busy;
  $<HTMLButtonElement>('channel-challenge').disabled =
    !state.needsChallenge || Date.now() / 1000 >= Number(state.deadline) || busy;
  $<HTMLButtonElement>('channel-finalize').disabled =
    status !== 2 || Date.now() / 1000 < Number(state.deadline) || busy;
}
let claimLimit = 20;
let claimsShown = '';
const claimRecipients = new Map<string, string>();
/** What closed balances are still owed: shown only while something is. */
function renderClaims() {
  const claims = [...(wallet.publicState.claims || [])].filter(
    (claim: any) => BigInt(claim.amount) > BigInt(claim.paid),
  );
  $('claims').classList.toggle('hidden', !claims.length);
  const list = $('claim-list');
  // The wallet re-renders on every observation. Rebuild the rows only when they differ, so a recipient
  // address being typed keeps its text and focus.
  const describe = (claim: any) => {
    const unpaid = BigInt(claim.amount) - BigInt(claim.paid),
      ready = BigInt(claim.protectedRemaining) + BigInt(claim.allocatedWinnings || '0');
    return (
      `Channel ${short(claim.channelId)}: ${eth(unpaid)} ETH still owed of ${eth(claim.amount)} ETH. ` +
      (ready > 0n
        ? `${eth(ready)} ETH can be collected now.`
        : `Its ${eth(claim.winningsRemaining)} ETH of winnings wait for the bankroll to have the cash.`)
    );
  };
  const visible = claims.slice(0, claimLimit);
  const shown = JSON.stringify([visible.map(describe), claims.length, wallet.busy || uiBusy]);
  if (shown === claimsShown) return;
  claimsShown = shown;
  list.replaceChildren();
  for (const claim of visible) {
    const row = document.createElement('div'),
      text = document.createElement('p');
    text.textContent = describe(claim);
    const collect = document.createElement('button');
    collect.className = 'button small';
    collect.type = 'button';
    collect.textContent = 'Collect';
    collect.disabled = wallet.busy || uiBusy;
    collect.addEventListener('click', () =>
      task(async () => {
        const before = BigInt(claim.paid);
        await wallet.claim(claim.channelId);
        const after = wallet.publicState.claims.find((c: any) => c.channelId === claim.channelId);
        const collected = BigInt(after?.paid ?? before) - before;
        toast(
          collected > 0n
            ? `Collected ${eth(collected)} ETH to your vault.`
            : 'Nothing could be paid yet: the bankroll has no cash for these winnings.',
        );
      }),
    );
    const destination = document.createElement('input');
    destination.placeholder = 'Or another address, 0x…';
    destination.setAttribute('aria-label', 'Collect to another address');
    destination.value = claimRecipients.get(claim.channelId) ?? '';
    destination.addEventListener('input', () => claimRecipients.set(claim.channelId, destination.value));
    const redirect = document.createElement('button');
    redirect.className = 'text-button';
    redirect.type = 'button';
    redirect.textContent = 'Collect there';
    redirect.disabled = collect.disabled;
    redirect.addEventListener('click', () =>
      task(async () => {
        const recipient = destination.value.trim();
        await wallet.claim(claim.channelId, recipient);
        toast(`Collected what could be paid to ${short(recipient)}.`);
      }),
    );
    const evidence = document.createElement('button');
    evidence.className = 'text-button';
    evidence.type = 'button';
    evidence.textContent = 'Export evidence';
    evidence.addEventListener('click', () =>
      task(async () => downloadEvidence(await wallet.exportEvidence(claim.channelId))),
    );
    row.className = 'claim-row';
    row.append(text, collect, destination, redirect, evidence);
    list.append(row);
  }
  if (claims.length > claimLimit) {
    const more = document.createElement('button');
    more.className = 'text-button';
    more.type = 'button';
    more.textContent = `Show more (${claims.length - claimLimit} more)`;
    more.addEventListener('click', () => {
      claimLimit += 20;
      renderClaims();
    });
    list.append(more);
  }
}

function transactionLink(hash: string, label?: string) {
  const link = document.createElement(
    wallet.expectedChainId === 11155111n && /^0x[0-9a-f]{64}$/i.test(hash) ? 'a' : 'span',
  );
  link.textContent = label || 'Transaction ID unavailable';
  if (link instanceof HTMLAnchorElement) {
    link.href = `https://sepolia.etherscan.io/tx/${hash}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'View this transaction on Sepolia Etherscan';
    link.addEventListener('click', event => event.stopPropagation());
  }
  return link;
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
    renderDeveloperBets();
    renderActivity();
    if (!$('page-bets').classList.contains('hidden')) renderBets();
    if (!$('page-games').classList.contains('hidden')) renderMyGames();
  }
}

/** Files a player picks are read here, so a damaged one says so instead of showing a parser's error. */
async function readJSONFile(file: File, what: string) {
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error(`That file is not a ${what}. Pick the JSON file this wallet wrote.`);
  }
}
function safeURL(value: string, base: string | undefined = undefined) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error('Enter the full URL of the game, starting with https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Games must use an HTTP or HTTPS URL without credentials.');
  return url;
}

function endpoint(value: string) {
  const url = safeURL(value);
  if (url.search || url.hash) throw new Error('Service addresses cannot include a query or fragment.');
  return url.href.replace(/\/$/, '');
}

/** A game's address, checked before the wallet frames it: HTTP(S) without credentials, and never the wallet's own
 * origin, where a frame could lift its own sandbox and read the wallet's storage. */
function gameURL(value: string) {
  const url = safeURL(value);
  if (url.origin === location.origin) throw new Error('Games cannot be served from the wallet’s own origin.');
  return url;
}
/** The icon a game is shown by: icon.svg beside its page. */
const iconURL = (url: string) => new URL('icon.svg', url).href;
/** How a game is named in the wallet: the name it is published under, in words. */
const gameTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

/** A game's icon: icon.svg beside its page, over the game's initial, which shows when it has none. */
function gameIcon(url: string, name: string) {
  const tile = document.createElement('span'),
    image = document.createElement('img');
  tile.className = 'game-icon';
  tile.dataset.initial = name.charAt(0).toUpperCase();
  image.src = iconURL(url);
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => image.remove(), { once: true });
  tile.append(image);
  return tile;
}

/** Open a game. A published one comes with what its profile records: its key, and its developer, the account that
 * publishes it. A game opened by its URL alone is nobody's: it has the key of that URL, and takes no developer bets. */
async function loadGame(url: string, gameRoute: GameRoute, push = true, published?: Published) {
  const entry = gameURL(url);
  const slug = 'url' in gameRoute ? undefined : gameRoute.name;
  closeGame();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'",
  );
  const currentGeneration = ++generation;
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
    active?.generation === currentGeneration &&
    active.frame === frame &&
    (active.channelId === null || active.channelId === wallet.channelId);
  const path = gamePath(gameRoute);
  await walletStarted;
  const key = wallet.openGame(identity);
  active = {
    channelId: wallet.channelId,
    identity,
    publisher: 'owner' in gameRoute ? gameRoute.owner : null,
    path,
    frame,
    generation: currentGeneration,
    dispose: () => {},
    key,
    pushed: null,
  };
  gameLog.clear();
  $<HTMLInputElement>('game-activity-search').value = '';
  logGameActivity('Game opened', {
    url: entry.href,
    origin: entry.origin,
    sandbox: frame.getAttribute('sandbox'),
    developer: identity.developer,
    channelId: active.channelId,
    gameKey: key,
    path,
  });
  frame.addEventListener('load', () => {
    if (!isCurrent()) return;
    logGameActivity('Game iframe loaded', { url: entry.href });
    active!.pushed = '';
    renderGameAccount();
    // The game's own keys, such as Space to play, work without a click into it first.
    if (!document.querySelector('dialog[open]')) frame.focus();
  });
  active.dispose = attachGameBridge({
    iframe: frame,
    origin: entry.origin,
    isCurrent,
    onActivity: (type, data) => gameLog.bridge(type, data),
    onRequest: async (method, params) => {
      if (method === 'wallet.hello') return wallet.gameHello();
      // The player is named once the wallet has heard from the casino, and a game finds its saved rounds by that name:
      // after a reload it waits for it.
      if (method === 'wallet.info') {
        await wallet.synced?.catch(() => {});
        const info = wallet.gameInfo();
        if (isCurrent()) active!.uname = info.uname;
        return info;
      }
      if (method === 'wallet.round') return wallet.gameRound(params.id);
      if (method === 'game.receipt') return wallet.gameReceipt(params.id);
      // What the player is doing in the wallet comes first; the wallet's own checks finish and the game's request
      // follows.
      if (uiBusy) throw gameError('busy', 'The wallet is processing another operation.');
      await wallet.actionDone;
      if (method === 'game.requestFunds') {
        const requested = params.amount === undefined ? undefined : BigInt(params.amount);
        const amount = await openFundDialog({ amount: requested, asked: true });
        if (!isCurrent()) throw gameError('game-closed', 'The game was closed.');
        return { funded: amount !== null, amount: amount === null ? null : String(amount), ...wallet.gameLimit() };
      }
      if (method === 'game.casinoBet') return wallet.gameCasinoBet(params);
      if (method === 'game.developerBet') return wallet.gameDeveloperBet(params);
      return wallet.gamePayment(params);
    },
    onError: message => toast(message, true),
  });
  frame.src = entry.href;
  // The game's icon stands in for it until its page has loaded.
  const loading = document.createElement('div'),
    label = document.createElement('p');
  loading.className = 'game-loading';
  label.textContent = `Loading ${identity.name}…`;
  loading.append(gameIcon(entry.href, identity.name), label);
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
  const card = document.createElement('a'),
    title = document.createElement('h3'),
    link = document.createElement('span');
  card.className = 'game-card';
  card.href = gamePath(route);
  title.textContent = gameTitle(game.name);
  link.className = 'catalog-link';
  link.textContent = `${route.owner}/${route.name}`;
  card.append(gameIcon(game.url, title.textContent), title, link);
  // A bet's receipt names its game only by this key, so remembering the card is what lets a line of
  // history be opened again, and its public record found.
  const key = game.key;
  knownGames.set(key.toLowerCase(), { route, ...game, name: title.textContent });
  const record = document.createElement('span');
  record.className = 'catalog-record';
  record.textContent = 'Every bet ↗';
  record.title = `Every bet anyone has placed in ${title.textContent}`;
  record.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void openGameRecord(key.toLowerCase());
  });
  card.append(record);
  card.addEventListener('click', event => {
    event.preventDefault();
    task(() => loadGame(game.url, route, true, game));
  });
  return card;
}
/** Every game a profile publishes, as cards. */
const profileCards = (owner: string, games: (Published & { name: string; url: string })[]) =>
  games.map(game => gameCard({ owner, name: game.name }, game));
/** The lobby is what `@hookedin` publishes, and whatever this account publishes itself. It needs nothing of the
 * wallet but the casino's address, so it shows before the wallet has started. */
async function loadLibrary() {
  const list = $('game-library');
  try {
    const response = await fetch(`${casinoURL}/api/players/@${HOUSE}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error();
    const house = await response.json();
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
  navigate('profile', push, profilePath(name));
  try {
    const profile = await wallet.api(`/api/players/${name}`);
    $('profile-name').textContent = showName(profile);
    // An alias is what they are called; the uname is who they are, and is shown beside it.
    $('profile-uname').textContent = profile.alias ? '~' + profile.uname : '';
    document.title = `${showName(profile)} · HookedIn`;
    $('profile-since').textContent = `Playing here since ${new Date(profile.since).toLocaleDateString()}.`;
    const card = document.createElement('div'),
      label = document.createElement('span'),
      amount = document.createElement('strong'),
      note = document.createElement('span');
    card.className = 'money-card';
    label.className = 'label';
    label.textContent = 'Bets';
    amount.textContent = String(profile.stats.plays);
    note.className = 'muted';
    note.textContent = `Staked ${eth(profile.stats.staked, 4)} ETH · won ${eth(profile.stats.won, 4)} ETH`;
    card.append(label, amount, note);
    $('profile-stats').replaceChildren(card);
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
  $<HTMLAnchorElement>('menu-profile').href = name ? profilePath(name) : '/';
  $('menu-profile').classList.toggle('hidden', !name);
  $('wallet-name').textContent = name ?? 'No name yet: your first deposit gives you one.';
  $<HTMLAnchorElement>('wallet-name-link').href = name ? profilePath(name) : '/';
  for (const id of ['pick-alias', 'publish-game']) $<HTMLButtonElement>(id).disabled = uiBusy || !open;
  for (const id of ['bank-deposit', 'bank-withdraw'])
    $<HTMLButtonElement>(id).disabled = uiBusy || !wallet.channel?.key || Boolean(wallet.pending);
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
    ...games.map(game => {
      const row = document.createElement('div'),
        label = document.createElement('span'),
        remove = document.createElement('button');
      row.className = 'game-row';
      label.textContent = `${name}/${game.name} · ${game.url}`;
      remove.className = 'text-button';
      remove.type = 'button';
      remove.textContent = 'Take down';
      remove.title = `Take ${name}/${game.name} out of the lobby`;
      remove.disabled = uiBusy;
      remove.addEventListener('click', () =>
        task(async () => {
          await wallet.publishGame(game.name, null);
          await loadLibrary();
          toast(`${name}/${game.name} is taken down.`);
        }),
      );
      row.append(label, remove);
      return row;
    }),
  );
}
/** This account's bank as a developer, as the casino has it now. */
async function refreshBank() {
  if (!wallet.channel?.key) return void ($('bank-balance').textContent = '—');
  const { balance } = await wallet.bankBalance();
  $('bank-balance').textContent = `${formatEther(balance)} ETH`;
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
/** Every settled bet this wallet signed. A rejected request never became a bet, so it stays in
 * Activity; only a bet whose odds the wallet recorded can say what it was worth. */
function ownBets(): BetRow[] {
  return wallet.history
    .filter(
      (receipt: any) =>
        receipt.status === 'signed' &&
        ((receipt.kind === 'casino-bet' && receipt.expectedPayout !== undefined) ||
          // A developer bet is one once what it was paid is collected.
          (receipt.kind === 'developer-bet' && developerBetStatus(receipt) === 'settled')),
    )
    .map((receipt: any) => ({
      at: Date.parse(receipt.createdAt),
      game: receipt.game?.name || 'Unnamed game',
      key: receipt.game?.key ?? null,
      ...(receipt.details?.group ? { group: receipt.details.group } : {}),
      stake: BigInt(receipt.stake),
      payout: BigInt(receipt.payout ?? 0),
      expected: receipt.expectedPayout === undefined ? null : BigInt(receipt.expectedPayout),
      maxPayout: receipt.maxPayout === undefined ? null : BigInt(receipt.maxPayout),
      operation: receipt.operationId,
      receipt,
    }));
}
/** Open a game's public record. From a bet, the key is all that is needed. */
const showGameRecord = (row: { key?: string | null }) => {
  if (row.key) void openGameRecord(row.key);
};
/** One bet in full: the odds it rode, where its round landed, and the preimages that fixed
 * it. Everything shown comes out of the receipt this wallet kept. */
function showBet(row: BetRow) {
  $('bet-detail-eyebrow').textContent = 'One bet';
  $('bet-detail-title').textContent = row.game;
  $('bet-detail').replaceChildren(
    betDetail(row, opened => {
      $<HTMLDialogElement>('bet-dialog').close();
      showGameRecord(opened);
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
const NO_BETS = 'No bets yet. Play a game with ETH and every bet you place is here.';
function renderBets() {
  const rows = ownBets();
  $<HTMLButtonElement>('refresh-bets').disabled = historyBusy || !wallet.address;
  const signature = betSignature(rows);
  if (signature === shownBets) return;
  shownBets = signature;
  $('bet-list').replaceChildren(...betElements(rows, showBet));
  filterBets($('bet-list'), $<HTMLInputElement>('bet-search').value, $('bet-empty'), $('bet-visible-count'), NO_BETS);
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
  const list = document.createElement('div');
  list.className = 'bet-table';
  list.append(...rows.map(row => betRowElement(row, onOpen)));
  $('bet-detail').replaceChildren(list);
  $('bet-dialog').scrollTop = 0;
  if (!$<HTMLDialogElement>('bet-dialog').open) $<HTMLDialogElement>('bet-dialog').showModal();
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
    ...list.map(entry => {
      const card = document.createElement('div');
      card.className = 'played-game';
      const heading = document.createElement('div');
      heading.className = 'played-heading';
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'played-star';
      star.disabled = !entry.key;
      star.textContent = entry.key && starred.has(entry.key) ? '★' : '☆';
      star.title = !entry.key
        ? 'This game has no key on its bets, so it cannot be starred.'
        : starred.has(entry.key)
          ? `Take ${entry.name} out of your favourites`
          : `Keep ${entry.name} at the top`;
      star.setAttribute('aria-pressed', String(Boolean(entry.key && starred.has(entry.key))));
      if (entry.key) star.addEventListener('click', () => toggleFavourite(entry.key!));
      const title = document.createElement('h3');
      title.textContent = entry.name;
      const when = document.createElement('span');
      when.className = 'played-when';
      when.textContent = `Last played ${new Date(entry.last).toLocaleDateString()}`;
      heading.append(star, title, when);
      card.append(heading);
      const totals = betTotals(entry.rows),
        expected = measuredReturn(totals.priced, totals.expected),
        figures = document.createElement('dl');
      figures.className = 'played-figures';
      for (const [label, value] of [
        ['Bets', String(totals.bets)],
        ['Staked', `${formatEther(totals.staked)} ETH`],
        ['Paid back', `${formatEther(totals.paid)} ETH`],
        ['Your result', `${totals.net < 0n ? '−' : '+'}${formatEther(totals.net < 0n ? -totals.net : totals.net)} ETH`],
        ['Return of your bets', expected === null ? '—' : percent(expected)],
      ] as [string, string][]) {
        const term = document.createElement('dt'),
          detail = document.createElement('dd');
        term.textContent = label;
        detail.textContent = value;
        if (label === 'Your result')
          detail.className = totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : '';
        figures.append(term, detail);
      }
      card.append(figures);
      const actions = document.createElement('div');
      actions.className = 'played-actions';
      const known = entry.key ? knownGames.get(entry.key) : undefined;
      if (known) {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'button small primary';
        play.textContent = 'Play';
        play.addEventListener('click', () => task(() => loadGame(known.url, known.route, true, known)));
        actions.append(play);
      }
      if (entry.key) {
        const record = document.createElement('button');
        record.type = 'button';
        record.className = 'button small';
        record.textContent = 'Every bet in it ↗';
        record.addEventListener('click', () => void openGameRecord(entry.key!));
        actions.append(record);
      }
      card.append(actions);
      return card;
    }),
  );
  $('played-empty').classList.toggle('hidden', list.length !== 0);
}
/** A game's public record: every bet anyone has placed in it, straight from the casino. */
async function openGameRecord(key: string, push = true) {
  const known = knownGames.get(key),
    mine = ownBets().find(row => row.key === key);
  const name = known?.name || mine?.game || 'This game';
  $('gamebets-name').textContent = name;
  $('gamebets-key').textContent = key;
  $('gamebets-list').replaceChildren();
  $('gamebets-totals').replaceChildren();
  $('gamebets-developer-bets').classList.add('hidden');
  $('gamebets-empty').classList.add('hidden');
  $<HTMLInputElement>('gamebets-search').value = '';
  navigate('gamebets', push, gameBetsPath(key));
  document.title = `${name} · HookedIn`;
  const play = $<HTMLButtonElement>('gamebets-play');
  play.classList.toggle('hidden', !known);
  play.onclick = known ? () => task(() => loadGame(known.url, known.route, true, known)) : null;
  try {
    const record = await wallet.api(`/api/games/${key}?limit=200`);
    if (location.pathname !== gameBetsPath(key)) return;
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
    filterBets(
      $('gamebets-list'),
      '',
      $('gamebets-empty'),
      $('gamebets-visible-count'),
      'Nobody has placed a bet in this game yet.',
    );
  } catch (error: any) {
    $('gamebets-empty').classList.remove('hidden');
    $('gamebets-empty').textContent =
      error.code === 'not-found'
        ? 'The casino holds no record under that name.'
        : `The casino did not answer for this game. ${error.shortMessage || error.message}`;
  }
}
window.addEventListener('popstate', () => void route(false));
$<HTMLButtonElement>('clear-game-activity').addEventListener('click', () => gameLog.clear());
$<HTMLButtonElement>('export-game-activity').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([gameLog.export()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `hookedin-game-log-${active?.identity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'session'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$<HTMLInputElement>('bet-search').addEventListener('input', () =>
  filterBets($('bet-list'), $<HTMLInputElement>('bet-search').value, $('bet-empty'), $('bet-visible-count'), NO_BETS),
);
$<HTMLInputElement>('gamebets-search').addEventListener('input', () =>
  filterBets(
    $('gamebets-list'),
    $<HTMLInputElement>('gamebets-search').value,
    $('gamebets-empty'),
    $('gamebets-visible-count'),
    'Nobody has placed a bet in this game yet.',
  ),
);
$<HTMLButtonElement>('refresh-bets').addEventListener('click', () => void refreshActivity());
$<HTMLInputElement>('activity-search').addEventListener('input', () => {
  filterActivity(
    $('activity-list'),
    $<HTMLInputElement>('activity-search').value,
    $('activity-empty'),
    $('activity-visible-count'),
  );
});
$<HTMLFormElement>('custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $<HTMLInputElement>('custom-url').value.trim();
  task(() => loadGame(url, { url }));
});
$<HTMLButtonElement>('setup-wallet').addEventListener('click', () =>
  task(async () => {
    await wallet.setupDemo();
    funded('Demo ETH deposited: games play with ETH.');
  }),
);
$<HTMLFormElement>('fund-form').addEventListener('submit', event => {
  event.preventDefault();
  void task(async () => {
    if (!active) return;
    const amount = parseEther($<HTMLInputElement>('fund-amount').value.trim() || '0');
    logGameActivity('Spending limit requested', { amount: String(amount) });
    // A limit on the balance is held against other tabs.
    await holdGameLimit();
    await wallet.setGameLimit(String(amount));
    localStorage.setItem(limitSetting(), String(amount));
    logGameActivity('Spending limit set; the game may risk it until you leave', wallet.game);
    toast(`${active.identity.name} may play with up to ${formatEther(amount)} ETH.`);
    $<HTMLDialogElement>('fund-dialog').close(String(amount));
  });
});
$<HTMLDialogElement>('fund-dialog').addEventListener('close', () => {
  const value = $<HTMLDialogElement>('fund-dialog').returnValue;
  const request = fundRequest;
  fundRequest = null;
  if (!value && active) logGameActivity('Spending limit unchanged');
  request?.resolve(value ? BigInt(value) : null);
  $<HTMLDialogElement>('fund-dialog').returnValue = '';
});
$<HTMLButtonElement>('bet-detail-close').addEventListener('click', () => $<HTMLDialogElement>('bet-dialog').close());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fund-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('fund-dialog').close(''));
$<HTMLButtonElement>('fund-deposit').addEventListener('click', () => {
  $<HTMLDialogElement>('fund-dialog').close('');
  openWallet('deposit');
});
for (const id of ['wallet-button', 'hero-deposit']) $(id).addEventListener('click', () => openWallet('deposit'));
for (const button of document.querySelectorAll<HTMLElement>('[data-wallet-tab]'))
  button.addEventListener('click', () => openWallet(button.dataset.walletTab as WalletTab));
for (const button of document.querySelectorAll<HTMLElement>('#wallet-dialog [data-tab]'))
  button.addEventListener('click', () => selectTab(button.dataset.tab as WalletTab));
$('wallet-dialog')
  .querySelector('[data-close]')!
  .addEventListener('click', () => $<HTMLDialogElement>('wallet-dialog').close());
$<HTMLInputElement>('fund-slider').addEventListener('input', () => {
  $<HTMLInputElement>('fund-amount').value = formatEther(
    sliderAmount(wallet.playableBalance(), $<HTMLInputElement>('fund-slider').value),
  );
  renderFundDialog();
});
$<HTMLInputElement>('fund-amount').addEventListener('input', renderFundDialog);
$<HTMLButtonElement>('fund-take-all').addEventListener('click', () => {
  $<HTMLInputElement>('fund-amount').value = '0';
  renderFundDialog();
});
function downloadEvidence(report: any) {
  const url = URL.createObjectURL(new Blob([json(report)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `hookedin-channel-${report.opening.channelId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const { state } = verifyEvidence(report);
  toast(`Exported the recovery bundle of channel ${short(state.channelId)}, sequence ${state.sequence}.`);
}
$<HTMLButtonElement>('export-evidence').addEventListener('click', () =>
  task(async () => {
    downloadEvidence(await wallet.exportEvidence());
  }),
);
$<HTMLButtonElement>('start-close').addEventListener('click', () =>
  task(async () => {
    await wallet.startClose();
    toast('Close started. It can be challenged for 24 hours; keep watching until it is done.');
  }),
);
$<HTMLButtonElement>('recover-wallet').addEventListener('click', () =>
  task(async () => {
    await wallet.recover();
    toast('The saved operation is finished. Reopen its game to carry on.');
  }),
);
$<HTMLButtonElement>('speed-up-transaction').addEventListener('click', () =>
  task(async () => {
    await wallet.speedUpTransaction();
    toast('Sent again with a higher fee. Retry to check for confirmation.');
  }),
);
$<HTMLButtonElement>('deposit').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('deposit-amount').value.trim());
    await wallet.deposit(amount);
    maxDepositEstimate = null;
    funded(`Deposited ${formatEther(amount)} ETH into your balance.`);
  }),
);
$<HTMLButtonElement>('max-deposit').addEventListener('click', () =>
  task(async () => {
    $<HTMLButtonElement>('max-deposit').textContent = '…';
    try {
      maxDepositEstimate = await wallet.maxDeposit();
      $<HTMLInputElement>('deposit-amount').value = formatEther(maxDepositEstimate.amount);
      if (maxDepositEstimate.amount === 0n)
        throw new Error('Your vault does not hold enough for a deposit after network fees.');
    } finally {
      $<HTMLButtonElement>('max-deposit').textContent = 'Max';
    }
  }),
);
$<HTMLInputElement>('deposit-amount').addEventListener('input', () => {
  maxDepositEstimate = null;
  renderWallet();
});
$<HTMLButtonElement>('withdraw').addEventListener('click', () =>
  task(async () => {
    const channelId = wallet.channelId,
      amount = BigInt(wallet.publicState.balance);
    closeGame();
    if (!$('page-play').classList.contains('hidden')) {
      showPage('library');
      history.replaceState(null, '', '/');
    }
    await wallet.withdraw();
    const claim = wallet.publicState.claims.find((c: any) => c.channelId === channelId);
    const unpaid = claim ? BigInt(claim.amount) - BigInt(claim.paid) : 0n;
    $<HTMLDialogElement>('wallet-dialog').close();
    toast(
      unpaid > 0n
        ? `${eth(amount - unpaid)} ETH is in your vault. ${eth(unpaid)} ETH of winnings is paid as the bankroll has the cash: see Wallet.`
        : `Withdrew ${eth(amount)} ETH to your vault.`,
    );
  }),
);
$<HTMLButtonElement>('max-send').addEventListener('click', () =>
  task(async () => {
    $<HTMLInputElement>('send-amount').value = formatEther(await wallet.maxSend());
  }),
);
for (const id of ['send-to', 'send-amount']) $(id).addEventListener('input', () => renderWallet());
$<HTMLButtonElement>('send').addEventListener('click', () =>
  task(async () => {
    const to = getAddress($<HTMLInputElement>('send-to').value.trim()),
      amount = parseEther($<HTMLInputElement>('send-amount').value.trim());
    await wallet.send(to, amount);
    $<HTMLInputElement>('send-to').value = $<HTMLInputElement>('send-amount').value = '';
    $<HTMLDialogElement>('wallet-dialog').close();
    toast(`Sent ${formatEther(amount)} ETH to ${short(to)}.`);
  }),
);
$<HTMLButtonElement>('invest').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('invest-amount').value.trim());
    if (wallet.pending) throw new Error('Finish the operation in flight before buying shares.');
    const receipt = await wallet.invest(amount);
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this investment.');
    toast(`Bought ${formatEther(receipt.shares)} shares for ${formatEther(amount)} ETH.`);
    await refreshFund();
  }),
);
$<HTMLButtonElement>('divest-all').addEventListener('click', () => {
  if (fundStatus) $<HTMLInputElement>('divest-amount').value = formatEther(fundStatus.value);
});
$<HTMLButtonElement>('divest').addEventListener('click', () =>
  task(async () => {
    const status = await wallet.fundStatus(),
      held = BigInt(wallet.fund.shares),
      wanted = parseEther($<HTMLInputElement>('divest-amount').value.trim());
    if (wanted <= 0n || BigInt(status.equity) <= 0n) throw new Error('Enter what the shares you sell should be worth.');
    // Shares worth the amount asked for at the stated price; everything, when that is all of them.
    const shares =
      wanted >= BigInt(status.value) ? held : (wanted * BigInt(status.totalShares)) / BigInt(status.equity);
    if (!shares) throw new Error('That is less than one share.');
    const receipt = await wallet.redeem(shares);
    toast(
      `Sold ${formatEther(shares)} shares for ${formatEther(receipt.amount)} ETH. It is on its way to your balance.`,
    );
    await wallet.collectPayouts();
    await refreshFund();
  }),
);
$<HTMLButtonElement>('channel-export').addEventListener('click', () =>
  task(async () => downloadEvidence(await wallet.exportEvidence())),
);
$<HTMLButtonElement>('channel-start-close').addEventListener('click', () =>
  task(async () => {
    await wallet.startClose();
    toast('Close started. It can be challenged for 24 hours; keep watching until it is done.');
  }),
);
for (const id of ['channel-challenge', 'challenge-now'])
  $<HTMLButtonElement>(id).addEventListener('click', () =>
    task(async () => {
      await wallet.challengeClose();
      toast('Your latest saved balance is submitted.');
    }),
  );
$<HTMLButtonElement>('channel-finalize').addEventListener('click', () =>
  task(async () => {
    await wallet.finalizeClose();
    toast('The close is done. Collect what it is owed under Waiting to be paid.');
  }),
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
$<HTMLButtonElement>('connect-browser').addEventListener('click', () =>
  task(async () => {
    closeGame();
    await wallet.connectInjected();
    $<HTMLTextAreaElement>('exported-key').classList.add('hidden');
    $<HTMLTextAreaElement>('exported-key').value = '';
    toast('Browser wallet connected.');
  }),
);
$<HTMLButtonElement>('export-key').addEventListener('click', () =>
  task(async () => {
    const field = $<HTMLTextAreaElement>('exported-key');
    const hiding = !field.classList.contains('hidden');
    if (
      !hiding &&
      !confirm('Show this wallet’s private key? Anyone who sees it can take everything this wallet holds.')
    )
      return;
    field.classList.toggle('hidden', hiding);
    field.value = hiding ? '' : wallet.exportKey();
    $<HTMLButtonElement>('export-key').textContent = hiding
      ? "Show this wallet's private key"
      : "Hide this wallet's private key";
  }),
);
$<HTMLButtonElement>('import-wallet').addEventListener('click', () =>
  task(async () => {
    closeGame();
    await wallet.importKey($<HTMLInputElement>('import-key').value);
    $<HTMLInputElement>('import-key').value = '';
    $<HTMLTextAreaElement>('exported-key').value = '';
    $<HTMLTextAreaElement>('exported-key').classList.add('hidden');
    toast('Account imported.');
  }),
);
$<HTMLButtonElement>('select-saved-wallet').addEventListener('click', () =>
  task(async () => {
    closeGame();
    await wallet.selectSavedAccount($<HTMLSelectElement>('saved-wallets').value);
    $<HTMLTextAreaElement>('exported-key').value = '';
    $<HTMLTextAreaElement>('exported-key').classList.add('hidden');
    toast('Switched account.');
  }),
);
$<HTMLButtonElement>('pick-alias').addEventListener('click', () =>
  task(async () => {
    const input = $<HTMLInputElement>('alias-input');
    await wallet.pickAlias(input.value);
    input.value = '';
    toast(`You are @${wallet.alias}.`);
  }),
);
$<HTMLButtonElement>('publish-game').addEventListener('click', () =>
  task(async () => {
    const name = $<HTMLInputElement>('game-name-input'),
      url = $<HTMLInputElement>('game-url-input');
    const published = name.value.trim();
    if (!GAME_NAME.test(published)) throw new Error('A game name is 1 to 32 lowercase letters, digits or hyphens.');
    await wallet.publishGame(published, gameURL(url.value.trim()).href);
    name.value = url.value = '';
    await loadLibrary();
    toast(`Published at ${showName(wallet)}/${published}.`);
  }),
);
$<HTMLButtonElement>('bank-deposit').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('bank-amount').value.trim());
    if (amount <= 0n) throw new Error('Enter how much to put in your bank.');
    const receipt = await wallet.depositBank(amount);
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
    $<HTMLInputElement>('bank-amount').value = '';
    toast(`Put ${formatEther(amount)} ETH in your bank.`);
    await refreshBank();
  }),
);
$<HTMLButtonElement>('bank-withdraw').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('bank-amount').value.trim());
    await wallet.withdrawBank(amount);
    $<HTMLInputElement>('bank-amount').value = '';
    toast(`Took ${formatEther(amount)} ETH out of your bank. It is on its way to your balance.`);
    await wallet.collectPayouts();
    await refreshBank();
  }),
);
$<HTMLButtonElement>('clear-alias').addEventListener('click', () =>
  task(async () => {
    await wallet.pickAlias(null);
    toast(`You are ~${wallet.uname}.`);
  }),
);
$<HTMLAnchorElement>('wallet-name-link').addEventListener('click', event => {
  event.preventDefault();
  if (wallet.uname) void openProfile(showName(wallet));
});
$<HTMLAnchorElement>('menu-profile').addEventListener('click', event => {
  event.preventDefault();
  $('account-menu').hidePopover?.();
  if (wallet.uname) void openProfile(showName(wallet));
});
$<HTMLButtonElement>('refresh-developer-bets').addEventListener('click', () => void refreshActivity());
$<HTMLButtonElement>('refresh-wallet').addEventListener('click', () => void refreshActivity());
$<HTMLButtonElement>('connect-casino').addEventListener('click', () =>
  task(async () => {
    if (wallet.pending) throw new Error('Finish the operation in flight before switching casinos.');
    const nextCasino = endpoint($<HTMLInputElement>('casino-url').value.trim());
    const nextNetwork = $<HTMLSelectElement>('network-mode').value === 'local' ? 'local' : 'sepolia';
    closeGame();
    localStorage.setItem(`hookedin:${nextNetwork}:casino-url`, nextCasino);
    localStorage.setItem(networkSetting, nextNetwork);
    location.assign('/');
  }),
);
$<HTMLInputElement>('casino-url').value = casinoURL;
$<HTMLSelectElement>('network-mode').value = network;
$('network-name').textContent = wallet.networkName;
$('receive-instructions').textContent =
  `Send ETH on ${wallet.networkName} (chain ${wallet.expectedChainId}) to this address, your vault. ETH sent on another network does not arrive.`;
$<HTMLInputElement>('deposit-amount').value = networkDefaults.deposit;
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-casino-link]')) link.href = casinoURL;
if (settingsWarning) toast(settingsWarning, true);
// Show the addressed page immediately; a game route waits for the wallet and the lobby.
const initialRoute = parseRoute(new URL(location.href));
showPage(typeof initialRoute === 'string' ? initialRoute : 'library');
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
      'The casino is unavailable or has changed. Your balance stays safe in the contract: export, close, challenge and collect all work from Wallet → Recovery. Playing and depositing need the casino. Reload to reconnect.',
    );
  // Everything with ETH waits for the deployment check, and a failed one shows here.
  wallet.verified.catch((error: any) =>
    warn(`${error.shortMessage || error.message} Reload to check again, or check the casino in Settings.`),
  );
  renderWallet();
  renderActivity();
  void refreshActivity();
  if ((wallet.pending && wallet.pending.kind !== 'taken-in') || wallet.needsOpening)
    toast('An operation is saved and unfinished. Use Retry above to finish it safely.');
  await route();
} catch (error: any) {
  warn(`${error.shortMessage || error.message} Reload this page; if it persists, check the casino in Settings.`);
  for (const id of ['setup-wallet', 'deposit', 'withdraw', 'connect-browser', 'import-wallet'])
    $<HTMLButtonElement>(id).disabled = true;
}

$<HTMLButtonElement>('backup-wallet').addEventListener('click', () =>
  task(async () => {
    const backup = await wallet.encryptedBackup($<HTMLInputElement>('backup-password').value);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hookedin-encrypted-wallet.json';
    link.click();
    URL.revokeObjectURL(url);
    $<HTMLInputElement>('backup-password').value = '';
    toast('Backup downloaded. Back up every other account you fund too.');
  }),
);
$<HTMLInputElement>('restore-backup').addEventListener('change', () =>
  task(async () => {
    const file = $<HTMLInputElement>('restore-backup').files?.[0];
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) throw new Error('A backup is at most 24 MiB.');
    await wallet.restoreBackup(await readJSONFile(file, 'wallet backup'), $<HTMLInputElement>('backup-password').value);
    $<HTMLInputElement>('backup-password').value = '';
    $<HTMLInputElement>('restore-backup').value = '';
    toast('Backup restored. Check your balance, and retry any saved operation.');
  }),
);
