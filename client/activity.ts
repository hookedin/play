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
/** An exact amount in ETH, a whole one without a trailing `.0`. */
export const ether = (value: bigint | string | number) => formatEther(value).replace(/\.0$/, '');
/** A gain or a loss in ETH, with its sign. */
export const signedEth = (value: bigint) => `${value < 0n ? '−' : '+'}${ether(value < 0n ? -value : value)} ETH`;
/** JSON as the wallet shows it: a Copy JSON button with its status, above the text. */
export function jsonBlock(text: string, title: string) {
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
        { type: 'button', className: 'text-button', ariaLabel: `Copy JSON: ${title}`, onclick: copy },
        'Copy JSON',
      ),
    ),
    h('pre', { className: 'activity-payload', tabIndex: 0, ariaLabel: `JSON: ${title}` }, text),
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
  body.append(...jsonBlock(entry.payload, entry.title));
  return h('details', { className: `activity-entry tone-${entry.tone || 'neutral'}` }, summary, body);
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
    amount: `${ether(amount)} ETH`,
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
      tone: 'neutral',
      amount: `0 ETH`,
      amountLabel: 'Balance change',
      description: ['invest', 'developer-bet', 'bank', 'withdrawal', 'lock-in'].includes(receipt.kind)
        ? 'Your balance is unchanged.'
        : 'Your balance is unchanged. You can place another bet.',
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
                  collateral: 'Collateral bought',
                  withdrawal: 'Withdrawn',
                  'lock-in': 'Balance locked in',
                  'withdrawal-sent': 'Withdrawal sent',
                  'close-started': 'Close started',
                  'bet-disputed': 'Bet disputed',
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
  let amount = `${ether(settled ? receipt.amount || '0' : '0')} ETH`;
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
              : ['payment', 'developer-bet', 'bank', 'collateral'].includes(receipt.kind)
                ? 'Sent'
                : receipt.kind === 'closure'
                  ? 'Claim recorded'
                  : ['withdrawal-sent', 'close-started', 'bet-disputed', 'dispute'].includes(receipt.kind)
                    ? 'No payment'
                    : `ETH received`;
  let tone: Tone = !settled ? (['reverted', 'replaced'].includes(receipt.status) ? 'negative' : 'warning') : 'neutral';
  let description = '';
  if (played) {
    amount = settled ? signedEth(net) : '—';
    amountLabel = settled ? 'Net game result' : 'Unconfirmed result';
    if (settled) tone = net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral';
    description = `Stake ${ether(receipt.stake)} ETH · Paid ${ether(receipt.payout ?? 0)} ETH${
      receipt.maxPayout === undefined
        ? ''
        : ` of up to ${ether(receipt.maxPayout)} ETH · RTP ${percent(returnParts(BigInt(receipt.stake), BigInt(receipt.expectedPayout)))}`
    }${receipt.kind === 'casino-bet' ? ` · Balance ${ether(receipt.balance)} ETH` : ''}`;
  } else if (
    settled &&
    ['withdrawal', 'divest', 'earnings', 'developer-bet-payout', 'withdrawn'].includes(receipt.kind) &&
    BigInt(receipt.amount || 0) > 0n
  )
    tone = 'positive';
  if (receipt.kind === 'collateral' && receipt.collateral)
    description = `${ether(receipt.collateral)} ETH of the casino's cash locked into your balance: it pays your winnings before the bankroll does, and the casino cannot take it back until your balance closes.`;
  if (receipt.kind === 'invest')
    description = `Bought ${ether(receipt.shares)} shares; you hold ${ether(receipt.holding)}. The casino signed a statement of your holding. Shares are its promise of a part of the bankroll, not protected money. Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'redeem')
    description = `Sold ${ether(receipt.shares)} shares; you hold ${ether(receipt.holding)}. Your wallet collects the money into your balance.`;
  if (receipt.kind === 'divest')
    description = `Paid for redeemed bankroll shares. Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'payment')
    description = `${receipt.details?.group ? "Part of one of this game's rounds, paid into the casino's bankroll: Bets shows the round together." : "A payment this game charged, paid into the casino's bankroll."} Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'developer-bet') {
    const open = receipt.payout === undefined;
    status = open ? 'Waiting for the developer' : BigInt(receipt.payout) ? 'Payout collected' : 'Settled · no payout';
    if (open) description = `Placed with the game’s developer. ${DEVELOPER_BET} Balance ${ether(receipt.balance)} ETH`;
  }
  if (receipt.kind === 'developer-bet-payout')
    description = `What a developer bet’s developer paid, checked by your wallet and collected into your balance. Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'bank')
    description = `Your bank takes the stakes of your games’ developer bets and pays their settlements and your casino bets. The casino signed a statement of it. Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'withdrawn')
    description = `Taken from your bank and collected into your balance. Balance ${ether(receipt.balance)} ETH`;
  if (receipt.kind === 'earnings')
    description = `Commission your games earned, collected into your balance. Balance ${ether(receipt.balance)} ETH`;
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
            ? `The contract still owes ${ether(receipt.owed)} ETH of it, paid as the bankroll has the cash: collect it under Waiting to be paid.`
            : "The contract makes it a claim under the withdrawal's ID and pays it, out of your deposits first and the bankroll for the rest, once the casino or you send it.",
      `Balance ${ether(receipt.balance)} ETH`,
    ].join(' ');
  }
  const notice =
    receipt.status === 'orphaned'
      ? 'This transaction is no longer confirmed. Refresh to check for re-inclusion, or retry it from your deposit address with the saved transaction details.'
      : receipt.kind === 'close-started'
        ? 'A close without the casino can be challenged for 24 hours. Then finish it under Wallet → Recovery.'
        : receipt.kind === 'bet-disputed'
          ? 'The casino has 24 hours to settle the disputed bet on-chain; if it does not, the bet counts as won. Then finish the close under Wallet → Recovery.'
          : receipt.kind === 'closure'
            ? 'A close without the casino records what the balance is owed. Collect it under Wallet → Waiting to be paid.'
            : undefined;
  return { title, status, tone, amount, amountLabel, description, notice };
}
