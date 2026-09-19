/** Records are decoded at their owning wallet/game boundary. Callers can request a shape. */
export interface Store {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  commit(entries: Iterable<readonly [string, unknown]>): Promise<void>;
  update<T = any>(key: string, change: (value: T | undefined) => T): Promise<T>;
}
/** Serialize browser tabs with a Web Lock. Node instances run directly; atomic storage updates
 * serialize them. Without `wait`, a lock held by another tab runs `fn` with `held` false. */
export function withLock<T>(name: string, wait: boolean, fn: (held: boolean) => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, { ifAvailable: !wait }, lock => fn(Boolean(lock)));
  if (typeof window !== 'undefined') throw new Error('Secure browser Web Locks are required');
  return fn(true);
}
/** Browser records commit before signatures or results leave the trusted wallet. */
export class BrowserStore {
  declare db: IDBDatabase | undefined;

  async ready() {
    if (!this.db)
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('hookedin-wallet-v1');
        r.onupgradeneeded = () => r.result.createObjectStore('records');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    return this.db;
  }
  async get<T = any>(key: string): Promise<T | undefined> {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly'),
        r = tx.objectStore('records').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async commit(entries: Iterable<readonly [string, unknown]>) {
    const db = await this.ready();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite', {
        durability: 'strict',
      });
      for (const [key, value] of entries) tx.objectStore('records').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Wallet storage failed'));
    });
  }
  async put(key: string, value: unknown) {
    return this.commit([[key, value]]);
  }
  /** Synchronous read/modify/write in one transaction, including across tabs. */
  async update<T = any>(key: string, change: (value: T | undefined) => T): Promise<T> {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
      const records = tx.objectStore('records'),
        request = records.get(key);
      let value: T, failure: unknown;
      request.onsuccess = () => {
        try {
          value = change(request.result);
          if ((value as { then?: unknown } | null | undefined)?.then)
            throw new Error('Storage updates must be synchronous');
          records.put(value, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('Wallet storage failed'));
    });
  }
}
export class MemoryStore {
  declare records: Map<string, any>;
  declare beforeCommit: (() => void) | null | undefined;

  constructor() {
    this.records = new Map();
  }
  async get<T = any>(key: string): Promise<T | undefined> {
    return structuredClone(this.records.get(key));
  }
  async commit(entries: Iterable<readonly [string, unknown]>) {
    this.beforeCommit?.();
    for (const [k, v] of entries) this.records.set(k, structuredClone(v));
  }
  async put(key: string, value: unknown) {
    return this.commit([[key, value]]);
  }
  async update<T = any>(key: string, change: (value: T | undefined) => T): Promise<T> {
    const value = change(structuredClone(this.records.get(key)));
    if ((value as { then?: unknown } | null | undefined)?.then) throw new Error('Storage updates must be synchronous');
    this.beforeCommit?.();
    this.records.set(key, structuredClone(value));
    return structuredClone(value);
  }
}
