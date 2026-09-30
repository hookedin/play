import { Wallet, sha256, toUtf8Bytes } from 'ethers';
import type { Integer } from '../protocol/types.ts';
import { canonicalJSON, same } from '../protocol/protocol.ts';
import { base64, bytes, passphraseKey } from './vault.ts';

const aad = new TextEncoder().encode('HOOKEDIN/WALLET-BACKUP/1');
export async function encryptBackup(value: unknown, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.length > 16 * 1024 * 1024) throw new Error('Backup exceeds 16 MiB');
  const key = await passphraseKey(password, salt),
    data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return {
    schema: 'HOOKEDIN/WALLET-BACKUP/1',
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    salt: base64(salt),
    iv: base64(iv),
    data: base64(new Uint8Array(data)),
  };
}
export async function decryptBackup(backup: Awaited<ReturnType<typeof encryptBackup>>, password: string) {
  if (
    backup.schema !== 'HOOKEDIN/WALLET-BACKUP/1' ||
    backup.kdf !== 'PBKDF2-SHA256' ||
    backup.iterations !== 600000 ||
    typeof backup.data !== 'string' ||
    backup.data.length > 24 * 1024 * 1024
  )
    throw new Error('Unsupported encrypted wallet backup');
  const iv = bytes(backup.iv);
  if (iv.length !== 12) throw new Error('Invalid backup parameters');
  const key = await passphraseKey(password, bytes(backup.salt));
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      bytes(backup.data),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Incorrect passphrase or damaged wallet backup');
  }
}
/** A backup's contents, once its passphrase opens it: one account's key and saved record, on this deployment. */
export async function openBackup(backup: any, password: string, deployment: { chainId: Integer; casino: string }) {
  const value = await decryptBackup(backup, password);
  if (
    value?.schema !== 'HOOKEDIN/WALLET/1' ||
    value.scope !== 'selected-account' ||
    value.chainId !== String(deployment.chainId) ||
    !same(value.casino, deployment.casino) ||
    value.record?.schema !== 'HOOKEDIN/WALLET-STATE/1' ||
    typeof value.fundingKey !== 'string' ||
    !same(new Wallet(value.fundingKey).address, value.address)
  )
    throw new Error('This backup belongs to a different wallet or deployment');
  return value;
}

const without = (value: Record<string, any>, fields: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));

/** Identify recovery contents, independently of observations the wallet can read again from the chain. */
export function backupFingerprint(record: any): string {
  if (
    record?.schema !== 'HOOKEDIN/WALLET-STATE/1' ||
    !record.channels ||
    typeof record.channels !== 'object' ||
    Array.isArray(record.channels) ||
    !Array.isArray(record.history)
  )
    throw new Error('Unsupported backup wallet record');
  const contents = {
    ...without(record, ['revision', 'developerBetCursor', 'controls', 'autoDeposit']),
    channels: Object.fromEntries(
      Object.entries(record.channels).map(([id, channel]) => [
        id,
        without(channel as Record<string, any>, ['onchain', 'claim', 'observedAt', 'round', 'registered']),
      ]),
    ),
    // A withdrawal's standing on-chain, where it pays included, is read again from the contract.
    history: record.history.map((receipt: any) =>
      without(receipt, [
        'recorded',
        'paid',
        'owed',
        'winningsRemaining',
        'collectable',
        'recordedIn',
        'returned',
        'settledAt',
        'to',
        'blockHash',
        'blockNumber',
        'previousStatus',
      ]),
    ),
    fund: without(record.fund ?? {}, ['alert']),
    developerBets: Object.fromEntries(
      Object.entries(record.developerBets ?? {}).map(([id, bet]) => [
        id,
        without(bet as Record<string, any>, ['error']),
      ]),
    ),
  };
  return sha256(toUtf8Bytes(canonicalJSON(contents)));
}

/** Call with a reopened file and the record held by wallet.withSavedRecord. This proves the file decrypts
 * and contains this account's current recovery contents; downloading alone does not verify a backup. */
export async function verifyBackupFile(
  backup: Parameters<typeof decryptBackup>[0],
  password: string,
  expected: { fundingKey: string; address: string; chainId: Integer; casino: string },
  currentRecord: any,
): Promise<string> {
  const value = await openBackup(backup, password, expected);
  if (!same(value.address, expected.address) || !same(value.fundingKey, expected.fundingKey))
    throw new Error('This backup belongs to a different wallet or deployment');
  const fingerprint = backupFingerprint(currentRecord);
  if (backupFingerprint(value.record) !== fingerprint)
    throw new Error('This backup does not contain your current recovery evidence. Download and verify a fresh backup.');
  return fingerprint;
}
