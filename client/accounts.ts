import type { Store } from './storage.ts';
import { Wallet } from 'ethers';
/** The keys this browser holds, by address, and the one in use. */
interface SavedAccounts {
  selected: string | null;
  accounts: Record<string, string>;
}

const keyFor = (chainId: bigint) => `accounts:${chainId}`;

/** Keep the key of an account the player created, signed in to or imported: the one in use, with `select` or when
 * none is. */
export async function saveAccount(
  storage: Store,
  chainId: bigint,
  privateKey: string,
  select: boolean,
): Promise<SavedAccounts> {
  const value = await readAccounts(storage, chainId),
    wallet = new Wallet(privateKey);
  value.accounts[wallet.address] = wallet.privateKey;
  if (select || !value.selected) value.selected = wallet.address;
  if (!value.accounts[value.selected]) throw new Error('Saved account has no key');
  await storage.put(keyFor(chainId), value);
  return value;
}

export async function readAccounts(storage: Store, chainId: bigint): Promise<SavedAccounts> {
  return (await storage.get(keyFor(chainId))) || { selected: null, accounts: {} };
}
