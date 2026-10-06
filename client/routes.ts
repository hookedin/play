import { GAME_ID } from '../protocol/protocol.ts';
import { $, toast } from './page.ts';
import { wallet, showWallet } from './sheet.ts';
import { active, closeGame, openGame, renderGameAccount } from './games.ts';
import { openProfile } from './profiles.ts';
import { refreshDeveloper } from './developer.ts';
import { openGameRecord, renderBets, renderMyGames, setBetGame } from './played.ts';
import { refreshFund } from './bankroll.ts';

/** A published game is `@username/<slug>` or `~uname/<slug>`: its owner, written as they are written, and
 * the slug of the name it has in their profile. Any other game is linkable by its URL alone. */
export type GameRoute = { owner: string; slug: string } | { url: string };
/** The pages with a path of their own, and what they are called. */
const PAGES: Record<string, { path: string; title: string }> = {
  library: { path: '/', title: 'Games' },
  games: { path: '/games', title: 'My games' },
  developer: { path: '/developer', title: 'Developer' },
  bets: { path: '/bets', title: 'Bets' },
  bankroll: { path: '/bankroll', title: 'Bankroll' },
};
/** The sheet's tabs, each with a path of its own: the wallet's money under `/wallet`, and Settings, a tab for each thing
 * they are for, under `/settings`. */
const SHEET_TABS = {
  deposit: '/wallet',
  withdraw: '/wallet/withdraw',
  transfer: '/wallet/transfer',
  activity: '/wallet/activity',
  keys: '/settings',
  deposits: '/settings/deposits',
  protection: '/settings/protection',
  recovery: '/settings/recovery',
};
export type WalletTab = keyof typeof SHEET_TABS;
export const walletPath = (tab: WalletTab) => SHEET_TABS[tab];
export const inSettings = (tab: WalletTab) => SHEET_TABS[tab].startsWith('/settings');
/** The wallet tab the URL names, if it names one. */
export function walletRoute() {
  const target = parseRoute(new URL(location.href));
  return typeof target === 'object' && 'wallet' in target ? target.wallet : null;
}
export const gamePath = (route: GameRoute) =>
  'url' in route ? `/games/custom?url=${encodeURIComponent(route.url)}` : `/${route.owner}/${route.slug}`;
/** Show a section; the URL is the caller's responsibility. */
export function showPage(page: string) {
  for (const section of document.querySelectorAll<HTMLElement>('.page'))
    section.classList.toggle('hidden', section.id !== `page-${page}`);
  for (const link of document.querySelectorAll<HTMLElement>('.nav-link'))
    link.classList.toggle('active', link.dataset.page === page || (page === 'play' && link.dataset.page === 'library'));
  document.title =
    page === 'library'
      ? 'HookedIn'
      : `${page === 'play' && active ? active.identity.name : page === 'profile' ? $('profile-name').textContent : (PAGES[page]?.title ?? page)} · HookedIn`;
  if (page === 'bets') renderBets();
  if (page === 'games') renderMyGames();
  if (page === 'developer') refreshDeveloper();
  if (page === 'bankroll') void refreshFund();
  renderGameAccount();
}
export function navigate(page: string, push = true, path = PAGES[page]!.path) {
  // The bets page shows the game its path names, or every game.
  if (page === 'bets') setBetGame(new URL(path, location.origin).searchParams.get('game')?.toLowerCase() ?? '');
  if (wallet.busy && active && wallet.pending?.game?.id === active.identity.id) {
    if (!push) history.pushState(null, '', active.path);
    return toast('Wait for the current operation to finish before leaving the game.', true);
  }
  $<HTMLDialogElement>('wallet-dialog').close();
  showPage(page);
  closeGame();
  if (push && location.pathname !== path) history.pushState(null, '', path);
}
/** Every page has a URL: `/`, `/games`, `/developer`, `/bets`, `/bankroll`, `/@<username>` or `/~<uname>` for a
 * player, the same and `/<slug>` for a game they publish, `/games/<id>` for a game's public record,
 * `/games/custom?url=<url>`, and `/bets?game=<id>` for the bets of one game; and the wallet or Settings over a page,
 * `/wallet[/<tab>]` and `/settings[/<tab>]`. */
export function parseRoute(
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
  const named = /^\/([~@][A-Za-z0-9_.]{1,32})(?:\/([a-z0-9][a-z0-9-]*))?$/.exec(pathname);
  if (named) return named[2] ? { owner: named[1]!, slug: named[2] } : { profile: named[1]! };
  if (pathname === '/games/custom') return { url: url.searchParams.get('url') || '' };
  const record = /^\/games\/(.+)$/.exec(pathname)?.[1]!.toLowerCase();
  if (record && GAME_ID.test(record)) return { record };
  return Object.entries(PAGES).find(([, page]) => page.path === pathname)?.[0] ?? { unknown: pathname };
}
export async function route(push = false) {
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

for (const link of document.querySelectorAll<HTMLElement>('[data-page]'))
  link.addEventListener('click', event => {
    event.preventDefault();
    $('account-menu').hidePopover?.();
    navigate(link.dataset.page!);
  });
window.addEventListener('popstate', () => void route(false));
