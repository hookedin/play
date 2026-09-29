import { sha256, toUtf8Bytes } from 'ethers';
import { canonicalJSON, same } from '../protocol/protocol.ts';
import { decryptBackup } from './backup.ts';

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

export interface BackupAccount {
  fundingKey: string;
  address: string;
  chainId: string | bigint;
  casino: string;
}

/** Call with a reopened file and the record held by wallet.withSavedRecord. This proves the file decrypts
 * and contains this account's current recovery contents; downloading alone does not verify a backup. */
export async function verifyBackupFile(
  backup: Parameters<typeof decryptBackup>[0],
  password: string,
  expected: BackupAccount,
  currentRecord: any,
): Promise<string> {
  const value = await decryptBackup(backup, password);
  if (
    value?.schema !== 'HOOKEDIN/WALLET/1' ||
    value.scope !== 'selected-account' ||
    value.chainId !== String(expected.chainId) ||
    !same(value.casino, expected.casino) ||
    !same(value.address, expected.address) ||
    !same(value.fundingKey, expected.fundingKey)
  )
    throw new Error('This backup belongs to a different wallet or deployment');
  const fingerprint = backupFingerprint(currentRecord);
  if (backupFingerprint(value.record) !== fingerprint)
    throw new Error('This backup does not contain your current recovery evidence. Download and verify a fresh backup.');
  return fingerprint;
}
