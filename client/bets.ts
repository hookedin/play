import { OUTCOME_SPACE } from '../protocol/risk.ts';
import { betPayout, channelId, drawStep, landStep, outcome, roundId, same, seedHash } from '../protocol/protocol.ts';
import { splitStep } from '../sdk/src/engine/transition.ts';
import type { StepBranch } from '../sdk/src/engine/transition.ts';
import { activityJSON, copyBlock, edgeWei, exact, h, percent, shortPercent, signedAmount, timeOf } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import type { Operation, StepTable } from '../protocol/types.ts';
import type { Receipt } from './wallet.ts';
import { landed } from './wallet-games.ts';

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
  /** The game's ID, when the reader knows it. */
  gameId?: string | null;
  /** Who placed it, on a public list. This wallet's own rows leave it out. */
  who?: string | null;
  /** The name the game's developer goes by, when this wallet has seen the game on their profile. */
  publisher?: string;
  /** The label the game gave it, such as a hand or a match. */
  group?: string;
  /** What went in and what came back. A step of a round puts in all the cash it held: its bet stakes part of it and
   * keeps the rest back, which comes back whatever happens, and a step that drew no bet keeps it all. A payment puts
   * in what it paid the house. */
  stake: bigint;
  payout: bigint;
  /** What it was expected to pay back, out of 2^64: its own odds' expected payout with what its step kept back, and
   * nothing for a payment. A developer bet has no odds, so nothing says what it was worth. */
  expected: bigint | null;
  /** A payment a game's round made to the house, with what the round kept beside it, when it signed that. */
  payment?: boolean;
  kept?: bigint;
  /** The most the bet could pay, when the reader knows it. */
  maxPayout?: bigint | null;
  /** This wallet's own name for the bet. A public row has none: it is known by `id` instead. */
  operation?: string;
  /** A public row's ID in the casino's record, which says when it was placed and nothing of how many were. */
  id?: string;
  /** This wallet's own receipt, whole: the odds, the preimages and the signatures it kept. A
   * public row has none, because the casino's list is only what anyone may read. */
  receipt?: Receipt;
}

/** A bet's house edge, out of 2^64: what it put in less what it was expected to pay back, which is what it was expected
 * to cost. A step's bet keeps back the rest of what the step held, which comes back whatever happens, so its edge is
 * that of its own odds, and a payment's is all it paid. Each is worked out from the bet's own signed terms, so the
 * bets of a round add up to what the round was played at. None for a developer bet, whose odds nobody prices. */
const rowEdge = (row: BetRow) => (row.expected === null ? null : row.stake * OUTCOME_SPACE - row.expected);
/** The house edge of a round's bets: none if one of them is a developer bet. */
const edgeOf = (rows: readonly BetRow[]) =>
  rows.reduce<bigint | null>((sum, row) => {
    const edge = rowEdge(row);
    return sum === null || edge === null ? null : sum + edge;
  }, 0n);
/** A part of a whole in millionths, to the nearest: none of nothing. */
const share = (part: bigint, whole: bigint) => (whole > 0n ? (part * 1_000_000n + whole / 2n) / whole : null);

interface BetTotals {
  /** Bets, a round's steps counting once. */
  bets: number;
  /** What the bets took from outside their rounds, and what they came out with. */
  putIn: bigint;
  net: bigint;
  /** The house edge of the bets with odds, out of 2^64, and what they put in. */
  edge: bigint;
  priced: bigint;
  /** Whether some bet has no odds anyone prices: a developer bet. */
  unpriced: boolean;
}
/** What went in is called: a payment of a game's round is money paid to the house. */
const stakeLabel = (row: BetRow) => (row.payment ? 'Paid to the house' : 'Put in');
/** What each bet of a round, oldest first, added to what the round took from outside itself: each step stakes what the
 * round's earlier steps paid before anything more, so together they are the most the round was ever down, what the
 * player put in. */
function putIns(rows: readonly BetRow[]) {
  let down = 0n,
    most = 0n;
  return rows.map(row => {
    const added = down + row.stake > most ? down + row.stake - most : 0n;
    most += added;
    down += row.stake - row.payout;
    return added;
  });
}
export const putIn = (rows: readonly BetRow[]) => putIns(rows).reduce((sum, added) => sum + added, 0n);
/** Bets, added up, a round's steps as one: what they took from outside their rounds and came out with, and the house
 * edge of those with odds against what those put in. */
export function betTotals(rows: readonly BetRow[]) {
  const rounds = groupRows(rows),
    totals: BetTotals = { bets: rounds.length, putIn: 0n, net: 0n, edge: 0n, priced: 0n, unpriced: false };
  for (const round of rounds) {
    const added = putIns(round);
    round.forEach((row, i) => {
      const edge = rowEdge(row);
      totals.putIn += added[i]!;
      totals.net += row.payout - row.stake;
      if (edge === null) totals.unpriced = true;
      else {
        totals.edge += edge;
        totals.priced += added[i]!;
      }
    });
  }
  return totals;
}
/** Bets' house edge, in millionths of what they put in. */
export const edgeShare = (totals: Pick<BetTotals, 'edge' | 'priced'>) =>
  share(totals.edge, totals.priced * OUTCOME_SPACE);

/** The class of a gain or a loss: none for nothing. */
export const tone = (net: bigint) => (net < 0n ? 'negative' : net > 0n ? 'positive' : '');
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
/** A house edge, to a millionth of a METH with every digit on hover, or in full; none for a developer bet. */
const edgeFigure = (edge: bigint | null, full = false) =>
  edge === null
    ? figure('House edge', '—', '', 'A developer bet has no odds anyone prices')
    : full
      ? figure('House edge', `${exact(edgeWei(edge))} METH`)
      : figure('House edge', `${formatAmount(edgeWei(edge), 6)} METH`, '', `${exact(edgeWei(edge))} METH`);

/** What went in, the house edge on it and what came back: one card, or none for no bets. */
export function totalCards(totals: BetTotals) {
  if (!totals.bets) return [];
  const edge = edgeShare(totals),
    paid = share(totals.putIn + totals.net, totals.putIn);
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
        h('span', edge === null ? null : { title: percent(edge) }, edge === null ? '—' : shortPercent(edge)),
        h('small', null, 'HOUSE EDGE'),
      ),
      h(
        'p',
        null,
        (totals.priced
          ? `What the bets were expected to cost: ${formatAmount(edgeWei(totals.edge), 6)} METH of the ${formatAmount(totals.priced)} METH put in${totals.unpriced ? ', leaving out developer bets, which have no odds anyone prices' : ''}. `
          : 'Developer bets have no odds anyone prices. ') +
          `They paid back ${paid === null ? '—' : shortPercent(paid)} of what went in.`,
      ),
      h('p', { className: `bet-net ${totals.net < 0n ? 'negative' : 'positive'}` }, signedAmount(totals.net)),
    ),
  ];
}

/** A row of a bet list, with the game, player and time of its latest bet, and how many bets a round's row holds. `who`
 * is shown on a public list and left out of a player's own. A row that can be opened is a button: only this wallet's
 * own receipt holds the odds and preimages to show. */
function rowElement(last: BetRow, net: bigint, onOpen?: () => void, bets?: string) {
  const item = onOpen ? h('button', { type: 'button', onclick: onOpen }) : h('div');
  item.className = `bet-row tone-${tone(net) || 'neutral'}`;
  const name = h('div', { className: 'bet-game' }, h('span', { className: 'bet-game-name' }, last.game));
  if (last.who) name.append(h('span', { className: 'bet-who' }, last.who));
  name.append(timeOf(last.at, 'bet-time', true));
  if (bets) name.append(h('span', { className: 'bet-count' }, bets));
  item.append(name);
  return item;
}
const plural = (n: number, noun: string) => `${n === 1 ? 'one' : n} ${noun}${n === 1 ? '' : 's'}`;
/** One row per bet. */
export function betRowElement(row: BetRow, onOpen?: (row: BetRow) => void) {
  const net = row.payout - row.stake,
    item = rowElement(row, net, onOpen && (() => onOpen(row)));
  item.append(
    amount(stakeLabel(row), row.stake),
    figure(
      'Paid',
      `${formatAmount(row.payout)} METH`,
      '',
      `${exact(row.payout)} METH` +
        (row.maxPayout === undefined || row.maxPayout === null ? '' : ` of up to ${exact(row.maxPayout)} METH`),
    ),
    figure('Result', signedAmount(net), tone(net), `${exact(net < 0n ? -net : net)} METH`),
    edgeFigure(rowEdge(row)),
  );
  // This wallet's own operation ID is long: it is searched, not shown, and so is a public row's ID in the game's record.
  const named = row.operation ? `operation ${row.operation}` : row.id === undefined ? null : `bet ${row.id}`;
  if (named) {
    item.dataset.search = `${named} ${row.group ?? ''}`.toLowerCase();
    item.title = onOpen ? `Open this bet in full · ${named}` : named[0].toUpperCase() + named.slice(1);
  }
  return item;
}

/** The bets of a round, leaving out its payments to the house and its steps that drew no bet. */
const betsIn = (rows: readonly BetRow[]) => rows.filter(row => !row.payment && row.receipt?.status !== 'kept').length;
/** Bets that carry the same group, in the same game and by the same player, belong together: the steps
 * of one hand, the bets on one match. Each group stands where its latest bet would, as one list of its
 * bets, oldest first; a bet alone stands as itself. */
export function groupRows(rows: readonly BetRow[]): BetRow[][] {
  const groups = new Map<string, BetRow[]>(),
    order: BetRow[][] = [];
  for (const row of rows) {
    const key = row.group === undefined ? null : JSON.stringify([row.gameId ?? row.game, row.who ?? null, row.group]);
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
/** One row for a round, a group of bets: what the player put in, what came back, what it came to and its house edge.
 * Its bets' own stakes and payouts are not added up: a round's steps stake again what its last step paid, which would
 * count the same money more than once. Its label is the game's own, often a long ID: it is searched, not shown. */
export function groupRowElement(rows: readonly BetRow[], onOpen?: (rows: readonly BetRow[]) => void) {
  const last = rows.at(-1)!,
    net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n),
    added = putIn(rows),
    bets = plural(betsIn(rows), 'bet'),
    item = rowElement(last, net, onOpen && (() => onOpen(rows)), bets);
  item.append(
    amount('Put in', added),
    amount('Paid', added + net),
    figure('Result', signedAmount(net), tone(net), `${exact(net < 0n ? -net : net)} METH`),
    edgeFigure(edgeOf(rows)),
  );
  item.dataset.search =
    `round group ${last.group} ${rows.map(row => row.operation ?? `bet ${row.id}`).join(' ')}`.toLowerCase();
  item.title = onOpen ? `Open the round of ${bets}` : `A round of ${bets}`;
  return item;
}

/** What a step landed on, by the label the game gave the result: none for a bet of no step, or a result without one. */
function landedLabel(receipt: Receipt | undefined) {
  try {
    const step = receipt && landed(receipt);
    return step ? receipt!.details!.table!.results[Number(step.result)]!.label : undefined;
  } catch {
    return undefined;
  }
}
/**
 * A round as the player played it: what it came to, what each step landed on, what went in and came back, and its
 * house edge; then, folded away, each step with what the round was worth before and after it, each opening in full.
 * A step that drew no bet signed nothing, so only the browser that drew it lists it.
 */
export function roundDetail(rows: readonly BetRow[], onOpen?: (row: BetRow) => void) {
  const added = putIn(rows),
    net = rows.reduce((sum, row) => sum + row.payout - row.stake, 0n),
    bets = betsIn(rows),
    labels = rows.map(row => landedLabel(row.receipt)),
    worth = (wei: bigint) => h('span', { title: `${exact(wei)} METH` }, formatAmount(wei)),
    edgeAmount = (edge: bigint | null) =>
      edge === null ? '—' : h('span', { title: `${exact(edgeWei(edge))} METH` }, formatAmount(edgeWei(edge), 6));
  const steps = rows.map((row, i) => {
    // A payment's round held what it paid and what it kept.
    const held = row.stake + (row.kept ?? 0n),
      left = row.payout + (row.kept ?? 0n),
      name = labels[i] ?? (row.payment ? 'Paid to the house' : `Step ${i + 1}`),
      kept = row.receipt?.status === 'kept';
    return h(
      'tr',
      null,
      h(
        'td',
        null,
        onOpen && row.receipt
          ? h('button', { type: 'button', className: 'text-button', onclick: () => onOpen(row) }, name)
          : name,
      ),
      h('td', null, worth(held), ' → ', worth(left)),
      h('td', null, kept ? 'No bet' : edgeAmount(rowEdge(row))),
    );
  });
  const edge = edgeOf(rows);
  return [
    h(
      'p',
      { className: `round-result ${tone(net)}`.trim(), title: `Group ${rows[0]!.group}` },
      net > 0n ? `Won ${formatAmount(net)} METH` : net < 0n ? `Lost ${formatAmount(-net)} METH` : 'Broke even',
      h('span', { className: 'bet-time' }, new Date(rows[0]!.at).toLocaleString()),
    ),
    ...(labels.some(Boolean)
      ? [h('ol', { className: 'round-landed' }, ...labels.flatMap(label => (label ? [h('li', null, label)] : [])))]
      : []),
    h(
      'div',
      { className: 'bet-detail-figures round-figures' },
      amount('Put in', added),
      amount('Paid back', added + net),
      edgeFigure(edge),
    ),
    h(
      'details',
      { className: 'raw-details round-steps' },
      h('summary', null, `How it was settled: ${plural(bets, 'bet')}`),
      h(
        'p',
        { className: 'bet-detail-note' },
        'Each bet stakes what the round was worth after the one before it, so only what the round took from your ' +
          'balance is money you put in. Open a step to see how your wallet drew it and how its outcome was fixed.',
      ),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h('tr', null, h('th', null, 'Landed on'), h('th', null, 'Worth, METH'), h('th', null, 'House edge')),
        ),
        h('tbody', null, ...steps),
        h(
          'tfoot',
          null,
          h(
            'tr',
            null,
            h('td', null, 'The round'),
            h('td', null, worth(added), ' → ', worth(added + net)),
            h('td', null, edgeAmount(edge)),
          ),
        ),
      ),
    ),
  ];
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

/** A share of the outcome space on a scale of 0 to 100, to `places` decimals: cut down, or with `nearest` rounded. */
function onScale(value: bigint, places: number, nearest = false) {
  const scaled = value * 10n ** BigInt(places + 2) + (nearest ? OUTCOME_SPACE / 2n : 0n),
    whole = scaled / OUTCOME_SPACE,
    unit = 10n ** BigInt(places);
  return { whole, text: `${whole / unit}.${String(whole % unit).padStart(places, '0')}` };
}
/** A casino bet as a roll from 0 to 100: its outcome, and the line it wins under, its chance, both as shares of 2^64,
 * the roll cut down and the line rounded, so that Dice's 49.50 reads 49.50, with as many decimals as it takes for the
 * roll to fall under the line exactly when the outcome is below the chance. Two, nearly always. */
export function roll(outcome: bigint, chance: bigint) {
  for (let places = 2; ; places++) {
    const rolled = onScale(outcome, places),
      under = onScale(chance, places, true);
    if (rolled.whole < under.whole === outcome < chance || places === 20)
      return { rolled: rolled.text, under: under.text };
  }
}
/** How likely something is: a percentage, or one in so many when that would round to nothing. */
const likelihood = (n: bigint, d: bigint) =>
  n * 10_000n >= d ? percent((n * 1_000_000n) / d) : `1 in ${((d + n / 2n) / n).toLocaleString('en-US')}`;
const total = (weights: readonly { weight: bigint }[]) => weights.reduce((sum, item) => sum + item.weight, 0n);
/** What a step's table was expected to leave the player, out of 2^64. */
export const tableOffered = ({ results }: Pick<StepTable, 'results'>) =>
  (results.reduce((sum, result) => sum + result.weight * result.cash, 0n) * OUTCOME_SPACE) / total(results);
/** Whether a step's ways reach each amount its table leaves exactly as often as its results' weights say. */
function realizes({ cash, results }: StepTable, branches: readonly StepBranch[]) {
  const offered = new Map<bigint, bigint>(),
    reached = new Map<bigint, bigint>(),
    add = (map: Map<bigint, bigint>, amount: bigint, n: bigint) => map.set(amount, (map.get(amount) ?? 0n) + n);
  for (const result of results) add(offered, result.cash, result.weight);
  for (const branch of branches)
    if (!('stake' in branch)) add(reached, cash, branch.weight * OUTCOME_SPACE);
    else {
      const kept = cash - branch.stake;
      add(reached, kept + branch.prize, branch.weight * branch.chance);
      add(reached, kept, branch.weight * (OUTCOME_SPACE - branch.chance));
    }
  const ways = total(branches) * OUTCOME_SPACE,
    weight = total(results);
  return [...new Set([...offered.keys(), ...reached.keys()])].every(
    amount => (reached.get(amount) ?? 0n) * weight === (offered.get(amount) ?? 0n) * ways,
  );
}
/** A game's step as the wallet drew it, worked out again from the table its receipt signed and the seed: the ways the
 * wallet split it into at the bankroll the table names, the way the seed draws, whether that is the bet it signed, and
 * the result it lands on with what the bet left. Null for a receipt of no step, or a table that splits into no ways. */
function drawnStep(receipt: Partial<Receipt>, paid: bigint | null) {
  const table: StepTable | undefined = receipt.details?.table,
    seed: string | undefined = receipt.seed ?? receipt.proof?.step.seed,
    op: Operation | undefined = receipt.proof?.step.operation;
  if (!table || !seed || (op && paid === null)) return null;
  let branches: StepBranch[];
  try {
    branches = splitStep({ bankroll: table.bankroll ?? 0n, cash: table.cash, results: table.results });
  } catch {
    return null;
  }
  const branch = drawStep(
      seed,
      branches.map(way => way.weight),
    ),
    chosen = branches[Number(branch)]!,
    signed = op
      ? 'stake' in chosen && chosen.stake === op.amount && chosen.chance === op.chance && chosen.prize === op.prize
      : !('stake' in chosen);
  return {
    table,
    seed,
    branches,
    branch,
    signed,
    realized: realizes(table, branches),
    ...landStep(seed, table.results, op ? table.cash - op.amount + paid! : table.cash),
  };
}
/** The page anyone can check a bet with, apart from this wallet, filled in after `#`, which never reaches a server. */
const VERIFIER = 'https://hookedin.com/verify/';
function verifierLink(
  receipt: Partial<Receipt>,
  revealed: { seed?: string; secret?: string } | null,
  step: ReturnType<typeof drawnStep>,
) {
  const op: Operation | undefined = receipt.proof?.step?.operation,
    fields: Record<string, string> = {};
  if (op && revealed?.secret)
    Object.assign(fields, { round: op.round, seedHash: op.seedHash, secret: revealed.secret });
  if (op) Object.assign(fields, { chance: String(op.chance), prize: String(op.prize) });
  if (step)
    Object.assign(fields, {
      cash: String(step.table.cash),
      results: step.table.results.map(result => `${result.weight}:${result.cash}`).join(','),
      branches: step.branches
        .map(way => ('stake' in way ? [way.weight, way.stake, way.chance, way.prize] : [way.weight]).join(':'))
        .join(','),
    });
  fields.seed = step?.seed ?? revealed?.seed ?? '';
  return `${VERIFIER}#${new URLSearchParams(fields)}`;
}
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

/** A link to the verifier, which works the proof out again apart from this wallet. */
const checkYourself = (
  receipt: Partial<Receipt>,
  revealed: { seed?: string; secret?: string } | null,
  step: ReturnType<typeof drawnStep>,
) =>
  h(
    'p',
    { className: 'bet-detail-note' },
    h(
      'a',
      { href: verifierLink(receipt, revealed, step), target: '_blank', rel: 'noopener noreferrer' },
      'Check it yourself ↗',
    ),
    ' on a page apart from this wallet, which you can also save and open offline.',
  );
/** Each way a step could go, in words, and whether two read alike: ways that make a table exact by differing in an
 * outcome or two of 2^64 then say their chances in outcomes as well. */
function waysOf(branches: readonly StepBranch[]) {
  const all = total(branches) * OUTCOME_SPACE,
    bets = branches.map(way =>
      'stake' in way
        ? `stakes ${exact(way.stake)} METH, pays ${exact(way.prize)} METH under ${roll(0n, way.chance).under}`
        : 'no bet',
    ),
    alike = new Set(bets).size < bets.length;
  return {
    alike,
    lines: branches.map(
      (way, i) =>
        `${likelihood(way.weight * OUTCOME_SPACE, all)} · ${bets[i]}` +
        (alike && 'stake' in way ? ` (${way.chance} of 2⁶⁴ outcomes)` : ''),
    ),
  };
}
/** A result as the player reads it: its label, or its place in the table. */
const resultName = (table: StepTable, index: bigint) =>
  table.results[Number(index)]!.label ?? `Result ${index + 1n} of ${table.results.length}`;
/** What the game offered for a step: its table, each result with the cash it leaves and how likely it is, the one it
 * landed on marked, and what the step returns of what it held. */
function offeredSection(step: NonNullable<ReturnType<typeof drawnStep>>) {
  const { table } = step,
    weight = total(table.results),
    landed = table.results[Number(step.result)]!.cash,
    alike = table.results.filter(result => result.cash === landed).length,
    bet = 'stake' in step.branches[Number(step.branch)]!,
    section = detailSection(
      'What the game offered',
      'The game gave your wallet this table: each result the step could end in, what it leaves you and how likely it is. ' +
        'Neither the game nor the casino chose the result.',
    );
  section.append(
    factList([
      ['What the step held', `${exact(table.cash)} METH`],
      // A bet's round decides what it leaves, and the seed only which of the results that leave it.
      bet
        ? [
            'Landed on',
            resultName(table, step.result) +
              (alike > 1 ? `, which your seed chose among the ${alike} results that leave ${exact(landed)} METH` : ''),
          ]
        : ['Landed on, drawn from your seed', resultName(table, step.result)],
    ]),
    h(
      'ol',
      { className: 'bet-step-list' },
      ...table.results.map((result, i) =>
        h(
          'li',
          { className: BigInt(i) === step.result ? 'drawn' : '' },
          `${result.label ? `${result.label} · ` : ''}${exact(result.cash)} METH · ${likelihood(result.weight, weight)}`,
        ),
      ),
    ),
  );
  return section;
}
/** How the wallet drew a game's step: the bets it split the table into, each one the casino's quote covered, with no
 * bet where a result keeps what the step held, and the one its seed drew, drawn again here, with its terms and what
 * they were worth, so that what the game offered is plain whichever bet came of it. */
function stepSection(step: NonNullable<ReturnType<typeof drawnStep>>) {
  const bets = step.branches.filter(way => 'stake' in way),
    none = bets.length < step.branches.length,
    chosen = step.branches[Number(step.branch)]!,
    offered = waysOf(step.branches),
    drew = 'stake' in chosen ? `Bet ${bets.indexOf(chosen) + 1} of ${bets.length}` : 'No bet',
    section = detailSection(
      'How your wallet drew it',
      !bets.length
        ? 'Every result keeps what the step held, so it placed no bet: your wallet drew the result with your seed, and signed nothing.'
        : `Your wallet split the table into ${bets.length === 1 ? 'a bet' : `${bets.length} bets`}${none ? ', with a chance of no bet,' : ''} that the casino's quote covered, and drew ${bets.length + (none ? 1 : 0) === 1 ? 'it' : 'one'} with your seed before it signed anything, so neither the game nor the casino chose it.` +
            (offered.alike ? ' Bets that differ by an outcome or two of 2⁶⁴ make the table exact.' : ''),
    );
  if (!bets.length) return section;
  section.append(
    factList([
      [
        'The bets pay out as the table says',
        rederived(
          step.realized ? 'Each amount, exactly as often' : 'Not as the table says',
          step.realized,
          'Every amount the table leaves, reached by the bets exactly as often as its results’ weights say',
        ),
      ],
      [
        'Drawn from your seed',
        rederived(
          drew,
          step.signed,
          'keccak256 of the tag HOOKEDIN/BRANCH, the seed and a counter, read as a number below the bets’ total weight: the bet your wallet signed',
        ),
      ],
      'stake' in chosen && [
        'The bet it signed',
        `Stakes ${exact(chosen.stake)} METH and pays ${exact(chosen.prize)} METH under ${roll(0n, chosen.chance).under}, ` +
          `${chosen.chance} of 2⁶⁴ outcomes, at a house edge of ${exact(edgeWei(chosen.stake * OUTCOME_SPACE - chosen.prize * chosen.chance))} METH`,
      ],
    ]),
    h(
      'details',
      { className: 'raw-details' },
      h('summary', null, 'Every bet it could draw'),
      h(
        'ol',
        { className: 'bet-step-list' },
        ...offered.lines.map((text, i) => h('li', { className: BigInt(i) === step.branch ? 'drawn' : '' }, text)),
      ),
      ...(step.table.bankroll === undefined
        ? []
        : [
            h(
              'p',
              { className: 'bet-detail-note' },
              `Each bet is as sound for the casino as the whole table at the bankroll its quote named, ${formatAmount(step.table.bankroll)} METH, which the split is weighed against.`,
            ),
          ]),
    ),
  );
  return section;
}
/**
 * One of this wallet's own bets, whole: for a casino bet, its chance drawn across the outcome space, where its round
 * landed in that space, and the seed and secret that fixed it; for a developer bet, what it was and how its developer
 * settled it. Every derived figure is worked out here from the receipt's own preimages, so it is checked in front of
 * the player rather than repeated back from what the casino said.
 */
export function betDetail(row: BetRow, onGame?: (row: BetRow) => void) {
  const net = row.payout - row.stake,
    receipt: Partial<Receipt> = row.receipt ?? {},
    step = receipt.proof?.step,
    // The checkpoint the bet follows names its channel and its place.
    base = receipt.proof?.base,
    op: Operation | undefined = step?.operation,
    developerBet = receipt.kind === 'developer-bet',
    // A casino bet keeps its chance, its prize, its round and the hash of its seed in its operation, and the seed and
    // secret that settled it in its step.
    revealed =
      op && step && !developerBet
        ? {
            chance: op.chance,
            prize: op.prize,
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
    drawn = drawnStep(receipt, paid),
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
      edgeFigure(rowEdge(row), true),
    ),
  );

  if (drawn) body.append(offeredSection(drawn));
  const round: string | undefined = receipt.details?.round,
    secret: string | undefined = receipt.settlement?.secret;
  if (developerBet && round) {
    // The round the bet rode on was fixed before the player signed it: its developer revealed the secret behind it when
    // it settled. What the secret means is the game's own rules.
    const fixed = detailSection(
      'Fixed before you bet',
      'Your bet named the hash of a secret the game’s developer had already chosen, so what it rode on was fixed before you signed. ' +
        'The game’s rules say how the secret makes its result.',
    );
    fixed.append(
      factList([
        ['The round you bet on', hex(round)],
        secret
          ? [
              'The secret its settlement revealed, which hashes to it',
              rederived(
                secret,
                same(roundId(secret), round),
                'keccak256 of the secret, against the round your bet named',
              ),
            ]
          : ['The secret', 'Revealed when the developer settles the bet'],
      ]),
    );
    body.append(fixed);
  }
  if (developerBet && receipt.settlement) {
    // A developer bet is settled by its game's server, from the game's bank, on its developer's word.
    const server = receipt.settlement.server?.message.server;
    const settled = detailSection(
      'How it settled',
      'The game’s server signed what this bet paid you and what it gave the casino, from the game’s bank, with the developer’s key or one the developer signed for it. Your wallet checked both before it collected.',
    );
    settled.append(
      factList([
        [
          'Developer',
          row.publisher
            ? h('span', null, `${row.publisher} · `, hex(receipt.game?.developer))
            : hex(receipt.game?.developer),
        ],
        server && ['Server key the developer named', hex(server)],
        ['The bet you signed', hex(JSON.stringify(receipt.details?.meta))],
        ['Paid to you', `${exact(receipt.settlement.player)} METH`],
        ['Given to the casino', `${exact(receipt.settlement.casino)} METH`],
        ['The server’s signature', hex(receipt.settlement.signature)],
      ]),
    );
    body.append(settled);
  }
  // A developer bet has no odds and no round.
  if (!developerBet && (!revealed || landed === null)) {
    body.append(
      h(
        'p',
        { className: 'bet-detail-note' },
        receipt.kind === 'payment'
          ? `A payment to the house out of what its round held, as the game's rules take it${receipt.details?.kept === undefined ? '' : `: the round kept ${exact(receipt.details.kept)} METH`}. It has no odds and no round.`
          : receipt.status === 'kept'
            ? `No bet: your wallet's draw kept the ${exact(receipt.details!.table!.cash)} METH the step held, with nothing signed and nothing at risk.`
            : 'This receipt keeps no revealed round, so there is nothing to draw: only the amounts above are known.',
      ),
    );
  } else if (revealed && landed !== null) {
    const won = landed < revealed.chance,
      rolled = roll(landed, revealed.chance);
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
      h('div', { className: 'bet-space-scale' }, h('span', null, '0'), h('span', null, '100')),
      h(
        'p',
        { className: 'bet-detail-note' },
        `Rolled ${rolled.rolled}: ` +
          (won
            ? `under ${rolled.under}, so it pays its prize, ${exact(revealed.prize)} METH.`
            : `not under ${rolled.under}, so it pays nothing of the ${exact(revealed.prize)} METH it could have.`) +
          ' The roll is the round’s outcome as a share of 2⁶⁴, on a scale of 0 to 100.',
      ),
    );
    body.append(where);

    // A bet drawn from a step shows its terms with how the wallet drew it.
    if (!drawn) {
      const terms = detailSection(
        'The bet you signed',
        'It pays its prize when the round’s outcome falls below its chance, counted in outcomes out of 2⁶⁴.',
      );
      terms.append(
        factList([
          ['Prize', `${exact(revealed.prize)} METH`],
          ['Chance', `Wins under ${rolled.under} · ${revealed.chance} of 2⁶⁴ outcomes`],
          [
            'House edge',
            `${percent(share(op!.amount * OUTCOME_SPACE - revealed.prize * revealed.chance, op!.amount * OUTCOME_SPACE)!)} of the stake: ` +
              'what it stakes, less its prize times its chance',
          ],
        ]),
      );
      body.append(terms);
    }
  }

  if (drawn) body.append(stepSection(drawn));

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
              receipt.payout === undefined || paid === receipt.payout,
              'The outcome the bet was read against, and what it pays on it',
            ),
          ],
        ]),
        checkYourself(receipt, revealed, drawn),
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
        ['Sequence', base ? String(base.sequence + 1n) : '—'],
        ['Game', receipt.game?.name ?? '—'],
        ['Game ID', hex(receipt.details?.game)],
        ['Memo, the hash of the details above', hex(op.memo)],
        ['Expected payout, out of 2⁶⁴ stakes', hex(receipt.expectedPayout)],
        receipt.balance !== undefined && ['Balance after it settled', `${exact(receipt.balance)} METH`],
        receipt.commission !== undefined && receipt.commission > 0n
          ? [
              'The game’s commission',
              h('span', { title: `${exact(receipt.commission)} METH` }, `${formatAmount(receipt.commission)} METH`),
            ]
          : null,
        ['The state it moved from', hex(op.previousStateHash)],
        ['Your signature on it', hex(step.authorization)],
        ['The casino’s signature on it', hex(step.casinoSignature)],
      ]),
    );
    record.append(
      h(
        'details',
        { className: 'raw-details' },
        h('summary', null, 'The whole receipt, as JSON'),
        ...copyBlock(activityJSON(receipt), 'the whole receipt'),
      ),
    );
    body.append(record);
  }

  if (receipt.status === 'kept') body.append(checkYourself(receipt, null, drawn));
  if (onGame && row.gameId)
    body.append(
      h(
        'button',
        { type: 'button', className: 'button small bet-detail-more', onclick: () => onGame(row) },
        'Every bet in this game ↗',
      ),
    );
  return body;
}
