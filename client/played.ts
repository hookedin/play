import type { Receipt } from './wallet.ts';
import * as read from '../protocol/read.ts';
import { json, validGameName } from '../protocol/protocol.ts';
import { OUTCOME_SPACE, returnParts } from '../protocol/risk.ts';
import { copyBlock, h, percent, shortPercent, signedAmount } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import {
  betDetail,
  betRowElement,
  betTotals,
  edgeShare,
  groupRowElement,
  groupRows,
  putIn,
  roundDetail,
  tableOffered,
  totalCards,
} from './bets.ts';
import type { BetRow } from './bets.ts';
import { $, network, shortDate, showSheet } from './page.ts';
import { navigate, parseRoute } from './routes.ts';
import type { GameRoute } from './routes.ts';
import { historyBusy, task, wallet } from './sheet.ts';
import { active, knownGames, loadGame, openGame } from './games.ts';

/** A bet as a game's public record lists it: the ID of the record that placed it, a casino bet's, a developer bet's or
 * a round's payment to the house, the developer bet's hash, who placed it (nobody for the game's own, from its bank),
 * its group, stake, a casino bet's chance and prize, what a step of a round held, a payment's with what its round kept,
 * what it paid and when it settled. */
const recordBet = read.object<{
  id: string;
  kind: 'casino' | 'developer' | 'payment';
  bet?: string;
  uname: string | null;
  discordUsername: string | null;
  group?: string;
  stake: bigint;
  chance?: bigint;
  prize?: bigint;
  held?: bigint;
  payout: bigint;
  at: number;
}>({
  id: read.recordId,
  kind: read.oneOf('casino', 'developer', 'payment'),
  bet: read.optional(read.hash),
  uname: read.nullable(read.uname),
  discordUsername: read.nullable(read.discordUsername),
  group: read.optional(read.group),
  stake: read.whole,
  chance: read.optional(read.whole),
  prize: read.optional(read.whole),
  held: read.optional(read.whole),
  payout: read.whole,
  at: read.time,
});
/** A game's public record, as `GET /api/games/:id` gives it: what its bank holds, how its developer bets stand, the
 * totals over its players' bets, and its latest settled bets. */
export const gameRecord = read.object<{
  id: string;
  name: string | null;
  page: string | null;
  bank: bigint;
  developerBets: { open: number; settled: number };
  totals: {
    plays: number;
    putIn: bigint;
    net: bigint;
    edge: bigint;
    priced: bigint;
    earned: bigint;
  };
  bets: ReturnType<typeof recordBet>[];
}>({
  id: read.gameId,
  name: read.nullable(read.exactly(validGameName, 'A game name')),
  page: read.nullable(
    read.exactly(
      (value: unknown): value is string =>
        typeof value === 'string' && /^[@~][A-Za-z0-9_.]{1,32}\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
      "A game's page",
    ),
  ),
  bank: read.whole,
  developerBets: read.object({ open: read.count, settled: read.count }),
  totals: read.object({
    plays: read.count,
    putIn: read.whole,
    net: read.integer,
    edge: read.whole,
    priced: read.whole,
    earned: read.whole,
  }),
  bets: read.list(recordBet, 500),
});
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
/** The account's operations in the casino's record, whichever device played them: its latest page, read when Bets or
 * My games opens, at most once a minute, and checked as the wallet checks a reply. */
let recorded: Receipt[] = [],
  recordedFor = '',
  recordedAt = 0,
  recording = false;
function loadRecorded() {
  const account = wallet.address;
  if (!account || recording || (recordedFor === account && Date.now() - recordedAt < 60_000)) return;
  recording = true;
  void (async () => {
    try {
      // The games this wallet has seen, with their developers, whose developer bets it can check.
      const games = new Map<string, { name: string; developer: string }>();
      for (const receipt of wallet.history)
        if (receipt.game?.id)
          games.set(receipt.game.id, { name: receipt.game.name, developer: receipt.game.developer });
      for (const [id, game] of knownGames) games.set(id, game);
      const receipts = (await wallet.recordedBets(games)) as Receipt[],
        // A game this wallet has not seen is named by its public record.
        unnamed = [...new Set(receipts.flatMap(receipt => (receipt.game!.name ? [] : [receipt.game!.id])))],
        names = new Map(
          await Promise.all(
            unnamed.map(
              async id =>
                [
                  id,
                  await wallet
                    .api(`/api/games/${id}?limit=1`)
                    .then(record => gameRecord(record).name)
                    .catch(() => null),
                ] as const,
            ),
          ),
        );
      recorded = receipts.map(receipt =>
        receipt.game!.name
          ? receipt
          : { ...receipt, game: { ...receipt.game!, name: names.get(receipt.game!.id) ?? '' } },
      );
    } catch {
      recorded = [];
    } finally {
      recordedFor = account;
      recordedAt = Date.now();
      recording = false;
      renderBets();
      renderMyGames();
    }
  })();
}
// Refresh reads the casino's record again too.
$('refresh-bets').addEventListener('click', () => (recordedAt = 0));
/** This browser's receipts and the casino's record of the account, an operation once, newest first. */
function receipts() {
  const seen = new Set(wallet.history.map(receipt => receipt.details?.id));
  return [
    ...wallet.history,
    ...(recordedFor === wallet.address ? recorded : []).filter(receipt => !seen.has(receipt.details?.id)),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
/** Every settled bet this account signed, here or on another device, and every payment a game's round made beside its
 * bets. A rejected request never became a bet, so it stays in Activity; only a bet whose odds the wallet recorded can
 * say what it was worth, and a payment pays nothing back. */
function ownBets(): BetRow[] {
  return receipts()
    .filter(
      receipt =>
        receipt.status === 'signed' &&
        ((receipt.kind === 'casino-bet' && receipt.expectedPayout !== undefined) ||
          // A developer bet is one once what it was paid is collected.
          (receipt.kind === 'developer-bet' && receipt.payout !== undefined) ||
          // A round pays the house what cashing out leaves of what its bet paid, so the round comes to what it showed.
          (receipt.kind === 'payment' && receipt.details?.group)),
    )
    .map(receiptRow);
}
/** A step of a round, a casino bet drawn from a game's step, a draw that placed none or a payment of a round: what the
 * step held, and what it was expected to leave, out of 2^64. */
function stepOffered(receipt: Receipt) {
  const { table, kept } = receipt.details ?? {};
  if (table) return { held: table.cash, offered: tableOffered(table) };
  if (receipt.kind === 'payment' && kept !== undefined && receipt.stake !== undefined)
    return { held: receipt.stake + kept, offered: kept * OUTCOME_SPACE };
  return undefined;
}
/** One of this wallet's receipts as a row of bets. A game's step puts in all the cash it holds and bets part of it: the
 * rest, kept, comes back whatever the round does, so the row counts it in what went in, what came back and what it was
 * expected to pay back, as the game showed them. A step that drew no bet kept it all. */
function receiptRow(receipt: Receipt): BetRow {
  const held: bigint | undefined = receipt.details?.table?.cash,
    kept = held === undefined ? 0n : held - (receipt.stake ?? 0n),
    route = receipt.game ? knownGames.get(receipt.game.id)?.route : undefined;
  return {
    ...(route && 'owner' in route ? { publisher: route.owner } : {}),
    at: Date.parse(receipt.createdAt),
    game: receipt.game?.name || 'Unnamed game',
    gameId: receipt.game?.id ?? null,
    ...(receipt.details?.group ? { group: receipt.details.group } : {}),
    stake: (receipt.stake ?? 0n) + kept,
    payout: (receipt.payout ?? 0n) + kept,
    ...(receipt.kind === 'payment'
      ? { payment: true, ...(receipt.details?.kept === undefined ? {} : { kept: receipt.details.kept }) }
      : {}),
    expected:
      receipt.kind === 'payment'
        ? 0n
        : receipt.expectedPayout === undefined && held === undefined
          ? null
          : (receipt.expectedPayout ?? 0n) + kept * OUTCOME_SPACE,
    maxPayout: receipt.maxPayout === undefined ? null : receipt.maxPayout + kept,
    operation: receipt.operationId,
    receipt,
  };
}
/** One of the open game's operations in full, when the game asks the wallet to show it: from a result on its page to
 * the proof behind it. */
export const showReceipt = (receipt: Receipt) => showBet(receiptRow(receipt));
/** One bet in full: the odds it rode, where its round landed, and the preimages that fixed
 * it. Everything shown comes out of the receipt this wallet kept. */
function showBet(row: BetRow) {
  // A step of a round says so first, with what the round came to, since its own figures are the round's cash so far. A
  // step that drew no bet is in no list of bets, but in its round all the same.
  const kept = row.receipt?.status === 'kept',
    round = row.group
      ? groupRows(ownBets()).find(rows =>
          kept
            ? rows[0]!.group === row.group && rows[0]!.gameId === row.gameId
            : rows.some(other => other.operation === row.operation),
        )
      : undefined,
    place = round && round.length > 1 ? round.findIndex(other => other.operation === row.operation) : -1;
  $('bet-detail-eyebrow').textContent = kept
    ? 'A step without a bet'
    : place < 0
      ? 'One bet'
      : `Bet ${place + 1} of a round of ${round!.length}`;
  $('bet-detail-title').textContent = row.game;
  $('bet-detail').replaceChildren(
    ...(place < 0 && !(kept && round)
      ? []
      : [
          h(
            'p',
            { className: 'bet-round-summary' },
            `${roundSummary(round!)} ${kept ? '' : 'This bet staked what the round was worth after the bets before it. '}`,
            h(
              'button',
              { type: 'button', className: 'text-button', onclick: () => showGroup(round!, showBet) },
              'See the whole round',
            ),
          ),
        ]),
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
/** A browser keeps the receipts of the bets it signed, so another device's are not here: the profile counts them all. */
const NO_BETS =
  'No bets yet. The bets you sign show here, on this device or another, and your profile counts them all.';
/** The game the bets page shows, by its ID, as `/bets?game=<id>` names it; every game when empty. */
let betGame = '';
/** The kind of event Activity shows, by its filter button's value: bets, deposits or withdrawals; every kind when empty. */
let activityKind = '';
export function setBetGame(id: string) {
  betGame = id;
}
const betsPath = () => (betGame ? `/bets?game=${betGame}` : '/bets');
export function renderBets() {
  loadRecorded();
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
/** What a round took from the player and came to, as they played it. */
function roundSummary(rows: readonly BetRow[]) {
  const net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n);
  return `You put in ${formatAmount(putIn(rows))} METH and ${net < 0n ? 'lost' : net > 0n ? 'won' : 'broke even'}${net ? ` ${formatAmount(net < 0n ? -net : net)} METH` : ''}.`;
}
/** A round of this wallet's own bets with its steps that drew no bet in this browser, oldest first: a public round's
 * bets as they are. */
function withKept(rows: readonly BetRow[]) {
  const { gameId, group } = rows[0]!;
  if (rows.some(row => !row.receipt)) return rows;
  const kept = receipts()
    .filter(receipt => receipt.status === 'kept' && receipt.game?.id === gameId && receipt.details?.group === group)
    .map(receiptRow);
  return [...rows, ...kept].sort((a, b) => a.at - b.at);
}
/** A round as the player played it, its steps folded away, each opening in full where this wallet kept its receipt. */
function showGroup(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  $('bet-detail-eyebrow').textContent = 'One round';
  $('bet-detail-title').textContent = rows.at(-1)!.game;
  $('bet-detail').replaceChildren(...roundDetail(withKept(rows), onOpen));
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
        : 'No activity in this browser yet. Each browser keeps what it signed, sent and found: what you did on another device is there.'
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
/** The house edges of a game's steps, here or on another device, in a line: each step's edge as a share of what it
 * held, to the hundredth of a percent, and how many had it. A step is a casino bet drawn from the game's table, a draw
 * from a table that could have placed one, or a payment of a round, whose edge is what it pays of what the round held;
 * a draw from a table whose results all keep what it holds has nothing to weigh. A game whose steps come from its
 * rules has one edge or a few; one that draws its results in its own page before it asks the wallet has many. */
function stepEdges(gameId: string) {
  const edges = new Map<bigint, number>();
  let steps = 0;
  for (const receipt of receipts()) {
    const step = receipt.game?.id === gameId && ['signed', 'kept'].includes(receipt.status) && stepOffered(receipt);
    if (
      !step ||
      (receipt.details?.table &&
        new Set(receipt.details.table.results.map((result: { cash: bigint }) => result.cash)).size === 1)
    )
      continue;
    const parts = ((1_000_000n - returnParts(step.held, step.offered) + 50n) / 100n) * 100n;
    edges.set(parts, (edges.get(parts) ?? 0) + 1);
    steps++;
  }
  if (!steps) return null;
  const each = [...edges].sort(([a], [b]) => (a < b ? 1 : -1)),
    [highest] = each[0]!,
    [lowest] = each.at(-1)!;
  return h(
    'p',
    {
      className: 'game-line-note',
      title: each.map(([parts, count]) => `${shortPercent(parts)} × ${count}`).join(' · '),
    },
    each.length > 1
      ? `Its ${steps} steps had house edges from ${shortPercent(lowest)} to ${shortPercent(highest)} of what each held.`
      : steps === 1
        ? `Its one step had a house edge of ${shortPercent(highest)} of what it held.`
        : `Each of its ${steps} steps had a house edge of ${shortPercent(highest)} of what it held.`,
  );
}
/** One line per game: what this wallet put in it, what came back, the house edge on it, and its steps' edges. */
export function renderMyGames() {
  loadRecorded();
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
        edge = edgeShare(totals),
        known = id ? knownGames.get(id) : undefined;
      const figures: Figure[] = [
        ['Bets', String(totals.bets)],
        ['Put in', `${formatAmount(totals.putIn)} METH`],
        ['Paid back', `${formatAmount(totals.putIn + totals.net)} METH`],
        ['Your result', signedAmount(totals.net), totals.net < 0n ? 'negative' : totals.net > 0n ? 'positive' : ''],
        ['House edge', edge === null ? '—' : shortPercent(edge), '', edge === null ? undefined : percent(edge)],
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
        ...(id ? [stepEdges(id)].filter(note => note !== null) : []),
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
  let name = known?.name || mine?.game || 'This game';
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
    const record = gameRecord(await wallet.api(`/api/games/${id}?limit=200`));
    if (location.pathname !== path) return;
    // The casino names a game this wallet has not seen, and while it is published, where to play it.
    if (record.name) {
      name = record.name;
      $('gamebets-name').textContent = name;
      document.title = `${name} · HookedIn`;
    }
    if (!known && record.page) {
      play.classList.remove('hidden');
      play.onclick = () => void openGame(parseRoute(new URL(`/${record.page}`, location.origin)) as GameRoute);
    }
    const rows: BetRow[] = record.bets.map(bet => {
      // A step's bet keeps back the rest of what the step held, as this wallet's own rows count it; a payment's round
      // kept the rest of what it held.
      const kept = bet.held === undefined ? 0n : bet.held - bet.stake,
        payment = bet.kind === 'payment';
      return {
        at: bet.at,
        game: name,
        // The game's own casino bet, from its bank, has no player: it is listed beside its players' bets, and counted
        // in no total.
        who: bet.uname === null ? "the game's bank" : bet.discordUsername ? '@' + bet.discordUsername : '~' + bet.uname,
        ...(bet.group === undefined ? {} : { group: bet.group }),
        stake: payment ? bet.stake : bet.stake + kept,
        payout: payment ? bet.payout : bet.payout + kept,
        expected: payment
          ? 0n
          : bet.chance === undefined || bet.prize === undefined
            ? null
            : bet.prize * bet.chance + kept * OUTCOME_SPACE,
        ...(payment ? { payment, ...(bet.held === undefined ? {} : { kept }) } : {}),
        maxPayout: bet.prize === undefined ? null : bet.prize + kept,
        id: bet.id,
      };
    });
    const { totals, developerBets } = record;
    $('gamebets-totals').replaceChildren(
      ...totalCards({
        bets: totals.plays,
        putIn: totals.putIn,
        net: totals.net,
        edge: totals.edge,
        priced: totals.priced,
        unpriced: developerBets.settled > 0,
      }),
    );
    // How the game's developer bets stand: a developer that leaves bets unsettled shows here.
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
/** The open game's bets the casino keeps for the account, whichever device played them, as rows: none when it cannot
 * be asked. */
async function recordedRows() {
  if (!active) return [];
  const { identity } = active;
  try {
    return (await wallet.recordedBets(new Map([[identity.id, identity]]), identity.id)).map(receipt =>
      receiptRow(receipt as Receipt),
    );
  } catch {
    return [];
  }
}
/** The open game's latest bet the player has seen, in full: the proof of it, whatever the game shows, from this
 * browser's receipts or the casino's record of the account, whichever is newer. */
$('game-verify').addEventListener('click', async () => {
  $('game-menu').hidePopover();
  if (!active) return;
  // The latest bet of a round still in play is a result the game has not shown, so the round comes first.
  const { id, name } = active.identity,
    playing = Object.keys(wallet.game?.table ?? {}).length > 0,
    local = playing ? null : wallet.lastShownBet(id),
    recorded = playing ? null : (await recordedRows()).find(row => row.receipt?.kind !== 'payment'),
    last =
      recorded && (!local || recorded.at > Date.parse(local.createdAt)) ? recorded : local ? receiptRow(local) : null;
  if (last) return showBet(last);
  $('bet-detail-eyebrow').textContent = 'Your last bet';
  $('bet-detail').replaceChildren(
    h(
      'p',
      { className: 'empty' },
      playing
        ? `A round of ${name} is in play: its bets can be verified here once it ends.`
        : `No bet in ${name} to verify in this browser yet.`,
    ),
  );
  $('bet-detail-title').textContent = name;
  $('bet-dialog').scrollTop = 0;
  showSheet($<HTMLDialogElement>('bet-dialog'));
});
/** The round the next casino bet settles on, which the casino fixed before it, as the menu opens: the player can copy
 * it before betting, and find it again in the bet's proof, with the secret that hashes to it. */
$('game-menu').addEventListener('toggle', async event => {
  if ((event as ToggleEvent).newState !== 'open') return;
  // A game that bets against its developer rides on its own rounds: the casino's next round is for a casino bet, which
  // such a game may never place.
  const casinoBets =
      !active?.developerBets ||
      wallet.history.some(receipt => receipt.game?.id === active!.identity.id && receipt.kind === 'casino-bet'),
    round = casinoBets ? await wallet.nextRound() : null;
  $('game-next-round').hidden = !round;
  $('game-next-round').dataset.round = round ?? '';
  $('game-next-round-hash').textContent = round ? `${round.slice(0, 6)}…${round.slice(-4)}` : '';
});
$('game-next-round').addEventListener('click', () => {
  $('game-menu').hidePopover();
  const round = $('game-next-round').dataset.round!;
  $('bet-detail-eyebrow').textContent = 'Before your next bet';
  $('bet-detail-title').textContent = 'Next round';
  $('bet-detail').replaceChildren(
    h(
      'p',
      { className: 'bet-detail-note' },
      'The casino has fixed the round of your next casino bet, in this game or any other: this is the hash of its ' +
        'secret, which it cannot change. Copy it or write it down. Once you have bet, Verify your last bet shows the ' +
        'same round, and the secret that hashes to it. Every bet moves your balance to a new round.',
    ),
    ...copyBlock(round, 'the next round', 'round'),
  );
  $('bet-dialog').scrollTop = 0;
  showSheet($<HTMLDialogElement>('bet-dialog'));
});
/** The open game's own bets, over it, so the game plays on: this browser's, and those the casino keeps for the account
 * from its other devices; and everyone's, on its public record. */
$('game-my-bets').addEventListener('click', async () => {
  $('game-menu').hidePopover();
  if (!active) return;
  const { id, name } = active.identity,
    own = ownBets().filter(row => row.gameId === id),
    mine = new Set(own.map(row => row.receipt?.details?.id)),
    rows = [...own, ...(await recordedRows()).filter(row => !mine.has(row.receipt?.details?.id))].sort(
      (a, b) => b.at - a.at,
    );
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
