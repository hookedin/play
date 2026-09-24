import { formatEther } from 'ethers';
import { OUTCOME_SPACE, returnParts } from '../protocol/risk.ts';
import { outcome, roundId, same, seedHash } from '../protocol/protocol.ts';
import { activityJSON } from './activity.ts';

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
  /** The label the game gave it, such as a hand or a match. */
  group?: string;
  stake: bigint;
  payout: bigint;
  /** The bet's expected payout, out of 2^64 stakes: what its own prize table was worth. A bet with terms
   * has no prize table, so nothing says what it was worth. */
  expected: bigint | null;
  /** The most the bet could pay, when the reader knows it. */
  maxPayout?: bigint | null;
  /** This wallet's own name for the bet. A public row has none: it is known by `index` instead. */
  operation?: string;
  /** A public row's number in the casino's record of every bet. */
  index?: number;
  /** This wallet's own receipt, whole: the prizes, the preimages and the signatures it kept. A
   * public row has none, because the casino's list is only what anyone may read. */
  receipt?: any;
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
  /** What the bets with a prize table were expected to pay, and what they staked. */
  expected: bigint;
  priced: bigint;
  net: bigint;
}
export const emptyTotals = (): BetTotals => ({ bets: 0, staked: 0n, paid: 0n, expected: 0n, priced: 0n, net: 0n });
export function addBet(totals: BetTotals, row: { stake: bigint; payout: bigint; expected: bigint | null }) {
  totals.bets++;
  totals.staked += row.stake;
  totals.paid += row.payout;
  if (row.expected !== null) {
    totals.expected += row.expected;
    totals.priced += row.stake;
  }
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
/** One figure under its label, as a bet's row and a bet in full both show it. */
const figure = (label: string, value: string, className = '') => {
  const cell = element('div', `bet-figure ${className}`.trim());
  cell.append(element('span', 'bet-figure-value', value), element('span', 'bet-figure-label', label));
  return cell;
};

/** One card per asset: how much went in, how much came back, and both returns side by side. */
export function totalCards(byAsset: Map<string, BetTotals>) {
  return [...byAsset]
    .sort(([a], [b]) => (a === 'eth' ? -1 : b === 'eth' ? 1 : 0))
    .map(([asset, totals]) => {
      const unit = unitOf(asset),
        card = element('div', 'wallet-balance-card'),
        expected = measuredReturn(totals.priced, totals.expected),
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
          `What these bets' own prize tables were worth${totals.priced < totals.staked ? ", where a bet had one: a referee's word is priced by no table" : ''}. ` +
            `They paid back ${realised === null ? '—' : percent(realised)}: ` +
            `${formatEther(totals.paid)} ${unit} for ${formatEther(totals.staked)} ${unit} staked.`,
        ),
      );
      card.append(element('p', totals.net < 0n ? 'bet-net negative' : 'bet-net positive', signed(totals.net, unit)));
      return card;
    });
}

/** One row per bet. `who` is shown on a public list and left out of a player's own. A row that can
 * be opened is a button: only this wallet's own receipt holds the prizes and preimages to show. */
export function betRowElement(row: BetRow, onOpen?: (row: BetRow) => void) {
  const unit = unitOf(row.asset),
    net = row.payout - row.stake,
    tone = `bet-row tone-${net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral'}`,
    item = element(onOpen ? 'button' : 'div', tone);
  if (onOpen) {
    (item as HTMLButtonElement).type = 'button';
    item.addEventListener('click', () => onOpen(row));
  }
  const name = element('div', 'bet-game');
  name.append(element('span', 'bet-game-name', row.game));
  if (row.who) name.append(element('span', 'bet-who', row.who));
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
  item.append(
    figure('Staked', `${formatEther(row.stake)} ${unit}`),
    figure(
      row.maxPayout === undefined || row.maxPayout === null
        ? 'Paid'
        : `Paid of up to ${formatEther(row.maxPayout)} ${unit}`,
      `${formatEther(row.payout)} ${unit}`,
    ),
    figure('Result', signed(net, unit), net < 0n ? 'negative' : net > 0n ? 'positive' : ''),
    figure(
      'Return of this bet',
      row.expected === null ? '—' : percent(returnParts(row.stake, row.expected)),
      'bet-return',
    ),
  );
  // This wallet's own operation ID is long: it is searched, not shown. A public row is its number in the game's record.
  const named = row.operation ? `operation ${row.operation}` : row.index === undefined ? null : `bet #${row.index}`;
  if (named) {
    item.dataset.search = `${named} ${row.group ?? ''}`.toLowerCase();
    item.title = onOpen ? `Open this bet in full · ${named}` : named[0].toUpperCase() + named.slice(1);
  }
  return item;
}

/** Bets that carry the same group, in the same game and by the same player, belong together: the steps
 * of one hand, the bets on one match. Each group stands where its latest bet would, as one list of its
 * bets, oldest first; a bet alone stands as itself. */
export function groupRows(rows: readonly BetRow[]): BetRow[][] {
  const groups = new Map<string, BetRow[]>(),
    order: BetRow[][] = [];
  for (const row of rows) {
    const key = row.group === undefined ? null : JSON.stringify([row.key ?? row.game, row.who ?? null, row.group]);
    const known = key === null ? undefined : groups.get(key);
    if (known) known.unshift(row);
    else {
      const group = [row];
      if (key !== null) groups.set(key, group);
      order.push(group);
    }
  }
  return order;
}
/** One row for a group of bets: its label, how many, and what they came to together. Only the net is summed:
 * a sequential game stakes again what its last step paid, so adding up its stakes or its payouts would count
 * the same money more than once. */
export function groupRowElement(rows: readonly BetRow[], onOpen?: (rows: readonly BetRow[]) => void) {
  const last = rows.at(-1)!,
    unit = unitOf(last.asset),
    net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n),
    item = element(
      onOpen ? 'button' : 'div',
      `bet-row tone-${net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral'}`,
    );
  if (onOpen) {
    (item as HTMLButtonElement).type = 'button';
    item.addEventListener('click', () => onOpen(rows));
  }
  const name = element('div', 'bet-game');
  name.append(element('span', 'bet-game-name', last.game));
  if (last.who) name.append(element('span', 'bet-who', last.who));
  const date = new Date(last.at);
  name.append(
    element(
      'span',
      'bet-time',
      Number.isNaN(date.getTime())
        ? '—'
        : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}`,
    ),
  );
  item.append(
    name,
    figure('Group', last.group!, 'bet-group'),
    figure('Bets', String(rows.length)),
    figure('Result', signed(net, unit), net < 0n ? 'negative' : net > 0n ? 'positive' : ''),
  );
  item.dataset.search =
    `group ${last.group} ${rows.map(row => row.operation ?? `bet #${row.index}`).join(' ')}`.toLowerCase();
  item.dataset.bets = String(rows.length);
  item.title = onOpen ? `Open the ${rows.length} bets of ${last.group}` : `The ${rows.length} bets of ${last.group}`;
  return item;
}

// --- One bet, in full -------------------------------------------------------------------------

/** Where a point or a stretch of the outcome space sits, as a percentage for laying out a bar. */
const across = (value: bigint) => Number((value * 1_000_000n) / OUTCOME_SPACE) / 10_000;
/** The share of the space a stretch of outcomes covers, as a percentage with four decimals. */
const chance = (width: bigint) => percent((width * 1_000_000n) / OUTCOME_SPACE);

const detailSection = (title: string, note?: string) => {
  const box = element('section', 'bet-detail-section');
  box.append(element('h3', '', title));
  if (note) box.append(element('p', 'bet-detail-note', note));
  return box;
};
const hex = (value: unknown) => element('code', 'bet-detail-hex', value === undefined ? '—' : String(value));
/** A value beside a tick: the wallet has just worked it out again from the preimages it kept. */
const rederived = (value: unknown, matches: boolean, why: string) => {
  const line = element('div', 'bet-detail-derived');
  line.title = why;
  line.append(hex(value), element('span', `bet-detail-check ${matches ? 'ok' : 'bad'}`, matches ? '✓' : '✗'));
  return line;
};
const factList = (rows: readonly (readonly [string, string | Node] | null | false | undefined)[]) => {
  const list = element('dl', 'bet-detail-facts');
  for (const entry of rows) {
    if (!entry) continue;
    const term = document.createElement('dt'),
      detail = document.createElement('dd');
    term.textContent = entry[0];
    detail.append(entry[1]);
    list.append(term, detail);
  }
  return list;
};

/**
 * One of this wallet's own bets, whole: the prize table it rode drawn across the outcome space,
 * where its round landed in that space, and the seed and secret that drew it. Every derived figure
 * is worked out here from the receipt's own preimages, so it is checked in front of the player
 * rather than repeated back from what the casino said.
 */
export function betDetail(row: BetRow, onGame?: (row: BetRow) => void) {
  const unit = unitOf(row.asset),
    net = row.payout - row.stake,
    receipt = row.receipt ?? {},
    step = receipt.proof?.step,
    op = step?.operation,
    later = receipt.details?.bet,
    // A drawn bet keeps its prizes, round and seed hash in its details, and the seed and secret that drew its
    // round on its receipt; a bet on its own round keeps them all in the operation.
    draw = later?.prizes
      ? receipt.draw && { prizes: later.prizes, round: later.round, seedHash: later.seedHash, ...receipt.draw }
      : op && step && !later
        ? { prizes: op.prizes, seed: step.seed, secret: step.secret, round: op.round, seedHash: op.seedHash }
        : null,
    prizes: { start: bigint; end: bigint; payout: bigint }[] = (Array.isArray(draw?.prizes) ? draw!.prizes : []).map(
      (prize: any) => ({
        start: BigInt(prize.rangeStart),
        end: BigInt(prize.rangeEnd),
        payout: BigInt(prize.payout),
      }),
    ),
    // Both preimages are here, so the round is drawn again from nothing but them.
    drawn = draw?.seed && draw.secret ? outcome(draw.prizes, draw.seed, draw.secret) : null,
    landed = drawn ? drawn.value : null,
    body = document.createDocumentFragment();

  const when = new Date(row.at);
  body.append(
    element(
      'p',
      'bet-detail-when',
      `${net > 0n ? 'Won' : net < 0n ? 'Lost' : 'Returned'} ${signed(net, unit)}` +
        (Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleString()}`),
    ),
  );
  const figures = element('div', 'bet-detail-figures');
  figures.append(
    figure('Staked', `${formatEther(row.stake)} ${unit}`),
    figure('Paid', `${formatEther(row.payout)} ${unit}`),
    figure('Result', signed(net, unit), net < 0n ? 'negative' : net > 0n ? 'positive' : ''),
    figure(
      'Return of this bet',
      row.expected === null ? '—' : percent(returnParts(row.stake, row.expected)),
      'bet-return',
    ),
  );
  body.append(figures);

  if (later?.terms) {
    // A bet with terms has no prize table and no round: its referee signed what it paid.
    const settled = detailSection(
      'How it settled',
      'The game’s referee signed what this bet paid you and what it gave the casino; the developer’s bank kept the rest of the stake or paid what the two came to beyond it. Your wallet checked the signature before it collected.',
    );
    settled.append(
      factList([
        ['Referee', hex(later.referee)],
        ['Terms you signed', element('code', 'bet-detail-hex', JSON.stringify(later.terms))],
        ['Refunded if unsettled by', new Date(later.deadline).toLocaleString()],
        receipt.settlement ? ['Paid to you', `${formatEther(receipt.settlement.player)} ${unit}`] : null,
        receipt.settlement ? ['Given to the casino', `${formatEther(receipt.settlement.casino)} ${unit}`] : null,
        receipt.settlement ? ['The referee’s signature', hex(receipt.settlement.signature)] : null,
        receipt.reason ? ['Refund', receipt.reason] : null,
      ]),
    );
    body.append(settled);
  } else if (!prizes.length || landed === null) {
    body.append(
      element(
        'p',
        'bet-detail-note',
        'This receipt keeps no prize table, so there is nothing to draw: only the amounts above are known.',
      ),
    );
  } else {
    const won = prizes.filter(prize => landed >= prize.start && landed < prize.end);
    // Every prize gets its own lane, so prizes that overlap are seen to overlap.
    const where = detailSection('Where the round landed');
    const space = element('div', 'bet-space'),
      lanes = element('div', 'bet-space-lanes');
    for (const prize of prizes) {
      const hit = landed >= prize.start && landed < prize.end,
        lane = element('div', `bet-space-lane${hit ? ' hit' : ''}`),
        band = element('div', 'bet-space-band');
      band.style.left = `${across(prize.start)}%`;
      band.style.width = `${across(prize.end - prize.start)}%`;
      band.title = `Pays ${formatEther(prize.payout)} ${unit} on ${chance(prize.end - prize.start)} of outcomes`;
      lane.append(band);
      lanes.append(lane);
    }
    const mark = element('div', 'bet-space-mark');
    mark.style.left = `${across(landed)}%`;
    mark.title = `The outcome, ${landed}`;
    lanes.append(mark);
    space.append(lanes);
    const scale = element('div', 'bet-space-scale');
    scale.append(element('span', '', '0'), element('span', '', '2⁶⁴'));
    space.append(scale);
    where.append(space);
    where.append(
      element(
        'p',
        'bet-detail-note',
        `The round drew ${landed}, ${across(landed).toFixed(3)}% of the way across the space. ` +
          (won.length
            ? `${won.length} of ${prizes.length} prize${prizes.length === 1 ? '' : 's'} held it, so the bet paid ${formatEther(row.payout)} ${unit}.`
            : `No prize held it, so the bet paid nothing of the ${formatEther(row.maxPayout ?? 0n)} ${unit} it could have.`),
      ),
    );
    body.append(where);

    const table = detailSection(
      'The prize table you signed',
      'A prize pays when the outcome falls in its range, the end never included. Prizes may overlap, and every one that holds the outcome pays.',
    );
    const grid = element('div', 'bet-prizes');
    for (const head of ['Prize', 'Pays', 'Chance', 'Outcomes it holds', ''])
      grid.append(element('span', 'bet-prizes-head', head));
    prizes.forEach((prize, index) => {
      const hit = landed >= prize.start && landed < prize.end;
      grid.append(
        element('span', `bet-prizes-cell${hit ? ' hit' : ''}`, `#${index + 1}`),
        element('span', `bet-prizes-cell${hit ? ' hit' : ''}`, `${formatEther(prize.payout)} ${unit}`),
        element('span', `bet-prizes-cell${hit ? ' hit' : ''}`, chance(prize.end - prize.start)),
        element('span', `bet-prizes-cell range${hit ? ' hit' : ''}`, `${prize.start} … ${prize.end}`),
        element('span', `bet-prizes-cell${hit ? ' hit' : ''}`, hit ? 'held it' : ''),
      );
    });
    table.append(grid);
    table.append(
      element(
        'p',
        'bet-detail-note',
        `Together they were worth ${percent(returnParts(row.stake, row.expected ?? 0n))} of the stake, and could have paid ` +
          `at most ${formatEther(row.maxPayout ?? 0n)} ${unit}.`,
      ),
    );
    body.append(table);
  }

  if (step && op) {
    if (draw && drawn) {
      const how = detailSection(
        'How the outcome was drawn',
        later
          ? 'The casino named the round by publishing the hash of its secret, and the game’s referee committed to the hash of its seed, both before you bet. ' +
              'Your bet named both, so its outcome was fixed before it was placed, and nobody can change it.'
          : 'The casino fixed the round by publishing the hash of its secret, and your bet named the hash of its seed. ' +
              'Neither side could see the outcome while choosing, and neither can change it afterwards.',
      );
      how.append(
        factList([
          [later ? 'The referee’s seed' : 'Your seed', hex(draw.seed)],
          [
            'Hashes to the seed hash your bet named',
            rederived(
              draw.seedHash,
              same(seedHash(draw.seed), draw.seedHash),
              'keccak256 of the seed above, against the hash your bet signed',
            ),
          ],
          ['The casino’s secret', hex(draw.secret)],
          [
            'Hashes to the round your bet was on',
            rederived(
              draw.round,
              same(roundId(draw.secret), draw.round),
              'keccak256 of the secret above, against the round your bet named before the secret was out',
            ),
          ],
          [
            'Both hashed together',
            rederived(
              drawn!.randomHash,
              receipt.randomHash === undefined || same(drawn!.randomHash, receipt.randomHash),
              'keccak256 of the tag HOOKEDIN/OUTCOME, the seed and the secret',
            ),
          ],
          [
            'Its lowest 64 bits are the outcome',
            rederived(
              `${drawn!.value} · 0x${drawn!.value.toString(16)}`,
              receipt.payout === undefined || drawn!.payout === BigInt(receipt.payout),
              'The outcome the prizes were read against, and the payout it produced',
            ),
          ],
        ]),
      );
      body.append(how);
    }

    const record = detailSection(
      'The record you both signed',
      'Your wallet keeps this whether or not the casino does. It proves this bet’s place in your channel.',
    );
    record.append(
      factList([
        ['Operation', hex(receipt.operationId)],
        ['Channel', hex(op.channelId)],
        ['Sequence', String(op.sequence)],
        ['Game', receipt.game?.name ?? '—'],
        ['Game key', hex(receipt.details?.game)],
        ['Memo, the hash of the details above', hex(op.memo)],
        ['Expected payout, out of 2⁶⁴ stakes', hex(receipt.expectedPayout)],
        ['Balance after it settled', `${formatEther(receipt.balance ?? 0)} ${unit}`],
        receipt.commission && BigInt(receipt.commission) > 0n
          ? ['The game’s commission', `${formatEther(receipt.commission)} ${unit}`]
          : null,
        ['The state it moved from', hex(op.previousStateHash)],
        ['Your signature on it', hex(step.authorization)],
        ['The casino’s signature on it', hex(step.casinoSignature)],
      ]),
    );
    const raw = document.createElement('details');
    raw.className = 'bet-detail-raw';
    const label = document.createElement('summary');
    label.textContent = 'The whole receipt, as JSON';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button';
    copy.textContent = 'Copy JSON';
    const text = activityJSON(receipt);
    const said = element('span', 'activity-copy-status');
    said.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        said.textContent = 'Copied';
      } catch {
        said.textContent = 'Copy unavailable. Select the text below.';
      }
    });
    const bar = element('div', 'activity-payload-heading');
    bar.append(said, copy);
    const payload = element('pre', 'activity-payload', text);
    payload.tabIndex = 0;
    raw.append(label, bar, payload);
    record.append(raw);
    body.append(record);
  }

  if (onGame && row.key) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'button secondary small bet-detail-more';
    link.textContent = 'Every bet in this game ↗';
    link.addEventListener('click', () => onGame(row));
    body.append(link);
  }
  return body;
}

/** Search across the rendered rows, as the activity list does: the text is what the player reads,
 * plus the operation ID or number each row carries. */
export function filterBets(list: HTMLElement, query: string, empty: HTMLElement, count: HTMLElement, none: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0,
    total = 0;
  for (const row of list.children as HTMLCollectionOf<HTMLElement>) {
    const text = (row.textContent! + ' ' + (row.dataset.search ?? '')).toLowerCase();
    const matches = terms.every(term => text.includes(term));
    // A group's row stands for every bet in it.
    const bets = Number(row.dataset.bets ?? 1);
    row.classList.toggle('hidden', !matches);
    total += bets;
    if (matches) visible += bets;
  }
  count.textContent = `${terms.length ? `${visible} / ` : ''}${total} ${total === 1 ? 'bet' : 'bets'}`;
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? 'No bet matches that. Try a game, an amount, a bet number or an operation ID.'
    : none;
}
