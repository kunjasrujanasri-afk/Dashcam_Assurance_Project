/**
 * src/lib/localStore.ts
 *
 * Persistent storage on the phone (IndexedDB), dependency-free.
 *
 *  kv        – device identity (id + non-extractable ECDSA key pair)
 *  segments  – recorded video segments (Blob) + their signed record
 *  outbox    – signed records waiting to be transmitted to the server
 *
 * Everything survives page reloads, crashes and loss of network, which is
 * what makes the "store-and-forward" transmission reliable.
 */

import type { SegmentRecord } from "./integrity";

const DB_NAME = "dashcam-encoder";
const DB_VERSION = 1;

export interface LocalSegment {
  key: string; // `${session_id}:${seq padded}`
  record: SegmentRecord;
  blob: Blob;
  fileName: string;
  locked: boolean; // protected from retention (incident)
  sent: boolean; // hash acknowledged by the server
}

export interface OutboxEntry {
  key: string;
  record: SegmentRecord;
  queuedAt: number;
  attempts: number;
  lastError?: string;
  rejected?: boolean; // permanently refused by the server
}

export const segmentKey = (sessionId: string, seq: number) =>
  `${sessionId}:${String(seq).padStart(6, "0")}`;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "key" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      })
  );
}

// ── kv ───────────────────────────────────────────────────────────────────────
export const kvGet = <T>(key: string) => run<T | undefined>("kv", "readonly", (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => run<IDBValidKey>("kv", "readwrite", (s) => s.put(value, key));

// ── segments ─────────────────────────────────────────────────────────────────
export const putSegment = (seg: LocalSegment) => run<IDBValidKey>("segments", "readwrite", (s) => s.put(seg));
export const getSegment = (key: string) => run<LocalSegment | undefined>("segments", "readonly", (s) => s.get(key));
export const deleteSegment = (key: string) => run<undefined>("segments", "readwrite", (s) => s.delete(key));
export const listSegments = () =>
  run<LocalSegment[]>("segments", "readonly", (s) => s.getAll()).then((a) =>
    a.sort((x, y) => x.record.started_at - y.record.started_at)
  );

export async function updateSegment(key: string, patch: Partial<LocalSegment>): Promise<void> {
  const cur = await getSegment(key);
  if (cur) await putSegment({ ...cur, ...patch });
}

// ── outbox ───────────────────────────────────────────────────────────────────
export const putOutbox = (e: OutboxEntry) => run<IDBValidKey>("outbox", "readwrite", (s) => s.put(e));
export const deleteOutbox = (key: string) => run<undefined>("outbox", "readwrite", (s) => s.delete(key));
export const listOutbox = () =>
  run<OutboxEntry[]>("outbox", "readonly", (s) => s.getAll()).then((a) =>
    a.sort((x, y) => x.queuedAt - y.queuedAt || x.key.localeCompare(y.key))
  );

/** Wipe all recordings and pending hashes (keeps the device identity). */
export async function clearRecordings(): Promise<void> {
  await run("segments", "readwrite", (s) => s.clear());
  await run("outbox", "readwrite", (s) => s.clear());
}
