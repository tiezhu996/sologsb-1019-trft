import type { Checkpoint, LegacyCodingState, PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const STORE_NAME = 'snapshots';
const CHECKPOINT_STORE = 'checkpoints';
const LEGACY_SNAPSHOT_KEY = 'current';
export const LEGACY_STORAGE_KEY = 'sologsb-1019-state-v1';

export const LIBRARY_KEY = 'library';
export const REGISTRY_KEY = 'registry';
export const projectKey = (id: string) => `project:${id}`;
export const CHECKPOINT_KEY = 'pending';

/* ---- 故障注入：?failWrites=N 让接下来 N 次快照写入失败，用于验证检查点重试。
   检查点存放在独立 object store，不受注入影响，因此失败后总能恢复。 ---- */
let failNextWrites = 0;
try {
  failNextWrites = Number(new URLSearchParams(window.location.search).get('failWrites') ?? 0) || 0;
} catch { /* ignore */ }
export const armWriteFailure = (count = 1) => { failNextWrites = count; };

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) db.createObjectStore(CHECKPOINT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const getStore = async (storeName: string, mode: IDBTransactionMode) => {
  const db = await openDatabase();
  const tx = db.transaction(storeName, mode);
  return { db, tx, store: tx.objectStore(storeName) };
};

export async function readRecord<T>(key: string): Promise<T | null> {
  if (!('indexedDB' in window)) return null;
  const { db, tx, store } = await getStore(STORE_NAME, 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const envelope = request.result as PersistedEnvelope | undefined;
      resolve((envelope?.state as T) ?? null);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function readEnvelope(key: string): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const { db, tx, store } = await getStore(STORE_NAME, 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeEnvelope(envelope: PersistedEnvelope): Promise<void> {
  if (!('indexedDB' in window)) throw new Error('当前浏览器不支持 IndexedDB，无法持久化');
  if (failNextWrites > 0) {
    failNextWrites -= 1;
    throw new Error('模拟写入失败（failWrites 故障注入）');
  }
  const { db, tx, store } = await getStore(STORE_NAME, 'readwrite');
  await new Promise<void>((resolve, reject) => {
    store.put(envelope, envelope.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteRecord(key: string): Promise<void> {
  if (!('indexedDB' in window)) return;
  const { db, tx, store } = await getStore(STORE_NAME, 'readwrite');
  await new Promise<void>((resolve, reject) => {
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function readLegacySnapshot(): Promise<LegacyCodingState | null> {
  if (!('indexedDB' in window)) return null;
  const { db, tx, store } = await getStore(STORE_NAME, 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(LEGACY_SNAPSHOT_KEY);
    request.onsuccess = () => {
      const envelope = request.result as { state?: unknown } | undefined;
      const state = envelope?.state;
      resolve(state && typeof state === 'object' && Array.isArray((state as LegacyCodingState).themes) ? (state as LegacyCodingState) : null);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function deleteLegacySnapshot(): Promise<void> {
  if (!('indexedDB' in window)) return;
  const { db, tx, store } = await getStore(STORE_NAME, 'readwrite');
  await new Promise<void>((resolve, reject) => {
    store.delete(LEGACY_SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function readCheckpoint(): Promise<Checkpoint | null> {
  if (!('indexedDB' in window)) return null;
  const { db, tx, store } = await getStore(CHECKPOINT_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(CHECKPOINT_KEY);
    request.onsuccess = () => resolve((request.result as Checkpoint | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  if (!('indexedDB' in window)) throw new Error('当前浏览器不支持 IndexedDB，无法写入检查点');
  const { db, tx, store } = await getStore(CHECKPOINT_STORE, 'readwrite');
  await new Promise<void>((resolve, reject) => {
    store.put(checkpoint, CHECKPOINT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function clearCheckpoint(): Promise<void> {
  if (!('indexedDB' in window)) return;
  const { db, tx, store } = await getStore(CHECKPOINT_STORE, 'readwrite');
  await new Promise<void>((resolve, reject) => {
    store.delete(CHECKPOINT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
