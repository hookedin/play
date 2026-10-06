import qrcode from 'qrcode-generator';
import { CasinoWallet } from './wallet.ts';
import { inUnit, typedIn, validateWithdrawal, type Unit } from './withdrawal.ts';
import { passkeyKey } from './passkey.ts';
import { gameReceipt } from './wallet-games.ts';
import { OPERATIONS } from './wallet-channel.ts';
import { inbound } from './wallet-transactions.ts';
import { BrowserStore } from './storage.ts';
import { json, same, verifyEvidence, collateralPrice, channelId, STATUS, UNAME } from '../protocol/protocol.ts';
import {
  activityJSON,
  copyBlock,
  createActivityEntry,
  developerBetSummary,
  exact,
  h,
  percent,
  receiptSummary,
} from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import {
  $,
  casinoURL,
  deployment,
  download,
  network,
  short,
  showName,
  showOnTop,
  shortDate,
  showSheet,
  toast,
  typedAmount,
} from './page.ts';
import { inSettings, parseRoute, route, walletPath, walletRoute, type GameRoute, type WalletTab } from './routes.ts';
import { abandonGame, active, closeGame, openGame, renderGameAccount } from './games.ts';
import { renderProfile } from './profiles.ts';
import { renderDeveloper } from './developer.ts';
import { filterList, renderBets, renderMyGames } from './played.ts';
import { renderFund } from './bankroll.ts';

export let uiBusy = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
export let historyBusy = false;
let historyError: any = null;
const storage = new BrowserStore();
export const wallet = new CasinoWallet({
  storage,
  casinoURL,
  network,
  trustedDeployment: deployment,
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

/** Where a claim pays, as a sentence says it: paying the contract puts it into the account's own channel. */
const paidTo = (to: string) =>
  same(to, wallet.config.contractAddress)
    ? 'into your balance'
    : same(to, wallet.address)
      ? 'to your address'
      : `to ${short(to)}`;
/** A typed amount of METH, in wei: null for anything that is not an amount above zero. */
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
  const what = `${exact(request.amount)} METH ${OPERATIONS[kind]!.name}${game ? ` in ${game.name}` : ''}`,
    failed = wallet.pendingError?.operationId === operationId ? wallet.pendingError : null;
  return (
    `Your ${what} is saved and unanswered (operation ${short(details.id)}, sequence ${BigInt(wallet.channel!.state.sequence) + 1n}). ` +
    'Retry sends exactly the same request again.' +
    (wallet.disputable()
      ? ` The casino's quote covers this bet until ${new Date(Number(wallet.pending.quote.message.expiresAt) * 1000).toLocaleString()}: Close without the casino disputes it, and the casino then has 7 days to settle it on-chain, or it counts as won.`
      : wallet.bound()
        ? ' The casino left this bet unanswered until its quote expired, so it can no longer be disputed, and the wallet takes no decline of it: Close without the casino ends this balance, and the bet with it.'
        : '') +
    (failed ? ` Last attempt: ${failed.message}${failed.code ? ` (${failed.code})` : ''}.` : '')
  );
}
/** What Withdraw's amount is typed in: the unit the player chooses. */
const withdrawUnit = () => $<HTMLSelectElement>('withdraw-unit').value as Unit;
/** Money out of the open balance to an address, as Withdraw's form has it. */
const withdrawRequest = () =>
  validateWithdrawal({
    destination: $<HTMLInputElement>('withdraw-to').value,
    ownAddress: wallet.address,
    contractAddress: wallet.config.contractAddress,
    amount: $<HTMLInputElement>('withdraw-amount').value,
    unit: withdrawUnit(),
    maximum: wallet.withdrawable(),
    channel: true,
  });
/** The player Transfer names: the name typed, with its sigil, and once the casino has answered, their public profile,
 * or why there is none. */
let payee: { name: string; profile: any; error: string | null } | null = null;
let lookingUp: ReturnType<typeof setTimeout> | undefined;
/** Find the player whose name is typed under Transfer, a moment after the typing stops. A link to a player's page is
 * written as their name; a name typed without its sigil is a uname when it reads like one, and otherwise a Discord
 * username. */
export function lookUpPayee() {
  clearTimeout(lookingUp);
  const input = $<HTMLInputElement>('transfer-to');
  if (/^https?:\/\//i.test(input.value.trim()))
    try {
      const target = parseRoute(new URL(input.value.trim()));
      if (typeof target === 'object' && 'profile' in target) input.value = target.profile;
    } catch {}
  const typed = input.value.trim(),
    name = /^[@~]/.test(typed) ? typed : (UNAME.test(typed.toLowerCase()) ? '~' : '@') + typed;
  payee = typed
    ? {
        name,
        profile: null,
        error: /^[@~][A-Za-z0-9_.]{2,32}$/.test(name)
          ? null
          : 'Enter a Discord username, such as @bob, a uname, such as ~3byt9ocwnnzaxanmiz3stocj, or a link to their page.',
      }
    : null;
  const asked = payee;
  if (asked && !asked.error)
    lookingUp = setTimeout(async () => {
      try {
        asked.profile = await wallet.api(`/api/players/${name}`);
      } catch (error: any) {
        asked.error = error.code === 'not-found' ? `Nobody goes by ${name}.` : error.message;
      }
      if (payee === asked) renderWallet();
    }, 300);
  renderWallet();
}
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
    payee = null;
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
    paid = wallet.depositFeePaid(whole, fee);
  $('deposit-fee').textContent =
    fee > 0n
      ? `Address balance ${exact(held)} METH. Estimated maximum network fee ${exact(fee)} METH. Up to ${exact(whole + paid)} METH can be added now${paid ? ': the casino pays the network fee' : ''}. The final fee is recorded in Activity.`
      : 'The network fee is estimated when ETH arrives. Small deposits may not cover that fee.';
}

/** One user action at a time. A background poll holding the wallet finishes first. */
export async function task(callback: () => unknown | Promise<unknown>) {
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
export function act(id: string, run: () => unknown, done?: string | (() => string)) {
  $(id).addEventListener('click', () =>
    task(async () => {
      await run();
      if (done) toast(typeof done === 'string' ? done : done());
    }),
  );
}

let walletTab: WalletTab = 'deposit';
/** The wallet's dialog on one of its tabs, over the page it opens on, and why it opened when it was not the player's own
 * click. Opening it is a step in the history, which closing it goes back from. */
export function openWallet(tab: WalletTab = 'deposit', reason = '') {
  $('account-menu').hidePopover?.();
  $('wallet-reason').textContent = reason;
  $('wallet-reason').hidden = !reason;
  if (!$<HTMLDialogElement>('wallet-dialog').open) history.pushState({ over: true }, '', walletPath(tab));
  showWallet(tab);
}
/** The wallet, or Settings, on `tab`. A tab has a path, but no step in the history of its own: Back closes the sheet. */
export function showWallet(tab: WalletTab) {
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
  if (['withdraw', 'recovery'].includes(tab) && wallet.channel) void wallet.quoteWithdrawalFee().catch(() => {});
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
/** The open balance's state, as both forms that take money out of it render it. */
interface SendState {
  open: boolean;
  busy: boolean;
  ready: boolean;
  closing: boolean;
}
/** Why a form that takes money out of the balance cannot now, when the balance itself is the reason. */
const sendBlocked = ({ open, ready, closing }: SendState, verb: string) =>
  !ready
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
              : null;
/** Withdraw: part of the signed balance, or all of it with Max, which the casino then pays to the address entered. */
function renderWithdraw(state: SendState) {
  const { open, busy } = state,
    request = withdrawRequest(),
    amount = request.amount,
    unit = withdrawUnit(),
    blocked = sendBlocked(state, 'Withdraw');
  $('withdraw-form').classList.toggle('hidden', !open);
  // Money goes out signing the casino's fee only once it is shown.
  $<HTMLButtonElement>('withdraw').disabled =
    busy || Boolean(blocked) || !wallet.withdrawalFee || Boolean(request.error);
  $('withdraw').textContent = `Withdraw${amount === null ? '' : ` ${inUnit(amount, unit)} ${unit}`}`;
  // A withdrawal leaves for a wallet that may count in ETH: what it receives is said in both units.
  const receives =
    amount === null
      ? ''
      : `The address receives ${inUnit(amount, unit)} ${unit} (${unit === 'ETH' ? `${exact(amount)} METH` : `${inUnit(amount, 'ETH')} ETH`}).`;
  // A form not yet touched is told what it needs, not that it is wrong.
  const touched = Boolean(
    $<HTMLInputElement>('withdraw-to').value.trim() || $<HTMLInputElement>('withdraw-amount').value.trim(),
  );
  $('withdraw-help').textContent =
    blocked ??
    (!touched && request.error
      ? 'Enter an amount, or Max, and the address that should receive it.'
      : request.error ||
        `${receives}${wallet.withdrawalFee ? ` Your balance also pays the casino ${formatAmount(wallet.withdrawalFee)} METH for sending it.` : ''} Check the full address before confirming.`);
  $('withdraw-help').classList.toggle('check-failed', !blocked && touched && Boolean(request.error));
}
/** A transfer as Transfer has it: the amount, the player the name typed belongs to, and what is wrong with either, or
 * only a `prompt` for what is still to come: the name, the casino's answer to who goes by it, or the amount. */
function transferRequest() {
  const typed = $<HTMLInputElement>('transfer-amount').value.trim(),
    amount = typedIn(typed, 'METH'),
    most = BigInt(wallet.channel?.state.balance ?? 0),
    profile = payee?.profile ?? null;
  const wrong =
      payee?.error ||
      (profile?.uname === wallet.uname
        ? 'That is you: transfer to another player.'
        : most <= 0n
          ? 'Nothing to transfer: your balance is empty.'
          : typed && amount === null
            ? 'Enter an amount in METH above zero, with at most 12 decimal places.'
            : amount !== null && amount > most
              ? `At most ${exact(most)} METH can go.`
              : null),
    missing = !payee
      ? 'Choose who it goes to: their Discord username, uname or a link to their page.'
      : !profile
        ? `Looking up ${payee.name}…`
        : amount === null
          ? 'Enter an amount or choose Max.'
          : null;
  return { profile, amount, error: wrong || missing, prompt: !wrong };
}
/** The players this account last transferred to or received from, newest first: the uname each transfer named, and the
 * name they went by then. */
function recentPlayers() {
  const players = new Map<string, string>();
  for (const receipt of wallet.history) {
    const uname = receipt.details?.counterparty;
    if (
      ['transfer', 'transfer-in'].includes(receipt.kind) &&
      receipt.status !== 'rejected' &&
      uname?.startsWith('~') &&
      !players.has(uname)
    )
      players.set(uname, receipt.name || uname);
  }
  return [...players].slice(0, 6);
}
/** A player's badge: the first letter of their name. */
const badge = (name: string) => h('span', { className: 'avatar' }, name.charAt(1).toUpperCase());
/** Transfer: who it goes to, picked from the players of this account's last transfers or found by the name typed, then
 * part of the signed balance, or all of it with Max. */
function renderTransfer(state: SendState) {
  const { open, busy } = state,
    { profile, amount, error, prompt } = transferRequest(),
    blocked = sendBlocked(state, 'Transfer'),
    to = $<HTMLInputElement>('transfer-to').value.trim(),
    touched = Boolean(to || $<HTMLInputElement>('transfer-amount').value.trim()),
    found = profile && profile.uname !== wallet.uname ? profile : null;
  $('transfer-form').classList.toggle('hidden', !open);
  // Until a name is typed, the players of this account's last transfers are a tap away.
  const recent = recentPlayers(),
    list = $('transfer-recent');
  list.hidden = !recent.length || Boolean(to);
  if (list.dataset.players !== JSON.stringify(recent)) {
    list.dataset.players = JSON.stringify(recent);
    list.replaceChildren(
      ...recent.map(([uname, name]) =>
        h('button', { type: 'button', className: 'chip', value: uname, title: uname }, badge(name), name),
      ),
    );
  }
  // The player the name belongs to, as their page shows them: the uname the transfer signs is the one under it.
  $('transfer-payee').hidden = !found;
  if (found)
    $('transfer-payee').replaceChildren(
      badge(showName(found)),
      h(
        'div',
        null,
        h('strong', null, showName(found)),
        h(
          'small',
          null,
          [
            found.discordUsername ? `~${found.uname}` : '',
            found.discordVerified
              ? `Verified on Discord ${shortDate(found.discordVerified)}`
              : `Joined ${shortDate(found.createdAt)}`,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    );
  $<HTMLButtonElement>('transfer').disabled = busy || Boolean(blocked) || Boolean(error);
  $('transfer').textContent =
    `Transfer${amount === null ? '' : ` ${exact(amount)} METH`}${found ? ` to ${showName(found)}` : ''}`;
  $('transfer-help').textContent =
    blocked ??
    (!touched
      ? recent.length
        ? 'Choose a player from your last transfers, or enter the name of another.'
        : 'Enter the Discord username or uname of the player it goes to, or a link to their page.'
      : error ||
        `${showName(profile)} receives ${exact(amount!)} METH once their wallet collects it into their balance. No fee.`);
  $('transfer-help').classList.toggle('check-failed', !blocked && touched && Boolean(error) && !prompt);
}
/** The account the saved-accounts list was last set to, so a render only moves it when that changes. */
let shownAccount: string | null = null;
export function renderWallet() {
  renderFund();
  renderProfile();
  renderDeveloper();
  $<HTMLButtonElement>('refresh-wallet').disabled = historyBusy || !wallet.address;
  if (!wallet.address) return;
  const state = wallet.publicState;
  if (active?.channelId && active.channelId !== wallet.channelId) abandonGame();
  const busy = uiBusy || wallet.busy;
  const ready = state.address === wallet.address;
  const observed = Boolean(state.observedAt);
  const balance = BigInt(state.balance || 0),
    arriving = BigInt(state.arriving || 0),
    // What the deposit address holds, read from the chain: until it has been, there is nothing to show.
    atAddress = observed ? BigInt(state.nativeBalance || '0') : 0n,
    closing = Number(state.channelStatus) === STATUS.closing || Boolean(wallet.channel?.closing);
  $('balance-amount').textContent = formatAmount(balance, 0);
  $('balance-amount').title = `${exact(balance)} METH`;
  renderCollateral();
  renderSafety();
  const inPlay = wallet.inPlay();
  // A balance can come before any deposit, from another player's transfer: its key is the account, saved or not.
  $('balance-note').textContent =
    balance && localStorage.getItem(savedSetting()) === null
      ? "This balance's key is only in this browser: save your wallet under Keys in Settings, or the balance is lost with it."
      : inPlay
        ? `${formatAmount(inPlay)} METH of it is in play in ${active?.identity.name}: it joins the game's allowance once the game has shown how its round ended.`
        : arriving
          ? `${formatAmount(arriving)} METH of it is on its way into your balance.`
          : state.closingChannelId && !state.channelId
            ? 'Your last balance is closing: finish the close under Settings → Recovery once its deadline passes, and collect it. A deposit opens your next balance.'
            : 'What games play with.';
  $('wallet-address').textContent = wallet.address;

  // Deposit: ETH sent to the address goes into the balance by itself, unless something the player should decide on
  // is in the way.
  const held = atAddress ? ` It holds ${formatAmount(atAddress)} METH.` : '';
  const depositStatus = !ready
    ? 'Connecting to your wallet…'
    : !observed
      ? 'Checking your deposit address…'
      : wallet.depositing
        ? `Adding ${formatAmount(wallet.depositing)} METH to your balance…`
        : arriving
          ? `${formatAmount(arriving)} METH is on its way into your balance.`
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
                    : `Waiting for ETH. Deposits are added after network confirmation.${wallet.config.depositFeeLimit == null ? ' The network fee of adding them comes out of them.' : ' The casino pays the network fee of adding them, as far as its daily budget goes.'}`;
  if ($('deposit-status').textContent !== depositStatus) $('deposit-status').textContent = depositStatus;
  const addable = (wallet.forceClosed || !wallet.autoDeposit) && !wallet.recoveryOnly && !closing && atAddress > 0n;
  $('add-to-balance').classList.toggle('hidden', !addable);
  $<HTMLButtonElement>('add-to-balance').disabled = busy || !ready;
  $<HTMLButtonElement>('copy-address').disabled = !ready;
  $('setup-wallet').classList.toggle('hidden', !wallet.isLocalDevelopment);
  $<HTMLButtonElement>('setup-wallet').disabled = busy;

  const open = wallet.playable;
  renderWithdraw({ open, busy, ready, closing });
  renderTransfer({ open, busy, ready, closing });

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
        : `Your deposit address holds ${formatAmount(atAddress)} METH. Check the full address before confirming.`;
  $('address-send-help').classList.toggle('check-failed', typed && Boolean(send.error));

  $('history-banner').textContent = wallet.historyAlert ?? '';
  $('history-banner').classList.toggle('hidden', !wallet.historyAlert);
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
  $<HTMLButtonElement>('start-close').disabled = busy || !closable();
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
      ? `${formatAmount(missing)} METH of your balance is deposits the chain does not hold: a close is owed them only once they land again.`
      : '',
    uncovered > 0n
      ? `${formatAmount(uncovered)} METH of your balance is winnings above them, which the bankroll pays only as it has the cash until you lock it in under Recovery or buy collateral for it.`
      : `${missing > 0n ? 'The rest' : 'All'} of your balance is protected${spare > 0n ? `, and ${formatAmount(spare)} METH more that you win would be too` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const button = $<HTMLButtonElement>('buy-collateral');
  button.disabled = uiBusy || wallet.busy || !wallet.playable || rate === null || !amount || Boolean(buying);
  button.textContent =
    amount && rate !== null ? `Buy for ${formatAmount(collateralPrice(amount, rate))} METH` : 'Buy collateral';
  $('collateral-help').textContent = buying
    ? `Send ${formatAmount(BigInt(buying.price) + 2n * wallet.depositFee)} METH or more to your deposit address by ${new Date(Number(buying.expiresAt) * 1000).toLocaleTimeString()}, the price and its network fee: the wallet buys ${formatAmount(buying.amount)} METH of collateral with it before it adds anything to your balance.`
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

export function renderActivity() {
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
  // A withdrawal shows its transaction once the ones before it are recorded, which its own JSON does not say.
  syncRows(
    $('activity-list'),
    wallet.history,
    receipt => receipt.operationId,
    receipt => activityJSON(receipt) + (receipt.withdrawal ? wallet.nextToRecord(receipt) : ''),
    activityEntry,
  );
  filterList('activity');
}
/** One receipt as Activity lists it, with the facts behind it. */
function activityEntry(receipt: any) {
  // A declined operation's proof is the checkpoint above it, with no step: the operation is the one it declined.
  const operation = receipt.request ?? receipt.proof?.step?.operation;
  // The checkpoint it reached names its channel: the one after its step, or the rejection's.
  const base = receipt.proof?.base,
    channel = base ? channelId(base.player, base.index) : receipt.channelId;
  const presentation = receiptSummary(receipt, wallet.config.contractAddress);
  const facts: [string, string | Node][] = [['Operation ID', receipt.operationId]];
  if (channel) facts.push(['Channel', channel]);
  if (base)
    facts.push(['Sequence', String(BigInt(base.sequence) + (Number(operation?.kind) && !receipt.request ? 1n : 0n))]);
  if (receipt.commission !== undefined) facts.push(['Commission', `${exact(receipt.commission)} METH`]);
  if (receipt.to)
    facts.push(['To', same(receipt.to, wallet.config.contractAddress) ? 'Your own channel, as deposits' : receipt.to]);
  // A transfer's other player, as they went by then, and the uname it named.
  const player = receipt.details?.counterparty;
  if (player?.startsWith('~'))
    facts.push([
      receipt.kind === 'transfer' ? 'To' : 'From',
      receipt.name === player ? player : `${receipt.name} (${player})`,
    ]);
  if (receipt.withdrawal) facts.push(['Withdrawal ID', receipt.withdrawal]);
  // One the contract has not made a claim yet, the casino sends straight away, and anyone can send from any wallet: the
  // oldest of its channel first, since the contract records them in order.
  if (receipt.withdrawal && !receipt.recorded && !receipt.returned && wallet.nextToRecord(receipt))
    facts.push([
      'Send it yourself',
      h(
        'details',
        { className: 'raw-details' },
        h('summary', null, 'Transaction data'),
        h(
          'p',
          null,
          `From any wallet to ${wallet.config.contractAddress}, with this data. Whoever sends it pays its gas.`,
        ),
        ...copyBlock(
          wallet.contract.interface.encodeFunctionData('withdraw', [receipt.proof]),
          presentation.title,
          'data',
        ),
      ),
    ]);
  if (receipt.fee !== undefined) facts.push(['Network fee', `${exact(receipt.fee)} METH`]);
  if (receipt.txHash) facts.push(['Transaction', transactionLink(receipt.txHash)]);
  if (receipt.recordedIn) facts.push(['Recorded in', transactionLink(receipt.recordedIn)]);
  if (receipt.blockNumber !== undefined) facts.push(['Block', String(receipt.blockNumber)]);
  return createActivityEntry({
    ...presentation,
    timestamp: receipt.createdAt,
    payload: activityJSON(receipt),
    facts,
    description:
      receipt.game?.name ||
      (receipt.to
        ? `To ${short(receipt.to)}`
        : receipt.name
          ? `${receipt.kind === 'transfer' ? 'To' : 'From'} ${receipt.name}`
          : undefined),
    notice: [presentation.description, presentation.notice].filter(Boolean).join(' '),
  });
}
/** Whether the balance can be closed without the casino: it has an active channel. */
const closable = () => Boolean(wallet.channel) && Number(wallet.publicState.channelStatus) === STATUS.active;
/** The balance's channel and any whose close is under way, for recovery: their state on the chain, and the lock in,
 * close, challenge and collect a player can do without the casino. */
function renderRecovery() {
  const state = wallet.publicState,
    busy = uiBusy || wallet.busy,
    open = closable() && !wallet.channel?.closing,
    closing = state.closingChannelId,
    deadline = Number(state.deadline);
  $('channel-status').textContent = wallet.missingChannel
    ? 'The casino holds another state of this balance than this browser: import its recovery bundle.'
    : [
        state.channelId
          ? `Channel ${short(state.channelId)} · ${Number(state.channelStatus) === STATUS.active ? (wallet.channel?.closing ? 'close signed; retry submission' : 'active') : 'closing'}`
          : 'No balance open',
        closing ? `channel ${short(closing)} · closing` : '',
      ]
        .filter(Boolean)
        .join(' · ');
  $('channel-observation').classList.toggle('hidden', !state.channelId && !closing);
  $('channel-observation').textContent = [
    open
      ? `The contract holds ${formatAmount(state.principal || '0')} METH of your deposits and ${formatAmount(state.collateral || '0')} METH of collateral for this balance, at saved sequence ${state.savedSequence || '0'}.`
      : '',
    open && wallet.withdrawalFee
      ? `Locking in pays the casino ${formatAmount(wallet.withdrawalFee)} METH for sending it.`
      : '',
    closing
      ? BigInt(state.disputedPrize || 0) > 0n
        ? `The close disputes your casino bet at sequence ${state.closingSequence}: the casino has until the deadline to settle it on-chain, or it counts as won and pays ${formatAmount(state.disputedPrize)} METH. Meanwhile the contract holds ${formatAmount(state.disputeHold || '0')} METH of house cash for it, which the casino cannot take.`
        : state.needsChallenge
          ? `The close proposes sequence ${state.closingSequence || '0'} where you saved ${state.closingSaved || '0'}, ${formatAmount(state.balanceAtRisk || '0')} METH less than yours${state.challengePending ? '; a challenge is on its way' : ''}.`
          : `The close stands at sequence ${state.closingSequence || '0'}, your latest saved state.`
      : '',
    `Last checked ${state.observedAt ? new Date(state.observedAt).toLocaleString() : 'never: refresh before acting'}.`,
  ]
    .filter(Boolean)
    .join(' ');
  $('challenge-deadline').textContent =
    closing && deadline
      ? Date.now() / 1000 < deadline
        ? `The close can be challenged until ${new Date(deadline * 1000).toLocaleString()}.`
        : `The close's challenge period ended ${new Date(deadline * 1000).toLocaleString()}: finish it.`
      : '';
  $<HTMLButtonElement>('channel-export').disabled = !(wallet.channel || wallet.closingChannel) || busy;
  // Locking in moves winnings into the deposits: with all of the balance protected, there is nothing to lock in.
  $<HTMLButtonElement>('channel-lock').disabled =
    !open || !BigInt(state.protection?.uncovered || 0) || !wallet.withdrawalFee || Boolean(wallet.pending) || busy;
  $<HTMLButtonElement>('channel-start-close').disabled = !closable() || Boolean(wallet.transactionIntent) || busy;
  $('channel-start-close').textContent =
    wallet.channel?.closing && Number(state.channelStatus) === STATUS.active
      ? 'Retry close'
      : 'Close without the casino';
  $('recovery-gas').textContent =
    `Your deposit address holds ${formatAmount(state.nativeBalance || 0)} METH for network fees. Closing, challenging and finishing need ETH at this address. Starting a close pauses automatic deposits so gas top-ups stay here.${!wallet.autoDeposit ? ' Automatic deposits are paused; turn them back on under Deposits when ready.' : ''}`;
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
      `${claim.channelId ? `Channel ${short(claim.channelId)}` : 'A withdrawal'}, paid ${paidTo(claim.to)}: ${formatAmount(unpaid)} METH still owed of ${formatAmount(claim.amount)} METH. ` +
      (ready > 0n
        ? `${formatAmount(ready)} METH can be collected now.`
        : `Its ${formatAmount(claim.winningsRemaining)} METH of winnings wait for the bankroll to have the cash.`)
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
              ? `Collected ${formatAmount(collected)} METH.`
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
export async function refreshWallet() {
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

for (const id of ['refresh-bets', 'refresh-wallet']) $(id).addEventListener('click', () => void refreshWallet());
act('setup-wallet', async () => {
  await wallet.setupDemo();
  funded('Demo ETH added: games play with ETH.');
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
  wallet.showDeposit(false);
  if (!walletRoute()) return;
  if (history.state?.over) history.back();
  else {
    history.replaceState(null, '', '/');
    void route();
  }
});
function downloadEvidence(report: any) {
  const { state } = verifyEvidence(report),
    channel = channelId(state.player, state.index);
  download(`hookedin-channel-${channel}.json`, json(report));
  toast(`Exported the recovery bundle of channel ${short(channel)}, sequence ${state.sequence}.`);
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
  funded(`Added ${formatAmount(BigInt(wallet.publicState.balance || 0) - before)} METH to your balance.`);
});
for (const id of ['withdraw-to', 'withdraw-amount', 'transfer-amount', 'address-send-to', 'collateral-buy-amount'])
  $<HTMLInputElement>(id).addEventListener('input', () => renderWallet());
$<HTMLInputElement>('transfer-to').addEventListener('input', lookUpPayee);
// A player picked from this account's last transfers: the amount is what is left to enter.
$('transfer-recent').addEventListener('click', event => {
  const chip = (event.target as Element).closest('button');
  if (!chip) return;
  $<HTMLInputElement>('transfer-to').value = chip.value;
  lookUpPayee();
  $('transfer-amount').focus();
});
// Switching Withdraw's unit keeps the amount typed, written in the other unit.
$<HTMLSelectElement>('withdraw-unit').addEventListener('change', () => {
  const input = $<HTMLInputElement>('withdraw-amount'),
    unit = withdrawUnit(),
    wei = typedIn(input.value, unit === 'ETH' ? 'METH' : 'ETH');
  if (wei !== null) input.value = inUnit(wei, unit, true);
  renderWallet();
});
$<HTMLButtonElement>('withdraw-max').addEventListener('click', () => {
  $<HTMLInputElement>('withdraw-amount').value = inUnit(wallet.withdrawable(), withdrawUnit(), true);
  renderWallet();
});
act('withdraw', async () => {
  const { to, amount, error } = withdrawRequest();
  if (error || !to || amount === null) throw new Error(error || 'Enter a destination address.');
  // Money partly out leaves the open game its allowance; all of it takes back what the game holds.
  if (amount >= wallet.withdrawable()) abandonGame();
  const receipt = await wallet.withdraw(to, amount);
  $<HTMLInputElement>('withdraw-to').value = '';
  $<HTMLInputElement>('withdraw-amount').value = '';
  $<HTMLDialogElement>('wallet-dialog').close();
  toast(
    `Withdrew ${exact(receipt.amount)} METH: the contract pays it to ${short(to)}, and Activity shows when it has.`,
  );
});
$<HTMLButtonElement>('transfer-max').addEventListener('click', () => {
  $<HTMLInputElement>('transfer-amount').value = inUnit(BigInt(wallet.channel?.state.balance ?? 0), 'METH', true);
  renderWallet();
});
act('transfer', async () => {
  const { profile, amount, error } = transferRequest();
  if (error || !profile || amount === null) throw new Error(error || 'Enter an amount and the player it goes to.');
  // Money partly out leaves the open game its allowance; all of it takes back what the game holds.
  if (amount >= BigInt(wallet.channel?.state.balance ?? 0)) abandonGame();
  const receipt = await wallet.transfer(profile, amount);
  $<HTMLInputElement>('transfer-to').value = '';
  $<HTMLInputElement>('transfer-amount').value = '';
  payee = null;
  $<HTMLDialogElement>('wallet-dialog').close();
  toast(`Transferred ${exact(receipt.amount)} METH to ${showName(profile)}: their wallet collects it.`);
});
act('address-send', async () => {
  const { to, error } = addressSendRequest();
  if (error || !to) throw new Error(error || 'Enter a destination address.');
  const receipt = await wallet.withdrawAddress(to);
  $<HTMLInputElement>('address-send-to').value = '';
  toast(`Sent ${exact(receipt.amount)} METH to ${short(to)}. Activity shows the transaction and its fee.`);
});
act('buy-collateral', async () => {
  const amount = positiveAmount($<HTMLInputElement>('collateral-buy-amount').value.trim());
  if (!amount) throw new Error('Enter how much collateral to buy.');
  const bought = await wallet.buyCollateral(amount);
  $<HTMLInputElement>('collateral-buy-amount').value = '';
  toast(
    bought
      ? `Bought ${formatAmount(amount)} METH of collateral: the contract holds it for your balance.`
      : 'Send its price to your deposit address: the wallet buys the collateral as soon as it arrives.',
  );
});
// The open balance's bundle, and the bundle of any channel still closing beside it.
act('channel-export', async () => {
  for (const key of new Set([wallet.channelId, wallet.closingChannel?.opening.channelId]))
    if (key) downloadEvidence(await wallet.exportEvidence(key));
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
  'Locking in: your balance, less the fee for sending it, goes into deposits the contract holds, in one transaction the casino sends.',
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
    `It deletes the private key of ${accounts > 1 ? `all ${accounts} accounts` : 'the account'} saved here, with their evidence, receipts, activity and game allowances.${held ? ` This account holds ${formatAmount(held)} METH.` : ''}`,
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
