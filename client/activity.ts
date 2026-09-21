import { formatEther } from 'ethers';
import { plain } from '../protocol/protocol.ts';

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
  count.textContent = terms.length ? `${visible} / ${list.childElementCount}` : String(visible);
  empty.classList.toggle('hidden', visible !== 0);
  empty.textContent = terms.length
    ? 'No matching events. Try a method, amount, operation ID or transaction hash.'
    : 'No activity yet. Events will appear here as you use the wallet and games.';
}

/** The exact return of a signed bet, from its expected payout out of 2^64 stakes, to a hundredth of a basis point. */
export function returnToPlayer(stake: unknown, expectedPayout: unknown) {
  const parts = (BigInt(expectedPayout as string) * 1000000n) / (BigInt(stake as string) << 64n);
  return `RTP ${parts / 10000n}.${String(parts % 10000n).padStart(4, '0')}%`;
}
/** A hosted round's seed was its host's: the one bet whose fairness also rests on the host. */
const HOSTED = 'Shared round: the game host drew the randomness.';
/** A receipt is in the asset of the channel that signed it; an on-chain transaction is always ETH. */
export const receiptUnit = (receipt: { asset?: string }) => (receipt.asset === 'test' ? 'TEST' : 'ETH');
export function receiptSummary(
  receipt: any,
): Pick<ActivityEntry, 'title' | 'status' | 'tone' | 'amount' | 'amountLabel' | 'description' | 'notice'> {
  const unit = receiptUnit(receipt);
  if (receipt.status === 'rejected')
    return {
      title:
        receipt.kind === 'transfer'
          ? 'Transfer cancelled'
          : receipt.kind === 'invest'
            ? 'Investment declined'
            : 'Bet rejected',
      status:
        receipt.kind === 'transfer'
          ? 'No payment made'
          : receipt.kind === 'invest'
            ? 'No shares bought'
            : 'No wager placed',
      tone: 'neutral',
      amount: `0 ${unit}`,
      amountLabel: 'Balance change',
      description: ['transfer', 'invest'].includes(receipt.kind)
        ? 'Your balance is unchanged.'
        : receipt.wouldHavePaid === undefined
          ? `Your balance is unchanged. You can place another bet.${receipt.hosted ? ' ' + HOSTED : ''}`
          : `Your balance is unchanged. The casino has since revealed the round: this wager would have paid ${formatEther(receipt.wouldHavePaid)} ${unit} for its ${formatEther(receipt.request?.amount ?? 0)} ${unit} stake.`,
      notice: receipt.reason,
    };
  const settled = ['signed', 'confirmed'].includes(receipt.status);
  const status =
    (
      {
        signed: 'Signed off-chain',
        confirmed: 'Confirmed on-chain',
        reverted: 'Reverted',
        replaced: 'Replaced',
        orphaned: 'Unconfirmed · reorg',
      } as Record<string, string>
    )[receipt.status] || 'Unconfirmed';
  // A bet's stake was paid to enter; its result is what the prizes paid against that stake.
  const net = receipt.kind === 'bet' ? BigInt(receipt.payout ?? 0) - BigInt(receipt.stake ?? 0) : 0n;
  const title =
    receipt.kind === 'bet'
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
            transfer: 'Payment sent',
            receive: 'Payment received',
            payment: 'Game payment',
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
      : ['withdrawal', 'receive', 'divest', 'earnings', 'faucet'].includes(receipt.kind)
        ? 'Received'
        : receipt.kind === 'invest'
          ? 'Invested'
          : receipt.kind === 'redeem'
            ? 'Owed to you'
            : ['transfer', 'payment'].includes(receipt.kind)
              ? 'Sent'
              : receipt.kind === 'closure'
                ? 'Claim recorded'
                : `${unit} received`;
  let tone: Tone = !settled ? (['reverted', 'replaced'].includes(receipt.status) ? 'negative' : 'warning') : 'neutral';
  let description = '';
  if (receipt.kind === 'bet') {
    amount = settled ? `${net < 0n ? '−' : '+'}${formatEther(net < 0n ? -net : net)} ${unit}` : '—';
    amountLabel = settled ? 'Net game result' : 'Unconfirmed result';
    if (settled) tone = net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral';
    description = `Stake ${formatEther(receipt.stake)} ${unit} · Paid ${formatEther(receipt.payout ?? 0)} ${unit}${
      receipt.maxPayout === undefined
        ? ''
        : ` of up to ${formatEther(receipt.maxPayout)} ${unit} · ${returnToPlayer(receipt.stake, receipt.expectedPayout)}`
    } · Balance ${formatEther(receipt.balance)} ${unit}${receipt.hosted ? ' · ' + HOSTED : ''}`;
  } else if (
    settled &&
    ['receive', 'withdrawal', 'divest', 'earnings', 'faucet'].includes(receipt.kind) &&
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
  if (receipt.kind === 'transfer')
    description = `Paid to this game's developer. Balance ${formatEther(receipt.balance)} ${unit}`;
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
