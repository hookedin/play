const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const aad = new TextEncoder().encode('HOOKEDIN/WALLET-BACKUP/1');
async function key(password: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Use a backup passphrase of 12–1024 characters');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}
export async function encryptBackup(value: unknown, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Backup exceeds 16 MiB');
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      await key(password, salt, 'encrypt'),
      bytes,
    ),
  );
  // Chunk encoding avoids spread/argument limits for real wallet histories.
  let data = '';
  for (let i = 0; i < ciphertext.length; i += 24576) data += encode(ciphertext.slice(i, i + 24576));
  return {
    schema: 'HOOKEDIN/WALLET-BACKUP/1',
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    salt: encode(salt),
    iv: encode(iv),
    data,
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
  const salt = decode(backup.salt),
    iv = decode(backup.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid backup parameters');
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      await key(password, salt, 'decrypt'),
      decode(backup.data),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Incorrect passphrase or damaged wallet backup');
  }
}
