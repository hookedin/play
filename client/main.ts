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
/** A catalog game is linkable by its manifest `id`; any other manifest is linkable by URL. */
type GameRoute = { id: string } | { manifest: string };
import { formatEther, getAddress, parseEther, ZeroAddress } from 'ethers';
import { CasinoWallet } from './wallet.ts';
import { withLock } from './storage.ts';
import { json, verifyEvidence } from '../protocol/protocol.ts';
import { attachGameBridge } from './bridge.ts';
import { activityJSON, createActivityEntry, filterActivity, receiptSummary } from './activity.ts';
import { createGameLog } from './game-log.ts';
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
    ? { precision: 4, total: '100000000000000000', transfer: '0.1' }
    : { precision: 6, total: '100000000000000', transfer: '0.00001' };
function configuredEndpoint(name: string, fallback: string) {
  try {
    return endpoint(localStorage.getItem(`hookedin:v1:${network}:${name}-url`) || fallback);
  } catch {
    settingsWarning = `The saved ${name} endpoint is invalid. Update it in My wallet. The client still requires the selected network.`;
    return fallback;
  }
}
const casinoURL = configuredEndpoint('casino', config.casino);
const gamesURL = configuredEndpoint('games', config.games);
let active: ActiveGame | null = null,
  generation = 0,
  uiBusy = false,
  toastTimer: ReturnType<typeof setTimeout> | undefined,
  statusTimer: ReturnType<typeof setTimeout> | undefined;
let maxDepositEstimate: Awaited<ReturnType<CasinoWallet['maxDeposit']>> | null = null;
let historyBusy = false,
  historyError: any = null;
const catalogGames = new Map<string, { manifestURL: string; manifest: any }>();
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
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

const pagePaths: Record<string, string> = { library: '/', wallet: '/wallet', activity: '/activity' };
const gamePath = (route: GameRoute) =>
  'id' in route ? `/games/${route.id}` : `/games/custom?manifest=${encodeURIComponent(route.manifest)}`;
/** Show a section; the URL is the caller's responsibility. */
function showPage(page: string) {
  for (const section of document.querySelectorAll<HTMLElement>('.page'))
    section.classList.toggle('hidden', section.id !== `page-${page}`);
  for (const link of document.querySelectorAll<HTMLElement>('.nav-link'))
    link.classList.toggle('active', link.dataset.page === page || (page === 'play' && link.dataset.page === 'library'));
  document.title =
    page === 'play' && active
      ? `${active.manifest.name} — HookedIn`
      : `HookedIn — ${page === 'library' ? 'Games' : page}`;
  if (page === 'activity') {
    renderActivity();
    void refreshActivity();
  }
  if (page === 'wallet') void refreshFund();
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
  $('fund-house').textContent =
    f && BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.houseShares) * 10000n) / BigInt(f.totalShares)) / 100).toFixed(2)}%`
      : '—';
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
function navigate(page: string, push = true) {
  if (wallet.busy && active && wallet.pending?.game?.key === active.key) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current wager to finish before leaving the game.', true);
  }
  showPage(page);
  closeGame();
  if (push && location.pathname !== pagePaths[page]) history.pushState(null, '', pagePaths[page]);
}
/** Every page has a URL: `/`, `/wallet`, `/activity`, `/games/<id>` and `/games/custom?manifest=<url>`. */
function parseRoute(url: URL): string | GameRoute {
  const game = /^\/games\/([a-z0-9][a-z0-9-]{0,31})$/.exec(url.pathname);
  if (game) return game[1] === 'custom' ? { manifest: url.searchParams.get('manifest') || '' } : { id: game[1]! };
  return Object.entries(pagePaths).find(([, path]) => path === url.pathname)?.[0] || 'library';
}
async function route(push = false) {
  const target = parseRoute(new URL(location.href));
  if (typeof target === 'string') return navigate(target, push);
  if (active && active.path === gamePath(target)) return showPage('play');
  const manifestURL = 'id' in target ? catalogGames.get(target.id)?.manifestURL : target.manifest;
  const opened = await task(async () => {
    if (!manifestURL) throw new Error('This game is not in the connected game library.');
    await loadGame(manifestURL, target, push);
    return true;
  });
  if (!opened) {
    showPage('library');
    history.replaceState(null, '', '/');
  }
}

const channelOpen = () => Boolean(wallet.current) && Number(wallet.current!.onchain?.status) === 1;
/**
 * While a game is open the top bar shows the money outside it. Every result moves the game's limit
 * and the signed balance together, so this figure stands still during play: only the game's own
 * balance moves, when the game chooses to show it.
 */
function renderHeaderBalance() {
  const practice = Boolean(active && wallet.game?.practice),
    state = wallet.publicState;
  $('top-balance').toggleAttribute('data-practice', practice);
  $('header-balance-label').textContent = practice ? 'Practice' : active ? 'In wallet' : 'Playing';
  $('header-balance').textContent = practice
    ? 'test money'
    : `${eth(active ? state.availableBalance : state.balance, networkDefaults.precision)} ETH`;
}
/** The play page shows no wallet controls: the game displays its balance and asks for money through the dialog. */
function renderGameAccount() {
  renderHeaderBalance();
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
    active.frame.contentWindow.postMessage(message, '*');
    gameLog.log('event', 'game.balance', {
      description: `balance ${formatEther(balance.balance)} ${balance.practice ? 'test ETH' : 'ETH'}${balance.pending ? ' · pending operation' : ''}`,
      payload: message,
    });
  }
}
/** The game restarts to see the wallet it now plays with: practice money, or the channel. */
function reloadGame() {
  if (!active) return;
  active.pushed = null;
  active.frame.src = active.frame.src;
}
/** The slider's stops: nothing, a 1-2-5 ladder, and the whole playing balance. */
function limitStops(total: bigint) {
  const stops = [0n];
  for (let unit = 10n ** BigInt(Math.max(String(total).length - 5, 0)); unit < total; unit *= 10n)
    for (const step of [1n, 2n, 5n]) if (step * unit < total) stops.push(step * unit);
  if (total > 0n) stops.push(total);
  return stops;
}
// The last limit the player chose for a game is only the next suggestion; authority comes from the dialog alone.
const limitSetting = () => `hookedin:v1:${network}:game-limit:${active?.key}`;
/** The wallet's own dialog: the sole grant of spending authority, and the way into and out of practice money. */
function renderFundDialog() {
  if (!active) return;
  const dialog = $<HTMLDialogElement>('fund-dialog'),
    name = active.manifest.name;
  dialog.dataset.mode = wallet.game?.practice ? 'practice' : channelOpen() ? 'fund' : 'channel';
  $('fund-eyebrow').textContent = wallet.game?.practice ? 'PRACTICE MONEY' : 'SPENDING LIMIT';
  $('fund-title').textContent = wallet.game?.practice
    ? `${name} is in practice`
    : channelOpen()
      ? `How much may ${name} play with?`
      : `${name} needs money to play`;
  if (dialog.dataset.mode !== 'fund') return;
  const total = BigInt(wallet.current!.state.balance),
    limit = BigInt(wallet.game?.balance || '0'),
    stops = limitStops(total),
    slider = $<HTMLInputElement>('fund-slider');
  let amount = -1n;
  try {
    amount = parseEther($<HTMLInputElement>('fund-amount').value.trim() || '0');
  } catch {}
  const valid = amount >= 0n && amount <= total;
  slider.max = String(stops.length - 1);
  $('fund-total').textContent = `${formatEther(total)} ETH, your playing balance`;
  // Practice is offered before the game holds real money, not in the middle of real play.
  $('fund-practice').classList.toggle('hidden', limit > 0n);
  slider.value = String(Math.max(stops.findLastIndex(stop => stop <= amount), 0));
  $('fund-help').textContent = !valid
    ? amount > total
      ? `More than your playing balance of ${formatEther(total)} ETH.`
      : 'Enter an amount in ETH.'
    : `${formatEther(total - amount)} ETH stays in your wallet.` +
      (limit > 0n ? ` The game has ${formatEther(limit)} ETH now.` : '');
  $('fund-help').classList.toggle('check-failed', !valid);
  $<HTMLButtonElement>('fund-confirm').disabled =
    !valid || amount === limit || uiBusy || wallet.busy || Boolean(wallet.pending);
  $('fund-confirm').textContent =
    valid && amount === 0n && limit > 0n
      ? 'Take it all back'
      : valid && amount > 0n
        ? `Allow up to ${formatEther(amount)} ETH`
        : 'Allow';
}
let fundRequest: { resolve: (amount: bigint | null) => void } | null = null;
/** Opened by the game's request for money, or by the player from the top bar. */
function openFundDialog({ amount, reason, asked = false }: { amount?: bigint; reason?: string; asked?: boolean }) {
  if (!active) return Promise.resolve<bigint | null>(null);
  fundRequest?.resolve(null);
  const dialog = $<HTMLDialogElement>('fund-dialog');
  $('fund-reason').classList.toggle('hidden', !asked || Boolean(wallet.game?.practice));
  $('fund-reason').textContent = `The game asks for money${reason ? `: “${reason.slice(0, 140)}”` : '.'}`;
  // The game page shows nothing but the game, so the dialog that grants it money says who it is.
  $('fund-game').textContent =
    `Served from ${new URL(active.frame.src).host}. Its developer, ${active.manifest.developer}, earns half of each bet’s fee.`;
  $('fund-channel-note').textContent = wallet.current
    ? 'Your channel is not open for play yet. Try the game with practice money meanwhile, or check the channel in My wallet.'
    : 'You have no funded channel yet. Try the game with practice money (the same bets at the same odds, nothing real won or lost) or set up your wallet to play for real.';
  if (channelOpen() && !wallet.game?.practice) {
    const total = BigInt(wallet.current!.state.balance),
      limit = BigInt(wallet.game?.balance || '0'),
      requested = amount && amount > 0n ? limit + amount : 0n,
      remembered = BigInt(localStorage.getItem(limitSetting()) || networkDefaults.total),
      // The player's own visit shows the limit as it is; a game's request suggests enough for it.
      suggested = !asked && limit > 0n ? limit : remembered > requested ? remembered : requested,
      choose = (value: bigint) => formatEther(value > total ? total : value);
    $<HTMLInputElement>('fund-amount').value = choose(suggested);
    const presets: [string, bigint][] = [
      ['Half', total / 2n],
      ['All', total],
    ];
    if (requested) presets.unshift([`Requested ${choose(requested)}`, requested]);
    $('fund-presets').replaceChildren(
      ...presets.map(([label, value]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          $<HTMLInputElement>('fund-amount').value = choose(value);
          renderFundDialog();
        });
        return button;
      }),
    );
  }
  renderFundDialog();
  if (!dialog.open) dialog.showModal();
  if (dialog.dataset.mode === 'fund') $<HTMLInputElement>('fund-amount').select();
  return new Promise<bigint | null>(resolve => {
    fundRequest = { resolve };
  });
}
/** A decision only the player makes, once per open game: the wallet explains what changes and waits. */
function openConsentDialog(text: {
  eyebrow: string;
  title: string;
  reason: string;
  note: string;
  allow: string;
  decline: string;
  log: string;
}) {
  if (!active) return Promise.resolve(false);
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
        if (active) logGameActivity(`${text.log} ${allowed ? 'allowed until you leave' : 'declined'}`);
        resolve(allowed);
      },
      { once: true },
    ),
  );
}
/** May this game's host draw the randomness of shared rounds? */
const openHostedDialog = () =>
  openConsentDialog({
    eyebrow: 'SHARED ROUND',
    title: `Join ${active?.manifest.name}'s shared rounds?`,
    reason:
      "Everyone at the table bets on one result, so its randomness comes from the game's host instead of your wallet.",
    note: 'In your own bets neither you nor the casino can choose the result. Here the host and the casino could choose it together; neither can alone. Your wallet still verifies every result and marks these bets in your activity. This choice lasts until you leave the game.',
    allow: 'Allow shared rounds',
    decline: 'Keep my own randomness',
    log: 'Shared-round randomness',
  });
/** May this oracle decide the game's matches, with the casino holding the stakes meanwhile? */
const openOracleDialog = (oracle: string) =>
  openConsentDialog({
    eyebrow: 'MATCH AGAINST PLAYERS',
    title: `Let ${active?.manifest.name} decide your matches?`,
    reason: `You and your opponent each stake into a match. The casino holds the pot, and the game's referee, ${oracle}, decides who is paid. A game may have the stakes settled as one bet when the match opens, so the pot can be smaller or many times larger than the stakes; your wallet checks it.`,
    note: 'A stake in an open match is a promise by the casino: it leaves your playing balance at once and is not protected by your deposit until it is paid back. The referee can decide wrongly, but can only award the stakes to the players as the match terms say, and your wallet checks every payout against those terms and the referee\u2019s signature. A match nobody decides returns the stakes at its deadline. This choice lasts until you leave the game.',
    allow: 'Allow this referee',
    decline: 'Not now',
    log: 'Match referee',
  });
function renderWallet() {
  renderFund();
  if (!wallet.address) return;
  const state = wallet.publicState;
  if (active?.channelId && active.channelId !== wallet.currentId) abandonGame();
  renderHeaderBalance();
  $('casino-balance').textContent = eth(state.balance, networkDefaults.precision);
  $('in-play').classList.toggle('hidden', !BigInt(state.inPlay || 0));
  $('in-play').textContent =
    `Plus ${eth(state.inPlay || '0', networkDefaults.precision)} ETH staked in undecided matches, held by the casino.`;
  $('native-balance').textContent = eth(state.nativeBalance, networkDefaults.precision);
  $('wallet-address').textContent = wallet.address;
  $('wallet-mode').textContent =
    `${wallet.mode === 'demo' ? 'GENERATED BROWSER WALLET' : 'CONNECTED BROWSER WALLET'} · ${wallet.networkName.toUpperCase()}`;
  $('chain-id').textContent = state.chainId || wallet.config.chainId;
  $('activity-count').textContent = String(wallet.history.length);
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
    depositAmount = parseEther($<HTMLInputElement>('transfer-amount').value.trim());
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
      ? `${formatEther(nativeBalance)} ETH in your wallet.${aboveReserve ? ' Continue with step 2.' : ' Add more ETH to cover the gas reserve and a deposit.'}`
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
        ? `Your ${formatEther(nativeBalance)} ETH is reserved for gas. Add ETH to fund your playing balance.`
        : depositTooLarge
          ? `Choose a smaller amount or select Max to keep ${formatEther(wallet.gasReserve)} ETH plus the deposit fee.`
          : maxDepositEstimate
            ? `Maximum to add: ${formatEther(maxDepositEstimate.amount)} ETH. Deposit fee: up to ${formatEther(maxDepositEstimate.maxFee)} ETH.`
            : `In your wallet: ${formatEther(nativeBalance)} ETH. Max calculates what you can add after the gas reserve and fee.`;
  $('pending-banner').classList.toggle(
    'hidden',
    !(wallet.pending || wallet.needsOpening || wallet.transactionIntent) || busy,
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
      : wallet.pending?.kind === 'transfer'
        ? 'Your transfer is waiting for the recipient wallet. The signed request is saved; retry it, cancel it, or close the channel.'
        : wallet.pending?.kind === 'stake'
          ? 'Your stake is waiting for the game to open the match with your opponent. Retry looks for it; withdrawing it leaves your balance unchanged.'
          : wallet.pending?.hosted
            ? 'Your bet is waiting for the table host to play the round. Retry looks for its result; withdrawing it leaves your balance unchanged.'
            : 'Your signed operation is saved. Retry the same operation, or close the channel and preserve its evidence.';
  $<HTMLButtonElement>('speed-up-transaction').classList.toggle('hidden', !wallet.transactionIntent);
  const cancellable = wallet.pending?.kind === 'transfer' || Boolean(wallet.pending?.hosted);
  $<HTMLButtonElement>('cancel-transfer').classList.toggle('hidden', !cancellable);
  $<HTMLButtonElement>('cancel-transfer').textContent =
    wallet.pending?.kind === 'stake' ? 'Withdraw stake' : wallet.pending?.hosted ? 'Withdraw bet' : 'Cancel transfer';
  $<HTMLButtonElement>('cancel-transfer').disabled = busy || !cancellable;
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
  $<HTMLInputElement>('transfer-amount').disabled = busy;
  $<HTMLButtonElement>('withdraw').disabled =
    busy || !ready || Boolean(wallet.pending) || !wallet.current || Number(state.channelStatus) !== 1;
  if (wallet.recoveryOnly) $<HTMLButtonElement>('withdraw').disabled = true;
  const accounts = $<HTMLSelectElement>('saved-wallets');
  if (accounts) {
    const addresses = wallet.savedFundingAddresses || [];
    if (JSON.stringify([...accounts.options].map(o => o.value)) !== JSON.stringify(addresses))
      accounts.replaceChildren(...addresses.map(address => new Option(address, address)));
    accounts.value = wallet.mode === 'demo' ? wallet.address : '';
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
      const gameName = wallet.game && receipt.game?.key === wallet.game.key ? wallet.game.identity.name : undefined;
      const presentation = receiptSummary(receipt);
      const facts: [string, string | Node][] = [['Operation ID', receipt.operationId]];
      if (channelId) facts.push(['Channel', channelId]);
      if (operation?.sequence !== undefined) facts.push(['Sequence', String(operation.sequence)]);
      if (receipt.game?.revision !== undefined) facts.push(['Game revision', String(receipt.game.revision)]);
      if (receipt.developer) facts.push(['Developer', receipt.developer]);
      if (receipt.commission !== undefined) facts.push(['Commission', `${formatEther(receipt.commission)} ETH`]);
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
  $('principal-balance').textContent = `${formatEther(state.protectedDeposit || '0')} ETH`;
  $('channel-status').textContent = state.channelId
    ? `Channel ${short(state.channelId)} · ${Number(state.channelStatus) === 2 ? 'Closing' : Number(state.channelStatus) === 1 ? 'Open' : 'Opening'}`
    : wallet.missingChannel
      ? 'Active channel found. Import its recovery bundle.'
      : 'No open channel';
  $('challenge-deadline').textContent = Number(state.deadline)
    ? `Challenge deadline: ${new Date(Number(state.deadline) * 1000).toLocaleString()}`
    : 'Check this wallet regularly while your channel is open. A stale closure must be challenged on-chain within 24 hours of starting. Keep current recovery evidence.';
  $('channel-observation').textContent =
    `Last verified: ${state.observedAt ? new Date(state.observedAt).toLocaleString() : 'unavailable — refresh before acting'} · Saved sequence ${state.savedSequence || '0'} · Proposed sequence ${state.closingSequence || '0'} · Balance at risk ${formatEther(state.balanceAtRisk || '0')} ETH${state.challengePending ? ' · Challenge transaction pending' : ''}`;
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
    `${short(claim.channelId)} · Due ${formatEther(claim.amount)} ETH · Received ${formatEther(claim.paid)} ETH · Unpaid ${formatEther(BigInt(claim.amount) - BigInt(claim.paid))} ETH` +
    ` · Protected principal ${formatEther(claim.protectedRemaining)} ETH · Unpaid winnings ${formatEther(claim.winningsRemaining)} ETH · Winnings allocated ${formatEther(claim.allocatedWinnings || '0')} ETH` +
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
        await wallet.claim(claim.channelId);
        renderClaims();
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
        await wallet.claim(claim.channelId, destination.value.trim());
        renderClaims();
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
  }
}

function safeURL(value: string, base: string | undefined = undefined) {
  const url = new URL(value, base);
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
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

async function loadGame(url: string, gameRoute: GameRoute, push = true) {
  const manifestURL = safeURL(url);
  // The game keeps its own origin, so it may persist its round state at its host. A same-origin frame
  // could remove its own sandbox and read the wallet's storage, so the wallet's origin is never framed.
  if (manifestURL.origin === location.origin) throw new Error('Games cannot be served from the wallet’s own origin.');
  const response = await fetch(manifestURL, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
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
  const developer = getAddress(manifest.developer);
  if (developer === ZeroAddress) throw new Error('The developer fee recipient cannot be the zero address.');
  const entry = safeURL(manifest.entry, response.url);
  if (entry.origin === location.origin || new URL(response.url).origin === location.origin)
    throw new Error('Games cannot be served from the wallet’s own origin.');
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
    isCurrent,
    onActivity: (type, data) => gameLog.bridge(type, data),
    onRequest: async (method, params) => {
      if (method === 'wallet.info') return wallet.gameInfo();
      if (method === 'game.receipt') return wallet.gameReceipt(params.id);
      if (method === 'game.match') return wallet.matchStatus(params.matchId);
      if (uiBusy || wallet.busy) throw new Error('The wallet is processing another operation.');
      if (method === 'game.requestFunds') {
        const requested = params.amount === undefined ? undefined : BigInt(params.amount);
        // Practice money needs no decision: the wallet tops it up.
        if (wallet.game?.practice) {
          wallet.refillPractice(requested);
          return { funded: true, amount: wallet.game.balance, ...wallet.gameLimit() };
        }
        if (wallet.pending) throw new Error('Recover the pending operation before adding money.');
        const amount = await openFundDialog({ amount: requested, reason: params.reason, asked: true });
        if (!isCurrent()) throw new Error('The game was closed.');
        return { funded: amount !== null, amount: amount === null ? null : String(amount), ...wallet.gameLimit() };
      }
      if (!channelOpen() && !wallet.game?.practice) throw new Error('Add money to this game to play.');
      if (method === 'game.bet') {
        if (params.round && !wallet.game?.hostedRounds) {
          if (!(await openHostedDialog()))
            throw new Error("You kept this wallet's own randomness; the shared round was not joined.");
          if (!isCurrent()) throw new Error('The game was closed.');
          wallet.allowHostedRounds();
        }
        return wallet.gameBet(params);
      }
      if (method === 'game.cancel') return wallet.gameCancel(params);
      if (method === 'game.stake') {
        if (!wallet.game?.oracles?.some(oracle => oracle.toLowerCase() === params.match.oracle.toLowerCase())) {
          if (!(await openOracleDialog(params.match.oracle)))
            throw new Error('You did not allow this referee; no stake was placed.');
          if (!isCurrent()) throw new Error('The game was closed.');
          wallet.allowOracle(params.match.oracle);
        }
        return wallet.gameStake(params);
      }
      if (method === 'game.payment') return wallet.gamePayment(params);
      return wallet.gameTransfer(params);
    },
    onError: message => toast(message, true),
  });
  frame.src = entry.href;
  $('frame-slot').replaceChildren(frame);
  showPage('play');
  if (push && location.pathname + location.search !== path) history.pushState(null, '', path);
  renderGameAccount();
}

for (const button of document.querySelectorAll<HTMLElement>('[data-page]'))
  button.addEventListener('click', event => {
    event.preventDefault();
    // While a game is open, the top bar's balance is where the player sees and changes its limit.
    if (button.id === 'top-balance' && active) return void openFundDialog({});
    navigate(button.dataset.page!);
    if (button.hasAttribute('data-receive') && !$('page-wallet').classList.contains('hidden')) {
      $('receive-title').focus({ preventScroll: true });
      $('receive-title').scrollIntoView({ block: 'center' });
    }
  });
async function loadLibrary() {
  const list = $('game-library');
  try {
    const catalogURL = `${gamesURL}/catalog.json`;
    const catalog = await readManifest(
      await fetch(catalogURL, { credentials: 'omit', signal: AbortSignal.timeout(12000) }),
    );
    if (!Array.isArray(catalog) || catalog.length > 32 || catalog.some(url => typeof url !== 'string'))
      throw new Error('Invalid game catalog');
    const entries = await Promise.all(
      catalog.map(async url => {
        const manifestURL = safeURL(url, catalogURL).href;
        const response = await fetch(manifestURL, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Game catalog unavailable');
        return { manifestURL, manifest: await readManifest(response) };
      }),
    );
    $('library-count').textContent = $('library-heading-count').textContent = String(entries.length);
    catalogGames.clear();
    list.replaceChildren(
      ...entries.map(({ manifestURL, manifest }) => {
        // A catalog game is linkable by its manifest id; a manifest without one is only reachable by URL.
        const id =
          typeof manifest.id === 'string' &&
          GAME_ID.test(manifest.id) &&
          !catalogGames.has(manifest.id) &&
          manifest.id !== 'custom'
            ? manifest.id
            : null;
        if (id) catalogGames.set(id, { manifestURL, manifest });
        const gameRoute: GameRoute = id ? { id } : { manifest: manifestURL };
        const card = document.createElement('a'),
          title = document.createElement('h3'),
          description = document.createElement('p'),
          link = document.createElement('span');
        card.className = 'game-card catalog-card';
        card.href = gamePath(gameRoute);
        title.textContent = String(manifest.name).slice(0, 80);
        description.textContent = String(manifest.description || 'Independent game').slice(0, 220);
        link.className = 'catalog-link';
        link.textContent = id ? `/games/${id}` : new URL(manifestURL).host;
        card.append(title, description, link);
        card.addEventListener('click', event => {
          event.preventDefault();
          task(() => loadGame(manifestURL, gameRoute));
        });
        return card;
      }),
    );
  } catch {
    list.textContent = 'Game catalog unavailable. You can load a custom manifest below.';
  }
}
const libraryLoaded = loadLibrary();
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
    toast('1 test ETH deposited. Choose a game to play.');
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
    toast(`${active.manifest.name} may play with up to ${formatEther(amount)} ETH.`);
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
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fund-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('fund-dialog').close(''));
$<HTMLButtonElement>('fund-open-wallet').addEventListener('click', () => {
  $<HTMLDialogElement>('fund-dialog').close('');
  navigate('wallet');
  $('receive-title').scrollIntoView({ block: 'center' });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fund-practice]'))
  button.addEventListener('click', () => {
    if (!active) return;
    wallet.setPractice(true);
    logGameActivity('Practice money started');
    $<HTMLDialogElement>('fund-dialog').close('');
    reloadGame();
    toast('Practice money: the same bets at the same odds, nothing real won or lost.');
  });
$<HTMLButtonElement>('fund-real').addEventListener('click', () => {
  if (!active) return;
  wallet.setPractice(false);
  logGameActivity('Practice money ended');
  $<HTMLDialogElement>('fund-dialog').close('');
  if (channelOpen()) return reloadGame();
  navigate('wallet');
  $('receive-title').scrollIntoView({ block: 'center' });
});
$<HTMLInputElement>('fund-slider').addEventListener('input', () => {
  const stops = limitStops(BigInt(wallet.current?.state.balance || 0));
  $<HTMLInputElement>('fund-amount').value = formatEther(stops[Number($<HTMLInputElement>('fund-slider').value)] ?? 0n);
  renderFundDialog();
});
$<HTMLInputElement>('fund-amount').addEventListener('input', renderFundDialog);
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
        ? 'Transfer is still waiting for its recipient.'
        : 'Saved wallet operation recovered. Reopen its game to continue the session.',
    );
  }),
);
$<HTMLButtonElement>('cancel-transfer').addEventListener('click', () =>
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
    const amount = parseEther($<HTMLInputElement>('transfer-amount').value.trim());
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
      $<HTMLInputElement>('transfer-amount').value = formatEther(maxDepositEstimate.amount);
      if (maxDepositEstimate.amount === 0n)
        throw new Error('Add ETH to cover the gas reserve and deposit fee before funding play.');
    } finally {
      $<HTMLButtonElement>('max-deposit').textContent = 'Max';
    }
  }),
);
$<HTMLInputElement>('transfer-amount').addEventListener('input', () => {
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
    await wallet.collectMatchPayouts();
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
      await wallet.importEvidence(JSON.parse(await file.text()));
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
    field.classList.toggle('hidden');
    field.value = field.classList.contains('hidden') ? '' : wallet.exportKey();
    $<HTMLButtonElement>('export-key').textContent = field.classList.contains('hidden')
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
$<HTMLButtonElement>('refresh-wallet').addEventListener('click', () => void refreshActivity());
$<HTMLButtonElement>('wallet-history').addEventListener('click', () => navigate('activity'));
$<HTMLButtonElement>('connect-casino').addEventListener('click', () =>
  task(async () => {
    if (wallet.pending) throw new Error('Recover the pending operation before switching services.');
    const nextCasino = endpoint($<HTMLInputElement>('casino-url').value.trim()),
      nextGames = endpoint($<HTMLInputElement>('games-url').value.trim());
    const nextNetwork = $<HTMLSelectElement>('network-mode').value === 'local' ? 'local' : 'sepolia';
    closeGame();
    localStorage.setItem(`hookedin:v1:${nextNetwork}:casino-url`, nextCasino);
    localStorage.setItem(`hookedin:v1:${nextNetwork}:games-url`, nextGames);
    localStorage.setItem(networkSetting, nextNetwork);
    location.assign('/');
  }),
);
$<HTMLInputElement>('casino-url').value = casinoURL;
$<HTMLInputElement>('games-url').value = gamesURL;
$<HTMLSelectElement>('network-mode').value = network;
const asset = `${wallet.networkName} ETH`;
$('network-name').textContent = wallet.networkName;
$('asset-pill').textContent = asset.toUpperCase();
$('asset-name').textContent = asset;
$('receive-network').textContent = `${wallet.networkName} · ${wallet.expectedChainId}`;
$('receive-instructions').textContent =
  `Send ${asset} from another wallet or a faucet to the address below. You can copy it into the sender’s destination field.`;
$('receive-network-note').textContent =
  `Select ${wallet.networkName} (chain ${wallet.expectedChainId}) in the sending wallet or service. ETH sent on another network won’t appear in this balance.`;
$<HTMLInputElement>('transfer-amount').value = networkDefaults.transfer;

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
  await libraryLoaded;
  await route();
} catch (error: any) {
  $('connection-banner').textContent =
    `${error.shortMessage || error.message} Check Connected services in My wallet, then reload this client.`;
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
    await wallet.restoreBackup(JSON.parse(await file.text()), $<HTMLInputElement>('backup-password').value);
    $<HTMLInputElement>('backup-password').value = '';
    $<HTMLInputElement>('restore-backup').value = '';
    toast('Backup restored. Check the channel status and recover any pending operation.');
  }),
);
