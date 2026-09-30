// test/browser.test.ts opens this harness in two tabs of one browser, with a shared run ID and roles a/b.
import { BrowserStore } from '../client/storage.ts';
import { Wallet } from 'ethers';
import { saveAccounts, readAccounts } from '../client/accounts.ts';
const output = document.getElementById('result');
try {
  const params = new URL(location.href).searchParams,
    run = params.get('run'),
    role = params.get('role');
  if (!run || !['a', 'b'].includes(role as any)) throw new Error('Supply run=unique-id and role=a or role=b');
  const storage = new BrowserStore(),
    key = 'browser-funding-test:' + run,
    peer = role === 'a' ? 'b' : 'a';
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
  const saved = await saveAccounts(storage, key, { create: true });
  await storage.put(key + ':' + role + ':address', saved.selected);
  const other = await waitFor(':' + peer + ':address');
  if (other !== saved.selected) throw new Error('Concurrent tabs selected different accounts');
  const durable = await readAccounts(storage, key);
  if (Object.keys(durable.accounts).length !== 1 || !durable.accounts[other]) throw new Error('Key was not retained');
  await storage.put(key + ':' + role + ':selection-checked', true);
  await waitFor(':' + peer + ':selection-checked');
  const imported = Wallet.createRandom();
  await saveAccounts(storage, key, { privateKeys: [imported.privateKey] });
  await storage.put(key + ':' + role + ':imported', true);
  await waitFor(':' + peer + ':imported');
  const accounts = (await readAccounts(storage, key)).accounts;
  if (Object.keys(accounts).length !== 3 || accounts[imported.address] !== imported.privateKey)
    throw new Error('Concurrent key import lost an account');
  // Also exercise cross-tab atomicity without relying on Web Locks.
  for (let i = 0; i < 20; i++) await storage.update(key + ':counter', n => (n || 0) + 1);
  await storage.put(key + ':' + role + ':done', true);
  await waitFor(':' + peer + ':done');
  const updates = await storage.get(key + ':counter');
  if (updates !== 40) throw new Error('Cross-tab read/modify/write lost an update');
  output!.textContent = JSON.stringify(
    {
      passed: true,
      role,
      simultaneousSelection: true,
      durableAccounts: 1,
      atomicUpdates: updates,
      imports: 2,
      browser: navigator.userAgent,
    },
    null,
    2,
  );
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
