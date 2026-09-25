import { formatEther } from 'ethers';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import { plain } from '../protocol/protocol.ts';
import { returnParts } from '../protocol/risk.ts';
import { developerBetStatus } from './game-account.ts';

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
/** What a developer bet asks of the player, said as plainly as the docs say it. */
const DEVELOPER_BET =
  'Its stake went to the game’s developer when you placed it, and the developer settles it: you trust the developer to pay. Your wallet collects what they pay.';
/** What a developer bet is owed: with prizes, what the round's outcome says, which the wallet checks; with terms, the
 * developer's word. */
const trust = (developerBet: { prizes?: unknown } | undefined) =>
  developerBet?.prizes
    ? 'It is provably fair: its outcome was fixed before you bet, by a round the casino named and a seed the developer committed to. It is owed what its prizes pay on that outcome if the developer’s casino bet on the round covers it, and its stake back if not. Your wallet checks what the developer pays and shows any shortfall.'
    : 'Its game’s developer says what it pays: that is their word.';
/** A receipt is in the asset of the channel that signed it; an on-chain transaction is always ETH. */
export const receiptUnit = (receipt: { asset?: string }) => (receipt.asset === 'test' ? 'TEST' : 'ETH');
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
    amount: `${formatEther(amount)} ${receiptUnit(bet)}`,
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
export function receiptSummary(
  receipt: any,
): Pick<ActivityEntry, 'title' | 'status' | 'tone' | 'amount' | 'amountLabel' | 'description' | 'notice'> {
  const unit = receiptUnit(receipt);
  if (receipt.status === 'rejected')
    return {
      title:
        receipt.kind === 'invest'
          ? 'Investment declined'
          : receipt.kind === 'developer-bet'
            ? 'Developer bet rejected'
            : receipt.kind === 'casino-bet'
              ? 'Casino bet rejected'
              : 'Payment rejected',
      status: receipt.kind === 'invest' ? 'No shares bought' : 'Nothing paid',
      tone: receipt.lost ? 'warning' : 'neutral',
      amount: `0 ${unit}`,
      amountLabel: 'Balance change',
      description: ['invest', 'developer-bet'].includes(receipt.kind)
        ? 'Your balance is unchanged.'
        : receipt.lost
          ? 'Your balance is unchanged. The casino says it has no record of this round, so it could not reveal it: what this casino bet would have paid cannot be checked.'
          : receipt.wouldHavePaid === undefined
            ? 'Your balance is unchanged. You can place another bet.'
            : `Your balance is unchanged. The casino revealed the round: this casino bet would have paid ${formatEther(receipt.wouldHavePaid)} ${unit} for its ${formatEther(receipt.request?.amount ?? 0)} ${unit} stake.`,
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
  // A developer bet its developer did not cover was returned: its stake came back, whatever it would have paid.
  const title =
    receipt.kind === 'developer-bet' && !played
      ? 'Developer bet placed'
      : receipt.kind === 'developer-bet' && developerBetStatus(receipt) === 'returned'
        ? 'Developer bet returned'
        : played
          ? net > 0n
            ? `${bet} won`
            : net < 0n
              ? `${bet} lost`
              : `${bet} broke even`
          : (
              {
                deposit: 'Channel funded',
                withdrawal: 'Claim collected',
                closure: 'Channel closed',
                dispute: 'Channel dispute',
                payment: 'Game payment',
                'developer-bet-payout': 'Developer bet payout',
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
      : ['withdrawal', 'divest', 'earnings', 'faucet', 'developer-bet-payout', 'withdrawn'].includes(receipt.kind)
        ? 'Received'
        : receipt.kind === 'invest'
          ? 'Invested'
          : receipt.kind === 'redeem'
            ? 'Owed to you'
            : ['payment', 'developer-bet', 'bank'].includes(receipt.kind)
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
    }${receipt.kind === 'casino-bet' ? ` · Balance ${formatEther(receipt.balance)} ${unit}` : ''}`;
  } else if (
    settled &&
    ['withdrawal', 'divest', 'earnings', 'faucet', 'developer-bet-payout', 'withdrawn'].includes(receipt.kind) &&
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
    description = `A payment this game charged, paid into the casino's bankroll. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'developer-bet') {
    const standing = developerBetStatus(receipt);
    status =
      standing === 'open'
        ? 'Waiting for the developer'
        : standing === 'shorted'
          ? 'Paid short'
          : standing === 'returned'
            ? 'Stake returned'
            : BigInt(receipt.payout)
              ? 'Payout collected'
              : 'Settled · no payout';
    if (standing === 'shorted') tone = 'negative';
    if (standing === 'open')
      description = `Placed with the game’s developer. ${DEVELOPER_BET} ${trust(receipt.details?.developerBet)} Balance ${formatEther(receipt.balance)} ${unit}`;
    else if (standing === 'shorted')
      description = `Its developer paid ${formatEther(receipt.payout)} ${unit} of the ${formatEther(receipt.owed)} ${unit} it is owed on its round’s outcome; your wallet keeps the proof. ${description}`;
    else if (standing === 'returned')
      description = `Its developer did not cover it and paid its stake back${
        receipt.wouldHavePaid === undefined
          ? ''
          : `: it would have paid ${formatEther(receipt.wouldHavePaid)} ${unit} on its round’s outcome`
      }. ${description}`;
  }
  if (receipt.kind === 'developer-bet-payout')
    description = `What a developer bet’s developer paid, checked by your wallet and collected into this channel. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'bank')
    description = `Your bank takes the stakes of your games’ developer bets and pays their settlements and your casino bets. The casino signed a statement of it. Balance ${formatEther(receipt.balance)} ${unit}`;
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
