import { exactAmount, formatAmount } from '../sdk/src/wire.ts';
import { exact } from './activity.ts';
import { $, toast, typedAmount } from './page.ts';
import { act, uiBusy, wallet } from './sheet.ts';

/** The bankroll fund as the casino states it, signed, against the shares this wallet can prove it holds. */
let fundStatus: Record<string, any> | null = null;
export async function refreshFund() {
  try {
    fundStatus = await wallet.fundStatus();
  } catch {
    fundStatus = null;
  }
  renderFund();
}
export function renderFund() {
  const f = fundStatus,
    open = wallet.playable && !wallet.recoveryOnly,
    shares = BigInt(wallet.fund?.shares || 0);
  $('fund-value').textContent = f ? formatAmount(f.value, 0) : '—';
  $('fund-equity').textContent = f ? formatAmount(f.equity, 0) : '—';
  // Shares are counted like METH, in units of 10^12: one began at 1 METH, and the price is what the bankroll has made
  // or lost since.
  $('fund-price').textContent =
    f && BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.equity) * 1000000n) / BigInt(f.totalShares)) / 1000000).toFixed(6)} METH`
      : '1.000000 METH';
  $('fund-house').textContent = !f
    ? '—'
    : BigInt(f.totalShares) > 0n
      ? `${(Number((BigInt(f.houseShares) * 10000n) / BigInt(f.totalShares)) / 100).toFixed(2)}%`
      : '100.00%';
  $('fund-note').textContent = wallet.fund?.alert
    ? `Your wallet refused a share statement: ${wallet.fund.alert}`
    : f && BigInt(f.overdrawn) > 0n
      ? `The casino's owner has withdrawn ${formatAmount(f.overdrawn)} METH more than its own shares covered. Holders bore that loss.`
      : f?.owed?.length
        ? 'Money from shares you sold is on its way to your balance.'
        : !f
          ? 'The casino is not reporting its bankroll right now.'
          : shares
            ? `You hold ${exact(shares)} shares under the casino's signed statement number ${wallet.fund.sequence}.`
            : open
              ? ''
              : 'Deposit into your balance to buy shares.';
  $<HTMLButtonElement>('invest').disabled = uiBusy || !open || !f;
  for (const id of ['divest', 'divest-all']) $<HTMLButtonElement>(id).disabled = uiBusy || !open || !f || !shares;
}

act('invest', async () => {
  const amount = typedAmount($<HTMLInputElement>('invest-amount').value.trim());
  if (wallet.pending) throw new Error('Finish the operation in flight before buying shares.');
  const receipt = await wallet.invest(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this investment.');
  toast(`Bought ${exact(receipt.shares)} shares for ${exact(amount)} METH.`);
  await refreshFund();
});
$<HTMLButtonElement>('divest-all').addEventListener('click', () => {
  if (fundStatus) $<HTMLInputElement>('divest-amount').value = exactAmount(fundStatus.value);
});
act('divest', async () => {
  const status = await wallet.fundStatus(),
    held = BigInt(wallet.fund.shares),
    wanted = typedAmount($<HTMLInputElement>('divest-amount').value.trim());
  if (wanted <= 0n || BigInt(status.equity) <= 0n) throw new Error('Enter what the shares you sell should be worth.');
  // Shares worth the amount asked for at the stated price; everything, when that is all of them.
  const shares = wanted >= BigInt(status.value) ? held : (wanted * BigInt(status.totalShares)) / BigInt(status.equity);
  if (!shares) throw new Error('That is less than one share.');
  const receipt = await wallet.redeem(shares);
  toast(`Sold ${exact(shares)} shares for ${exact(receipt.amount)} METH. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshFund();
});
