import { ZeroAddress } from 'ethers';
import { withLock } from './storage.ts';
import { urlGameKey } from '../protocol/protocol.ts';
import { attachGameBridge, gameError } from './bridge.ts';
import { exact, h } from './activity.ts';
import { formatAmount, MICRO_ETH } from '../sdk/src/wire.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import { $, showName, toast } from './page.ts';
import { gamePath, showPage, walletRoute, type GameRoute } from './routes.ts';
import { openWallet, task, uiBusy, wallet } from './sheet.ts';

interface ActiveGame {
  /** The channel this game is bound to; null until the wallet has a channel. */
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
  /** Whether the game has said it places developer bets: its allowance dialog asks the player about them too. */
  developerBets: boolean;
}
/** What a profile records of a game it publishes: its key, and its developer, the account that publishes it. */
export type Published = { key: string; developer: string };
export let active: ActiveGame | null = null;
/** The casino's own profile, its account on X: the games it ships with are published there. */
export const HOUSE = 'hookedin';
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
export function closeGame() {
  if (!active) return;
  active.dispose();
  active.frame.remove();
  active = null;
  wallet.closeGame();
  allowanceLock?.();
  allowanceLock = null;
  if ($<HTMLDialogElement>('allowance-dialog').open) $<HTMLDialogElement>('allowance-dialog').close();
}
/** The game went away without navigation (a balance or account change): the lobby replaces its URL, or the wallet open
 * over it closes onto the lobby. */
export function abandonGame() {
  closeGame();
  if (!$('page-play').classList.contains('hidden')) {
    showPage('library');
    history.replaceState(null, '', walletRoute() ? location.pathname : '/');
  }
}
/** Open the game a route names: true once it is open. */
export const openGame = (target: GameRoute, push = false) =>
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
 * bar shows one amount. Until the allowance is set, setting it is all the bar offers, deposit or none: the only way a
 * game gets money to play with, where its refusals point. What the game's groups have won and it has not shown yet is
 * in none of these. */
export function renderGameAccount() {
  const playable = wallet.playable,
    game = active ? wallet.game : null,
    allowance = BigInt(game?.allowance ?? 0),
    balance = BigInt(wallet.publicState?.balance || 0) - wallet.inPlay(),
    unset = Boolean(game) && !allowance;
  $('game-title').classList.toggle('hidden', !game);
  $('game-allowance').classList.toggle('hidden', !game);
  $('game-allowance').classList.toggle('unset', unset);
  $('wallet-button').classList.toggle('hidden', unset);
  // Balances read in whole METH, cut off, with every digit on hover.
  $('game-allowance-amount').replaceChildren(
    ...(allowance
      ? [formatAmount(allowance, 0), h('small', { title: 'A millionth of an ETH' }, 'METH')]
      : ['Set allowance']),
  );
  $('game-allowance-amount').title = allowance ? `${exact(allowance)} METH` : '';
  $('wallet-button-amount').replaceChildren(
    formatAmount(balance, 0),
    h('small', { title: 'A millionth of an ETH' }, 'METH'),
  );
  $('wallet-button-amount').title = `${exact(balance)} METH`;
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
/** An allowance is whole METH: wei cut down to them. */
const wholeMicro = (wei: bigint) => wei - (wei % MICRO_ETH);
/** A whole number of METH the player typed, as wei: null for anything else. */
const typedWhole = (text: string) => (/^\d{1,30}$/.test(text.trim()) ? BigInt(text.trim()) * MICRO_ETH : null);
/** The wallet's own dialog: the sole grant of spending authority over ETH. It says what the game may play with now,
 * what it would, and out of how much, because those are the whole of what is being authorized; and, once the player
 * has allowed it something, how the visit stands. */
function renderAllowanceDialog() {
  if (!active || !wallet.game) return;
  const name = active.identity.name;
  // The dialog deals in whole METH: the allowance as it stands reads cut down to them, as the top bar shows it.
  const allowance = wholeMicro(BigInt(wallet.game.allowance)),
    visit = wallet.gameVisit();
  $('allowance-title').textContent = allowance > 0n ? `Change the allowance for ${name}` : `Play ${name} with ETH`;
  $('allowance-visit').hidden = !visit.allowed;
  $('allowance-taken-back').parentElement!.hidden = !visit.takenBack;
  for (const [id, amount] of [
    ['allowance-allowed', visit.allowed],
    ['allowance-taken-back', visit.takenBack],
    ['allowance-left', visit.left],
  ] as const) {
    $(id).textContent = formatAmount(amount, 0);
    $(id).title = `${exact(amount)} METH`;
  }
  // The visit's gain or loss in whole METH, with its sign, and every digit on hover.
  const result = visit.result < 0n ? -visit.result : visit.result;
  $('allowance-result').textContent = `${visit.result < 0n ? '−' : '+'}${formatAmount(result, 0)}`;
  $('allowance-result').title = `${visit.result < 0n ? 'Lost' : 'Won'} ${exact(result)} METH since you opened it`;
  $('allowance-result').className = visit.result < 0n ? 'negative' : 'positive';
  const total = allowable(),
    slider = $<HTMLInputElement>('allowance-slider'),
    amount = typedWhole($<HTMLInputElement>('allowance-amount').value || '0') ?? -1n,
    valid = amount >= 0n && amount <= total,
    shown = formatAmount(amount, 0),
    // A game that places developer bets can be allowed them at the allowance it has.
    granting = allowingDeveloperBets && !wallet.game.developerBets && amount > 0n,
    unchanged = amount === allowance && !granting;
  $('allowance-total').textContent = `${formatAmount(total, 0)} METH, your balance`;
  $<HTMLButtonElement>('allowance-take-all').classList.toggle('hidden', allowance === 0n);
  slider.value = String(valid && total > 0n ? (amount * SLIDER_STEPS) / total : 0n);
  $('allowance-help').textContent = !valid
    ? amount > total
      ? `That is more than your balance of ${formatAmount(total, 0)} METH.`
      : 'Enter a whole number of METH.'
    : total === 0n
      ? 'Your balance is empty. Deposit to play with ETH.'
      : unchanged
        ? allowance
          ? `This is ${name}'s allowance now.`
          : `Choose how much ${name} may play with.`
        : amount === allowance
          ? `${name} keeps its allowance of ${shown} METH, and may place developer bets too.`
          : amount > allowance
            ? `${name} may play with up to ${shown} METH.`
            : `${name} may play with up to ${shown} METH, and the rest stays in your balance.`;
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
            ? `Lower to ${shown} METH`
            : `Allow ${shown} METH`;
}
/** What the player may allow the open game: the playable balance less what its groups hold, which stays theirs. */
const allowable = () => {
  const total = wallet.playableBalance() - wallet.inPlay();
  return total < 0n ? 0n : total;
};
/** Whether confirming the dialog lets the game place developer bets: it said it places them, or already may. */
let allowingDeveloperBets = false;
/** Opened only by the player, from the top bar: a game never opens it, and a bet the allowance does not cover is
 * refused. With nothing in the balance to allow, the wallet opens on Deposit instead. */
function openAllowanceDialog() {
  if (!active || !wallet.game) return;
  if (allowable() === 0n && BigInt(wallet.game.allowance) === 0n) {
    openWallet('deposit', `${active.identity.name} plays with ETH from your balance. Deposit some to play.`);
    return;
  }
  const dialog = $<HTMLDialogElement>('allowance-dialog');
  // The game page shows nothing but the game, so the dialog that grants it money says who it is, and what it may do.
  const host = new URL(active.frame.src).host;
  $('allowance-who').textContent = active.publisher
    ? `Published by ${active.publisher}, served from ${host}.`
    : `Served from ${host}.`;
  // Only a published game has a developer to bet against.
  allowingDeveloperBets = Boolean(active.publisher) && (active.developerBets || wallet.game.developerBets);
  $('allowance-developer').hidden = !allowingDeveloperBets;
  $('allowance-developer-text').textContent =
    `${active.identity.name} also bets against its developer, ${active.publisher}: your stake goes into the game's bank at once, and they decide what each bet pays. Neither the casino nor your wallet can check that result, so allow this only for a developer you trust.`;
  // The dialog starts at the allowance as it stands: nothing, for a game just opened.
  const total = wholeMicro(allowable()),
    allowance = wholeMicro(BigInt(wallet.game.allowance));
  $<HTMLInputElement>('allowance-amount').value = String((allowance > total ? total : allowance) / MICRO_ETH);
  renderAllowanceDialog();
  if (!dialog.open) dialog.showModal();
  $<HTMLInputElement>('allowance-amount').select();
}

/** A game's address, checked before the wallet frames it: HTTP(S) without credentials, and never the wallet's own
 * origin, where a frame could lift its own sandbox and read the wallet's storage. */
export function gameURL(value: string) {
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
export const gameTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

/** A game's icon: icon.svg beside its page, over the game's initial, which shows when it has none. */
export function gameIcon(url: string, name: string) {
  const image = h('img', { src: new URL('icon.svg', url).href, alt: '', loading: 'lazy', decoding: 'async' });
  image.onerror = () => image.remove();
  const tile = h('span', { className: 'game-icon' }, image);
  tile.dataset.initial = name.charAt(0).toUpperCase();
  return tile;
}

export const startup = Promise.withResolvers<void>();
/** Games opened by an early click wait here, so their session opens against the started wallet. */
const walletStarted = startup.promise;
/** Open a game. A published one comes with what its profile records: its key, and its developer, the account that
 * publishes it. A game opened by its URL alone is nobody's: it has the key of that URL, and takes no developer bets. */
export async function loadGame(url: string, gameRoute: GameRoute, push = true, published?: Published) {
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
    key: published?.key ?? urlGameKey(entry.href),
    developer: published?.developer ?? ZeroAddress,
    ...(slug === undefined ? {} : { slug }),
    name: slug === undefined ? entry.host : gameTitle(slug),
  };
  frame.title = `${identity.name}, a sandboxed game`;
  // A game bound to a channel closes with it; a game opened without one adopts the first channel the wallet takes up.
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
    developerBets: false,
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
      // Its allowance dialog asks about developer bets from now on; only a published game has a developer to bet
      // against.
      if (method === 'game.placesDeveloperBets') {
        if (isCurrent()) active!.developerBets = true;
        return null;
      }
      // What the player is doing in the wallet comes first; the wallet's own checks finish and the game's request
      // follows.
      if (uiBusy) throw gameError('busy', 'The wallet is processing another operation.');
      await wallet.actionDone;
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

/** Games this wallet can reopen, by their key: whatever the lobby showed.
 * A bet's receipt carries only the game's key and the name it went by, so this is what turns a
 * line of history back into something to play. */
export const knownGames = new Map<string, Published & { route: GameRoute; url: string; name: string }>();
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
export const profileCards = (owner: string, games: (Published & { name: string; url: string })[]) =>
  games.map(game => gameCard({ owner, name: game.name }, game));
/** The lobby is what `@hookedin` publishes, and whatever this account publishes itself. It needs nothing of the
 * wallet but the casino's address, so it shows before the wallet has started. */
export async function loadLibrary() {
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

$<HTMLFormElement>('custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $<HTMLInputElement>('custom-url').value.trim();
  task(() => loadGame(url, { url }));
});
$<HTMLFormElement>('allowance-form').addEventListener('submit', event => {
  event.preventDefault();
  void task(async () => {
    if (!active) return;
    const amount = typedWhole($<HTMLInputElement>('allowance-amount').value || '0');
    if (amount === null) throw new Error('Enter a whole number of METH.');
    // An allowance is held against other tabs.
    await holdGameAllowance();
    await wallet.setGameAllowance(String(amount), allowingDeveloperBets);
    toast(
      amount
        ? `${active.identity.name} may play with up to ${formatAmount(amount, 0)} METH${allowingDeveloperBets ? ', developer bets included' : ''}.`
        : `${active.identity.name} may play with nothing.`,
    );
    $<HTMLDialogElement>('allowance-dialog').close();
  });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-allowance-cancel]'))
  button.addEventListener('click', () => $<HTMLDialogElement>('allowance-dialog').close());
$<HTMLButtonElement>('allowance-deposit').addEventListener('click', () => {
  $<HTMLDialogElement>('allowance-dialog').close();
  openWallet('deposit');
});
$('game-allowance').addEventListener('click', openAllowanceDialog);
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
