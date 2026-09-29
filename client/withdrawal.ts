import { formatEther, getAddress, parseEther, ZeroAddress } from 'ethers';

export interface WithdrawalInput {
  destination: string;
  ownAddress: string;
  contractAddress?: string;
  amount: string;
  maximum: bigint;
  channel: boolean;
}
export interface WithdrawalValidation {
  to: string | null;
  /** Null means sweep the deposit address, with the network fee deducted by the wallet. */
  amount: bigint | null;
  error: string | null;
}

/** One interpretation of the form for both its preview and its submit handler. */
export function validateWithdrawal(input: WithdrawalInput): WithdrawalValidation {
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
    const typed = input.amount.trim();
    if (/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(typed)) {
      try {
        const parsed = parseEther(typed);
        if (parsed > 0n) amount = parsed;
      } catch {
        // Numeric overflow is invalid input, just like excess precision.
      }
    }
    if (amount === null)
      error ??= typed
        ? 'Enter an ETH amount above zero, with at most 18 decimal places.'
        : 'Enter an amount or choose Max.';
    else if (amount > input.maximum) error ??= `Your balance holds ${formatEther(input.maximum)} ETH.`;
  }
  if (input.maximum <= 0n) error ??= 'Nothing to withdraw: your balance is empty.';
  return { to, amount, error };
}
