import test from 'node:test';
import assert from 'node:assert/strict';
import { backupFingerprint, verifyBackupFile } from '../client/backup-status.ts';
import { encryptBackup } from '../client/backup.ts';

const password = 'the downloaded backup passphrase';
const account = {
  fundingKey: '0x' + 'ab'.repeat(32),
  address: '0x1111111111111111111111111111111111111111',
  chainId: '31337',
  casino: '0x2222222222222222222222222222222222222222',
};
const record = () => ({
  schema: 'HOOKEDIN/WALLET-STATE/1',
  channels: {
    channel: {
      opening: { channelId: 'channel', player: account.address, index: '0' },
      state: { sequence: '1', balance: '10' },
      playerSignature: 'player signature',
      casinoSignature: 'casino signature',
      lastResponse: { evidence: { base: { sequence: '1' } } },
      pending: null as any,
      closing: false,
      onchain: { status: '1', deposited: '10' },
      claim: null as any,
      observedAt: 1,
      registered: true,
      round: 'round',
    },
  },
  channelId: 'channel',
  history: [{ operationId: 'op', proof: { signature: 'receipt' }, paid: false, blockNumber: 1, blockHash: 'hash' }],
  transactionIntent: null as any,
  fund: { sequence: 1, shares: '10', statement: { signature: 'fund' }, owed: ['2'], alert: '' },
  bank: { statement: { signature: 'bank' }, withdrawing: null as any, owed: ['3'] },
  developerBets: { bet: { operationId: 'op', state: { payout: '3' }, error: '' } },
  developerBetCursor: '1',
  controls: { limits: { loss: '10' }, pausedUntil: 0 },
  autoDeposit: true,
  revision: 1,
});
const contents = (saved = record()) => ({
  schema: 'HOOKEDIN/WALLET/1',
  scope: 'selected-account',
  ...account,
  record: saved,
});

test('backup fingerprint ignores observation refreshes and object insertion order', () => {
  const saved = record(),
    observed = record();
  observed.revision++;
  observed.developerBetCursor = '2';
  Object.assign(observed.channels.channel, {
    observedAt: 123456,
    onchain: { status: '2', deadline: '999', deposited: '10' },
    claim: { collectable: '20' },
    registered: false,
    round: 'another round',
  });
  Object.assign(observed.history[0], {
    recorded: true,
    paid: true,
    owed: '0',
    winningsRemaining: '0',
    collectable: '0',
    recordedIn: 'transaction',
    returned: false,
    settledAt: { number: 2, hash: 'another hash' },
    to: account.casino,
    blockNumber: 2,
    blockHash: 'another hash',
  });
  observed.fund.alert = 'RPC unavailable';
  observed.developerBets.bet.error = 'Service unavailable';
  observed.controls.pausedUntil = 999;
  observed.autoDeposit = false;
  assert.equal(backupFingerprint(saved), backupFingerprint(observed));
  assert.equal(backupFingerprint(saved), backupFingerprint(Object.fromEntries(Object.entries(saved).reverse())));
});

test('backup fingerprint covers keys to recovery across every balance and pending action', () => {
  const baseline = backupFingerprint(record());
  const changes = [
    (value: ReturnType<typeof record>) => {
      value.channels.channel.state.sequence = '2';
    },
    (value: ReturnType<typeof record>) => {
      value.channels.channel.state.balance = '11';
    },
    (value: ReturnType<typeof record>) => {
      value.channels.channel.playerSignature = 'another';
    },
    (value: ReturnType<typeof record>) => {
      value.channels.channel.lastResponse.evidence.base.sequence = '2';
    },
    (value: ReturnType<typeof record>) => {
      value.channels.channel.pending = { signature: 'pending' };
    },
    (value: ReturnType<typeof record>) => {
      value.channels.channel.closing = true;
    },
    (value: ReturnType<typeof record>) => {
      value.transactionIntent = { raw: 'signed transaction' };
    },
    (value: ReturnType<typeof record>) => {
      value.history[0].proof.signature = 'another receipt';
    },
    (value: ReturnType<typeof record>) => {
      value.fund.statement.signature = 'another statement';
    },
    (value: ReturnType<typeof record>) => {
      value.fund.owed.push('4');
    },
    (value: ReturnType<typeof record>) => {
      value.bank.withdrawing = { signature: 'signed withdrawal' };
    },
    (value: ReturnType<typeof record>) => {
      value.bank.owed.push('5');
    },
    (value: ReturnType<typeof record>) => {
      value.developerBets.bet.state.payout = '4';
    },
  ];
  for (const change of changes) {
    const saved = record();
    change(saved);
    assert.notEqual(backupFingerprint(saved), baseline, String(change));
  }
});

test('only decrypting a file with the current account and evidence verifies a backup', async () => {
  const saved = record(),
    backup = await encryptBackup(contents(saved), password),
    reopened = JSON.parse(JSON.stringify(backup));
  assert.equal(await verifyBackupFile(reopened, password, account, saved), backupFingerprint(saved));
  await assert.rejects(verifyBackupFile(reopened, 'an incorrect passphrase', account, saved), /Incorrect passphrase/);
  for (const change of [
    { fundingKey: 'another key' },
    { address: account.casino },
    { chainId: '1' },
    { casino: account.address },
  ])
    await assert.rejects(
      verifyBackupFile(reopened, password, { ...account, ...change }, saved),
      /different wallet or deployment/,
    );
  const current = record();
  current.channels.channel.state.sequence = '2';
  await assert.rejects(verifyBackupFile(reopened, password, account, current), /current recovery evidence/);
  const corrupted = { ...reopened, data: reopened.data.slice(0, -4) + 'AAAA' };
  await assert.rejects(verifyBackupFile(corrupted, password, account, saved), /damaged wallet backup/);
});

test('backup fingerprint rejects records that cannot be restored', () => {
  for (const invalid of [
    null,
    {},
    { ...record(), schema: 'wrong' },
    { ...record(), channels: [] },
    { ...record(), history: null },
  ])
    assert.throws(() => backupFingerprint(invalid), /Unsupported backup wallet record/);
});
