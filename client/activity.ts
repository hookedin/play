import type { PlayerDeveloperBet } from '../protocol/types.ts';
import { plain, same } from '../protocol/protocol.ts';
import { returnParts } from '../protocol/risk.ts';
import { formatAmount } from '../sdk/src/wire.ts';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';
/** Activity's filters beside All: the value of each one's button. */
type Filter = 'bets' | 'deposits' | 'withdrawals';
interface ActivityEntry {
  title: string;
  /** Which of Activity's filters shows it, beside All. */
  filter?: Filter;
  timestamp: string;
  status?: string;
  tone?: Tone;
  description?: string;
  amount?: string;
  amountLabel?: string;
  payload: string;
  facts?: [string, string | Node][];
  notice?: string;
}

export function activityJSON(data: unknown): string {
  try {
    return JSON.stringify(plain(data), null, 2);
  } catch {
    return '[Payload could not be displayed as JSON.]';
  }
}

/** An element with its properties, `onclick` among them, and its children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> | null = null,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
/** A moment, to the second, or with `short` to the minute and without its year. */
export function timeOf(at: string | number, className: string, short = false) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return h('time', { className }, '—');
  const iso = date.toISOString(),
    day = date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }) }),
    clock = date.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      ...(short ? {} : { second: '2-digit' }),
    });
  return h('time', { className, dateTime: iso, title: iso }, `${day} · ${clock}`);
}
/** A share in millionths, as a percentage with four decimals. */
export const percent = (parts: bigint) => `${parts / 10000n}.${String(parts % 10000n).padStart(4, '0')}%`;
/** Every digit of an amount in METH, thousands grouped. A list shows `formatAmount`'s, cut off at a gwei; a bet or an
 * event opened in full has this one. */
export const exact = (value: bigint | string | number) => formatAmount(value, 12);
/** A gain or a loss in METH, with its sign, as a list shows it. */
export const signedAmount = (value: bigint) =>
  `${value < 0n ? '−' : '+'}${formatAmount(value < 0n ? -value : value)} METH`;
/** Text to copy as the wallet shows it, JSON unless said: a Copy button with its status, above the text. */
export function copyBlock(text: string, title: string, what = 'JSON') {
  const status = h('span', { className: 'activity-copy-status', role: 'status' });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied';
    } catch {
      status.textContent = 'Copy unavailable. Select the text below.';
    }
  };
  return [
    h(
      'div',
      { className: 'activity-payload-heading' },
      status,
      h(
        'button',
        { type: 'button', className: 'text-button', ariaLabel: `Copy ${what}: ${title}`, onclick: copy },
        `Copy ${what}`,
      ),
    ),
    h('pre', { className: 'activity-payload', tabIndex: 0, ariaLabel: `${what}: ${title}` }, text),
  ];
}

/** One line of Activity: its summary, and opened, its facts and the JSON behind it. */
export function createActivityEntry(entry: ActivityEntry) {
  const heading = h(
    'div',
    { className: 'activity-title-line' },
    h('span', { className: 'activity-title' }, entry.title),
  );
  if (entry.status) heading.append(h('span', { className: 'activity-badge' }, entry.status));
  const content = h('div', { className: 'activity-content' }, heading);
  if (entry.description) content.append(h('p', { className: 'activity-description' }, entry.description));
  content.append(timeOf(entry.timestamp, 'activity-time'));
  const summary = h('summary', { className: 'activity-summary' }, content);
  if (entry.amount !== undefined)
    summary.append(
      h(
        'div',
        { className: 'activity-amount' },
        h('span', { className: 'activity-value' }, entry.amount),
        h('span', { className: 'activity-amount-label' }, entry.amountLabel ?? ''),
      ),
    );
  const body = h('div', { className: 'activity-body' });
  if (entry.notice) body.append(h('p', { className: 'activity-notice' }, entry.notice));
  if (entry.facts?.length)
    body.append(
      h(
        'dl',
        { className: 'activity-facts' },
        ...entry.facts.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, value)]),
      ),
    );
  body.append(...copyBlock(entry.payload, entry.title));
  const node = h('details', { className: `activity-entry tone-${entry.tone || 'neutral'}` }, summary, body);
  if (entry.filter) node.dataset.filter = entry.filter;
  return node;
}

/** What a developer bet asks of the player, said as plainly as the docs say it. */
const DEVELOPER_BET =
  'Its stake went to the game’s developer when you placed it, and the developer settles it: what it pays is their word, and you trust them to pay it. Your wallet collects what they pay.';
/** A developer bet can have settled while what it was paid still waits to enter the channel balance. Its game goes by
 * the name its receipt kept, when this wallet has the receipt. */
export function developerBetSummary(bet: PlayerDeveloperBet, name = 'A developer bet') {
  const settled = bet.status === 'settled',
    amount = settled ? (bet.payout ?? '0') : bet.stake;
  return {
    title: name,
    status: !settled
      ? 'Waiting for the developer'
      : bet.payout === '0'
        ? 'Settled · no payout'
        : bet.collected
          ? 'Payout collected'
          : 'Payout ready',
    amount: `${formatAmount(amount)} METH`,
    amountLabel: !settled
      ? 'Stake with the developer'
      : bet.payout === '0'
        ? 'Payout'
        : bet.collected
          ? 'Collected'
          : 'Awaiting collection',
    description: !settled ? 'Its developer settles it when they choose.' : 'Its developer has settled it.',
    tone: (!settled ? 'neutral' : bet.payout === '0' ? 'neutral' : bet.collected ? 'positive' : 'warning') as Tone,
  };
}
const balanceOf = (receipt: any) => `Balance ${exact(receipt.balance)} METH`;
/** Each kind of receipt as Activity shows it: its title, the label under its amount once settled, what it is called
 * declined, whether it brings money in (`incoming`, positive once settled with an amount), what it says, and a notice.
 * A bet's result and a withdrawal or lock-in still on its way are worked out in `receiptSummary`. */
const KINDS: Record<
  string,
  {
    title: string;
    label?: string;
    declined?: string;
    incoming?: boolean;
    describe?: (receipt: any) => string;
    notice?: string;
    filter?: Filter;
  }
> = {
  'casino-bet': { title: 'Casino bet', declined: 'Casino bet rejected', filter: 'bets' },
  'developer-bet': {
    title: 'Developer bet placed',
    filter: 'bets',
    label: 'Sent',
    declined: 'Developer bet rejected',
    describe: r => `Placed with the game’s developer. ${DEVELOPER_BET} ${balanceOf(r)}`,
  },
  payment: {
    title: 'Game payment',
    filter: 'bets',
    label: 'Sent',
    declined: 'Payment rejected',
    describe: r =>
      `${r.details?.group ? "Part of one of this game's rounds, paid into the casino's bankroll: Bets shows the round together." : "A payment this game charged, paid into the casino's bankroll."} ${balanceOf(r)}`,
  },
  invest: {
    title: 'Invested in the bankroll',
    label: 'Invested',
    declined: 'Investment declined',
    describe: r =>
      `Bought ${exact(r.shares)} shares; you hold ${exact(r.holding)}. The casino signed a statement of your holding. Shares are its promise of a part of the bankroll, not protected money. ${balanceOf(r)}`,
  },
  bank: {
    title: 'Put into a game’s bank',
    label: 'Sent',
    declined: 'Bank deposit declined',
    describe: r =>
      `Into the bank of ${r.name ?? 'your game'}, which takes half the commission of its casino bets and the stakes of its developer bets, and pays their settlements and its own casino bets. The casino signed a statement of it. ${balanceOf(r)}`,
  },
  withdrawal: {
    title: 'Withdrawn',
    label: 'Paid out',
    declined: 'Withdrawal declined',
    incoming: true,
    filter: 'withdrawals',
  },
  transfer: {
    title: 'Transferred',
    label: 'Sent',
    declined: 'Transfer declined',
    describe: r =>
      `To ${r.name ?? r.details?.counterparty}, off-chain: their wallet collects it into their balance, and nothing about it goes on-chain. ${balanceOf(r)}`,
  },
  'lock-in': { title: 'Balance locked in', declined: 'Lock-in declined', filter: 'withdrawals' },
  'deposit-fee': {
    title: 'Network fee paid',
    label: 'Received',
    incoming: true,
    filter: 'deposits',
    describe: r =>
      `The network fee your deposit ${r.details?.id ?? ''} kept back, which the casino paid into your balance. ${balanceOf(r)}`,
  },
  received: {
    title: 'Received at your address',
    filter: 'deposits',
    describe: () =>
      'ETH sent to your deposit address, as your wallet found it there. It goes into your balance by itself unless that is off in Settings.',
  },
  deposit: { title: 'Deposited', label: 'Deposited', filter: 'deposits' },
  'taken-in': {
    title: 'Added to your balance',
    label: 'Added',
    filter: 'deposits',
    describe: r =>
      `What was deposited into your channel, signed into your balance once the casino had seen it confirmed: from your address, a lock-in or anyone's deposit. ${balanceOf(r)}`,
  },
  collateral: {
    title: 'Collateral bought',
    label: 'Sent',
    describe: r =>
      r.collateral
        ? `${exact(r.collateral)} METH of the casino's cash locked into your balance: it pays your winnings before the bankroll does, and the casino cannot take it back until your balance closes.`
        : '',
  },
  'transfer-in': {
    title: 'Transfer received',
    label: 'Received',
    incoming: true,
    describe: r =>
      `From ${r.name ?? r.details?.counterparty}, collected into your balance. Beyond your own deposits, your balance is paid out of the casino's bankroll, as winnings are. ${balanceOf(r)}`,
  },
  'close-started': {
    title: 'Close started',
    label: 'No payment',
    filter: 'withdrawals',
    notice: 'A close without the casino can be challenged for 7 days. Then finish it under Settings → Recovery.',
  },
  'bet-disputed': {
    title: 'Bet disputed',
    label: 'No payment',
    filter: 'withdrawals',
    notice:
      'The casino has 7 days to settle the disputed bet on-chain; if it does not, the bet counts as won. Then finish the close under Settings → Recovery.',
  },
  closure: {
    title: 'Balance closed',
    label: 'Claim recorded',
    filter: 'withdrawals',
    notice:
      'A close without the casino records what the balance is owed. Collect it under Wallet → Waiting to be paid.',
  },
  dispute: { title: 'Close challenged', label: 'No payment', filter: 'withdrawals' },
  'developer-bet-payout': {
    title: 'Developer bet payout',
    label: 'Received',
    incoming: true,
    filter: 'bets',
    describe: r =>
      `What a developer bet’s developer paid, checked by your wallet and collected into your balance. ${balanceOf(r)}`,
  },
  withdrawn: {
    title: 'Taken from a game’s bank',
    label: 'Received',
    incoming: true,
    describe: r => `Taken from the bank of ${r.name ?? 'your game'} and collected into your balance. ${balanceOf(r)}`,
  },
  redeem: {
    title: 'Shares redeemed',
    label: 'Owed to you',
    describe: r =>
      `Sold ${exact(r.shares)} shares; you hold ${exact(r.holding)}. Your wallet collects the money into your balance.`,
  },
  divest: {
    title: 'Bankroll payout',
    label: 'Received',
    incoming: true,
    describe: r => `Paid for redeemed bankroll shares. ${balanceOf(r)}`,
  },
  transaction: { title: 'Transaction' },
};
/** A receipt as Activity shows it. `contract` is the deployment's: a withdrawal or a claim paid to it goes into the
 * account's own channel as deposits. */
export function receiptSummary(
  receipt: any,
  contract: string,
): Pick<ActivityEntry, 'title' | 'status' | 'tone' | 'amount' | 'amountLabel' | 'description' | 'notice' | 'filter'> {
  const kind = KINDS[receipt.kind];
  if (receipt.status === 'rejected')
    return {
      title: kind?.declined ?? receipt.kind,
      filter: kind?.filter,
      status: receipt.kind === 'invest' ? 'No shares bought' : 'Nothing paid',
      tone: 'neutral',
      amount: `0 METH`,
      amountLabel: 'Balance change',
      description: `Your balance is unchanged.${['casino-bet', 'payment'].includes(receipt.kind) ? ' You can place another bet.' : ''}`,
      notice: receipt.reason,
    };
  const settled = ['signed', 'confirmed'].includes(receipt.status);
  let status =
    (
      {
        signed: 'Signed off-chain',
        confirmed: 'Confirmed on-chain',
        reverted: 'Reverted',
        replaced: 'Replaced',
        orphaned: 'Unconfirmed · reorg',
      } as Record<string, string>
    )[receipt.status] || 'Unconfirmed';
  // A bet's stake was paid to enter; its result is what it paid against that stake. A developer bet has a result
  // once what its developer paid is collected.
  const played = receipt.kind === 'casino-bet' || (receipt.kind === 'developer-bet' && receipt.payout !== undefined),
    net = played ? BigInt(receipt.payout ?? 0) - BigInt(receipt.stake ?? 0) : 0n,
    bet = receipt.kind === 'developer-bet' ? 'Developer bet' : 'Casino bet';
  const title = played
    ? net > 0n
      ? `${bet} won`
      : net < 0n
        ? `${bet} lost`
        : `${bet} broke even`
    : receipt.withdrawal && receipt.returned
      ? 'Withdrawal returned'
      : receipt.withdrawal && !receipt.paid
        ? receipt.kind === 'lock-in'
          ? 'Locking in'
          : 'Withdrawal on its way'
        : (kind?.title ?? receipt.kind);
  let amount = `${formatAmount(settled ? receipt.amount || '0' : '0')} METH`;
  let amountLabel = !settled ? 'No confirmed payment' : (kind?.label ?? 'ETH received');
  let tone: Tone = !settled
    ? ['reverted', 'replaced'].includes(receipt.status)
      ? 'negative'
      : 'warning'
    : kind?.incoming && BigInt(receipt.amount || 0) > 0n
      ? 'positive'
      : 'neutral';
  let description = kind?.describe?.(receipt) ?? '';
  if (played) {
    amount = settled ? signedAmount(net) : '—';
    amountLabel = settled ? 'Net game result' : 'Unconfirmed result';
    if (settled) tone = net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral';
    description = `Stake ${formatAmount(receipt.stake)} METH · Paid ${formatAmount(receipt.payout ?? 0)} METH${
      receipt.maxPayout === undefined
        ? ''
        : ` of up to ${formatAmount(receipt.maxPayout)} METH · RTP ${percent(returnParts(BigInt(receipt.stake), BigInt(receipt.expectedPayout)))}`
    }${receipt.kind === 'casino-bet' ? ` · Balance ${exact(receipt.balance)} METH` : ''}`;
  }
  if (receipt.kind === 'developer-bet')
    status =
      receipt.payout === undefined
        ? 'Waiting for the developer'
        : BigInt(receipt.payout)
          ? 'Payout collected'
          : 'Settled · no payout';
  // The contract makes a withdrawal or a lock-in a claim under its ID once the casino, or anyone, sends it, and pays what
  // it can at once; anyone can see how it stands. One that pays the contract, as a lock-in does, goes into the account's
  // own channel.
  if (receipt.withdrawal) {
    const into = same(receipt.to, contract),
      fee = BigInt(receipt.fee ?? 0);
    status = receipt.paid
      ? into
        ? 'In as deposits'
        : 'Paid on-chain'
      : receipt.returned
        ? 'Returned with the close'
        : receipt.recorded
          ? 'Part waits for the bankroll'
          : 'Being sent';
    tone = receipt.paid ? 'positive' : receipt.returned ? 'neutral' : 'warning';
    amountLabel = receipt.paid ? (into ? 'Locked in' : 'Paid out') : receipt.returned ? 'In the claim' : 'To be paid';
    description = [
      `${receipt.kind === 'lock-in' ? 'All of your balance' : 'From your balance'} ${
        into ? 'into your own channel, as deposits the contract holds' : `to ${receipt.to}`
      }.`,
      fee ? `Your balance paid the casino ${exact(fee)} METH for sending it.` : '',
      receipt.paid
        ? into
          ? 'The contract has put it in, and your balance takes it in as a deposit.'
          : 'The contract has paid it.'
        : receipt.returned
          ? 'It never became a claim, so the close returned it: it is part of what your closed balance is owed, under Waiting to be paid.'
          : receipt.recorded
            ? `The contract still owes ${exact(receipt.owed)} METH of it, paid as the bankroll has the cash: collect it under Waiting to be paid.`
            : 'The contract makes it a claim under its ID and pays it, out of your deposits first and the bankroll for the rest, once the casino, or anyone, sends it.',
      `Balance ${exact(receipt.balance)} METH`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  const notice =
    receipt.status === 'orphaned'
      ? 'This transaction is no longer confirmed. Refresh to check for re-inclusion, or retry it from your deposit address with the saved transaction details.'
      : kind?.notice;
  return { title, status, tone, amount, amountLabel, description, notice, filter: kind?.filter };
}
