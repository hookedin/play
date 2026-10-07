import type { Store } from './storage.ts';
import type { Integer } from '../protocol/types.ts';
import { Wallet } from 'ethers';
import { withLock } from './storage.ts';
/** The keys this browser holds, by address, and the one in use. */
export interface SavedAccounts {
  selected: string | null;
  accounts: Record<string, string>;
}

const keyFor = (chainId: Integer) => `accounts:${chainId}`;

function add(accounts: Record<string, string>, privateKey: string) {
  const wallet = new Wallet(privateKey);
  accounts[wallet.address] = wallet.privateKey;
  return wallet.address;
}

/** Keep the keys of the accounts the player created, signed in to or imported, and which one is in use. */
export async function saveAccounts(
  storage: Store,
  chainId: Integer,
  { privateKeys = [], select = false }: { privateKeys?: string[]; select?: boolean } = {},
): Promise<SavedAccounts> {
  return withLock(`hookedin:accounts:${chainId}`, true, async () => {
    // Validate before entering the IndexedDB transaction.
    const keys = privateKeys.map(key => new Wallet(key).privateKey);
    return storage.update<SavedAccounts>(keyFor(chainId), saved => {
      const value = saved || { selected: null, accounts: {} };
      for (const key of keys) {
        const address = add(value.accounts, key);
        if (select || !value.selected) value.selected = address;
      }
      if (value.selected && !value.accounts[value.selected]) throw new Error('Saved account has no key');
      return value;
    });
  });
}

export async function readAccounts(storage: Store, chainId: Integer): Promise<SavedAccounts> {
  return (await storage.get(keyFor(chainId))) || { selected: null, accounts: {} };
}
