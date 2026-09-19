// Open this harness in two actual tabs with a shared run ID and roles a/b.
import { BrowserStore } from '../client/storage.ts';
import { fundingAccounts, readFundingAccounts } from '../client/funding-accounts.ts';
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
  const vault = await fundingAccounts(storage, key, { create: true });
  await storage.put(key + ':' + role + ':address', vault.selected);
  const other = await waitFor(':' + peer + ':address');
  if (other !== vault.selected) throw new Error('Concurrent tabs selected different funding accounts');
  const durable = await readFundingAccounts(storage, key);
  if (Object.keys(durable.accounts).length !== 1 || !durable.accounts[other])
    throw new Error('Funding key was not retained');
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
      simultaneousFundingSelection: true,
      durableAccounts: 1,
      atomicUpdates: updates,
      browser: navigator.userAgent,
    },
    null,
    2,
  );
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
