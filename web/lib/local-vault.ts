import type { SignedFingerprint } from "./signed-evidence";

const DB_NAME = "dashcam-assurance-vault";
const DB_VERSION = 1;
export type LocalSegment = {
  id: string; sessionId: string; deviceId: string; workspaceId: string; sequence: number;
  capturedAt: string; blob: Blob; mimeType: string; fingerprint: SignedFingerprint;
  state: "LOCAL" | "QUEUED" | "SENDING" | "FAILED" | "SENT";
  locked: boolean; incidentId: string | null; fingerprintId?: string; storagePath?: string;
  attempts: number; lastError?: string;
};
export type VerificationAttempt = { id: string; workspaceId: string; actorId: string; kind: string; status: string; name: string; details: Record<string, unknown>; createdAt: string };

function openVault() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("segments")) { const s = db.createObjectStore("segments", { keyPath: "id" }); s.createIndex("deviceId", "deviceId"); s.createIndex("capturedAt", "capturedAt"); }
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) { const s = db.createObjectStore("outbox", { keyPath: "id" }); s.createIndex("deviceId", "deviceId"); }
      if (!db.objectStoreNames.contains("history")) { const s = db.createObjectStore("history", { keyPath: "id" }); s.createIndex("workspaceId", "workspaceId"); s.createIndex("createdAt", "createdAt"); }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local evidence storage."));
  });
}

async function transact<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openVault();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, mode), request = action(tx.objectStore(storeName));
      if (request) { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }
      else tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function putSegment(segment: LocalSegment) { await transact("segments", "readwrite", s => s.put(segment)); }
export async function getSegment(id: string) { return await transact<LocalSegment>("segments", "readonly", s => s.get(id)); }
export async function listSegments(deviceId: string) {
  const all = await transact<LocalSegment[]>("segments", "readonly", s => s.index("deviceId").getAll(deviceId));
  return (all ?? []).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
}
export async function saveKeyPair(id: string, privateKey: CryptoKey, publicKey: CryptoKey, publicJwk: JsonWebKey) {
  await transact("keys", "readwrite", s => s.put({ id, privateKey, publicKey, publicJwk }));
}
export async function loadKeyPair(id: string) { return await transact<{ id: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey }>("keys", "readonly", s => s.get(id)); }
export async function enqueueSegment(segment: LocalSegment) { await transact("outbox", "readwrite", s => s.put({ id: segment.id, deviceId: segment.deviceId, fingerprint: segment.fingerprint, attempts: segment.attempts ?? 0, queuedAt: new Date().toISOString(), lastError: segment.lastError ?? null })); }
export async function listOutbox(deviceId: string) { return await transact<Array<{ id: string; fingerprint: SignedFingerprint; attempts: number; queuedAt: string; lastError?: string }>>("outbox", "readonly", s => s.index("deviceId").getAll(deviceId)) ?? []; }
export async function removeOutbox(id: string) { await transact("outbox", "readwrite", s => s.delete(id)); }
export async function updateOutbox(id: string, fields: Record<string, unknown>) {
  const db = await openVault();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("outbox", "readwrite"), store = tx.objectStore("outbox"), request = store.get(id); request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...fields }); }; request.onerror = () => reject(request.error); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
}
export async function addLocalAttempt(attempt: VerificationAttempt) { await transact("history", "readwrite", s => s.put(attempt)); }
export async function listLocalAttempts(workspaceId: string) { return await transact<VerificationAttempt[]>("history", "readonly", s => s.index("workspaceId").getAll(workspaceId)) ?? []; }
export async function removeLocalAttempt(id: string) { await transact("history", "readwrite", s => s.delete(id)); }
export async function deleteSegments(ids: string[]) {
  const db = await openVault();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(["segments", "outbox"], "readwrite"); const videos = tx.objectStore("segments"), queue = tx.objectStore("outbox"); ids.forEach(id => { videos.delete(id); queue.delete(id); }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
}
export async function purgeExpired(deviceId: string, retentionMinutes: number) {
  const records = await listSegments(deviceId), cutoff = Date.now() - retentionMinutes * 60_000;
  const expired = records.filter(record => !record.locked && record.state === "SENT" && Date.parse(record.capturedAt) < cutoff);
  await deleteSegments(expired.map(record => record.id));
  return expired.length;
}
