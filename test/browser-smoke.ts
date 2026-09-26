import { BrowserStore } from '../client/storage.ts';
import { CasinoWallet } from '../client/wallet.ts';
import { Wallet, id } from 'ethers';
import { domain, initialState, channelId, STATE_TYPES, plain, checkpointEvidence } from '../protocol/protocol.ts';
import { decryptBackup } from '../client/backup.ts';
const output = document.getElementById('result');
try {
  const report = { browser: navigator.userAgent, indexedDB: {} };
  const storage = new BrowserStore(),
    latencies = [],
    prefix = 'v1-browser-test:' + crypto.randomUUID();
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    await storage.commit([
      [prefix, { sequence: i, data: 'x'.repeat(4096) }],
      [prefix + ':receipt:' + i, { sequence: i, verified: true }],
    ]);
    latencies.push(performance.now() - t);
  }
  const state = await storage.get(prefix),
    receipt = await storage.get(prefix + ':receipt:299');
  if (state.sequence !== receipt.sequence) throw new Error('State and receipt diverged');
  report.indexedDB = { atomicCommits: 300, finalSequence: state.sequence, p95Ms: latencies.sort((a, b) => a - b)[284] };
  // Two independent wallet instances share real IndexedDB and the browser lock.
  const player = Wallet.createRandom(),
    owner = Wallet.createRandom(),
    casino = Wallet.createRandom().address;
  const d = domain(31337, casino),
    message = {
      channelId: channelId(player.address, player.address, 1000n),
      player: player.address,
      signer: player.address,
      deposit: '1000',
    };
  const opening = message;
  const makeWallet = () => {
    const w = new CasinoWallet({ network: 'local', storage });
    Object.assign(w, {
      storageKey: prefix + ':wallet',
      address: player.address,
      signer: player,
      operator: owner.address,
      config: { contractAddress: casino },
      domain: d,
      render: () => {},
      refresh: async () => {},
    });
    return w;
  };
  const a = makeWallet();
  a.channels[message.channelId] = {
    opening,
    state: plain(initialState(message)),
    key: player.privateKey,
    playerSignature: '0x',
    casinoSignature: '0x',
    onchain: { status: '1' },
  };
  a.channelId = message.channelId;
  await a.save();
  const b = makeWallet();
  b.hydrate(await storage.get(a.storageKey));
  const password = 'browser regression backup password',
    backup = await b.encryptedBackup(password);
  await a.exclusive(async () => {
    a.channel!.state = { ...a.channel!.state, sequence: '1', balance: '900' };
    a.channel!.playerSignature = await player.signTypedData(d, STATE_TYPES, a.channel!.state);
    a.channel!.casinoSignature = await owner.signTypedData(d, STATE_TYPES, a.channel!.state);
    await a.save();
  });
  const rejects = async (call: any, expected: any) => {
    try {
      await call();
    } catch (error: any) {
      if (expected.test(error.message)) return;
      throw error;
    }
    throw new Error('Unsafe wallet restoration was accepted');
  };
  await rejects(() => b.restoreBackup(backup, password), /changed in another tab/);
  await rejects(() => b.restoreBackup(backup, password), /newer or conflicting/);
  await navigator.locks.request('hookedin:channel:' + a.storageKey, async () => {
    await rejects(() => b.restoreBackup(backup, password), /Another tab/);
  });
  if ((await storage.get(a.storageKey)).channels[message.channelId].state.sequence !== '1')
    throw new Error('Restore lost durable evidence');
  (report as any).walletRecovery = {
    staleRevisionRejected: true,
    downgradeRejected: true,
    competingWebLockRejected: true,
    durableSequence: '1',
  };
  const stale = makeWallet();
  stale.hydrate({ schema: 'HOOKEDIN/WALLET-STATE/1', channels: {}, revision: 0 });
  if ((await stale.exportEvidence()).evidence.base.sequence !== '1')
    throw new Error('Export ignored the durable selection');
  let queuedExport;
  await navigator.locks.request('hookedin:channel:' + a.storageKey, async () => {
    queuedExport = stale.exportEvidence();
    a.channel!.state = { ...a.channel!.state, sequence: '2', balance: '1100' };
    a.channel!.playerSignature = await player.signTypedData(d, STATE_TYPES, a.channel!.state);
    a.channel!.casinoSignature = await owner.signTypedData(d, STATE_TYPES, a.channel!.state);
    await a.save();
  });
  if (((await queuedExport)! as any).evidence.base.sequence !== '2')
    throw new Error('Export missed a checkpoint committed while waiting for the lock');
  (report as any).walletRecovery.freshExportAfterLockWait = true;
  // Optional network reads release the real browser lock before they finish.
  const observing = makeWallet();
  observing.storageKey = prefix + ':observing';
  observing.hydrate(await storage.get(a.storageKey));
  observing.refresh = CasinoWallet.prototype.refresh.bind(observing);
  observing.assertNetwork = async () => {};
  observing.recoveryOnly = true;
  const block = { number: 1, hash: id('browser-observation') };
  observing.observer = {
    observe: async () => ({ block }),
    balance: async () => 1000n,
    accept: async () => {},
    contractRead: async (_: any, method: any) =>
      method === 'activeChannel'
        ? observing.channelId
        : { status: 2n, closingSequence: 0n, closingBalance: 0n, deadline: 9999999999n },
    corroborate: async (_: any, read: any) => read({ getBlock: async () => block }),
  } as any;
  let releaseDetails, detailsStarted: any;
  const started = new Promise(resolve => {
    detailsStarted = resolve;
  });
  observing.observeTransactionHistory = () => {
    detailsStarted();
    return new Promise(resolve => {
      releaseDetails = resolve;
    });
  };
  await observing.save();
  await observing.refresh();
  await started;
  await observing.exclusive(async () => {
    observing.channel!.closing = true;
    await observing.save();
  });
  releaseDetails!([]);
  await observing.detailsRefreshing;
  if (!(await storage.get(observing.storageKey)).channels[observing.channelId!].closing)
    throw new Error('Optional activity replaced a newer wallet action');
  const oldChannel = id('slow-historical-browser-channel');
  observing.channels[oldChannel] = structuredClone(observing.channel!);
  observing.channels[oldChannel].state.channelId = oldChannel;
  observing.channels[oldChannel].onchain.status = '3';
  await observing.save();
  const historicalStarted = new Promise(resolve => {
    detailsStarted = resolve;
  });
  const slowHistory = observing.refreshDetails();
  await historicalStarted;
  await observing.refresh();
  await observing.refresh();
  releaseDetails!([]);
  await slowHistory;
  if ((await storage.get(observing.storageKey)).channels[oldChannel].onchain.status !== '2')
    throw new Error('Active polls starved a slow historical update');
  // A failing refresh may have been awaited before the failure latch was set.
  const failing = makeWallet();
  failing.storageKey = prefix + ':failed';
  let rejectWrite,
    ran = false;
  failing.storage = {
    get: (key: any) => storage.get(key),
    commit: () =>
      new Promise((_, reject) => {
        rejectWrite = reject;
      }),
  } as any;
  failing.refreshing = failing.save();
  const waiting = failing.exclusive(async () => {
    ran = true;
  });
  rejectWrite!(new Error('Injected IndexedDB failure'));
  await rejects(() => waiting, /reload from durable state/);
  if (ran || !failing.storageFailed) throw new Error('Wallet action escaped the persistence latch');
  (report as any).refreshIsolation = {
    realWebLocks: true,
    stalledActivityDoesNotBlockAction: true,
    staleResultDiscarded: true,
    slowHistoryMergesAcrossActivePolls: true,
    waitingActionRejectsStorageFailure: true,
  };
  // Synthetic lifetime storage shape; copied signatures are not settlement proofs.
  const historical = { channels: {}, history: [], revision: 0 },
    commits = [];
  for (let i = 0; i < 1000; i++) {
    const key = id(prefix + ':historical:' + i),
      c = structuredClone(a.channel!);
    c.state.channelId = key;
    c.opening.channelId = key;
    c.onchain = { status: '3' };
    c.claim = { amount: '1100', paid: '1100' };
    (historical.channels as any)[key] = c;
  }
  for (let i = 0; i < 20; i++) {
    historical.revision++;
    const start = performance.now();
    await storage.put(prefix + ':historical', historical);
    commits.push(performance.now() - start);
  }
  if (Object.keys((await storage.get(prefix + ':historical')).channels).length !== 1000)
    throw new Error('Historical storage lost a channel');
  (report as any).walletHistory = {
    synthetic: true,
    channels: 1000,
    jsonBytes: new TextEncoder().encode(JSON.stringify(historical)).length,
    commits: 20,
    commitP95Ms: commits.sort((a, b) => a - b)[18],
  };
  const proof = checkpointEvidence(a.channel!.state, a.channel!.playerSignature, a.channel!.casinoSignature);
  const rawReceiptBytes = new TextEncoder().encode(JSON.stringify(proof)).length;
  for (let i = 0; i < 100; i++)
    await a.save({
      kind: 'payment',
      operationId: prefix + ':large:' + i,
      proof,
      status: 'signed',
      amount: '1',
      createdAt: new Date().toISOString(),
    });
  const compactBackup = await a.encryptedBackup(password),
    compact = await decryptBackup(compactBackup, password);
  const backupBytes = new TextEncoder().encode(JSON.stringify(compact)).length;
  if (backupBytes > 1024 * 1024 || compact.receipts || compact.record.history.length !== 100)
    throw new Error('Recovery backup exceeded its size bound');
  const restored = makeWallet();
  restored.storageKey = prefix + ':restored';
  await restored.restoreBackup(compactBackup, password);
  if (
    restored.channel!.state.sequence !== '2' ||
    restored.history.length !== 100 ||
    !(await storage.get(restored.storageKey + ':receipt:' + restored.history[0].operationId))
  )
    throw new Error('Compact backup did not restore evidence and retry receipts');
  (report as any).compactBackup = {
    syntheticReceipts: 100,
    rawReceiptBytes,
    backupBytes,
    restored: true,
    storageEstimate: await navigator.storage.estimate(),
  };
  (report as any).passed = true;
  output!.textContent = JSON.stringify(report, null, 2);
} catch (error: any) {
  output!.textContent = JSON.stringify({ passed: false, error: error.message });
}
