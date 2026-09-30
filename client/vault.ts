import { BrowserStore, withLock } from './storage.ts';
import type { Store } from './storage.ts';

const metadataKey = 'wallet-vault',
  proof = 'HOOKEDIN/WALLET-VAULT',
  text = new TextEncoder();
type Sealed = { iv: string; data: string };
type Metadata = Sealed & { salt: string };
const protectedKey = (key: string) => key.startsWith('funding-accounts:');
/** Bytes as base64, a chunk at a time, so no call takes more arguments than an engine allows. */
export const base64 = (data: Uint8Array) => {
  let result = '';
  for (let i = 0; i < data.length; i += 24576) result += btoa(String.fromCharCode(...data.slice(i, i + 24576)));
  return result;
};
export const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** The key a passphrase stands for with a salt: what the vault and every backup encrypt with. */
export async function passphraseKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Use a passphrase of 12–1024 characters');
  if (salt.length !== 16) throw new Error('Invalid encryption parameters');
  const material = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, name: string, value: unknown): Promise<Sealed> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Wallet keys must be serializable');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: text.encode(`${proof}:${name}`) },
    key,
    text.encode(serialized),
  );
  return { iv: base64(iv), data: base64(new Uint8Array(data)) };
}

async function unseal<T>(key: CryptoKey, name: string, value: Sealed): Promise<T> {
  if (!value || typeof value.iv !== 'string' || typeof value.data !== 'string')
    throw new Error('Invalid encrypted wallet record');
  const iv = bytes(value.iv);
  if (iv.length !== 12) throw new Error('Invalid encryption parameters');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: text.encode(`${proof}:${name}`) },
    key,
    bytes(value.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Encrypt account keys at rest; signed settlement evidence stays readable while locked.
 * Locking drops this tab's encryption key. The UI must also discard its live wallet signer. */
export class VaultStore implements Store {
  #key: CryptoKey | null = null;
  #epoch = 0;
  readonly storage: Store;

  constructor(storage: Store = new BrowserStore()) {
    this.storage = storage;
  }

  get locked() {
    return !this.#key;
  }

  async hasPassphrase() {
    return (await this.storage.get(metadataKey)) !== undefined;
  }

  async setup(password: string) {
    const epoch = this.#epoch,
      salt = crypto.getRandomValues(new Uint8Array(16)),
      key = await passphraseKey(password, salt),
      metadata: Metadata = { salt: base64(salt), ...(await seal(key, metadataKey, proof)) };
    if (epoch !== this.#epoch) throw new Error('Wallet is locked');
    await this.storage.update(metadataKey, saved => {
      if (saved !== undefined) throw new Error('Wallet already has a passphrase. Unlock it instead.');
      return metadata;
    });
    if (epoch !== this.#epoch) throw new Error('Wallet is locked');
    this.#key = key;
  }

  async #check(password: string) {
    const metadata = await this.storage.get<Metadata>(metadataKey);
    if (!metadata) throw new Error('Set a wallet passphrase first');
    const key = await passphraseKey(password, bytes(metadata.salt));
    try {
      if ((await unseal(key, metadataKey, metadata)) !== proof) throw new Error('Invalid wallet proof');
    } catch {
      throw new Error('Incorrect wallet passphrase or damaged wallet storage');
    }
    return key;
  }

  async unlock(password: string) {
    const epoch = this.#epoch,
      key = await this.#check(password);
    if (epoch !== this.#epoch) throw new Error('Wallet is locked');
    this.#key = key;
  }

  /** Reauthenticate without changing this tab's lock state. */
  async verify(password: string) {
    await this.#check(password);
  }

  lock() {
    this.#key = null;
    this.#epoch++;
  }

  #requireKey() {
    if (!this.#key) throw new Error('Unlock your wallet first');
    return this.#key;
  }

  #stillUnlocked(key: CryptoKey) {
    if (this.#key !== key) throw new Error('Wallet is locked');
  }

  async get<T = any>(name: string): Promise<T | undefined> {
    if (!protectedKey(name)) return this.storage.get<T>(name);
    const key = this.#requireKey(),
      saved = await this.storage.get<Sealed>(name),
      value = saved === undefined ? undefined : await unseal<T>(key, name, saved);
    this.#stillUnlocked(key);
    return value;
  }

  async put(name: string, value: unknown) {
    await this.commit([[name, value]]);
  }

  /** Keys are written only through `update`, which encrypts them. */
  async commit(entries: Iterable<readonly [string, unknown]>) {
    const values = Array.from(entries);
    if (values.some(([name]) => protectedKey(name))) throw new Error('Wallet keys are saved only by update');
    await this.storage.commit(values);
  }

  /** A key's read, change and encrypted write, one tab at a time. */
  async update<T = any>(name: string, change: (value: T | undefined) => T): Promise<T> {
    if (!protectedKey(name)) return this.storage.update(name, change);
    const key = this.#requireKey();
    return withLock('hookedin:vault', true, async () => {
      const saved = await this.storage.get<Sealed>(name),
        value = saved === undefined ? undefined : await unseal<T>(key, name, saved);
      this.#stillUnlocked(key);
      const next = change(value);
      if ((next as { then?: unknown } | null | undefined)?.then) throw new Error('Storage updates must be synchronous');
      const encrypted = await seal(key, name, next);
      this.#stillUnlocked(key);
      await this.storage.put(name, encrypted);
      return structuredClone(next);
    });
  }
}
