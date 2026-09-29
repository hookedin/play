// test/browser.test.ts opens this harness in two tabs of one browser, with a shared run ID and roles a/b.
import { BrowserStore } from '../client/storage.ts';
import { VaultStore } from '../client/vault.ts';
import { Wallet } from 'ethers';
import { fundingAccounts, readFundingAccounts } from '../client/funding-accounts.ts';
const output = document.getElementById('result');
try {
  const params = new URL(location.href).searchParams,
    run = params.get('run'),
    role = params.get('role');
  if (!run || !['a', 'b'].includes(role as any)) throw new Error('Supply run=unique-id and role=a or role=b');
  const raw = new BrowserStore(),
    storage = new VaultStore(raw),
    key = 'browser-funding-test:' + run,
    peer = role === 'a' ? 'b' : 'a',
    password = 'browser funding wallet passphrase';
  const waitFor = async (suffix: any) => {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const value = await storage.get(key + suffix);
      if (value) return value;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('Peer tab did not arrive');
  };
  await storage.put(key + ':' + role + ':ready', true);
  await waitFor(':' + peer + ':ready');
  try {
    await storage.setup(password);
  } catch (error: any) {
    if (!error.message.includes('already has a passphrase')) throw error;
    await storage.unlock(password);
  }
  const saved = await fundingAccounts(storage, key, { create: true });
  await storage.put(key + ':' + role + ':address', saved.selected);
  const other = await waitFor(':' + peer + ':address');
  if (other !== saved.selected) throw new Error('Concurrent tabs selected different funding accounts');
  const durable = await readFundingAccounts(storage, key);
  if (Object.keys(durable.accounts).length !== 1 || !durable.accounts[other])
    throw new Error('Funding key was not retained');
  const ciphertext = await raw.get('funding-accounts:1:' + key);
  if (typeof ciphertext.data !== 'string' || JSON.stringify(ciphertext).includes(durable.accounts[other]))
    throw new Error('Funding private key was not encrypted');
  await storage.put(key + ':' + role + ':selection-checked', true);
  await waitFor(':' + peer + ':selection-checked');
  const imported = Wallet.createRandom();
  await fundingAccounts(storage, key, { privateKeys: [imported.privateKey] });
  await storage.put(key + ':' + role + ':imported', true);
  await waitFor(':' + peer + ':imported');
  if (Object.keys((await readFundingAccounts(storage, key)).accounts).length !== 3)
    throw new Error('Concurrent encrypted key import lost an account');
  // Also exercise cross-tab atomicity without relying on Web Locks.
  for (let i = 0; i < 20; i++) await storage.update(key + ':counter', n => (n || 0) + 1);
  for (let i = 0; i < 20; i++) await storage.update('funding-accounts:counter:' + key, n => (n || 0) + 1);
  await storage.put(key + ':' + role + ':done', true);
  await waitFor(':' + peer + ':done');
  const updates = await storage.get(key + ':counter');
  if (updates !== 40) throw new Error('Cross-tab read/modify/write lost an update');
  const encryptedUpdates = await storage.get('funding-accounts:counter:' + key);
  if (encryptedUpdates !== 40) throw new Error('Encrypted cross-tab update lost an update');
  storage.lock();
  let lockedRead = false;
  try {
    await readFundingAccounts(storage, key);
  } catch {
    lockedRead = true;
  }
  if (!lockedRead || !(await storage.get(key + ':' + role + ':done')))
    throw new Error('Lock must protect keys while keeping evidence readable');
  await storage.unlock(password);
  if ((await readFundingAccounts(storage, key)).accounts[imported.address] !== imported.privateKey)
    throw new Error('Unlock did not recover the saved key');
  output!.textContent = JSON.stringify(
    {
      passed: true,
      role,
      simultaneousFundingSelection: true,
      durableAccounts: 1,
      atomicUpdates: updates,
      encryptedUpdates,
      encryptedImports: 2,
      lockedKeys: lockedRead,
      browser: navigator.userAgent,
    },
    null,
    2,
  );
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
