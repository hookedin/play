import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { MemoryStore } from '../client/storage.ts';
import { VaultStore } from '../client/vault.ts';
import { fundingAccounts, readFundingAccounts } from '../client/funding-accounts.ts';

const password = 'a separate wallet passphrase',
  otherPassword = 'a different wallet passphrase',
  name = 'funding-accounts:1:31337';

test('funding keys are encrypted at rest and evidence remains available while locked', async () => {
  const storage = new MemoryStore(),
    vault = new VaultStore(storage);
  assert.equal(vault.locked, true);
  assert.equal(await vault.hasPassphrase(), false);
  await assert.rejects(fundingAccounts(vault, 31337, { create: true }), /Unlock your wallet/);
  await vault.setup(password);
  const saved = await fundingAccounts(vault, 31337, { create: true });
  await vault.put('wallet:state', { signedEvidence: 'available' });
  const persisted = JSON.stringify([...storage.records]);
  assert.ok(!persisted.includes(saved.accounts[saved.selected!]));
  assert.ok(!persisted.includes(password));
  assert.equal(vault.locked, false);
  assert.equal(await vault.hasPassphrase(), true);
  vault.lock();
  assert.deepEqual(await vault.get('wallet:state'), { signedEvidence: 'available' });
  await assert.rejects(readFundingAccounts(vault, 31337), /Unlock your wallet/);
  await assert.rejects(vault.put(name, saved), /Unlock your wallet/);
  await assert.rejects(vault.unlock(otherPassword), /Incorrect wallet passphrase/);
  assert.equal(vault.locked, true);
  await vault.verify(password);
  assert.equal(vault.locked, true, 'verification must not silently unlock a session');
  await vault.unlock(password);
  assert.deepEqual(await readFundingAccounts(vault, 31337), saved);
});

test('concurrent first-run tabs keep one passphrase and one selected funding account', async () => {
  const storage = new MemoryStore(),
    a = new VaultStore(storage),
    b = new VaultStore(storage);
  const setup = await Promise.allSettled([a.setup(password), b.setup(otherPassword)]);
  assert.equal(setup.filter(result => result.status === 'fulfilled').length, 1);
  const winnerPassword = setup[0].status === 'fulfilled' ? password : otherPassword;
  await Promise.all([a.unlock(winnerPassword), b.unlock(winnerPassword)]);
  const [first, second] = await Promise.all([
    fundingAccounts(a, 31337, { create: true }),
    fundingAccounts(b, 31337, { create: true }),
  ]);
  assert.equal(first.selected, second.selected);
  assert.equal(Object.keys((await readFundingAccounts(a, 31337)).accounts).length, 1);
  const imported = [Wallet.createRandom(), Wallet.createRandom()];
  await Promise.all([
    fundingAccounts(a, 31337, { privateKeys: [imported[0].privateKey] }),
    fundingAccounts(b, 31337, { privateKeys: [imported[1].privateKey], select: true }),
  ]);
  const final = await readFundingAccounts(a, 31337);
  assert.equal(Object.keys(final.accounts).length, 3);
  assert.equal(final.selected, imported[1].address);
  assert.equal(final.accounts[imported[0].address], imported[0].privateKey);
  assert.equal(final.accounts[imported[1].address], imported[1].privateKey);
  a.lock();
  assert.deepEqual(await readFundingAccounts(b, 31337), final, 'each tab owns its unlock session');
});

test('mixed commits keep evidence and encrypted keys atomic when persistence fails', async () => {
  const storage = new MemoryStore(),
    vault = new VaultStore(storage);
  await vault.setup(password);
  await vault.commit([
    [name, { key: 'initial private key' }],
    ['wallet:evidence', { sequence: 1 }],
  ]);
  storage.beforeCommit = () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(
    vault.commit([
      [name, { key: 'updated private key' }],
      ['wallet:evidence', { sequence: 2 }],
    ]),
    /storage unavailable/,
  );
  assert.deepEqual(await vault.get(name), { key: 'initial private key' });
  assert.deepEqual(await vault.get('wallet:evidence'), { sequence: 1 });
  storage.beforeCommit = null;
  await assert.rejects(
    vault.update(name, async () => 'secret'),
    /must be synchronous/,
  );
  assert.deepEqual(await vault.get(name), { key: 'initial private key' });
});

test('ciphertexts are authenticated and bound to the funding account record', async () => {
  const storage = new MemoryStore(),
    vault = new VaultStore(storage);
  await vault.setup(password);
  await vault.put(name, { key: 'private key' });
  await storage.put('funding-accounts:1:11155111', await storage.get(name));
  await assert.rejects(vault.get('funding-accounts:1:11155111'));
  const sealed = await storage.get(name);
  await storage.put(name, { ...sealed, data: sealed.data.slice(0, -4) + 'AAAA' });
  await assert.rejects(vault.get(name));
  await storage.put(name, { selected: 'address', accounts: { address: 'plaintext' } });
  await assert.rejects(vault.get(name), /Invalid encrypted wallet record/);
});

test('lock cancels pending setup, unlock, reads and updates', async () => {
  const storage = new MemoryStore(),
    vault = new VaultStore(storage);
  const setup = vault.setup(password);
  vault.lock();
  await assert.rejects(setup, /Wallet is locked/);
  assert.equal(await vault.hasPassphrase(), false);
  await vault.setup(password);
  await vault.put(name, { key: 'private key' });
  const read = vault.get(name);
  vault.lock();
  await assert.rejects(read, /Wallet is locked/);
  const unlock = vault.unlock(password);
  vault.lock();
  await assert.rejects(unlock, /Wallet is locked/);
  assert.equal(vault.locked, true);
  await vault.unlock(password);
  await assert.rejects(
    vault.update(name, () => {
      vault.lock();
      return { key: 'must not persist' };
    }),
    /Wallet is locked/,
  );
  await vault.unlock(password);
  assert.deepEqual(await vault.get(name), { key: 'private key' });
});

test('passphrase validation leaves a fresh vault untouched', async () => {
  const storage = new MemoryStore(),
    vault = new VaultStore(storage);
  for (const invalid of ['short', 'x'.repeat(1025)]) await assert.rejects(vault.setup(invalid), /12–1024 characters/);
  assert.equal(await vault.hasPassphrase(), false);
  await assert.rejects(vault.unlock(password), /Set a wallet passphrase first/);
  assert.equal(storage.records.size, 0);
});
