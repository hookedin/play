/** Records are decoded at their owning wallet/game boundary. Callers can request a shape. */
export interface Store {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  commit(entries: Iterable<readonly [string, unknown]>): Promise<void>;
}
/** Where the records name the tab that has the wallet. */
const OWNER = 'owner';
/** Browser records commit before signatures or results leave the trusted wallet, and only from the tab that has it. */
export class BrowserStore {
  declare db: IDBDatabase | undefined;
  /** This tab's mark: the records carry it once the tab takes the wallet, and every write checks for it. */
  readonly owner = crypto.randomUUID();

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
  /** Take the wallet's records for this tab: from then on, only it writes them. */
  async claim() {
    const db = await this.ready();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
      tx.objectStore('records').put(this.owner, OWNER);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Wallet storage failed'));
    });
  }
  async commit(entries: Iterable<readonly [string, unknown]>) {
    const db = await this.ready();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite', { durability: 'strict' }),
        records = tx.objectStore('records'),
        owner = records.get(OWNER);
      let failure: Error | undefined;
      // Checked in the transaction that writes: a tab the wallet was taken from writes nothing, whatever it had under
      // way.
      owner.onsuccess = () => {
        if (owner.result === this.owner) for (const [key, value] of entries) records.put(value, key);
        else {
          failure = new Error('HookedIn is open in another tab.');
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('Wallet storage failed'));
    });
  }
  async put(key: string, value: unknown) {
    return this.commit([[key, value]]);
  }
  /** Delete every record: this tab writes nothing more. */
  async clear() {
    this.db?.close();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase('hookedin-wallet-v1');
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
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
}
