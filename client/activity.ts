import { formatEther } from 'ethers';
import type { PlayerBet } from '../protocol/types.ts';
import { plain } from '../protocol/protocol.ts';
import { returnParts } from '../protocol/risk.ts';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';
interface ActivityEntry {
  title: string;
  timestamp: string;
  status?: string;
  tone?: Tone;
  description?: string;
  amount?: string;
  amountLabel?: string;
  payload?: string;
  facts?: [string, string | Node][];
  notice?: string;
  compact?: boolean;
  /** Timing shown beside the clock, such as latency or the gap since the previous event. */
  meta?: string;
}

export function activityJSON(data: unknown, limit = Infinity): string {
  let text: string;
  try {
    text = JSON.stringify(plain(data), null, 2);
  } catch {
    return '[Payload could not be displayed as JSON.]';
  }
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Payload truncated at ${limit.toLocaleString('en-US')} characters.]`
    : text;
}

const element = (tag: string, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Shared presentation only: receipts and live events keep their existing owners. */
export function createActivityEntry(entry: ActivityEntry) {
  const expandable = entry.payload !== undefined;
  const row = document.createElement(expandable ? 'details' : 'div');
  row.className = `activity-entry tone-${entry.tone || 'neutral'}${entry.compact ? ' compact-entry' : ''}`;
  const summary = element(expandable ? 'summary' : 'div', 'activity-summary');
  const content = element('div', 'activity-content');
  const heading = element('div', 'activity-title-line');
  heading.append(element('span', 'activity-title', entry.title));
  if (entry.status) heading.append(element('span', 'activity-badge', entry.status));
  content.append(heading);
  if (entry.description) content.append(element('p', 'activity-description', entry.description));
  const date = new Date(entry.timestamp),
    time = document.createElement('time');
  time.className = 'activity-time';
  if (!Number.isNaN(date.getTime())) {
    time.dateTime = date.toISOString();
    time.title = time.dateTime;
    const clock = date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    time.textContent = entry.compact
      ? `${clock}.${String(date.getMilliseconds()).padStart(3, '0')}`
      : `${date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${clock}`;
  } else time.textContent = 'Time unavailable';
  content.append(time);
  if (entry.meta) time.after(element('span', 'activity-meta', entry.meta));
  summary.append(content);
  if (entry.amount !== undefined) {
    const amount = element('div', 'activity-amount');
    amount.append(
      element('span', 'activity-value', entry.amount),
      element('span', 'activity-amount-label', entry.amountLabel),
    );
    summary.append(amount);
  }
  row.append(summary);
  if (expandable) {
    const body = element('div', 'activity-body');
    if (entry.notice) body.append(element('p', 'activity-notice', entry.notice));
    if (entry.facts?.length) {
      const facts = document.createElement('dl');
      facts.className = 'activity-facts';
      for (const [label, value] of entry.facts) {
        const term = document.createElement('dt'),
          detail = document.createElement('dd');
        term.textContent = label;
        detail.append(value);
        facts.append(term, detail);
      }
      body.append(facts);
    }
    const toolbar = element('div', 'activity-payload-heading');
    const truncated = entry.payload!.endsWith('characters.]');
    toolbar.append(element('span', '', truncated ? 'Payload preview · truncated' : 'Raw JSON'));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button';
    const copyLabel = truncated ? 'Copy shown text' : 'Copy JSON';
    copy.textContent = copyLabel;
    copy.setAttribute('aria-label', `${copyLabel}: ${entry.title}`);
    const feedback = element('span', 'activity-copy-status');
    feedback.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.payload!);
        feedback.textContent = 'Copied';
      } catch {
        feedback.textContent = 'Copy unavailable. Select the text below.';
      }
    });
    toolbar.append(feedback, copy);
    const payload = element('pre', 'activity-payload', entry.payload);
    payload.tabIndex = 0;
    payload.setAttribute('aria-label', `JSON details: ${entry.title}`);
    body.append(toolbar, payload);
    row.append(body);
  }
  return row;
}

export function filterActivity(list: HTMLElement, query: string, empty: HTMLElement, count: HTMLElement) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const row of list.children) {
    const text = terms.length ? row.textContent!.toLowerCase() : '';
    // A caller's own category filter marks rows `filtered`; the search never un-hides them.
    const matches = !row.classList.contains('filtered') && terms.every(term => text.includes(term));
    row.classList.toggle('hidden', !matches);
    if (matches) visible++;
  }
  const total = terms.length ? list.childElementCount : visible;
  count.textContent = `${terms.length ? `${visible} / ` : ''}${total} ${total === 1 ? 'event' : 'events'}`;
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? 'No matching events. Try a method, amount, operation ID or transaction hash.'
    : 'No activity yet. Events will appear here as you use the wallet and games.';
}

/** The exact return of a signed bet, from its expected payout out of 2^64 stakes, to a hundredth of a basis point. */
export function returnToPlayer(stake: unknown, expectedPayout: unknown) {
  const parts = returnParts(BigInt(stake as string), BigInt(expectedPayout as string));
  return `RTP ${parts / 10000n}.${String(parts % 10000n).padStart(4, '0')}%`;
}
/** What a bet that settles later asks of the player, said as plainly as the docs say it. */
const HELD =
  'The casino holds its stake until it settles, and what it pays is owed to you, collected by your wallet: like winnings, it is the casino’s promise until then.';
/** Whose word a bet that settles later is: with prizes, a draw's; with terms, its referee's. */
const trust = (bet: { prizes?: unknown } | undefined) =>
  bet?.prizes
    ? 'Its referee draws it against the casino’s bankroll, on a round the casino named and the referee committed its seed to before you bet: its outcome was fixed before your bet, and nobody can change it. Neither sees it alone before the draw; together they could, and turn the bet away, which its receipt would show. The referee chooses when to draw, not what it pays. Undrawn by its deadline, the stake comes back.'
    : 'Its referee signs what it pays: that is the game developer’s word, and what it wins beyond its stake is theirs to pay. Unsettled by its deadline, the stake comes back.';
/** A receipt is in the asset of the channel that signed it; an on-chain transaction is always ETH. */
export const receiptUnit = (receipt: { asset?: string }) => (receipt.asset === 'test' ? 'TEST' : 'ETH');
/** A bet can have settled while what it paid still waits to enter the channel balance. */
export function heldSummary(bet: PlayerBet) {
  const settled = bet.status === 'settled',
    amount = settled ? (bet.payout ?? '0') : bet.stake;
  return {
    title: bet.game.name,
    status: !settled
      ? 'Waiting for result'
      : bet.payout === '0'
        ? 'Settled · no payout'
        : bet.collected
          ? bet.refunded
            ? 'Refund collected'
            : 'Payout collected'
          : bet.refunded
            ? 'Refund ready'
            : 'Payout ready',
    amount: `${formatEther(amount)} ${receiptUnit(bet)}`,
    amountLabel: !settled
      ? 'Stake held'
      : bet.payout === '0'
        ? 'Payout'
        : bet.collected
          ? 'Collected'
          : 'Awaiting collection',
    description: !settled
      ? `Refunded if unsettled by ${new Date(bet.deadline).toLocaleString()}.`
      : bet.refunded
        ? 'Its stake came back.'
        : 'The bet has settled.',
    tone: (!settled ? 'neutral' : bet.payout === '0' ? 'neutral' : bet.collected ? 'positive' : 'warning') as Tone,
  };
}
export function receiptSummary(
  receipt: any,
): Pick<ActivityEntry, 'title' | 'status' | 'tone' | 'amount' | 'amountLabel' | 'description' | 'notice'> {
  const unit = receiptUnit(receipt);
  if (receipt.status === 'rejected')
    return {
      title: receipt.kind === 'invest' ? 'Investment declined' : 'Bet rejected',
      status: receipt.kind === 'invest' ? 'No shares bought' : 'No wager placed',
      tone: receipt.lost ? 'warning' : 'neutral',
      amount: `0 ${unit}`,
      amountLabel: 'Balance change',
      description: ['invest', 'wager'].includes(receipt.kind)
        ? 'Your balance is unchanged.'
        : receipt.lost
          ? 'Your balance is unchanged. The casino says it has no record of this round, so it could not reveal it: what this wager would have paid cannot be checked.'
          : receipt.wouldHavePaid === undefined
            ? 'Your balance is unchanged. You can place another bet.'
            : `Your balance is unchanged. The casino revealed the round: this wager would have paid ${formatEther(receipt.wouldHavePaid)} ${unit} for its ${formatEther(receipt.request?.amount ?? 0)} ${unit} stake.`,
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
  // A bet's stake was paid to enter; its result is what it paid against that stake. A bet that settles
  // later has a result once its payout is collected.
  const played = receipt.kind === 'bet' || (receipt.kind === 'wager' && receipt.payout !== undefined),
    net = played ? BigInt(receipt.payout ?? 0) - BigInt(receipt.stake ?? 0) : 0n;
  const title =
    receipt.kind === 'wager' && !played
      ? 'Bet placed'
      : played
        ? net > 0n
          ? 'Bet won'
          : net < 0n
            ? 'Bet lost'
            : 'Bet returned'
        : (
            {
              deposit: 'Channel funded',
              withdrawal: 'Claim collected',
              closure: 'Channel closed',
              dispute: 'Channel dispute',
              payment: 'Game payment',
              payout: 'Bet payout',
              bank: 'Put into your bank',
              withdrawn: 'Taken from your bank',
              invest: 'Invested in the bankroll',
              redeem: 'Shares redeemed',
              divest: 'Bankroll payout',
              earnings: 'Developer earnings',
              faucet: 'Test coins claimed',
              transaction: 'Transaction',
            } as Record<string, string>
          )[receipt.kind] || receipt.kind;
  let amount = `${formatEther(settled ? receipt.amount || '0' : '0')} ${unit}`;
  let amountLabel = !settled
    ? 'No confirmed payment'
    : receipt.kind === 'deposit'
      ? 'Deposited'
      : ['withdrawal', 'divest', 'earnings', 'faucet', 'payout', 'withdrawn'].includes(receipt.kind)
        ? 'Received'
        : receipt.kind === 'invest'
          ? 'Invested'
          : receipt.kind === 'redeem'
            ? 'Owed to you'
            : ['payment', 'wager', 'bank'].includes(receipt.kind)
              ? 'Sent'
              : receipt.kind === 'closure'
                ? 'Claim recorded'
                : `${unit} received`;
  let tone: Tone = !settled ? (['reverted', 'replaced'].includes(receipt.status) ? 'negative' : 'warning') : 'neutral';
  let description = '';
  if (played) {
    amount = settled ? `${net < 0n ? '−' : '+'}${formatEther(net < 0n ? -net : net)} ${unit}` : '—';
    amountLabel = settled ? 'Net game result' : 'Unconfirmed result';
    if (settled) tone = net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral';
    description = `Stake ${formatEther(receipt.stake)} ${unit} · Paid ${formatEther(receipt.payout ?? 0)} ${unit}${
      receipt.maxPayout === undefined
        ? ''
        : ` of up to ${formatEther(receipt.maxPayout)} ${unit} · ${returnToPlayer(receipt.stake, receipt.expectedPayout)}`
    }${receipt.kind === 'bet' ? ` · Balance ${formatEther(receipt.balance)} ${unit}` : ''}`;
  } else if (
    settled &&
    ['withdrawal', 'divest', 'earnings', 'faucet', 'payout', 'withdrawn'].includes(receipt.kind) &&
    BigInt(receipt.amount || 0) > 0n
  )
    tone = 'positive';
  if (receipt.kind === 'invest')
    description = `Bought ${formatEther(receipt.shares)} shares; you hold ${formatEther(receipt.holding)}. The casino signed a statement of your holding. Shares are its promise of a part of the bankroll, not protected money. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'redeem')
    description = `Sold ${formatEther(receipt.shares)} shares; you hold ${formatEther(receipt.holding)}. Your wallet collects the money into your open channel.`;
  if (receipt.kind === 'divest')
    description = `Paid for redeemed bankroll shares. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'payment')
    description = `An extra wager this game charged, paid into the casino's bankroll. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'wager') {
    status = !played
      ? 'Waiting for result'
      : receipt.reason
        ? 'Refund collected'
        : BigInt(receipt.payout)
          ? 'Payout collected'
          : 'Settled · no payout';
    if (!played)
      description = `Placed; it settles later. ${HELD} ${trust(receipt.details?.bet)} Balance ${formatEther(receipt.balance)} ${unit}`;
    else if (receipt.reason)
      description = `${receipt.reason}${
        receipt.wouldHavePaid === undefined
          ? ''
          : `: it would have paid ${formatEther(receipt.wouldHavePaid)} ${unit}, the draw on record beside it`
      }. ${description}`;
  }
  if (receipt.kind === 'payout')
    description = `What a bet that settled later paid, checked by your wallet and collected into this channel. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'bank')
    description = `Your bank pays what your referee's splits owe beyond their stakes, and keeps what they do not pay. The casino signed a statement of it. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'withdrawn')
    description = `Taken from your bank and collected into this channel. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'faucet')
    description = `The casino's faucet paid this channel. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'earnings')
    description = `Commission your games earned, collected into this channel. Balance ${formatEther(receipt.balance)} ${unit}`;
  const notice =
    receipt.status === 'orphaned'
      ? 'This transaction is no longer confirmed. Refresh to check for re-inclusion, or use the saved transaction details to retry from your funding wallet.'
      : receipt.kind === 'closure'
        ? 'Closing records a withdrawal claim. Collect available funds separately; unpaid winnings remain claimable.'
        : undefined;
  return { title, status, tone, amount, amountLabel, description, notice };
}
