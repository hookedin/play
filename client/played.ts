import { json } from '../protocol/protocol.ts';
import { h, shortPercent, signedAmount } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
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
import { $, network, shortDate, showSheet } from './page.ts';
import { navigate } from './routes.ts';
import { historyBusy, task, wallet } from './sheet.ts';
import { active, knownGames, loadGame } from './games.ts';

const favouriteSetting = `hookedin:${network}:favourite-games`;
function favourites(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(favouriteSetting) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id: unknown) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
/** A favourite is this browser's own note about a game. It is never signed and never leaves here. */
function toggleFavourite(id: string) {
  const saved = favourites();
  if (!saved.delete(id)) saved.add(id);
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
      gameId: receipt.game?.id ?? null,
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
      if (opened.gameId) void openGameRecord(opened.gameId);
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
/** The game the bets page shows, by its ID, as `/bets?game=<id>` names it; every game when empty. */
let betGame = '';
/** The kind of event Activity shows, by its filter button's value: bets, deposits or withdrawals; every kind when empty. */
let activityKind = '';
export function setBetGame(id: string) {
  betGame = id;
}
const betsPath = () => (betGame ? `/bets?game=${betGame}` : '/bets');
export function renderBets() {
  const rows = ownBets();
  $<HTMLButtonElement>('refresh-bets').disabled = historyBusy || !wallet.address;
  // A game to choose for every game played, and the one asked for even before it has a bet.
  const games = new Map(rows.flatMap(row => (row.gameId ? [[row.gameId, row.game] as const] : [])));
  if (betGame && !games.has(betGame)) games.set(betGame, knownGames.get(betGame)?.name ?? 'This game');
  const select = $<HTMLSelectElement>('bet-game'),
    options = [['', 'All games'], ...[...games].sort((a, b) => a[1].localeCompare(b[1]))];
  if (json(options) !== json([...select.options].map(option => [option.value, option.text])))
    select.replaceChildren(...options.map(([id, name]) => new Option(name, id)));
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
    element.dataset.game = group[0]!.gameId ?? '';
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
      `You put in ${formatAmount(putIn(rows))} METH and ${net < 0n ? 'lost' : net > 0n ? 'won' : 'broke even'}${net ? ` ${formatAmount(net < 0n ? -net : net)} METH` : ''}. Each bet below stakes what the bet before it paid.`,
    ),
    h('div', { className: 'bet-table' }, ...rows.map(row => betRowElement(row, onOpen))),
  );
  $('bet-dialog').scrollTop = 0;
  showSheet($<HTMLDialogElement>('bet-dialog'));
}
/** Show the rows of a list, of bets or events, that hold every word typed in its search, and count them. */
export function filterList(name: 'activity' | 'bet' | 'gamebets') {
  const terms = $<HTMLInputElement>(`${name}-search`).value.trim().toLowerCase().split(/\s+/).filter(Boolean),
    events = name === 'activity',
    game = name === 'bet' ? betGame : '',
    kind = events ? activityKind : '';
  let visible = 0,
    total = 0;
  for (const row of $(`${name}-list`).children as HTMLCollectionOf<HTMLElement>) {
    const text = `${row.textContent} ${row.dataset.search ?? ''}`.toLowerCase(),
      matches =
        (!game || row.dataset.game === game) &&
        (!kind || row.dataset.filter === kind) &&
        terms.every(term => text.includes(term));
    // A round's row counts once, as the player played it.
    row.classList.toggle('hidden', !matches);
    total++;
    if (matches) visible++;
  }
  $(`${name}-visible-count`).textContent =
    `${terms.length || game || kind ? `${visible} / ` : ''}${total} ${events ? 'event' : 'bet'}${total === 1 ? '' : 's'}`;
  const empty = $(`${name}-empty`);
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? events
      ? 'No matching events. Try a method, amount, operation ID or transaction hash.'
      : 'No bet matches that. Try a game, an amount, a bet number or an operation ID.'
    : events
      ? kind
        ? `No ${kind} yet.`
        : 'No activity yet. Events will appear here as you use the wallet and games.'
      : game
        ? 'No bets in this game yet.'
        : name === 'bet'
          ? NO_BETS
          : 'Nobody has placed a bet in this game yet.';
}
/** A figure on a game's line: its label, its value, the value's class, and every digit of it on hover. */
export type Figure = [label: string, value: string, className?: string, exact?: string];
/** A game's figures, side by side, each value over its label. */
export const gameFigures = (figures: Figure[]) =>
  h(
    'dl',
    { className: 'game-figures' },
    ...figures.map(([label, value, className = '', exact]) =>
      h('div', null, h('dt', null, label), h('dd', { className, ...(exact ? { title: exact } : {}) }, value)),
    ),
  );
/** One line per game: what this wallet staked in it, what came back, and what its bets were worth. */
export function renderMyGames() {
  const all = ownBets(),
    starred = favourites(),
    played = new Map<string, { id: string | null; name: string; last: number; rows: BetRow[] }>();
  const signature = betSignature(all, [...starred].sort().join(',') + '|' + knownGames.size + '|');
  if (signature === shownPlayed) return;
  shownPlayed = signature;
  for (const row of all) {
    const key = row.gameId || `name:${row.game}`,
      entry = played.get(key) ?? { id: row.gameId ?? null, name: row.game, last: row.at, rows: [] };
    entry.rows.push(row);
    entry.last = Math.max(entry.last, row.at);
    played.set(key, entry);
  }
  const staked = (rows: BetRow[]) => rows.reduce((sum, row) => sum + row.stake, 0n);
  const list = [...played.values()].sort((a, b) => {
    const star = Number(starred.has(b.id || '')) - Number(starred.has(a.id || ''));
    if (star) return star;
    const difference = staked(b.rows) - staked(a.rows);
    return difference > 0n ? 1 : difference < 0n ? -1 : b.last - a.last;
  });
  $('played-count').textContent = String(list.length);
  $('games-totals').replaceChildren(...totalCards(betTotals(all)));
  $('played-games').replaceChildren(
    ...list.map(({ id, name, last, rows }) => {
      const favourite = id !== null && starred.has(id),
        totals = betTotals(rows),
        expected = measuredReturn(totals.priced, totals.expected),
        known = id ? knownGames.get(id) : undefined;
      const figures: Figure[] = [
        ['Bets', String(totals.bets)],
        ['Put in', `${formatAmount(totals.putIn)} METH`],
        ['Paid back', `${formatAmount(totals.putIn + totals.net)} METH`],
        ['Your result', signedAmount(totals.net), totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : ''],
        ['Return of your bets', expected === null ? '—' : shortPercent(expected)],
      ];
      return h(
        'div',
        { className: 'game-line' },
        h(
          'div',
          { className: 'game-line-heading' },
          h(
            'button',
            {
              type: 'button',
              className: 'played-star',
              disabled: !id,
              ariaPressed: String(favourite),
              title: !id
                ? 'This game has no ID on its bets, so it cannot be starred.'
                : favourite
                  ? `Take ${name} out of your favourites`
                  : `Keep ${name} at the top`,
              onclick: () => id && toggleFavourite(id),
            },
            favourite ? '★' : '☆',
          ),
          h('h3', null, name),
          h('span', { className: 'game-line-when' }, `Last played ${shortDate(last)}`),
        ),
        gameFigures(figures),
        h(
          'div',
          { className: 'game-actions' },
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
          ...(id
            ? [
                h(
                  'button',
                  { type: 'button', className: 'button small', onclick: () => void openGameRecord(id) },
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
export async function openGameRecord(id: string, push = true) {
  const known = knownGames.get(id),
    mine = ownBets().find(row => row.gameId === id),
    path = `/games/${id}`;
  const name = known?.name || mine?.game || 'This game';
  $('gamebets-name').textContent = name;
  $('gamebets-id').textContent = id;
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
    const record = await wallet.api(`/api/games/${id}?limit=200`);
    if (location.pathname !== path) return;
    const rows: BetRow[] = record.bets.map((bet: any) => {
      return {
        at: Number(bet.at),
        game: name,
        // The game's own casino bet, from its bank, has no player: it is listed beside its players' bets, and counted in
        // no total.
        who: bet.uname === null ? "the game's bank" : bet.discordUsername ? '@' + bet.discordUsername : '~' + bet.uname,
        ...(bet.group === undefined ? {} : { group: bet.group }),
        stake: BigInt(bet.stake),
        payout: BigInt(bet.payout),
        expected: bet.chance === undefined ? null : BigInt(bet.prize) * BigInt(bet.chance),
        maxPayout: bet.prize === undefined ? null : BigInt(bet.prize),
        id: bet.id,
      };
    });
    const totals = record.totals;
    $('gamebets-totals').replaceChildren(
      ...totalCards({
        bets: Number(totals.plays),
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

for (const name of ['activity', 'bet', 'gamebets'] as const)
  $(`${name}-search`).addEventListener('input', () => filterList(name));
for (const button of $('activity-filters').children as HTMLCollectionOf<HTMLButtonElement>)
  button.addEventListener('click', () => {
    activityKind = button.value;
    for (const other of $('activity-filters').children) other.setAttribute('aria-pressed', String(other === button));
    filterList('activity');
  });
$<HTMLSelectElement>('bet-game').addEventListener('change', () => {
  betGame = $<HTMLSelectElement>('bet-game').value;
  history.replaceState(null, '', betsPath());
  filterList('bet');
});
/** The open game's own bets, over it, so the game plays on; and everyone's, on its public record. */
$('game-my-bets').addEventListener('click', () => {
  $('game-menu').hidePopover();
  if (!active) return;
  const { id, name } = active.identity,
    rows = ownBets().filter(row => row.gameId === id);
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
  if (active) void openGameRecord(active.identity.id);
});
$<HTMLButtonElement>('bet-detail-close').addEventListener('click', () => $<HTMLDialogElement>('bet-dialog').close());
