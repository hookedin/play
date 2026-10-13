// test/browser.test.ts opens this harness: what only a real browser has, IndexedDB transactions.
import { BrowserStore } from '../client/storage.ts';
const output = document.getElementById('result');
try {
  const storage = new BrowserStore(),
    prefix = 'browser-test:' + crypto.randomUUID();
  await storage.claim();
  // A state and its receipt are one transaction.
  for (let i = 0; i < 3; i++)
    await storage.commit([
      [prefix, { sequence: i }],
      [prefix + ':receipt:' + i, { sequence: i }],
    ]);
  if ((await storage.get(prefix)).sequence !== (await storage.get(prefix + ':receipt:2')).sequence)
    throw new Error('State and receipt diverged');
  // Another tab takes the wallet: this one writes nothing more.
  const taker = new BrowserStore();
  await taker.claim();
  const refused = await storage.commit([[prefix, { sequence: 3 }]]).then(
    () => false,
    error => /open in another tab/.test(error.message),
  );
  if (!refused || (await storage.get(prefix)).sequence !== 2) throw new Error('A tab the wallet left wrote');
  await taker.commit([[prefix, { sequence: 3 }]]);
  if ((await storage.get(prefix)).sequence !== 3) throw new Error('The tab that took the wallet could not write');
  output!.textContent = JSON.stringify({ passed: true, browser: navigator.userAgent });
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
