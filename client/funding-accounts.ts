import type { Store } from './storage.ts';
import type { Integer } from '../protocol/types.ts';
export interface FundingAccounts {
  selected: string | null;
  accounts: Record<string, string>;
}
import { Wallet } from 'ethers';
import { withLock } from './storage.ts';

const keyFor = (chainId: Integer) => `funding-accounts:1:${chainId}`;

function add(accounts: Record<string, string>, privateKey: string) {
  const wallet = new Wallet(privateKey);
  accounts[wallet.address] = wallet.privateKey;
  return wallet.address;
}

/** Retain imported/generated keys and a separate selection. */
export async function fundingAccounts(
  storage: Store,
  chainId: Integer,
  {
    privateKeys = [],
    select = false,
    create = false,
  }: { privateKeys?: string[]; select?: boolean; create?: boolean } = {},
): Promise<FundingAccounts> {
  return withLock(`hookedin:funding:${chainId}`, true, async () => {
    // Validate before entering the IndexedDB transaction. Never expose a candidate
    // address until the atomic update has committed its winning selection.
    const keys = privateKeys.map(key => new Wallet(key).privateKey);
    const candidate = create ? Wallet.createRandom().privateKey : null;
    return storage.update<FundingAccounts>(keyFor(chainId), saved => {
      const value = saved || { selected: null, accounts: {} };
      for (const key of keys) {
        const address = add(value.accounts, key);
        if (select || !value.selected) value.selected = address;
      }
      if (!value.selected && candidate) value.selected = add(value.accounts, candidate);
      if (value.selected && !value.accounts[value.selected]) throw new Error('Saved funding account has no key');
      return value;
    });
  });
}

export async function readFundingAccounts(storage: Store, chainId: Integer): Promise<FundingAccounts> {
  return (await storage.get(keyFor(chainId))) || { selected: null, accounts: {} };
}
