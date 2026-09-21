/** Records are decoded at their owning wallet/game boundary. Callers can request a shape. */
export interface Store {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  commit(entries: Iterable<readonly [string, unknown]>): Promise<void>;
  update<T = any>(key: string, change: (value: T | undefined) => T): Promise<T>;
}
/** Serialize browser tabs with a Web Lock. Node instances run directly; atomic storage updates
 * serialize them. Without `wait`, a lock held by another tab runs `fn` with `held` false; a number
 * waits that many milliseconds for it first, which outlasts another tab's brief observation. */
export function withLock<T>(name: string, wait: boolean | number, fn: (held: boolean) => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    if (typeof window !== 'undefined') throw new Error('Secure browser Web Locks are required');
    return fn(true);
  }
  if (typeof wait !== 'number') return locks.request(name, { ifAvailable: !wait }, lock => fn(Boolean(lock)));
  let granted = false;
  return locks
    .request(name, { signal: AbortSignal.timeout(wait) }, () => {
      granted = true;
      return fn(true);
    })
    .catch(error => {
      // Only the expired wait is the other tab's doing; an error from `fn` is its own.
      if (granted) throw error;
      return fn(false);
    });
}
/** Browser records commit before signatures or results leave the trusted wallet. */
export class BrowserStore {
  declare db: IDBDatabase | undefined;

  async ready() {
    // A blocked open fires neither success nor error, so it is answered here: every wallet read and
    // write waits on this one promise, and a silent wait looks exactly like a casino that is down.
    if (!this.db)
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('hookedin-wallet-v1');
        const stuck = setTimeout(
          () =>
            reject(
              new Error(
                'This browser is not letting the wallet open its storage. Close other HookedIn tabs and reload.',
              ),
            ),
          5000,
        );
        const settle = (finish: () => void) => {
          clearTimeout(stuck);
          finish();
        };
        r.onupgradeneeded = () => r.result.createObjectStore('records');
        r.onsuccess = () => settle(() => resolve(r.result));
        r.onerror = () => settle(() => reject(r.error));
        r.onblocked = () => settle(() => reject(new Error('Another tab has this wallet open. Close it and reload.')));
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
