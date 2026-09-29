import { BrowserStore, withLock } from './storage.ts';
import type { Store } from './storage.ts';

const metadataKey = 'wallet-vault',
  proof = 'HOOKEDIN/WALLET-VAULT',
  text = new TextEncoder(),
  conflict = new Error('Encrypted wallet record changed');
type Sealed = { iv: string; data: string };
type Metadata = Sealed & { salt: string };
const protectedKey = (key: string) => key.startsWith('funding-accounts:');
const encode = (bytes: Uint8Array) => {
  let result = '';
  for (let i = 0; i < bytes.length; i += 24576) result += btoa(String.fromCharCode(...bytes.slice(i, i + 24576)));
  return result;
};
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Use a wallet passphrase of 12–1024 characters');
  if (salt.length !== 16) throw new Error('Invalid wallet encryption parameters');
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
  return { iv: encode(iv), data: encode(new Uint8Array(data)) };
}

async function unseal<T>(key: CryptoKey, name: string, value: Sealed): Promise<T> {
  if (!value || typeof value.iv !== 'string' || typeof value.data !== 'string')
    throw new Error('Invalid encrypted wallet record');
  const iv = decode(value.iv);
  if (iv.length !== 12) throw new Error('Invalid wallet encryption parameters');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: text.encode(`${proof}:${name}`) },
    key,
    decode(value.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Encrypt funding keys at rest; signed settlement evidence stays readable while locked.
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
      key = await derive(password, salt),
      metadata: Metadata = { salt: encode(salt), ...(await seal(key, metadataKey, proof)) };
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
    const key = await derive(password, decode(metadata.salt));
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

  async commit(entries: Iterable<readonly [string, unknown]>) {
    const values = Array.from(entries);
    if (!values.some(([name]) => protectedKey(name))) return this.storage.commit(values);
    const key = this.#requireKey();
    await withLock('hookedin:vault', true, async () => {
      const encrypted = await Promise.all(
        values.map(async ([name, value]) => [name, protectedKey(name) ? await seal(key, name, value) : value] as const),
      );
      this.#stillUnlocked(key);
      await this.storage.commit(encrypted);
    });
  }

  async update<T = any>(name: string, change: (value: T | undefined) => T): Promise<T> {
    if (!protectedKey(name)) return this.storage.update(name, change);
    const key = this.#requireKey();
    return withLock('hookedin:vault', true, async () => {
      for (;;) {
        const saved = await this.storage.get<Sealed>(name),
          value = saved === undefined ? undefined : await unseal<T>(key, name, saved);
        this.#stillUnlocked(key);
        const next = change(value);
        if ((next as { then?: unknown } | null | undefined)?.then)
          throw new Error('Storage updates must be synchronous');
        const encrypted = await seal(key, name, next);
        this.#stillUnlocked(key);
        try {
          // Crypto completes before the transaction starts. Compare within the atomic update
          // so callers without Web Locks also preserve concurrent imports and selections.
          await this.storage.update<Sealed>(name, current => {
            if (JSON.stringify(current) !== JSON.stringify(saved)) throw conflict;
            return encrypted;
          });
          this.#stillUnlocked(key);
          return structuredClone(next);
        } catch (error) {
          if (error !== conflict) throw error;
        }
      }
    });
  }
}
