import type { PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const LEGACY_STORE = 'snapshots';
const STORES = ['projects', 'codebook', 'meta', 'checkpoint'] as const;
export type StoreName = (typeof STORES)[number] | typeof LEGACY_STORE;
const LEGACY_SNAPSHOT_KEY = 'current';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 旧库保留，仅作首次迁移读取；不再写入。
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE);
      STORES.forEach((name) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name); });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function dbRead<T>(store: StoreName, key: string): Promise<PersistedEnvelope<T> | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result as PersistedEnvelope<T> | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function dbWrite<T>(store: StoreName, key: string, envelope: PersistedEnvelope<T>): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(envelope, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

interface BatchItem {
  store: Exclude<StoreName, typeof LEGACY_STORE>;
  key: string;
  envelope: PersistedEnvelope;
}
/** 多仓库原子提交：检查点重试 / 回写依赖“要么全部成功，要么全部不留”。 */
export async function dbWriteBatch(items: BatchItem[]): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const storeNames = [...new Set(items.map((item) => item.store))];
      const tx = db.transaction(storeNames, 'readwrite');
      items.forEach((item) => tx.objectStore(item.store).put(item.envelope, item.key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** v1 单库快照（迁移用），state 为旧版 CodingState。 */
export interface LegacyEnvelope {
  revision: number;
  updatedAt: string;
  writerId?: string;
  state: Record<string, unknown>;
}

/** 读取 v1 单库快照（迁移用）。 */
export async function dbReadLegacySnapshot(): Promise<LegacyEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LEGACY_STORE, 'readonly');
      const request = tx.objectStore(LEGACY_STORE).get(LEGACY_SNAPSHOT_KEY);
      request.onsuccess = () => {
        const result = request.result as LegacyEnvelope | undefined;
        resolve(result && typeof result.revision === 'number' && result.state ? result : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
