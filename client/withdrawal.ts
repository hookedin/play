import { formatEther, getAddress, parseUnits, ZeroAddress } from 'ethers';
import { exactAmount } from '../sdk/src/wire.ts';
import { exact } from './activity.ts';

/** What an amount being withdrawn is typed in: METH, as the wallet counts, or ETH, as the wallet it goes to may. */
export type Unit = 'METH' | 'ETH';
const DECIMALS: Record<Unit, number> = { METH: 12, ETH: 18 };
/** Wei in `unit`, every digit: grouped for a sentence, or with `typed` as the amount field holds it. */
export const inUnit = (wei: bigint, unit: Unit, typed = false) =>
  unit === 'ETH' ? formatEther(wei).replace(/\.0$/, '') : typed ? exactAmount(wei) : exact(wei);
/** What the player typed in `unit`, as wei: null for anything that is not an amount above zero. */
export function typedIn(text: string, unit: Unit) {
  const typed = text.trim(),
    decimals = DECIMALS[unit];
  if (!new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`).test(typed)) return null;
  try {
    const wei = parseUnits(typed, decimals);
    return wei > 0n ? wei : null;
  } catch {
    // Numeric overflow is invalid input, just like excess precision.
    return null;
  }
}

export interface WithdrawalInput {
  destination: string;
  ownAddress: string;
  contractAddress?: string;
  amount: string;
  unit?: Unit;
  maximum: bigint;
  channel: boolean;
}
export interface WithdrawalValidation {
  to: string | null;
  /** Null means sweep the deposit address, with the network fee deducted by the wallet. */
  amount: bigint | null;
  error: string | null;
}

/** One interpretation of a form that sends money for both its preview and its submit handler. */
export function validateWithdrawal({ unit = 'METH', ...input }: WithdrawalInput): WithdrawalValidation {
  let to: string | null = null,
    amount: bigint | null = null,
    error: string | null = null;
  const destination = input.destination.trim();
  try {
    to = getAddress(destination);
    if (to === ZeroAddress) error = 'The zero address cannot receive your withdrawal. Enter another address.';
    else if (to.toLowerCase() === input.contractAddress?.toLowerCase())
      error = 'Withdraw to a receiving address, not the casino contract.';
    else if (to.toLowerCase() === input.ownAddress.toLowerCase())
      error = 'That is your deposit address. Withdraw to another address.';
  } catch {
    error = destination
      ? 'Enter a valid Ethereum address with the correct checksum.'
      : 'Enter the address that should receive your ETH.';
  }
  if (input.channel) {
    amount = typedIn(input.amount, unit);
    if (amount === null)
      error ??= input.amount.trim()
        ? `Enter an amount in ${unit} above zero, with at most ${DECIMALS[unit]} decimal places.`
        : 'Enter an amount or choose Max.';
    else if (amount > input.maximum) error ??= `At most ${inUnit(input.maximum, unit)} ${unit} can be withdrawn.`;
  }
  if (input.maximum <= 0n)
    error ??= input.channel
      ? 'Nothing to withdraw: your balance holds no more than the fee for sending it and what the casino lent you.'
      : 'Nothing to withdraw: your deposit address is empty.';
  return { to, amount, error };
}
