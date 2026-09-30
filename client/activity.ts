import { formatEther } from 'ethers';
import type { PlayerDeveloperBet } from '../protocol/types.ts';
import { plain, same } from '../protocol/protocol.ts';
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
}

export function activityJSON(data: unknown): string {
  try {
    return JSON.stringify(plain(data), null, 2);
  } catch {
    return '[Payload could not be displayed as JSON.]';
  }
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
  row.className = `activity-entry tone-${entry.tone || 'neutral'}`;
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
    time.textContent = `${date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${clock}`;
  } else time.textContent = 'Time unavailable';
  content.append(time);
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
    toolbar.append(element('span', '', 'Raw JSON'));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button';
    copy.textContent = 'Copy JSON';
    copy.setAttribute('aria-label', `Copy JSON: ${entry.title}`);
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
    const matches = terms.every(term => text.includes(term));
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
  'Its stake went to the game’s developer when you placed it, and the developer settles it: what it pays is their word, and you trust them to pay it. Your wallet collects what they pay.';
/** Every receipt this wallet keeps is in ETH. */
const unit = 'ETH';
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
    amount: `${formatEther(amount)} ${unit}`,
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
/** A receipt as Activity shows it. `contract` is the deployment's: a withdrawal or a claim paid to it goes into the
 * account's own channel as deposits. */
export function receiptSummary(
  receipt: any,
  contract: string,
): Pick<ActivityEntry, 'title' | 'status' | 'tone' | 'amount' | 'amountLabel' | 'description' | 'notice'> {
  if (receipt.status === 'rejected')
    return {
      title: (
        {
          'casino-bet': 'Casino bet rejected',
          'developer-bet': 'Developer bet rejected',
          payment: 'Payment rejected',
          invest: 'Investment declined',
          bank: 'Bank deposit declined',
          withdrawal: 'Withdrawal declined',
          'lock-in': 'Lock-in declined',
        } as Record<string, string>
      )[receipt.kind],
      status: receipt.kind === 'invest' ? 'No shares bought' : 'Nothing paid',
      tone: receipt.lost ? 'warning' : 'neutral',
      amount: `0 ${unit}`,
      amountLabel: 'Balance change',
      description: ['invest', 'developer-bet', 'bank', 'withdrawal', 'lock-in'].includes(receipt.kind)
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
  const title =
    receipt.kind === 'developer-bet' && !played
      ? 'Developer bet placed'
      : played
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
            : (
                {
                  deposit: 'Deposited',
                  withdrawal: 'Withdrawn',
                  'lock-in': 'Balance locked in',
                  'withdrawal-sent': 'Withdrawal sent',
                  'close-started': 'Close started',
                  closure: 'Balance closed',
                  dispute: 'Close challenged',
                  payment: 'Game payment',
                  'developer-bet-payout': 'Developer bet payout',
                  bank: 'Put into your bank',
                  withdrawn: 'Taken from your bank',
                  invest: 'Invested in the bankroll',
                  redeem: 'Shares redeemed',
                  divest: 'Bankroll payout',
                  earnings: 'Developer earnings',
                  transaction: 'Transaction',
                } as Record<string, string>
              )[receipt.kind] || receipt.kind;
  let amount = `${formatEther(settled ? receipt.amount || '0' : '0')} ${unit}`;
  let amountLabel = !settled
    ? 'No confirmed payment'
    : receipt.kind === 'deposit'
      ? 'Deposited'
      : receipt.kind === 'withdrawal'
        ? 'Paid out'
        : ['divest', 'earnings', 'developer-bet-payout', 'withdrawn'].includes(receipt.kind)
          ? 'Received'
          : receipt.kind === 'invest'
            ? 'Invested'
            : receipt.kind === 'redeem'
              ? 'Owed to you'
              : ['payment', 'developer-bet', 'bank'].includes(receipt.kind)
                ? 'Sent'
                : receipt.kind === 'closure'
                  ? 'Claim recorded'
                  : ['withdrawal-sent', 'close-started', 'dispute'].includes(receipt.kind)
                    ? 'No payment'
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
    ['withdrawal', 'divest', 'earnings', 'developer-bet-payout', 'withdrawn'].includes(receipt.kind) &&
    BigInt(receipt.amount || 0) > 0n
  )
    tone = 'positive';
  if (receipt.kind === 'invest')
    description = `Bought ${formatEther(receipt.shares)} shares; you hold ${formatEther(receipt.holding)}. The casino signed a statement of your holding. Shares are its promise of a part of the bankroll, not protected money. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'redeem')
    description = `Sold ${formatEther(receipt.shares)} shares; you hold ${formatEther(receipt.holding)}. Your wallet collects the money into your balance.`;
  if (receipt.kind === 'divest')
    description = `Paid for redeemed bankroll shares. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'payment')
    description = `A payment this game charged, paid into the casino's bankroll. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'developer-bet') {
    const open = receipt.payout === undefined;
    status = open ? 'Waiting for the developer' : BigInt(receipt.payout) ? 'Payout collected' : 'Settled · no payout';
    if (open)
      description = `Placed with the game’s developer. ${DEVELOPER_BET} Balance ${formatEther(receipt.balance)} ${unit}`;
  }
  if (receipt.kind === 'developer-bet-payout')
    description = `What a developer bet’s developer paid, checked by your wallet and collected into your balance. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'bank')
    description = `Your bank takes the stakes of your games’ developer bets and pays their settlements and your casino bets. The casino signed a statement of it. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'withdrawn')
    description = `Taken from your bank and collected into your balance. Balance ${formatEther(receipt.balance)} ${unit}`;
  if (receipt.kind === 'earnings')
    description = `Commission your games earned, collected into your balance. Balance ${formatEther(receipt.balance)} ${unit}`;
  // The contract makes a withdrawal or a lock-in a claim under its ID once the casino, or anyone, sends it, and pays
  // what it can at once; anyone can see how it stands. One that pays the contract, as a lock-in does, goes into the
  // account's own channel.
  if (receipt.withdrawal) {
    const into = same(receipt.to, contract);
    status = receipt.paid
      ? into
        ? 'In as deposits'
        : 'Paid on-chain'
      : receipt.returned
        ? 'Returned with the close'
        : receipt.recorded
          ? 'Part waits for the bankroll'
          : 'Waiting to be paid';
    tone = receipt.paid ? 'positive' : receipt.returned ? 'neutral' : 'warning';
    amountLabel = receipt.paid ? (into ? 'Locked in' : 'Paid out') : receipt.returned ? 'In the claim' : 'To be paid';
    description = [
      `${receipt.kind === 'lock-in' ? 'All of your balance' : 'From your balance'} ${
        into ? 'into your own channel, as deposits the contract holds' : `to ${receipt.to}`
      }.`,
      receipt.paid
        ? into
          ? 'The contract has put it in, and your balance takes it in as a deposit.'
          : 'The contract has paid it.'
        : receipt.returned
          ? 'It never became a claim, so the close returned it: it is part of what your closed balance is owed, under Waiting to be paid.'
          : receipt.recorded
            ? `The contract still owes ${formatEther(receipt.owed)} ${unit} of it, paid as the bankroll has the cash: collect it under Waiting to be paid.`
            : "The contract makes it a claim under the withdrawal's ID and pays it, out of your deposits first and the bankroll for the rest, once the casino or you send it.",
      `Balance ${formatEther(receipt.balance)} ${unit}`,
    ].join(' ');
  }
  const notice =
    receipt.status === 'orphaned'
      ? 'This transaction is no longer confirmed. Refresh to check for re-inclusion, or retry it from your deposit address with the saved transaction details.'
      : receipt.kind === 'close-started'
        ? 'A close without the casino can be challenged for 24 hours. Then finish it under Wallet → Recovery.'
        : receipt.kind === 'closure'
          ? 'A close without the casino records what the balance is owed. Collect it under Wallet → Waiting to be paid.'
          : undefined;
  return { title, status, tone, amount, amountLabel, description, notice };
}
