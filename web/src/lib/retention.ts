/**
 * src/lib/retention.ts — loop-recording data lifecycle on the phone
 *
 * A dashcam records continuously, so storage must be recycled. A segment is
 * considered "no longer valid" once it is older than the retention period
 * and is then deleted from the phone, unless it has been locked by an
 * incident (the driver pressed "Incident" around that time).
 *
 * Hashes are NOT deleted by this: pending hashes stay in the outbox until the
 * server acknowledges them, so the server-side chain is always complete. On
 * the server, hashes expire after segment_retention() (see schema.sql).
 */

import { MAX_LOCAL_SEGMENTS } from "./config";
import { deleteSegment, listSegments, LocalSegment, updateSegment } from "./localStore";

export interface RetentionResult {
  deleted: LocalSegment[];
  kept: LocalSegment[];
}

export async function applyRetention(retentionMs: number, now = Date.now()): Promise<RetentionResult> {
  const all = await listSegments();
  const deleted: LocalSegment[] = [];
  const kept: LocalSegment[] = [];

  for (const s of all) {
    if (!s.locked && s.record.ended_at < now - retentionMs) deleted.push(s);
    else kept.push(s);
  }

  // Storage guard: never keep more than MAX_LOCAL_SEGMENTS unlocked segments.
  const unlocked = kept.filter((s) => !s.locked);
  const overflow = kept.length - MAX_LOCAL_SEGMENTS;
  if (overflow > 0) {
    const victims = new Set(unlocked.slice(0, overflow).map((s) => s.key));
    for (let i = kept.length - 1; i >= 0; i--) {
      if (victims.has(kept[i].key)) deleted.push(...kept.splice(i, 1));
    }
  }

  for (const s of deleted) await deleteSegment(s.key);
  return { deleted, kept };
}

/** Lock every stored segment overlapping [from, to]. Returns how many. */
export async function lockRange(from: number, to: number): Promise<number> {
  let n = 0;
  for (const s of await listSegments()) {
    if (!s.locked && s.record.ended_at >= from && s.record.started_at <= to) {
      await updateSegment(s.key, { locked: true });
      n++;
    }
  }
  return n;
}

export async function setLocked(key: string, locked: boolean) {
  await updateSegment(key, { locked });
}
