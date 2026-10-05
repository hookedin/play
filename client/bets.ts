import { OUTCOME_SPACE, returnParts } from '../protocol/risk.ts';
import { betPayout, channelId, outcome, roundId, same, seedHash } from '../protocol/protocol.ts';
import { activityJSON, exact, h, jsonBlock, percent, signedAmount, timeOf } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';

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
  /** The game's key, made from its developer and the name it is published under, when the reader knows it. */
  key?: string | null;
  /** Who placed it, on a public list. This wallet's own rows leave it out. */
  who?: string | null;
  /** The label the game gave it, such as a hand or a match. */
  group?: string;
  /** What it put at risk: what a casino bet staked, which can be less than the stake a game shows when the game keeps
   * part of it back, or what a payment of the round paid the house. */
  stake: bigint;
  payout: bigint;
  /** The bet's expected payout, out of 2^64 stakes: what its own odds were worth. A developer bet has no
   * odds, so nothing says what it was worth. */
  expected: bigint | null;
  /** The most the bet could pay, when the reader knows it. */
  maxPayout?: bigint | null;
  /** This wallet's own name for the bet. A public row has none: it is known by `index` instead. */
  operation?: string;
  /** A public row's place in the casino's signing history, which orders every settled bet. */
  index?: number;
  /** This wallet's own receipt, whole: the odds, the preimages and the signatures it kept. A
   * public row has none, because the casino's list is only what anyone may read. */
  receipt?: any;
}

/** What a set of bets was expected to pay back, in millionths of everything staked. */
export const measuredReturn = (staked: bigint, expected: bigint) =>
  staked > 0n ? returnParts(staked, expected) : null;
/** What a set of bets did pay back. Over a handful of bets this is luck; over thousands it is the
 * odds. Both are shown, because a player deserves to see which one they are reading. */
export const realisedReturn = (staked: bigint, paid: bigint) =>
  staked > 0n ? (paid * 1_000_000n + staked / 2n) / staked : null;

export interface BetTotals {
  /** Bets, a round's steps counting once. */
  bets: number;
  staked: bigint;
  paid: bigint;
  /** What the bets with odds were expected to pay, and what they staked. */
  expected: bigint;
  priced: bigint;
  net: bigint;
}
/** What a row put at risk is called: a payment of a game's round is money paid to the house. */
const stakeLabel = (row: BetRow) => (row.receipt?.kind === 'payment' ? 'Paid in' : 'At risk');
/** What a round took from outside itself, its bets oldest first: each step stakes what the round's earlier steps paid
 * before anything more, so this is the most the round was ever down, what the player put in. */
export function putIn(rows: readonly BetRow[]) {
  let held = 0n,
    most = 0n;
  for (const row of rows) {
    held -= row.stake;
    if (-held > most) most = -held;
    held += row.payout;
  }
  return most;
}
/** Bets, added up, a round's steps as one, with what they took from outside their rounds. */
export function betTotals(rows: readonly BetRow[]) {
  const rounds = groupRows(rows),
    totals: BetTotals & { putIn: bigint } = {
      bets: rounds.length,
      putIn: rounds.reduce((sum, round) => sum + putIn(round), 0n),
      staked: 0n,
      paid: 0n,
      expected: 0n,
      priced: 0n,
      net: 0n,
    };
  for (const row of rows) {
    totals.staked += row.stake;
    totals.paid += row.payout;
    totals.net += row.payout - row.stake;
    if (row.expected === null) continue;
    totals.expected += row.expected;
    totals.priced += row.stake;
  }
  return totals;
}

const tone = (net: bigint) => (net < 0n ? 'negative' : net > 0n ? 'positive' : '');
/** One figure under its label, as a bet's row and a bet in full both show it; `exact`, when the figure is cut short. */
const figure = (label: string | Node, value: string, className = '', exact = '') =>
  h(
    'div',
    { className: `bet-figure ${className}`.trim(), ...(exact ? { title: exact } : {}) },
    h('span', { className: 'bet-figure-value' }, value),
    h('span', { className: 'bet-figure-label' }, label),
  );
/** An amount as a row shows it, short, with the exact one on hover. */
const amount = (label: string | Node, wei: bigint, className = '') =>
  figure(label, `${formatAmount(wei)} METH`, className, `${exact(wei)} METH`);

/** How much went in, how much came back, and both returns side by side: one card, or none for no bets. */
export function totalCards(totals: BetTotals) {
  if (!totals.bets) return [];
  const expected = measuredReturn(totals.priced, totals.expected),
    realised = realisedReturn(totals.staked, totals.paid);
  return [
    h(
      'div',
      { className: 'money-card' },
      h(
        'div',
        { className: 'eyebrow' },
        `${totals.bets.toLocaleString('en-US')} ${totals.bets === 1 ? 'BET' : 'BETS'}`,
      ),
      h(
        'div',
        { className: 'large-amount' },
        h('span', null, expected === null ? '—' : percent(expected)),
        h('small', null, 'EXPECTED'),
      ),
      h(
        'p',
        null,
        `What these bets' own odds were worth${totals.priced < totals.staked ? ', where a bet had them: a developer bet has none' : ''}. ` +
          `They paid back ${realised === null ? '—' : percent(realised)}.`,
      ),
      h('p', { className: `bet-net ${totals.net < 0n ? 'negative' : 'positive'}` }, signedAmount(totals.net)),
    ),
  ];
}

/** A row of a bet list, with the game, player and time of its latest bet. `who` is shown on a public list and left
 * out of a player's own. A row that can be opened is a button: only this wallet's own receipt holds the odds and
 * preimages to show. */
function rowElement(last: BetRow, net: bigint, onOpen?: () => void) {
  const item = onOpen ? h('button', { type: 'button', onclick: onOpen }) : h('div');
  item.className = `bet-row tone-${tone(net) || 'neutral'}`;
  const name = h('div', { className: 'bet-game' }, h('span', { className: 'bet-game-name' }, last.game));
  if (last.who) name.append(h('span', { className: 'bet-who' }, last.who));
  name.append(timeOf(last.at, 'bet-time', true));
  item.append(name);
  return item;
}
/** One row per bet. */
export function betRowElement(row: BetRow, onOpen?: (row: BetRow) => void) {
  const net = row.payout - row.stake,
    item = rowElement(row, net, onOpen && (() => onOpen(row)));
  item.append(
    amount(stakeLabel(row), row.stake),
    amount(
      row.maxPayout === undefined || row.maxPayout === null
        ? 'Paid'
        : `Paid of up to ${formatAmount(row.maxPayout)} METH`,
      row.payout,
    ),
    figure('Result', signedAmount(net), tone(net), `${exact(net < 0n ? -net : net)} METH`),
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
/** One row for a round, a group of bets: what it took from the player, its bets, and what it came to. Its stakes and
 * payouts are not added up: a round's steps stake again what its last step paid, which would count the same money
 * more than once. Its label is the game's own, often a long ID: it is searched, not shown. */
export function groupRowElement(rows: readonly BetRow[], onOpen?: (rows: readonly BetRow[]) => void) {
  const last = rows.at(-1)!,
    net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n),
    item = rowElement(last, net, onOpen && (() => onOpen(rows)));
  item.append(
    amount('Put in', putIn(rows)),
    figure('Bets in one round', String(rows.length)),
    figure('Result', signedAmount(net), tone(net), `${exact(net < 0n ? -net : net)} METH`),
  );
  item.dataset.search =
    `round group ${last.group} ${rows.map(row => row.operation ?? `bet #${row.index}`).join(' ')}`.toLowerCase();
  item.title = onOpen ? `Open the round's ${rows.length} bets` : `The round's ${rows.length} bets`;
  return item;
}

// --- One bet, in full -------------------------------------------------------------------------

/** Where a point or a stretch of the outcome space sits, as a percentage for laying out a bar. */
const across = (value: bigint) => Number((value * 1_000_000n) / OUTCOME_SPACE) / 10_000;
/** The share of the space a stretch of outcomes covers, as a percentage with four decimals. */
const chance = (width: bigint) => percent((width * 1_000_000n) / OUTCOME_SPACE);

const detailSection = (title: string, note?: string) =>
  h(
    'section',
    { className: 'bet-detail-section' },
    h('h3', null, title),
    ...(note ? [h('p', { className: 'bet-detail-note' }, note)] : []),
  );
const hex = (value: unknown) => h('code', { className: 'bet-detail-hex' }, value === undefined ? '—' : String(value));
/** A value beside a tick: the wallet has just worked it out again from the preimages it kept. */
const rederived = (value: unknown, matches: boolean, why: string) =>
  h(
    'div',
    { className: 'bet-detail-derived', title: why },
    hex(value),
    h('span', { className: `bet-detail-check ${matches ? 'ok' : 'bad'}` }, matches ? '✓' : '✗'),
  );
const factList = (rows: readonly (readonly [string, string | Node] | null | false | undefined)[]) =>
  h(
    'dl',
    { className: 'bet-detail-facts' },
    ...rows.flatMap(entry => (entry ? [h('dt', null, entry[0]), h('dd', null, entry[1])] : [])),
  );

/**
 * One of this wallet's own bets, whole: for a casino bet, its chance drawn across the outcome space, where its round
 * landed in that space, and the seed and secret that fixed it; for a developer bet, what it was and how its developer
 * settled it. Every derived figure is worked out here from the receipt's own preimages, so it is checked in front of
 * the player rather than repeated back from what the casino said.
 */
export function betDetail(row: BetRow, onGame?: (row: BetRow) => void) {
  const net = row.payout - row.stake,
    receipt = row.receipt ?? {},
    step = receipt.proof?.step,
    // The checkpoint the bet follows names its channel and its place.
    base = receipt.proof?.base,
    op = step?.operation,
    developerBet = receipt.kind === 'developer-bet',
    // A casino bet keeps its chance, its prize, its round and the hash of its seed in its operation, and the seed and
    // secret that settled it in its step.
    revealed =
      op && step && !developerBet
        ? {
            chance: BigInt(op.chance),
            prize: BigInt(op.prize),
            seed: step.seed,
            secret: step.secret,
            round: op.round,
            seedHash: op.seedHash,
          }
        : null,
    // Both preimages are here, so the round's outcome and what the bet paid are worked out again from nothing but them.
    result = revealed?.seed && revealed.secret ? outcome(revealed.seed, revealed.secret) : null,
    landed = result ? result.value : null,
    paid = revealed && landed !== null ? betPayout(revealed, landed) : null,
    body = document.createDocumentFragment();

  const when = new Date(row.at);
  body.append(
    h(
      'p',
      { className: 'bet-detail-when' },
      `${net > 0n ? 'Won' : net < 0n ? 'Lost' : 'Broke even'} ${signedAmount(net)}` +
        (Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleString()}`),
    ),
    h(
      'div',
      { className: 'bet-detail-figures' },
      figure(stakeLabel(row), `${exact(row.stake)} METH`),
      figure('Paid', `${exact(row.payout)} METH`),
      figure('Result', signedAmount(net), tone(net)),
      figure(
        'Return of this bet',
        row.expected === null ? '—' : percent(returnParts(row.stake, row.expected)),
        'bet-return',
      ),
    ),
  );

  if (developerBet && receipt.settlement) {
    // A developer bet is settled by its developer, from their bank, on their word.
    const settled = detailSection(
      'How it settled',
      'The game’s developer signed what this bet paid you and what it gave the casino, from their bank. Your wallet checked the signature before it collected.',
    );
    settled.append(
      factList([
        ['Developer', hex(receipt.game?.developer)],
        ['The bet you signed', hex(JSON.stringify(receipt.details?.meta))],
        ['Paid to you', `${exact(receipt.settlement.player)} METH`],
        ['Given to the casino', `${exact(receipt.settlement.casino)} METH`],
        ['The developer’s signature', hex(receipt.settlement.signature)],
      ]),
    );
    body.append(settled);
  }
  if (developerBet) {
    // A developer bet has no odds and no round.
  } else if (!revealed || landed === null) {
    body.append(
      h(
        'p',
        { className: 'bet-detail-note' },
        receipt.kind === 'payment'
          ? 'A payment: the game paid this to the house out of what its round held. It has no odds and no round.'
          : 'This receipt keeps no revealed round, so there is nothing to draw: only the amounts above are known.',
      ),
    );
  } else {
    const won = landed < revealed.chance;
    // The whole outcome space, the stretch below the bet's chance and where the round landed in it.
    const where = detailSection('Where the round landed');
    const band = h('div', {
        className: 'bet-space-band',
        title: `Pays ${exact(revealed.prize)} METH on ${chance(revealed.chance)} of outcomes`,
      }),
      mark = h('div', { className: 'bet-space-mark', title: `The outcome, ${landed}` });
    band.style.width = `${across(revealed.chance)}%`;
    mark.style.left = `${across(landed)}%`;
    where.append(
      h('div', { className: `bet-space${won ? ' hit' : ''}` }, band, mark),
      h('div', { className: 'bet-space-scale' }, h('span', null, '0'), h('span', null, '2⁶⁴')),
      h(
        'p',
        { className: 'bet-detail-note' },
        `The round drew ${landed}, ${across(landed).toFixed(3)}% of the way across the space. ` +
          (won
            ? `That is below the bet’s chance, so it pays its prize, ${exact(revealed.prize)} METH.`
            : `That is not below the bet’s chance, so it pays nothing of the ${exact(revealed.prize)} METH it could have.`),
      ),
    );
    body.append(where);

    const terms = detailSection(
      'The bet you signed',
      'It pays its prize when the round’s outcome falls below its chance, counted in outcomes out of 2⁶⁴.',
    );
    terms.append(
      factList([
        ['Prize', `${exact(revealed.prize)} METH`],
        ['Chance', `${chance(revealed.chance)} · ${revealed.chance} of 2⁶⁴ outcomes`],
        ['Worth', `${percent(returnParts(row.stake, row.expected ?? 0n))} of the stake`],
      ]),
    );
    body.append(terms);
  }

  if (step && op) {
    if (revealed && result) {
      const how = detailSection(
        'How the outcome was fixed',
        'The casino fixed the round by publishing the hash of its secret, and your bet named the hash of its seed. ' +
          'Neither side could see the outcome while choosing, and neither can change it afterwards.',
      );
      how.append(
        factList([
          ['Your seed', hex(revealed.seed)],
          [
            'Hashes to the seed hash your bet named',
            rederived(
              revealed.seedHash,
              same(seedHash(revealed.seed), revealed.seedHash),
              'keccak256 of the seed above, against the hash your bet signed',
            ),
          ],
          ['The casino’s secret', hex(revealed.secret)],
          [
            'Hashes to the round your bet was on',
            rederived(
              revealed.round,
              same(roundId(revealed.secret), revealed.round),
              'keccak256 of the secret above, against the round your bet named before the secret was out',
            ),
          ],
          [
            'Both hashed together',
            rederived(
              result!.randomHash,
              receipt.randomHash === undefined || same(result!.randomHash, receipt.randomHash),
              'keccak256 of the tag HOOKEDIN/OUTCOME, the seed and the secret',
            ),
          ],
          [
            'Its lowest 64 bits are the outcome',
            rederived(
              `${result!.value} · 0x${result!.value.toString(16)}`,
              receipt.payout === undefined || paid === BigInt(receipt.payout),
              'The outcome the bet was read against, and what it pays on it',
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
        ['Channel', hex(base && channelId(base.player, base.index))],
        ['Sequence', base ? String(BigInt(base.sequence) + 1n) : '—'],
        ['Game', receipt.game?.name ?? '—'],
        ['Game key', hex(receipt.details?.game)],
        ['Memo, the hash of the details above', hex(op.memo)],
        ['Expected payout, out of 2⁶⁴ stakes', hex(receipt.expectedPayout)],
        ['Balance after it settled', `${exact(receipt.balance ?? 0)} METH`],
        receipt.commission && BigInt(receipt.commission) > 0n
          ? ['The game’s commission', `${exact(receipt.commission)} METH`]
          : null,
        ['The state it moved from', hex(op.previousStateHash)],
        ['Your signature on it', hex(step.authorization)],
        ['The casino’s signature on it', hex(step.casinoSignature)],
      ]),
    );
    record.append(
      h(
        'details',
        { className: 'bet-detail-raw' },
        h('summary', null, 'The whole receipt, as JSON'),
        ...jsonBlock(activityJSON(receipt), 'the whole receipt'),
      ),
    );
    body.append(record);
  }

  if (onGame && row.key)
    body.append(
      h(
        'button',
        { type: 'button', className: 'button small bet-detail-more', onclick: () => onGame(row) },
        'Every bet in this game ↗',
      ),
    );
  return body;
}
