// test/browser.test.ts opens this harness: what only a real browser has, IndexedDB transactions and Web Locks.
import { BrowserStore } from '../client/storage.ts';
import { CasinoWallet } from '../client/wallet.ts';
import { Wallet } from 'ethers';
import { domain, baseState, channelId, plain } from '../protocol/protocol.ts';
const output = document.getElementById('result');
try {
  const storage = new BrowserStore(),
    prefix = 'browser-test:' + crypto.randomUUID();
  // A state and its receipt are one transaction.
  for (let i = 0; i < 3; i++)
    await storage.commit([
      [prefix, { sequence: i }],
      [prefix + ':receipt:' + i, { sequence: i }],
    ]);
  if ((await storage.get(prefix)).sequence !== (await storage.get(prefix + ':receipt:2')).sequence)
    throw new Error('State and receipt diverged');
  const player = Wallet.createRandom(),
    casino = Wallet.createRandom().address,
    id = channelId(player.address, 0);
  const tab = () =>
    Object.assign(new CasinoWallet({ network: 'local', storage }), {
      storageKey: prefix + ':wallet',
      address: player.address,
      signer: player,
      config: { contractAddress: casino, operator: Wallet.createRandom().address },
      domain: domain(31337, casino),
      render: () => {},
      refresh: async () => {},
    });
  const writer = tab();
  writer.channels[id] = {
    opening: { channelId: id, player: player.address, index: '0' },
    state: plain(baseState(id)),
    playerSignature: '0x',
    casinoSignature: '0x',
    onchain: { status: '1' },
  };
  writer.channelId = id;
  await writer.save();
  const lock = (fn: () => Promise<unknown>) => navigator.locks.request('hookedin:channel:' + writer.storageKey, fn);
  // An export waits for the lock, and reads what was committed while it waited.
  const reader = tab();
  reader.hydrate({ schema: 'HOOKEDIN/WALLET-STATE/1', channels: {}, revision: 0 });
  let exported!: ReturnType<CasinoWallet['exportEvidence']>;
  await lock(async () => {
    exported = reader.exportEvidence();
    writer.channel!.state = { ...writer.channel!.state, sequence: '1' };
    await writer.save();
  });
  if ((await exported).evidence.base.sequence !== '1')
    throw new Error('Export missed a checkpoint committed while waiting for the lock');
  output!.textContent = JSON.stringify({ passed: true, browser: navigator.userAgent });
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
