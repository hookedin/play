import { formatEther } from 'ethers';
import { returnParts } from '../protocol/risk.ts';

/**
 * One settled bet, however it was read: from this wallet's own receipt, or from a game's public
 * list at the casino. No game says what it pays back, because nothing bounds how often a game
 * wagers the money it holds; every figure here is worked out from bets that really happened.
 */
export interface BetRow {
  /** Milliseconds. A public row carries the casino's clock, an own receipt this wallet's. */
  at: number;
  /** The game the bet was placed in, named as it named itself. */
  game: string;
  /** The hash of the game's manifest URL, when the reader knows it. */
  key?: string | null;
  /** Who placed it, on a public list. This wallet's own rows leave it out. */
  who?: string | null;
  asset: 'eth' | 'test';
  stake: bigint;
  payout: bigint;
  /** The bet's expected payout, out of 2^64 stakes: what its own prize table was worth. */
  expected: bigint;
  /** The most the bet could pay, when the reader knows it. */
  maxPayout?: bigint | null;
  operation?: string;
  /** The seed came from the game's host, not this wallet. */
  hosted?: boolean;
}

export const unitOf = (asset: string) => (asset === 'test' ? 'TEST' : 'ETH');
/** A return in millionths, written as a percentage with four decimals. */
export const percent = (parts: bigint) => `${parts / 10000n}.${String(parts % 10000n).padStart(4, '0')}%`;
/** What a set of bets was expected to pay back, in millionths of everything staked. */
export const measuredReturn = (staked: bigint, expected: bigint) =>
  staked > 0n ? returnParts(staked, expected) : null;
/** What a set of bets did pay back. Over a handful of bets this is luck; over thousands it is the
 * table. Both are shown, because a player deserves to see which one they are reading. */
export const realisedReturn = (staked: bigint, paid: bigint) =>
  staked > 0n ? (paid * 1_000_000n + staked / 2n) / staked : null;

export interface BetTotals {
  bets: number;
  staked: bigint;
  paid: bigint;
  expected: bigint;
  net: bigint;
}
export const emptyTotals = (): BetTotals => ({ bets: 0, staked: 0n, paid: 0n, expected: 0n, net: 0n });
export function addBet(totals: BetTotals, row: { stake: bigint; payout: bigint; expected: bigint }) {
  totals.bets++;
  totals.staked += row.stake;
  totals.paid += row.payout;
  totals.expected += row.expected;
  totals.net += row.payout - row.stake;
  return totals;
}
/** Bets of one asset, added up. A wallet plays ETH and test coins in separate channels, so the two
 * are never mixed into one figure. */
export function totalsByAsset(rows: readonly BetRow[]) {
  const byAsset = new Map<string, BetTotals>();
  for (const row of rows) addBet(byAsset.get(row.asset) ?? byAsset.set(row.asset, emptyTotals()).get(row.asset)!, row);
  return byAsset;
}

const element = (tag: string, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const signed = (value: bigint, unit: string) =>
  `${value < 0n ? '−' : '+'}${formatEther(value < 0n ? -value : value)} ${unit}`;

/** One card per asset: how much went in, how much came back, and both returns side by side. */
export function totalCards(byAsset: Map<string, BetTotals>) {
  return [...byAsset]
    .sort(([a], [b]) => (a === 'eth' ? -1 : b === 'eth' ? 1 : 0))
    .map(([asset, totals]) => {
      const unit = unitOf(asset),
        card = element('div', 'wallet-balance-card'),
        expected = measuredReturn(totals.staked, totals.expected),
        realised = realisedReturn(totals.staked, totals.paid);
      card.append(
        element(
          'div',
          'eyebrow',
          `${totals.bets.toLocaleString('en-US')} ${unit} ${totals.bets === 1 ? 'BET' : 'BETS'}`,
        ),
      );
      const amount = element('div', 'large-amount');
      amount.append(element('span', '', expected === null ? '—' : percent(expected)), element('small', '', 'EXPECTED'));
      card.append(amount);
      card.append(
        element(
          'p',
          '',
          `What these bets' own prize tables were worth. They paid back ${realised === null ? '—' : percent(realised)}: ` +
            `${formatEther(totals.paid)} ${unit} for ${formatEther(totals.staked)} ${unit} staked.`,
        ),
      );
      card.append(element('p', totals.net < 0n ? 'bet-net negative' : 'bet-net positive', signed(totals.net, unit)));
      return card;
    });
}

/** One row per bet. `who` is shown on a public list and left out of a player's own. */
export function betRowElement(row: BetRow, onGame?: (row: BetRow) => void) {
  const unit = unitOf(row.asset),
    net = row.payout - row.stake,
    item = element('div', `bet-row tone-${net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral'}`);
  const name = element('div', 'bet-game');
  if (onGame && row.key) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'bet-game-link';
    link.textContent = row.game;
    link.title = `Every bet anyone has placed in ${row.game}`;
    link.addEventListener('click', () => onGame(row));
    name.append(link);
  } else name.append(element('span', 'bet-game-name', row.game));
  if (row.who) name.append(element('span', 'bet-who', row.who));
  if (row.hosted) name.append(element('span', 'bet-tag', 'shared round'));
  const date = new Date(row.at),
    time = document.createElement('time');
  time.className = 'bet-time';
  if (!Number.isNaN(date.getTime())) {
    time.dateTime = date.toISOString();
    time.title = time.dateTime;
    time.textContent = `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${date.toLocaleTimeString(
      [],
      { hour12: false, hour: '2-digit', minute: '2-digit' },
    )}`;
  } else time.textContent = '—';
  name.append(time);
  item.append(name);
  const figure = (label: string, value: string, className = '') => {
    const cell = element('div', `bet-figure ${className}`.trim());
    cell.append(element('span', 'bet-figure-value', value), element('span', 'bet-figure-label', label));
    return cell;
  };
  item.append(
    figure('Staked', `${formatEther(row.stake)} ${unit}`),
    figure(
      row.maxPayout === undefined || row.maxPayout === null
        ? 'Paid'
        : `Paid of up to ${formatEther(row.maxPayout)} ${unit}`,
      `${formatEther(row.payout)} ${unit}`,
    ),
    figure('Result', signed(net, unit), net < 0n ? 'negative' : net > 0n ? 'positive' : ''),
    figure('Return of this bet', percent(returnParts(row.stake, row.expected)), 'bet-return'),
  );
  // The operation ID identifies the bet everywhere else, and is long: it is searched, not shown.
  if (row.operation) {
    item.dataset.search = row.operation.toLowerCase();
    item.title = `Operation ${row.operation}`;
  }
  return item;
}

/** Search across the rendered rows, as the activity list does: the text is what the player reads,
 * plus the operation ID each row carries. */
export function filterBets(list: HTMLElement, query: string, empty: HTMLElement, count: HTMLElement, none: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const row of list.children) {
    const text = (row.textContent! + ' ' + ((row as HTMLElement).dataset.search ?? '')).toLowerCase();
    const matches = terms.every(term => text.includes(term));
    row.classList.toggle('hidden', !matches);
    if (matches) visible++;
  }
  count.textContent = terms.length ? `${visible} / ${list.childElementCount}` : String(visible);
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length ? 'No bet matches that. Try a game, an amount or an operation ID.' : none;
}
