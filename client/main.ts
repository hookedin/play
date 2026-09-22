interface ActiveGame {
  /** The channel whose allocation this game uses; null until a channel is open. */
  channelId: string | null;
  identity: GameIdentity;
  manifest: { name: string; developer: string };
  manifestURL: string;
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
 * the name it has in their profile. Any other manifest is linkable by its URL alone. */
type GameRoute = { owner: string; name: string } | { manifest: string };
import { formatEther, getAddress, id, parseEther, ZeroAddress } from 'ethers';
import { CasinoWallet } from './wallet.ts';
import { withLock } from './storage.ts';
import { json, verifyEvidence, FAUCET_BELOW } from '../protocol/protocol.ts';
import { attachGameBridge, gameError } from './bridge.ts';
import { activityJSON, createActivityEntry, filterActivity, receiptSummary, receiptUnit } from './activity.ts';
import type { BetRow } from './bets.ts';
import {
  betDetail,
  betRowElement,
  filterBets,
  percent,
  measuredReturn,
  totalCards,
  totalsByAsset,
  unitOf,
} from './bets.ts';
import { createGameLog, logAsset } from './game-log.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { LogKind } from './game-log.ts';
import config from './config.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const eth = (value: string | number | bigint | undefined, precision = 4) => {
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
const networkSetting = `hookedin:v1:${config.network}:selected-network`;
const network = localStorage.getItem(networkSetting) || config.network;
const networkDefaults =
  network === 'local'
    ? { precision: 4, total: '100000000000000000', deposit: '0.1' }
    : { precision: 6, total: '100000000000000', deposit: '0.00001' };
function configuredEndpoint(name: string, fallback: string) {
  try {
    return endpoint(localStorage.getItem(`hookedin:v1:${network}:${name}-url`) || fallback);
  } catch {
    settingsWarning = `The saved ${name} endpoint is invalid. Update it in My wallet. The client still requires the selected network.`;
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
    logGameActivity(message, undefined, 'wallet');
    $('operation-text').textContent = message;
    $('operation-status').classList.remove('hidden');
    clearTimeout(statusTimer);
    if (!wallet.busy) statusTimer = setTimeout(() => $('operation-status').classList.add('hidden'), 3500);
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
    throw new Error('Another tab already has a funded game on this wallet. Finish or leave it there first.');
  limitLock = () => released.resolve();
}
/** Leaving a game releases its spending limit: the money was always in the channel. */
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
/** The game went away without navigation (channel or account change): the library replaces its URL. */
function abandonGame() {
  closeGame();
  if (!$('page-play').classList.contains('hidden')) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}

const pagePaths: Record<string, string> = {
  library: '/',
  account: '/account',
  wallet: '/wallet',
  games: '/games',
  bets: '/bets',
  bankroll: '/bankroll',
  settings: '/settings',
  activity: '/activity',
};
const gamePath = (route: GameRoute) =>
  'manifest' in route
    ? `/games/custom?manifest=${encodeURIComponent(route.manifest)}`
    : `/${route.owner}/${route.name}`;
/** How a player is written: an alias wears `@`, a uname wears `~`. */
const showName = (names: { uname?: string | null; alias?: string | null } | null) =>
  names?.alias ? '@' + names.alias : names?.uname ? '~' + names.uname : '—';
/** A player's page: everything the casino says about them, as anyone sees it. */
const profilePath = (name: string) => `/${name}`;
/** A game's public record: every bet anyone has placed in it, under the hash of its manifest URL. */
const gameBetsPath = (key: string) => `/games/${key.toLowerCase()}`;
const PAGE_TITLES: Record<string, string> = {
  library: 'Games',
  account: 'My account',
  wallet: 'My wallet',
  games: 'My games',
  bets: 'Bet history',
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
      ? `${active.manifest.name} — HookedIn`
      : page === 'profile'
        ? `${$('profile-name').textContent} — HookedIn`
        : `HookedIn — ${PAGE_TITLES[page] ?? page}`;
  if (page === 'activity') {
    renderActivity();
    void refreshActivity();
  }
  if (page === 'bets') renderBets();
  if (page === 'games') renderMyGames();
  if (page === 'wallet' || page === 'bankroll') void refreshFund();
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
    open = channelOpen() && !wallet.recoveryOnly,
    shares = BigInt(wallet.fund?.shares || 0);
  $('fund-value').textContent = f ? eth(f.value, 6) : '—';
  $('fund-equity').textContent = f ? eth(f.equity) : '—';
  // Shares are counted like ETH, in units of 10^18: one began at 1 ETH, and the price is what the
  // bankroll has made or lost since.
  $('fund-price').textContent =
    f && BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.equity) * 1000000n) / BigInt(f.totalShares)) / 1000000).toFixed(6)} ETH a share`
      : '1.000000 ETH a share';
  $('fund-house').textContent = !f
    ? '—'
    : BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.houseShares) * 10000n) / BigInt(f.totalShares)) / 100).toFixed(2)}%`
      : '100.00%';
  $('fund-note').textContent = wallet.fund?.alert
    ? `Your wallet refused a share statement: ${wallet.fund.alert}`
    : f && BigInt(f.overdrawn) > 0n
      ? `The casino's owner has withdrawn ${eth(f.overdrawn)} ETH more than its own shares covered. Holders bore that loss.`
      : f?.owed?.length
        ? 'Money from shares you sold is on its way to your playing balance.'
        : !f
          ? 'The casino is not reporting its bankroll right now.'
          : shares
            ? `You hold ${formatEther(shares)} shares under the casino's signed statement number ${wallet.fund.sequence}.`
            : '';
  $<HTMLButtonElement>('invest').disabled = uiBusy || !open || !f;
  for (const id of ['divest', 'divest-all']) $<HTMLButtonElement>(id).disabled = uiBusy || !open || !f || !shares;
}
function navigate(page: string, push = true, path = pagePaths[page]) {
  if (wallet.busy && active && wallet.pending?.game?.key === active.key) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current wager to finish before leaving the game.', true);
  }
  showPage(page);
  closeGame();
  if (push && location.pathname !== path) history.pushState(null, '', path);
}
/** Every page has a URL: `/`, `/account`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`,
 * `/activity`, `/@<alias>` or `/~<uname>` for a player, the same and `/<game>` for a game they
 * publish, `/games/<key>` for a game's public record, and `/games/custom?manifest=<url>`. */
function parseRoute(url: URL): string | GameRoute | { profile: string } | { record: string } | { unknown: string } {
  // A player's sigil survives whatever encoded the link: `@` reaches here as `%40` from some clients,
  // and the static host decodes the path the same way before it serves this page.
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const named = /^\/([~@][A-Za-z0-9_]{3,24})(?:\/([a-z0-9][a-z0-9-]{0,31}))?$/.exec(pathname);
  if (named) return named[2] ? { owner: named[1]!, name: named[2] } : { profile: named[1]! };
  if (pathname === '/games/custom') return { manifest: url.searchParams.get('manifest') || '' };
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
    const manifestURL =
      'manifest' in target ? target.manifest : (await wallet.api(`/api/players/${target.owner}/${target.name}`)).url;
    if (!manifestURL) throw new Error('This game is not published at that name.');
    await loadGame(manifestURL, target, push);
    return true;
  });
  if (!opened) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}

/** Is there a channel to play on: the on-chain one, or the test-coin one? */
const channelOpen = () => Boolean(wallet.channel) && Number(wallet.channel!.onchain?.status) === 1;
const ethOpen = () => Boolean(wallet.current?.key) && Number(wallet.current!.onchain?.status) === 1;
/** Amounts of whatever this tab plays with. */
const units = () => wallet.asset.symbol;
/**
 * The top bar's money: the balance this tab plays with, which opens the wallet, and the choice of
 * what that balance is — the network's ETH, or the casino's test coins. An open game takes the
 * balance's place: a player reading one figure in the game and another above it cannot tell which
 * money a bet is about to spend, and the one above was never the game's to spend anyway. What
 * stands there instead is the authority itself — the way to take back what the game holds, or to
 * give it some — and it opens the wallet's own dialog, the only place that authority is granted or
 * withdrawn. The asset stays named either way: test coins must never be mistaken for money.
 */
function renderMoney() {
  const button = $<HTMLButtonElement>('game-funds'),
    test = wallet.playing === 'test',
    holding = Boolean(active) && BigInt(wallet.game?.balance || '0') > 0n;
  // Truncated like every other amount here, so it is a prefix of the digits shown for the same money.
  $('balance-amount').textContent = eth(wallet.publicState?.playBalance, test ? 2 : networkDefaults.precision);
  $('balance-link').classList.toggle('hidden', Boolean(active));
  for (const option of document.querySelectorAll<HTMLButtonElement>('#asset-switch button')) {
    const needsChannel = option.dataset.play === 'eth' && !ethOpen();
    option.setAttribute('aria-pressed', String(option.dataset.play === wallet.playing));
    // A limit granted in one asset answers this question until the game gives the money back.
    option.disabled = uiBusy || wallet.busy || holding || needsChannel;
    option.title = holding
      ? `Take back what ${active!.manifest.name} holds to play with something else.`
      : needsChannel
        ? 'Add ETH to your playing balance in My wallet to play with it.'
        : '';
  }
  button.classList.toggle('hidden', !active);
  button.toggleAttribute('data-holding', holding);
  button.textContent = holding ? 'Take money back' : 'Give this game money';
  button.title = !active
    ? ''
    : holding
      ? `Take back what ${active.manifest.name} still holds, or change what it may play with.`
      : `Choose what ${active.manifest.name} may play with.`;
  button.disabled = uiBusy || wallet.busy;
}
/** The play page shows no wallet controls: the game displays its balance and asks for money through the dialog. */
function renderGameAccount() {
  renderMoney();
  if (!active || !wallet.game) return;
  // A game opened before a channel adopts the first one; a game bound to a channel closes with it.
  if (active.channelId === null && wallet.currentId) active.channelId = wallet.currentId;
  if ($<HTMLDialogElement>('fund-dialog').open) renderFundDialog();
  // The game's own balance view follows the wallet: top-ups and recoveries push without polling.
  const balance = wallet.gameLimit();
  const pushed = JSON.stringify(balance);
  if (active.pushed !== null && pushed !== active.pushed && active.frame.contentWindow) {
    active.pushed = pushed;
    const message = { hookedin: true, event: 'game.balance', ...balance };
    active.frame.contentWindow.postMessage(message, new URL(active.identity.entryURL).origin);
    gameLog.log('event', 'game.balance', {
      description: `balance ${formatEther(balance.balance)} ${units()}${balance.pending ? ' · pending operation' : ''}`,
      payload: message,
    });
  }
}
/** The game restarts to see what the wallet now plays with: ETH, or test coins. */
function reloadGame() {
  if (!active) return;
  active.pushed = null;
  active.frame.src = active.frame.src;
}
/** The slider runs linearly from nothing to the whole playing balance, a hundredth of it a step. */
const SLIDER_STEPS = 100n;
const sliderAmount = (total: bigint, value: string) => (total * BigInt(value)) / SLIDER_STEPS;
// The last limit the player chose for a game is only the next suggestion; authority comes from the dialog alone.
const limitSetting = () => `hookedin:v1:${network}:${wallet.playing}:game-limit:${active?.key}`;
/** The wallet's own dialog: the sole grant of spending authority, and where the player chooses ETH
 * or test coins. It opens saying what the game holds now, what it would hold, and what stays out of
 * its reach, because those three numbers are the whole of what is being authorized. */
function renderFundDialog() {
  if (!active) return;
  const dialog = $<HTMLDialogElement>('fund-dialog'),
    name = active.manifest.name;
  const test = wallet.playing === 'test';
  dialog.dataset.mode = channelOpen() ? 'fund' : 'channel';
  $('fund-eyebrow').textContent = test ? 'YOU ARE AUTHORIZING · TEST COINS' : 'YOU ARE AUTHORIZING';
  const limit = BigInt(wallet.game?.balance || '0');
  $('fund-title').textContent = !channelOpen()
    ? `${name} needs money to play`
    : limit > 0n
      ? `Change what ${name} may play with`
      : `Let ${name} play with your money?`;
  if (dialog.dataset.mode !== 'fund') return;
  $('fund-asset').textContent = units();
  const total = wallet.playableBalance(),
    slider = $<HTMLInputElement>('fund-slider');
  let amount = -1n;
  try {
    amount = parseEther($<HTMLInputElement>('fund-amount').value.trim() || '0');
  } catch {}
  const valid = amount >= 0n && amount <= total;
  slider.max = String(SLIDER_STEPS);
  $('fund-total').textContent = `${formatEther(total)} ${units()}, your playing balance`;
  // What this changes, as three figures: before, after, and what the game can never touch.
  $('fund-now').textContent = `${formatEther(limit)} ${units()}`;
  $('fund-next').textContent = valid ? `${formatEther(amount)} ${units()}` : '—';
  $('fund-rest').textContent = valid ? `${formatEther(total - amount)} ${units()}` : '—';
  $('fund-next').classList.toggle('fund-change-up', valid && amount > limit);
  $('fund-test-note').classList.toggle('hidden', !test);
  $<HTMLButtonElement>('fund-take-all').classList.toggle('hidden', limit === 0n);
  // The faucet pays a test channel that has run low.
  $('fund-faucet').classList.toggle('hidden', !test || total >= FAUCET_BELOW);
  // Changing what the game plays with is offered before the game holds money, not in the middle of play.
  $('fund-switch').classList.toggle('hidden', limit > 0n || (test && !ethOpen()));
  $('fund-switch').textContent = test ? 'Or play with your ETH' : 'Or play with test coins';
  slider.value = String(valid && total > 0n ? (amount * SLIDER_STEPS) / total : 0n);
  $('fund-help').textContent = !valid
    ? amount > total
      ? `More than your playing balance of ${formatEther(total)} ${units()}.`
      : `Enter an amount in ${units()}.`
    : amount === limit
      ? 'This is what the game may already play with.'
      : amount > limit
        ? `Giving it ${formatEther(amount - limit)} ${units()} more.`
        : `Taking back ${formatEther(limit - amount)} ${units()}.`;
  $('fund-help').classList.toggle('check-failed', !valid);
  $<HTMLButtonElement>('fund-confirm').disabled = !valid || amount === limit || uiBusy || wallet.busy;
  $('fund-confirm').textContent = !valid
    ? 'Allow'
    : amount === 0n && limit > 0n
      ? `Take back ${formatEther(limit)} ${units()}`
      : amount < limit
        ? `Take back ${formatEther(limit - amount)} ${units()}`
        : `Allow up to ${formatEther(amount)} ${units()}`;
}
let fundRequest: { resolve: (amount: bigint | null) => void } | null = null;
/** Opened by the game's request for money, or by the player from the top bar. `take` is the player
 * asking for their money back, so the dialog opens at nothing with the confirmation still to make. */
function openFundDialog({ amount, asked = false, take = false }: { amount?: bigint; asked?: boolean; take?: boolean }) {
  if (!active) return Promise.resolve<bigint | null>(null);
  fundRequest?.resolve(null);
  const dialog = $<HTMLDialogElement>('fund-dialog');
  // The game page shows nothing but the game, so the dialog that grants it money says who it is.
  $('fund-who').textContent =
    `${active.manifest.name}, served from ${new URL(active.frame.src).host}. Its developer, ${active.manifest.developer}, earns half of each bet’s fee.`;
  $('fund-channel-note').textContent =
    wallet.playing === 'eth'
      ? 'Your channel is not open for play yet. Play with test coins meanwhile, or check the channel in My wallet.'
      : 'Your test coins are not ready: the casino could not be reached. Try again in a moment, or set up your wallet to play with ETH.';
  if (channelOpen()) {
    const total = wallet.playableBalance(),
      test = wallet.playing === 'test',
      limit = BigInt(wallet.game?.balance || '0'),
      requested = amount && amount > 0n ? limit + amount : 0n,
      // Ten test coins is a fair first limit; ETH follows the network's default.
      remembered = BigInt(localStorage.getItem(limitSetting()) || (test ? 10n ** 19n : networkDefaults.total)),
      // The player's own visit shows the limit as it is, or what they last chose; a game's request
      // suggests exactly what it asked for, never more; asking for it back suggests nothing at all.
      suggested = take ? 0n : asked && requested ? requested : limit > 0n ? limit : remembered;
    $<HTMLInputElement>('fund-amount').value = formatEther(suggested > total ? total : suggested);
  }
  renderFundDialog();
  if (!dialog.open) dialog.showModal();
  if (dialog.dataset.mode === 'fund') $<HTMLInputElement>('fund-amount').select();
  return new Promise<bigint | null>(resolve => {
    fundRequest = { resolve };
  });
}
/** A decision only the player makes, before the wallet opens the game: it explains what changes and waits. */
function openConsentDialog(text: {
  eyebrow: string;
  title: string;
  reason: string;
  note: string;
  allow: string;
  decline: string;
  log: string;
}) {
  const dialog = $<HTMLDialogElement>('hosted-dialog');
  for (const part of ['eyebrow', 'title', 'reason', 'note', 'allow', 'decline'] as const)
    $('hosted-' + part).textContent = text[part];
  logGameActivity(`${text.log} requested`);
  if (!dialog.open) dialog.showModal();
  return new Promise<boolean>(resolve =>
    dialog.addEventListener(
      'close',
      () => {
        const allowed = dialog.returnValue === 'allow';
        dialog.returnValue = '';
        logGameActivity(`${text.log} ${allowed ? 'allowed' : 'declined'}`);
        resolve(allowed);
      },
      { once: true },
    ),
  );
}
/** A game whose manifest declares shared rounds asks this before it is opened: its host, not this
 * wallet, draws the seed of every round it runs. */
const openHostedDialog = (name: string) =>
  openConsentDialog({
    eyebrow: 'SHARED ROUND',
    title: `Open ${name}, where everyone shares one result?`,
    reason:
      "Everyone at the table bets on one result, so its randomness comes from the game's host instead of your wallet.",
    note: 'In your own bets neither you nor the casino can choose the result. Here the host and the casino could choose it together; neither can alone. Your wallet still verifies every result and marks these bets in your activity. Refusing leaves the game closed; every other game plays with your own randomness.',
    allow: 'Open the game',
    decline: 'Keep my own randomness',
    log: 'Shared-round randomness',
  });
function renderWallet() {
  renderFund();
  renderProfile();
  if (!wallet.address) return;
  const state = wallet.publicState;
  if (active?.channelId && active.channelId !== wallet.currentId) abandonGame();
  renderMoney();
  $('casino-balance').textContent = eth(state.balance, networkDefaults.precision);
  // Test coins: every wallet has them. The faucet pays once they run low.
  const testBalance = BigInt(state.testBalance || 0);
  $('test-balance').textContent = eth(state.testBalance || '0', 2);
  $<HTMLButtonElement>('test-faucet').disabled =
    uiBusy || wallet.busy || wallet.playing !== 'test' || testBalance >= FAUCET_BELOW;
  // A disabled control is the hardest kind to act on, so each one says what it is waiting for.
  $('test-faucet').title =
    wallet.playing !== 'test'
      ? 'Play with test coins to claim more.'
      : testBalance >= FAUCET_BELOW
        ? `The faucet pays once you are under ${eth(String(FAUCET_BELOW), 2)} test coins.`
        : '';
  const earnings = state.developerEarnings,
    earningsUnit = wallet.playing === 'test' ? 'TEST' : 'ETH';
  // The tally is the one for what this tab plays with, and it is collected into that channel.
  for (const id of ['developer-earnings', 'test-earnings']) {
    const shown = (id === 'test-earnings') === (wallet.playing === 'test');
    $(id).classList.toggle('hidden', !shown || !BigInt(earnings?.earned || 0));
    $(id).textContent =
      shown && earnings
        ? `Your games have earned ${formatEther(earnings.earned)} ${earningsUnit} in commission; ${formatEther(earnings.collected)} ${earningsUnit} of it is collected into this balance.`
        : '';
  }
  $('native-balance').textContent = eth(state.nativeBalance, networkDefaults.precision);
  $('wallet-address').textContent = wallet.address;
  $('wallet-mode').textContent =
    `${wallet.mode === 'demo' ? 'GENERATED BROWSER WALLET' : 'CONNECTED BROWSER WALLET'} · ${wallet.networkName.toUpperCase()}`;
  $('chain-id').textContent = state.chainId || wallet.config.chainId;
  $('activity-count').textContent = String(wallet.history.length);
  $('bets-count').textContent = String(ownBets().length);
  if (!$('page-bets').classList.contains('hidden')) renderBets();
  if (!$('page-games').classList.contains('hidden')) renderMyGames();
  const busy = uiBusy || wallet.busy;
  const ready = state.address === wallet.address;
  const observed = Boolean(state.observedAt);
  const nativeBalance = BigInt(state.nativeBalance || '0');
  if (
    maxDepositEstimate &&
    (maxDepositEstimate.address !== wallet.address || maxDepositEstimate.nativeBalance !== nativeBalance)
  )
    maxDepositEstimate = null;
  let depositAmount = 0n;
  try {
    depositAmount = parseEther($<HTMLInputElement>('deposit-amount').value.trim());
  } catch {}
  const aboveReserve = nativeBalance > wallet.gasReserve;
  const depositTooLarge = depositAmount > 0n && depositAmount >= nativeBalance - wallet.gasReserve;
  $('wallet-caption').textContent =
    wallet.mode === 'demo'
      ? 'This wallet’s key is stored only in this browser.'
      : 'This is your connected browser wallet’s address. Your browser wallet holds the signing key.';
  $<HTMLButtonElement>('copy-address').disabled = !ready;
  $<HTMLButtonElement>('check-deposit').disabled = !ready || busy;
  const receiveStatus = !ready
    ? 'Connecting to your wallet…'
    : nativeBalance > 0n
      ? `${eth(nativeBalance, networkDefaults.precision)} ETH in your wallet.${aboveReserve ? ' Continue with step 2.' : ' Add more ETH to cover the gas reserve and a deposit.'}`
      : 'Waiting for ETH at this address.';
  if ($('receive-status').textContent !== receiveStatus) $('receive-status').textContent = receiveStatus;
  $('receive-check').textContent = observed
    ? `Last checked ${new Date(state.observedAt).toLocaleTimeString()}. Updates every 4 seconds.`
    : 'Balance could not be checked. It is retried automatically, or use Check now.';
  $('receive-check').classList.toggle('check-failed', !observed);
  $('deposit-help').textContent =
    nativeBalance === 0n
      ? 'Receive ETH in step 1 to get started.'
      : !aboveReserve
        ? `Your ${eth(nativeBalance, networkDefaults.precision)} ETH is reserved for gas. Add ETH to fund your playing balance.`
        : depositTooLarge
          ? `Choose a smaller amount or select Max to keep ${eth(wallet.gasReserve, networkDefaults.precision)} ETH plus the deposit fee.`
          : maxDepositEstimate
            ? `Maximum to add: ${eth(maxDepositEstimate.amount, networkDefaults.precision)} ETH. Deposit fee: up to ${eth(maxDepositEstimate.maxFee, networkDefaults.precision)} ETH.`
            : `In your wallet: ${eth(nativeBalance, networkDefaults.precision)} ETH. Max calculates what you can add after the gas reserve and fee.`;
  // A seat in a shared round is the normal way to wait for a spin, and the open game already shows it
  // with its own "take my bet back". Offering unilateral close over the table, and shifting the
  // layout under the player's next click, would make every ordinary round look like an emergency.
  const seatedInOpenGame =
    Boolean(wallet.pending?.hosted) && Boolean(active) && wallet.pending!.game?.key === wallet.game?.key;
  $('pending-banner').classList.toggle(
    'hidden',
    !(wallet.pending || wallet.needsOpening || wallet.transactionIntent) || busy || seatedInOpenGame,
  );
  const challengeExpired = Date.now() / 1000 >= Number(state.deadline);
  $('challenge-banner').classList.toggle('hidden', !state.needsChallenge);
  $('challenge-summary').textContent = state.needsChallenge
    ? challengeExpired
      ? 'The challenge deadline has passed. This closure uses an older balance; retain your recovery evidence.'
      : `The casino is closing with an older balance. Submit your saved evidence before ${new Date(Number(state.deadline) * 1000).toLocaleString()}.`
    : '';
  $<HTMLButtonElement>('challenge-now').disabled = busy || !state.needsChallenge || challengeExpired;
  $('pending-summary').textContent = wallet.transactionIntent
    ? wallet.transactionIntent.hash
      ? 'A wallet transaction needs confirmation. Recover its result, or speed it up with a higher network fee.'
      : 'The wallet did not return a transaction hash. Recover checks its result, then requests approval to resend the same action with the same nonce.'
    : wallet.needsOpening
      ? 'Your channel registration needs recovery. The opening and channel key are saved.'
      : wallet.pending?.hosted
        ? "Your bet is waiting for the game's host to close the round. Retry looks for its result; withdrawing it leaves your balance unchanged."
        : 'Your signed operation is saved. Retry the same operation, or close the channel and preserve its evidence.';
  $<HTMLButtonElement>('speed-up-transaction').classList.toggle('hidden', !wallet.transactionIntent);
  const cancellable = Boolean(wallet.pending?.hosted);
  $<HTMLButtonElement>('withdraw-bet').classList.toggle('hidden', !cancellable);
  $<HTMLButtonElement>('withdraw-bet').disabled = busy || !cancellable;
  $<HTMLButtonElement>('speed-up-transaction').disabled = busy || !wallet.transactionIntent;
  $<HTMLButtonElement>('export-evidence').disabled = busy || !wallet.current;
  $<HTMLButtonElement>('start-close').disabled = busy || !wallet.current || Number(state.channelStatus) !== 1;
  for (const id of ['setup-wallet', 'deposit', 'withdraw', 'connect-browser', 'import-wallet', 'recover-wallet'])
    $<HTMLButtonElement>(id).disabled = busy;
  $<HTMLButtonElement>('deposit').disabled =
    busy ||
    !ready ||
    !observed ||
    Boolean(wallet.pending) ||
    Boolean(wallet.current) ||
    !aboveReserve ||
    depositTooLarge ||
    depositAmount <= 0n;
  $<HTMLButtonElement>('max-deposit').disabled =
    busy || !ready || !observed || Boolean(wallet.pending) || Boolean(wallet.current) || !aboveReserve;
  $<HTMLInputElement>('deposit-amount').disabled = busy;
  $<HTMLButtonElement>('withdraw').disabled =
    busy || !ready || Boolean(wallet.pending) || !wallet.current || Number(state.channelStatus) !== 1;
  if (wallet.recoveryOnly) $<HTMLButtonElement>('withdraw').disabled = true;
  const accounts = $<HTMLSelectElement>('saved-wallets');
  if (accounts) {
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
  }
  $('demo-funding').classList.toggle('hidden', wallet.mode !== 'demo' || !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('setup-wallet').textContent =
    BigInt(state.balance || '0') > 0n ? 'Add demo funds ↗' : 'Set up demo wallet ↗';
  $<HTMLButtonElement>('setup-wallet').classList.toggle('hidden', wallet.mode !== 'demo' || !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('export-key').disabled = wallet.mode !== 'demo';
  if (!busy) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => $('operation-status').classList.add('hidden'), 2200);
  }
  if (!$('page-activity').classList.contains('hidden')) renderActivity();
  renderClaims();
  renderGameAccount();
}

function renderActivity() {
  $<HTMLButtonElement>('refresh-wallet').disabled = historyBusy || !wallet.address;
  const refreshError = historyError?.shortMessage || historyError?.message || historyError || wallet.detailsError;
  $('history-status').textContent =
    historyError || wallet.detailsError
      ? `Activity or bankroll information is stale; saved proofs remain available. ${refreshError}`
      : historyBusy || wallet.detailsRefreshing
        ? 'Refreshing activity and bankroll information; saved proofs remain available.'
        : 'Signed winnings await cash-out.' +
          (wallet.detailsObservedAt
            ? ' Last checked ' + new Date(wallet.detailsObservedAt).toLocaleTimeString([], { hour12: false })
            : '');
  $('history-status').classList.toggle('check-failed', Boolean(historyError || wallet.detailsError));
  const list = $('activity-list');
  const existing = new Map(
    [...list.children].map(row => [(row as HTMLElement).dataset.operationId, row as HTMLDetailsElement]),
  );
  for (const [index, receipt] of wallet.history.entries()) {
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
      if (receipt.game?.revision !== undefined) facts.push(['Game revision', String(receipt.game.revision)]);
      if (receipt.developer) facts.push(['Developer', receipt.developer]);
      if (receipt.commission !== undefined)
        facts.push(['Commission', `${formatEther(receipt.commission)} ${receiptUnit(receipt)}`]);
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
let claimLimit = 20;
let claimsShown = '';
const claimRecipients = new Map<string, string>();
function renderClaims() {
  const state = wallet.publicState;
  const openChannel = Boolean(state.channelId);
  $('principal-balance').textContent = `${eth(state.protectedDeposit || '0', networkDefaults.precision)} ETH`;
  for (const id of ['channel-deposit-note', 'channel-observation']) $(id).classList.toggle('hidden', !openChannel);
  $('channel-status').textContent = state.channelId
    ? `Channel ${short(state.channelId)} · ${Number(state.channelStatus) === 2 ? 'Closing' : Number(state.channelStatus) === 1 ? 'Open' : 'Opening'}`
    : wallet.missingChannel
      ? 'Active channel found. Import its recovery bundle.'
      : 'No open channel';
  $('challenge-deadline').textContent = Number(state.deadline)
    ? `Challenge deadline: ${new Date(Number(state.deadline) * 1000).toLocaleString()}`
    : openChannel
      ? 'Check this wallet regularly while your channel is open. A stale closure must be challenged on-chain within 24 hours of starting. Keep current recovery evidence.'
      : 'Claims below hold what a closed channel is owed. Collect them whenever you like; unpaid winnings stay claimable.';
  $('channel-observation').textContent =
    `Last verified: ${state.observedAt ? new Date(state.observedAt).toLocaleString() : 'unavailable — refresh before acting'} · Saved sequence ${state.savedSequence || '0'} · Proposed sequence ${state.closingSequence || '0'} · Balance at risk ${eth(state.balanceAtRisk || '0', networkDefaults.precision)} ETH${state.challengePending ? ' · Challenge transaction pending' : ''}`;
  $<HTMLButtonElement>('channel-export').disabled = !wallet.current || uiBusy || wallet.busy;
  $<HTMLButtonElement>('channel-start-close').disabled =
    !wallet.current || Number(state.channelStatus) !== 1 || uiBusy || wallet.busy;
  $<HTMLButtonElement>('channel-challenge').disabled =
    !state.needsChallenge || Date.now() / 1000 >= Number(state.deadline) || uiBusy || wallet.busy;
  $<HTMLButtonElement>('channel-finalize').disabled =
    Number(state.channelStatus) !== 2 || Date.now() / 1000 < Number(state.deadline) || uiBusy || wallet.busy;
  const list = $('claim-list');
  const claims = [...(state.claims || [])].sort(
    (a, b) => Number(BigInt(b.amount) > BigInt(b.paid)) - Number(BigInt(a.amount) > BigInt(a.paid)),
  );
  // The wallet re-renders on every observation. Rebuild the rows only when they differ, so a recipient
  // address being typed keeps its text and focus.
  const describe = (claim: any) =>
    `${short(claim.channelId)} · Due ${eth(claim.amount, networkDefaults.precision)} ETH · Received ${eth(claim.paid, networkDefaults.precision)} ETH · Unpaid ${eth(BigInt(claim.amount) - BigInt(claim.paid), networkDefaults.precision)} ETH` +
    ` · Protected principal ${eth(claim.protectedRemaining, networkDefaults.precision)} ETH · Unpaid winnings ${eth(claim.winningsRemaining, networkDefaults.precision)} ETH · Winnings allocated ${eth(claim.allocatedWinnings || '0', networkDefaults.precision)} ETH` +
    (claim.observedAt ? ` · Checked ${new Date(claim.observedAt).toLocaleTimeString()}` : '');
  const visible = claims.slice(0, claimLimit);
  const shown = JSON.stringify([
    visible.map(describe).map(t => t.replace(/ · Checked .*$/, '')),
    claims.length,
    wallet.busy || uiBusy,
  ]);
  if (shown === claimsShown) {
    list.querySelectorAll('.claim-row > p').forEach((text, i) => (text.textContent = describe(visible[i])));
    return;
  }
  claimsShown = shown;
  list.replaceChildren();
  for (const claim of visible) {
    const row = document.createElement('div'),
      text = document.createElement('p');
    text.textContent = describe(claim);
    const collect = document.createElement('button');
    collect.className = 'button secondary small';
    collect.textContent = 'Collect available funds';
    collect.disabled = wallet.busy || uiBusy || BigInt(claim.amount) === BigInt(claim.paid);
    collect.addEventListener('click', () =>
      task(async () => {
        const collected = BigInt(claim.amount) - BigInt(claim.paid);
        await wallet.claim(claim.channelId);
        renderClaims();
        toast(`Collected ${eth(collected, networkDefaults.precision)} ETH to your wallet address.`);
      }),
    );
    const destination = document.createElement('input');
    destination.placeholder = 'Optional recipient address';
    destination.setAttribute('aria-label', 'Claim recipient address');
    destination.value = claimRecipients.get(claim.channelId) ?? '';
    destination.addEventListener('input', () => claimRecipients.set(claim.channelId, destination.value));
    const redirect = document.createElement('button');
    redirect.className = 'text-button';
    redirect.textContent = 'Collect to another address';
    redirect.disabled = collect.disabled;
    redirect.addEventListener('click', () =>
      task(async () => {
        const recipient = destination.value.trim();
        const collected = BigInt(claim.amount) - BigInt(claim.paid);
        await wallet.claim(claim.channelId, recipient);
        renderClaims();
        toast(`Collected ${eth(collected, networkDefaults.precision)} ETH to ${short(recipient)}.`);
      }),
    );
    const evidence = document.createElement('button');
    evidence.className = 'text-button';
    evidence.textContent = 'Export claim evidence';
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
    more.textContent = `Show more claims (${claims.length - claimLimit} remaining)`;
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
    link.title = 'View transaction on Sepolia Etherscan';
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
    await wallet.auditRejections();
  } catch (error) {
    historyError = error;
  } finally {
    historyBusy = false;
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
    throw new Error('Enter the full URL of the game manifest, starting with https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Games must use an HTTP or HTTPS URL without credentials.');
  return url;
}

function endpoint(value: string) {
  const url = safeURL(value);
  if (url.search || url.hash) throw new Error('Service endpoints cannot include a query or fragment.');
  return url.href.replace(/\/$/, '');
}

async function readManifest(response: Response) {
  const limit = 16384;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Game manifest is too large.');
  }
  if (!response.body) throw new Error('The game manifest is empty.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0,
    text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Game manifest is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('That URL does not answer with a game manifest. It must serve the manifest JSON itself.');
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch a manifest and check everything the wallet needs before it will frame the game. Opening a
 * game and publishing one ask the same question, so a game published from this wallet is one this
 * wallet could open.
 */
async function fetchGame(url: string) {
  const manifestURL = safeURL(url);
  // The game keeps its own origin, so it may persist its round state at its host. A same-origin frame
  // could remove its own sandbox and read the wallet's storage, so the wallet's origin is never framed.
  if (manifestURL.origin === location.origin) throw new Error('Games cannot be served from the wallet’s own origin.');
  let response;
  try {
    response = await fetch(manifestURL, {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    // A host that is down, a name that does not resolve, and a missing CORS header all land here.
    throw new Error(`${manifestURL.host} did not answer. Check the URL, that the host is up, and its CORS headers.`);
  }
  if (!response.ok) throw new Error('The game manifest could not be loaded. Check its URL and CORS headers.');
  const manifest = await readManifest(response);
  if (
    !manifest ||
    typeof manifest.name !== 'string' ||
    !manifest.name.length ||
    manifest.name.length > 80 ||
    typeof manifest.entry !== 'string' ||
    typeof manifest.developer !== 'string'
  )
    throw new Error('A game manifest needs a name, entry URL, and developer address.');
  let developer;
  try {
    developer = getAddress(manifest.developer);
  } catch {
    throw new Error(`The manifest's developer, ${String(manifest.developer).slice(0, 60)}, is not an address.`);
  }
  if (developer === ZeroAddress) throw new Error('The developer fee recipient cannot be the zero address.');
  if (manifest.rounds !== undefined && typeof manifest.rounds !== 'boolean')
    throw new Error("A manifest's rounds is true when the game bets on rounds its own host opens.");
  const entry = safeURL(manifest.entry, response.url);
  if (entry.origin === location.origin || new URL(response.url).origin === location.origin)
    throw new Error('Games cannot be served from the wallet’s own origin.');
  return { manifestURL, manifest, developer, entry };
}

async function loadGame(url: string, gameRoute: GameRoute, push = true) {
  const { manifestURL, manifest, developer, entry } = await fetchGame(url);
  // The one decision the player takes before a game is framed: its host's randomness, or none of it.
  if (manifest.rounds && !(await openHostedDialog(String(manifest.name))))
    throw new Error(`${manifest.name} runs shared rounds, so it stays closed while you keep your own randomness.`);
  closeGame();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute(
    'allow',
    "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'",
  );
  frame.title = `${manifest.name} — sandboxed game`;
  const currentGeneration = ++generation;
  const identity: GameIdentity = {
    manifestURL: manifestURL.href,
    entryURL: entry.href,
    developer,
    name: manifest.name,
    ...(manifest.rounds ? { rounds: true } : {}),
  };
  // A game bound to a channel closes with it; a game opened without one adopts the first channel that opens.
  const isCurrent = () =>
    active?.generation === currentGeneration &&
    active.frame === frame &&
    (active.channelId === null || active.channelId === wallet.currentId);
  const path = gamePath(gameRoute);
  await walletStarted;
  const key = wallet.openGame(identity);
  active = {
    channelId: wallet.currentId,
    identity,
    manifest: { ...manifest, developer },
    manifestURL: manifestURL.href,
    path,
    frame,
    generation: currentGeneration,
    dispose: () => {},
    key,
    pushed: null,
  };
  // Every amount in the developer log is in what the wallet plays with.
  logAsset(units());
  gameLog.clear();
  $<HTMLInputElement>('game-activity-search').value = '';
  logGameActivity('Game opened', {
    manifestURL: manifestURL.href,
    entryURL: entry.href,
    origin: entry.origin,
    sandbox: frame.getAttribute('sandbox'),
    developer,
    channelId: active.channelId,
    gameKey: key,
    path,
  });
  frame.addEventListener('load', () => {
    if (!isCurrent()) return;
    logGameActivity('Game iframe loaded', { entryURL: entry.href });
    active!.pushed = '';
    renderGameAccount();
  });
  active.dispose = attachGameBridge({
    iframe: frame,
    origin: entry.origin,
    isCurrent,
    onActivity: (type, data) => gameLog.bridge(type, data),
    onRequest: async (method, params) => {
      if (method === 'wallet.hello') return wallet.gameHello();
      if (method === 'wallet.info') return wallet.gameInfo();
      if (method === 'game.receipt') return wallet.gameReceipt(params.id);
      if (uiBusy || wallet.busy) throw gameError('busy', 'The wallet is processing another operation.');
      if (method === 'game.requestFunds') {
        const requested = params.amount === undefined ? undefined : BigInt(params.amount);
        const amount = await openFundDialog({ amount: requested, asked: true });
        if (!isCurrent()) throw gameError('game-closed', 'The game was closed.');
        return { funded: amount !== null, amount: amount === null ? null : String(amount), ...wallet.gameLimit() };
      }
      if (!channelOpen()) throw gameError('no-channel', 'Add money to this game to play.');
      if (method === 'game.bet') return wallet.gameBet(params);
      if (method === 'game.cancel') return wallet.gameCancel(params);
      return wallet.gamePayment(params);
    },
    onError: message => toast(message, true),
  });
  frame.src = entry.href;
  const loading = document.createElement('p');
  loading.className = 'game-loading';
  loading.textContent = `Loading ${manifest.name}…`;
  frame.addEventListener('load', () => loading.remove(), { once: true });
  $('frame-slot').replaceChildren(loading, frame);
  showPage('play');
  if (push && location.pathname + location.search !== path) history.pushState(null, '', path);
  renderGameAccount();
}

for (const button of document.querySelectorAll<HTMLElement>('[data-page]'))
  button.addEventListener('click', event => {
    event.preventDefault();
    navigate(button.dataset.page!);
  });
// The open game's money: the dialog opens at nothing when the game is holding some, so the button
// that takes it back does exactly that and still shows what it is taking back before it happens.
$<HTMLButtonElement>('game-funds').addEventListener('click', () => {
  if (active) void openFundDialog({ take: BigInt(wallet.game?.balance || '0') > 0n });
});
/** One card for a published game, read from its manifest. */
async function gameCard(route: GameRoute, url: string) {
  const manifest = await readManifest(
    await fetch(safeURL(url), { credentials: 'omit', signal: AbortSignal.timeout(12000) }),
  );
  const card = document.createElement('a'),
    title = document.createElement('h3'),
    description = document.createElement('p'),
    link = document.createElement('span');
  card.className = 'game-card catalog-card';
  card.href = gamePath(route);
  title.textContent = String(manifest.name).slice(0, 80);
  description.textContent = String(manifest.description || 'Independent game').slice(0, 220);
  link.className = 'catalog-link';
  link.textContent = 'manifest' in route ? new URL(url).host : `${route.owner}/${route.name}`;
  card.append(title, description, link);
  // A bet's receipt names its game only by this key, so remembering the card is what lets a line of
  // history be opened again, and its public record found.
  knownGames.set(id(safeURL(url).href).toLowerCase(), { route, url, name: title.textContent });
  const record = document.createElement('span');
  record.className = 'catalog-record';
  record.textContent = 'Every bet ↗';
  record.title = `Every bet anyone has placed in ${title.textContent}`;
  record.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void openGameRecord(id(safeURL(url).href).toLowerCase());
  });
  card.append(record);
  card.addEventListener('click', event => {
    event.preventDefault();
    task(() => loadGame(url, route));
  });
  return card;
}
/** How many of a profile's games a page will fetch the manifest of. The rest stay reachable by
 * their own URL: a profile holds a hundred games, all of them addresses its owner chose. */
const SHOWN_GAMES = 32;
/** Every game a profile publishes, as cards. A manifest that cannot be read is left out. */
async function profileCards(owner: string, games: { name: string; url: string }[]) {
  const cards = await Promise.all(
    games.slice(0, SHOWN_GAMES).map(game => gameCard({ owner, name: game.name }, game.url).catch(() => null)),
  );
  return cards.filter(card => card !== null);
}
/** The library is what `@hookedin` publishes, and whatever this account publishes itself. */
async function loadLibrary() {
  const list = $('game-library');
  try {
    const house = await wallet.api(`/api/players/@${HOUSE}`);
    const mine = wallet.alias === HOUSE ? [] : (wallet.profile?.games ?? []);
    const cards = [
      ...(await profileCards('@' + HOUSE, house.games)),
      ...(await profileCards(showName(wallet.profile), mine)),
    ];
    $('library-count').textContent = $('library-heading-count').textContent = String(cards.length);
    list.replaceChildren(...cards);
  } catch {
    list.textContent = 'Game catalog unavailable. You can load a custom manifest below.';
  }
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
    document.title = `${showName(profile)} — HookedIn`;
    $('profile-since').textContent = `Playing here since ${new Date(profile.since).toLocaleDateString()}.`;
    $('profile-stats').replaceChildren(
      ...(['eth', 'test'] as const).map(asset => {
        const card = document.createElement('div'),
          label = document.createElement('div'),
          amount = document.createElement('div'),
          note = document.createElement('p');
        const stats = profile.stats[asset];
        card.className = 'wallet-balance-card';
        label.className = 'eyebrow';
        label.textContent = asset === 'eth' ? 'ETH PLAYS' : 'TEST COIN PLAYS';
        amount.className = 'large-amount';
        amount.textContent = String(stats.plays);
        note.textContent = `Staked ${eth(stats.staked, 4)} · won ${eth(stats.won, 4)}`;
        card.append(label, amount, note);
        return card;
      }),
    );
    const cards = await profileCards(showName(profile), profile.games);
    if (cards.length) games.replaceChildren(...cards);
    else games.textContent = `${showName(profile)} publishes no games.`;
  } catch (error: any) {
    $('profile-since').textContent = error.code === 'not-found' ? 'Nobody goes by that name.' : error.message;
    games.replaceChildren();
    // Nobody is here, so neither is anything of theirs.
    $('profile-games-heading').classList.add('hidden');
  }
}
/** The library is reloaded whenever what this account publishes changes. */
let libraryKey = '';
/** The account the saved-wallets list was last set to, so a render only moves it when that changes. */
let shownAccount: string | null = null;
/** The account's own profile: the names it answers to, and the games it publishes. */
function renderProfile() {
  const name = wallet.uname ? showName(wallet) : null,
    funded = ethOpen() && !wallet.recoveryOnly;
  $('wallet-name').textContent = name ?? '—';
  $<HTMLAnchorElement>('wallet-name-link').href = name ? profilePath(name) : '/';
  renderAccount(name);
  // The uname is always there; when an alias covers it up, it is shown underneath.
  $('wallet-uname').textContent = wallet.alias ? '~' + wallet.uname : '';
  for (const id of ['pick-alias', 'publish-game']) $<HTMLButtonElement>(id).disabled = uiBusy || !funded;
  $<HTMLButtonElement>('clear-alias').disabled = uiBusy || !funded;
  $('clear-alias').classList.toggle('hidden', !wallet.alias);
  $('alias-note').textContent = !funded
    ? 'Open a funded ETH channel to take an alias or publish games.'
    : 'An alias is unique, and two aliases that read alike are the same alias. Your uname stays whatever you are called.';
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
      row.className = 'input-row';
      label.className = 'game-handle';
      label.textContent = `${name}/${game.name} — ${game.url}`;
      remove.className = 'text-button';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.title = `Take ${name}/${game.name} out of the library`;
      remove.disabled = uiBusy;
      remove.addEventListener('click', () =>
        task(async () => {
          await wallet.publishGame(game.name, null);
          await loadLibrary();
          toast(`${name}/${game.name} is no longer published.`);
        }),
      );
      row.append(label, remove);
      return row;
    }),
  );
}
/** The account: the name this wallet answers to, in the top bar and at the head of its own page,
 * and one line under each card saying what is behind it. No balance is named here — that is the
 * wallet's page, and the one place a figure is not competing with a game's own. */
function renderAccount(name: string | null) {
  $('account-name').textContent = name ?? 'My account';
  $('account-uname').textContent = wallet.alias && wallet.uname ? '~' + wallet.uname : '';
  $('account-heading').textContent = name ?? 'My account';
  $('account-handle').textContent = name
    ? wallet.alias
      ? `~${wallet.uname} · the name every game and shared round knows you by`
      : 'Take an alias below and this becomes the shorter name you are shown by.'
    : 'Connecting to your wallet…';
  $<HTMLAnchorElement>('account-public').href = name ? profilePath(name) : '/';
  $('account-public').classList.toggle('hidden', !name);
  const rows = ownBets(),
    counted = totalsByAsset(rows),
    unit = wallet.playing === 'test' ? 'test' : 'eth',
    mine = counted.get(unit),
    games = new Set(rows.map(row => row.key || row.game));
  $('account-wallet-note').textContent = channelOpen()
    ? `Channel open · ${eth(wallet.publicState.balance, networkDefaults.precision)} ETH signed`
    : 'No channel open yet';
  $('account-games-note').textContent = `${games.size} played · ${wallet.profile?.games?.length ?? 0} published`;
  $('account-bets-note').textContent = mine
    ? `${mine.bets} ${unitOf(unit)} bets · ${percent(measuredReturn(mine.staked, mine.expected) ?? 0n)} expected`
    : 'No bets yet';
  $('account-bankroll-note').textContent = BigInt(wallet.fund?.shares || 0)
    ? `${formatEther(BigInt(wallet.fund!.shares))} shares held`
    : 'No shares held';
  $('account-activity-note').textContent = `${wallet.history.length} events saved`;
  $('account-settings-note').textContent =
    wallet.mode === 'demo' ? 'Generated browser wallet' : 'Connected browser wallet';
}

// --- What you play, and what it paid ---------------------------------------------------------

/** Games this wallet can reopen, by the hash of their manifest URL: whatever the library showed.
 * A bet's receipt carries only the game's key and the name it went by, so this is what turns a
 * line of history back into something to play. */
const knownGames = new Map<string, { route: GameRoute; url: string; name: string }>();
const favouriteSetting = `hookedin:v1:${network}:favourite-games`;
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
 * Activity; only a bet whose prize table the wallet recorded can say what it was worth. */
function ownBets(): BetRow[] {
  return wallet.history
    .filter(
      (receipt: any) => receipt.kind === 'bet' && receipt.status === 'signed' && receipt.expectedPayout !== undefined,
    )
    .map((receipt: any) => ({
      at: Date.parse(receipt.createdAt),
      game: receipt.game?.name || 'Unnamed game',
      key: receipt.game?.key ?? null,
      asset: receipt.asset === 'test' ? 'test' : 'eth',
      stake: BigInt(receipt.stake),
      payout: BigInt(receipt.payout ?? 0),
      expected: BigInt(receipt.expectedPayout),
      maxPayout: receipt.maxPayout === undefined ? null : BigInt(receipt.maxPayout),
      operation: receipt.operationId,
      hosted: receipt.hosted === true,
      receipt,
    }));
}
/** Open a game's public record. From a bet, the key is all that is needed. */
const showGameRecord = (row: { key?: string | null }) => {
  if (row.key) void openGameRecord(row.key);
};
/** One bet in full: the prize table it rode, where its round landed, and the preimages that drew
 * it. Everything shown comes out of the receipt this wallet kept. */
function showBet(row: BetRow) {
  $('bet-detail-title').textContent = row.game;
  $('bet-detail').replaceChildren(
    betDetail(row, opened => {
      $<HTMLDialogElement>('bet-dialog').close();
      showGameRecord(opened);
    }),
  );
  $('bet-dialog').scrollTop = 0;
  $<HTMLDialogElement>('bet-dialog').showModal();
}
/** A list is rebuilt only when what it shows has changed. The wallet renders on every poll, and a
 * row replaced under the player's cursor takes their click with it. */
const betSignature = (rows: readonly BetRow[], extra = '') =>
  extra + rows.map(row => `${row.operation}:${row.payout}`).join(',');
let shownBets = '\u0000',
  shownPlayed = '\u0000';
function renderBets() {
  const rows = ownBets();
  $<HTMLButtonElement>('refresh-bets').disabled = historyBusy || !wallet.address;
  const signature = betSignature(rows);
  if (signature === shownBets) return;
  shownBets = signature;
  $('bet-list').replaceChildren(...rows.map(row => betRowElement(row, showBet)));
  filterBets(
    $('bet-list'),
    $<HTMLInputElement>('bet-search').value,
    $('bet-empty'),
    $('bet-visible-count'),
    'No bets yet. Open a game from the library and every bet you sign is recorded here.',
  );
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
  $('games-totals').replaceChildren(...totalCards(totalsByAsset(all)));
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
      const figures = document.createElement('div');
      figures.className = 'played-figures';
      for (const [asset, totals] of totalsByAsset(entry.rows)) {
        const unit = unitOf(asset),
          expected = measuredReturn(totals.staked, totals.expected),
          cell = document.createElement('dl');
        cell.className = 'played-asset';
        for (const [label, value] of [
          [`${unit} bets`, String(totals.bets)],
          ['Staked', `${formatEther(totals.staked)} ${unit}`],
          ['Paid back', `${formatEther(totals.paid)} ${unit}`],
          [
            'Your result',
            `${totals.net < 0n ? '−' : '+'}${formatEther(totals.net < 0n ? -totals.net : totals.net)} ${unit}`,
          ],
          ['Return of your bets', expected === null ? '—' : percent(expected)],
        ] as [string, string][]) {
          const term = document.createElement('dt'),
            detail = document.createElement('dd');
          term.textContent = label;
          detail.textContent = value;
          if (label === 'Your result')
            detail.className = totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : '';
          cell.append(term, detail);
        }
        figures.append(cell);
      }
      card.append(figures);
      const actions = document.createElement('div');
      actions.className = 'played-actions';
      const known = entry.key ? knownGames.get(entry.key) : undefined;
      if (known) {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'button secondary small';
        play.textContent = 'Play again ↗';
        play.addEventListener('click', () => task(() => loadGame(known.url, known.route)));
        actions.append(play);
      }
      if (entry.key) {
        const record = document.createElement('button');
        record.type = 'button';
        record.className = 'button secondary small';
        record.textContent = 'Every bet in this game ↗';
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
  $('gamebets-empty').classList.add('hidden');
  $<HTMLInputElement>('gamebets-search').value = '';
  navigate('gamebets', push, gameBetsPath(key));
  document.title = `${name} — HookedIn`;
  const play = $<HTMLButtonElement>('gamebets-play');
  play.classList.toggle('hidden', !known);
  play.onclick = known ? () => task(() => loadGame(known.url, known.route)) : null;
  try {
    const record = await wallet.api(`/api/games/${key}?limit=200`);
    if (location.pathname !== gameBetsPath(key)) return;
    const rows: BetRow[] = record.bets.map((bet: any) => ({
      at: Number(bet.at),
      game: name,
      who: bet.alias ? '@' + bet.alias : bet.uname ? '~' + bet.uname : 'a player',
      asset: bet.asset === 'test' ? 'test' : 'eth',
      stake: BigInt(bet.stake),
      payout: BigInt(bet.payout),
      expected: BigInt(bet.expected),
      index: Number(bet.index),
    }));
    $('gamebets-totals').replaceChildren(
      ...totalCards(
        new Map(
          Object.entries(record.totals as Record<string, any>).map(([asset, totals]) => [
            asset,
            {
              bets: Number(totals.bets),
              staked: BigInt(totals.staked || 0),
              paid: BigInt(totals.paid || 0),
              expected: BigInt(totals.expected || 0),
              net: BigInt(totals.paid || 0) - BigInt(totals.staked || 0),
            },
          ]),
        ),
      ),
    );
    $('gamebets-list').replaceChildren(...rows.map(row => betRowElement(row)));
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
  link.download = `hookedin-game-log-${active?.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'session'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$<HTMLInputElement>('bet-search').addEventListener('input', () =>
  filterBets(
    $('bet-list'),
    $<HTMLInputElement>('bet-search').value,
    $('bet-empty'),
    $('bet-visible-count'),
    'No bets yet. Open a game from the library and every bet you sign is recorded here.',
  ),
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
$<HTMLButtonElement>('open-custom').addEventListener('click', () => {
  $<HTMLFormElement>('custom-form').classList.toggle('hidden');
  if (!$<HTMLFormElement>('custom-form').classList.contains('hidden')) $<HTMLInputElement>('manifest-url').focus();
});
$<HTMLFormElement>('custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const manifest = $<HTMLInputElement>('manifest-url').value.trim();
  task(() => loadGame(manifest, { manifest }));
});
$<HTMLButtonElement>('setup-wallet').addEventListener('click', () =>
  task(async () => {
    await wallet.setupDemo();
    toast('Demo ETH added and a channel opened. Choose a game to play.');
  }),
);
$<HTMLFormElement>('fund-form').addEventListener('submit', event => {
  event.preventDefault();
  void task(async () => {
    if (!active) return;
    const amount = parseEther($<HTMLInputElement>('fund-amount').value.trim() || '0');
    logGameActivity('Spending limit requested', { amount: String(amount) });
    await holdGameLimit();
    await wallet.setGameLimit(String(amount));
    localStorage.setItem(limitSetting(), String(amount));
    logGameActivity('Spending limit set; the game may risk it until you leave', wallet.game);
    toast(`${active.manifest.name} may play with up to ${formatEther(amount)} ${units()}.`);
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
$<HTMLButtonElement>('hosted-allow').addEventListener('click', () =>
  $<HTMLDialogElement>('hosted-dialog').close('allow'),
);
$<HTMLButtonElement>('hosted-decline').addEventListener('click', () => $<HTMLDialogElement>('hosted-dialog').close(''));
$<HTMLButtonElement>('bet-detail-close').addEventListener('click', () => $<HTMLDialogElement>('bet-dialog').close());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fund-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('fund-dialog').close(''));
$<HTMLButtonElement>('fund-open-wallet').addEventListener('click', () => {
  $<HTMLDialogElement>('fund-dialog').close('');
  navigate('wallet');
  $('receive-title').scrollIntoView({ block: 'center' });
});
/** Change what this tab plays with. An open game restarts to greet a wallet holding another asset. */
async function playWith(asset: 'eth' | 'test') {
  $<HTMLDialogElement>('fund-dialog').close('');
  await task(async () => {
    await wallet.setPlaying(asset);
    if (active) {
      logAsset(units());
      logGameActivity(asset === 'test' ? 'Playing with test coins' : 'Playing with ETH');
      reloadGame();
    }
    // Play money and money look alike; say which one is now in play.
    toast(
      asset === 'test'
        ? 'Test coins: the same games at the same odds, nothing real won or lost.'
        : 'Playing with your ETH.',
    );
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-play]'))
  button.addEventListener('click', () => {
    // A segment showing the asset already in play has nothing to change; the dialog's button, which
    // shows no such state, asks again for the asset whose channel is not ready yet.
    if (button.getAttribute('aria-pressed') !== 'true') void playWith(button.dataset.play as 'eth' | 'test');
  });
$<HTMLButtonElement>('fund-switch').addEventListener(
  'click',
  () => void playWith(wallet.playing === 'test' ? 'eth' : 'test'),
);
$<HTMLButtonElement>('test-faucet').addEventListener('click', () =>
  task(async () => {
    await wallet.claimTestCoins();
    toast('100 test coins claimed.');
  }),
);
$<HTMLButtonElement>('fund-faucet').addEventListener('click', () =>
  task(async () => {
    await wallet.claimTestCoins();
    toast('100 test coins claimed.');
    renderFundDialog();
  }),
);
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
  toast(`Exported channel ${short(state.channelId)}, sequence ${state.sequence}.`);
}
$<HTMLButtonElement>('export-evidence').addEventListener('click', () =>
  task(async () => {
    downloadEvidence(await wallet.exportEvidence());
  }),
);
$<HTMLButtonElement>('start-close').addEventListener('click', () =>
  task(async () => {
    await wallet.startClose();
    toast('Unilateral closure started. Keep monitoring the deadline.');
  }),
);
$<HTMLButtonElement>('recover-wallet').addEventListener('click', () =>
  task(async () => {
    await wallet.recover();
    toast(
      wallet.pending
        ? "The bet is still waiting for the game's host to close its round."
        : 'Saved wallet operation recovered. Reopen its game to continue the session.',
    );
  }),
);
$<HTMLButtonElement>('withdraw-bet').addEventListener('click', () =>
  task(async () => {
    const receipt = await wallet.cancelPending();
    toast(
      receipt.status === 'rejected'
        ? 'Withdrawn. Your balance is unchanged.'
        : 'The round was already played; its verified result is in your history.',
    );
  }),
);
$<HTMLButtonElement>('speed-up-transaction').addEventListener('click', () =>
  task(async () => {
    await wallet.speedUpTransaction();
    toast('Transaction recovery submitted. Check again for confirmation.');
  }),
);
$<HTMLButtonElement>('deposit').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('deposit-amount').value.trim());
    await wallet.deposit(amount);
    maxDepositEstimate = null;
    toast('Channel opened. Bets now run off-chain.');
  }),
);
$<HTMLButtonElement>('max-deposit').addEventListener('click', () =>
  task(async () => {
    $<HTMLButtonElement>('max-deposit').textContent = 'Calculating…';
    try {
      maxDepositEstimate = await wallet.maxDeposit();
      $<HTMLInputElement>('deposit-amount').value = formatEther(maxDepositEstimate.amount);
      if (maxDepositEstimate.amount === 0n)
        throw new Error('Add ETH to cover the gas reserve and deposit fee before funding play.');
    } finally {
      $<HTMLButtonElement>('max-deposit').textContent = 'Max';
    }
  }),
);
$<HTMLInputElement>('deposit-amount').addEventListener('input', () => {
  maxDepositEstimate = null;
  renderWallet();
});
$<HTMLButtonElement>('invest').addEventListener('click', () =>
  task(async () => {
    const amount = parseEther($<HTMLInputElement>('invest-amount').value.trim());
    if (wallet.pending) throw new Error('Recover the pending operation before investing.');
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
    toast(`Sold ${formatEther(shares)} shares for ${formatEther(receipt.amount)} ETH. Collecting it now.`);
    await wallet.collectPayouts();
    await refreshFund();
  }),
);
$<HTMLButtonElement>('withdraw').addEventListener('click', () =>
  task(async () => {
    await wallet.withdraw();
    toast('Channel closed. Collect your claim below to receive available funds.');
  }),
);
$<HTMLButtonElement>('channel-export').addEventListener('click', () =>
  task(async () => downloadEvidence(await wallet.exportEvidence())),
);
$<HTMLButtonElement>('channel-start-close').addEventListener('click', () =>
  task(async () => {
    await wallet.startClose();
    toast('Unilateral closure started.');
  }),
);
$<HTMLButtonElement>('channel-challenge').addEventListener('click', () =>
  task(async () => {
    await wallet.challengeClose();
    toast('Latest saved evidence submitted.');
  }),
);
$<HTMLButtonElement>('challenge-now').addEventListener('click', () =>
  task(async () => {
    await wallet.challengeClose();
    toast('Latest saved evidence submitted.');
  }),
);
$<HTMLButtonElement>('channel-finalize').addEventListener('click', () =>
  task(async () => {
    await wallet.finalizeClose();
    toast('Claim finalized. Collect your claim below to receive available funds.');
  }),
);
$<HTMLInputElement>('channel-import').addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file)
    void task(async () => {
      closeGame();
      await wallet.importEvidence(await readJSONFile(file, 'recovery bundle'));
      toast('Recovery evidence verified and imported.');
    });
});
$<HTMLButtonElement>('copy-address').addEventListener('click', async () => {
  if (!wallet.address || wallet.publicState.address !== wallet.address) return;
  try {
    await navigator.clipboard.writeText(wallet.address);
    toast(`Deposit address copied. Use the ${wallet.networkName} network.`);
  } catch {
    const selection = window.getSelection(),
      range = document.createRange();
    range.selectNodeContents($('wallet-address'));
    selection?.removeAllRanges();
    selection?.addRange(range);
    toast('Your address is selected. Copy it with your browser’s copy command.');
  }
});
$<HTMLButtonElement>('check-deposit').addEventListener('click', () => task(() => wallet.refresh()));
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
      ? 'Show browser wallet private key'
      : 'Hide browser wallet private key';
  }),
);
$<HTMLButtonElement>('import-wallet').addEventListener('click', () =>
  task(async () => {
    closeGame();
    await wallet.importKey($<HTMLInputElement>('import-key').value);
    $<HTMLInputElement>('import-key').value = '';
    $<HTMLTextAreaElement>('exported-key').value = '';
    $<HTMLTextAreaElement>('exported-key').classList.add('hidden');
    toast(`${wallet.networkName} wallet restored.`);
  }),
);
$<HTMLButtonElement>('select-saved-wallet').addEventListener('click', () =>
  task(async () => {
    closeGame();
    await wallet.selectSavedAccount($<HTMLSelectElement>('saved-wallets').value);
    $<HTMLTextAreaElement>('exported-key').value = '';
    $<HTMLTextAreaElement>('exported-key').classList.add('hidden');
    toast('Saved browser wallet selected.');
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
    // Anyone who opens this card has to be able to play it, so it is loaded before it is published.
    const { manifestURL } = await fetchGame(url.value.trim());
    await wallet.publishGame(published, manifestURL.href);
    name.value = url.value = '';
    await loadLibrary();
    toast(`Published at ${showName(wallet)}/${published}.`);
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
$<HTMLButtonElement>('refresh-wallet').addEventListener('click', () => void refreshActivity());
$<HTMLButtonElement>('wallet-history').addEventListener('click', () => navigate('activity'));
$<HTMLButtonElement>('connect-casino').addEventListener('click', () =>
  task(async () => {
    if (wallet.pending) throw new Error('Recover the pending operation before switching services.');
    const nextCasino = endpoint($<HTMLInputElement>('casino-url').value.trim());
    const nextNetwork = $<HTMLSelectElement>('network-mode').value === 'local' ? 'local' : 'sepolia';
    closeGame();
    localStorage.setItem(`hookedin:v1:${nextNetwork}:casino-url`, nextCasino);
    localStorage.setItem(networkSetting, nextNetwork);
    location.assign('/');
  }),
);
$<HTMLInputElement>('casino-url').value = casinoURL;
$<HTMLSelectElement>('network-mode').value = network;
const asset = `${wallet.networkName} ETH`;
$('network-name').textContent = wallet.networkName;
$('asset-name').textContent = asset;
$('receive-network').textContent = `${wallet.networkName} · ${wallet.expectedChainId}`;
$('receive-instructions').textContent =
  `Send ${asset} from another wallet or a faucet to the address below. You can copy it into the sender’s destination field.`;
$('receive-network-note').textContent =
  `Select ${wallet.networkName} (chain ${wallet.expectedChainId}) in the sending wallet or service. ETH sent on another network won’t appear in this balance.`;
$<HTMLInputElement>('deposit-amount').value = networkDefaults.deposit;

$('gas-reserve-note').textContent =
  `At least ${formatEther(wallet.gasReserve)} ETH stays in your wallet for future network fees. Max also sets aside this deposit’s fee.`;
$('connection-banner').textContent = `Connecting to the ${wallet.networkName} casino…`;
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-casino-link]')) link.href = casinoURL;
if (settingsWarning) toast(settingsWarning, true);
// Show the addressed page immediately; a game route waits for the wallet and catalog.
const initialRoute = parseRoute(new URL(location.href));
showPage(typeof initialRoute === 'string' ? initialRoute : 'library');
const startup = Promise.withResolvers<void>();
/** Games opened by an early click wait here, so their allocation is created against the started wallet. */
const walletStarted = startup.promise;

try {
  await wallet.start().finally(startup.resolve);
  $('connection-banner').classList.toggle('hidden', !wallet.recoveryOnly);
  if (wallet.recoveryOnly) {
    $('connection-banner').textContent =
      'Recovery mode: the casino is unavailable or its configuration changed. Your trusted deployment remains available for deposits, evidence export, unilateral close, challenge and claims. Playing requires the casino. Reload to reconnect.';
    $('connection-banner').classList.add('warning');
  }
  renderWallet();
  renderActivity();
  void refreshActivity();
  if (wallet.pending || wallet.needsOpening)
    toast('A saved operation needs recovery. Use Recover operation to finish safely.');
  await loadLibrary();
  await route();
} catch (error: any) {
  $('connection-banner').textContent =
    `${error.shortMessage || error.message} Reload this client; if it persists, check Connected services in My wallet.`;
  $('connection-banner').classList.add('warning');
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
    toast('Selected account backup downloaded. Back up other accounts separately.');
  }),
);
$<HTMLInputElement>('restore-backup').addEventListener('change', () =>
  task(async () => {
    const file = $<HTMLInputElement>('restore-backup').files?.[0];
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) throw new Error('Backup exceeds 24 MiB');
    await wallet.restoreBackup(await readJSONFile(file, 'wallet backup'), $<HTMLInputElement>('backup-password').value);
    $<HTMLInputElement>('backup-password').value = '';
    $<HTMLInputElement>('restore-backup').value = '';
    toast('Backup restored. Check the channel status and recover any pending operation.');
  }),
);
