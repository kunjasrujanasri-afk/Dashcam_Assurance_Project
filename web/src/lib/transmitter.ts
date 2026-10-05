/**
 * src/lib/transmitter.ts
 *
 * Store-and-forward transmission of segment hashes to the server.
 *
 * - Every signed record is first written to the persistent IndexedDB outbox,
 *   then sent. It is removed from the outbox only after the server confirms.
 * - Connectivity is judged by real request results, not only navigator.onLine
 *   (which is unreliable on phones: captive portals, weak signal, tunnels).
 * - Transient failures → exponential back-off (1 s … 30 s) + immediate retry
 *   when the browser fires "online".
 * - Inserts are idempotent (unique (session_id, seq) + ON CONFLICT DO NOTHING),
 *   so a retry after a lost acknowledgement never creates duplicates.
 * - A "simulate network loss" switch lets the demo cut the uplink on demand.
 */

import { OUTBOX_BACKOFF_MAX_MS, OUTBOX_BATCH_SIZE, OUTBOX_POLL_MS } from "./config";
import type { DeviceIdentity } from "./deviceIdentity";
import { registerDevice } from "./deviceIdentity";
import type { SegmentRecord } from "./integrity";
import { deleteOutbox, listOutbox, OutboxEntry, putOutbox, segmentKey, updateSegment } from "./localStore";
import { isTransientFailure, supabase } from "./supabaseClient";

export type LinkState = "online" | "offline" | "simulated_offline";

export interface TransmitterEvents {
  onLinkState?: (s: LinkState) => void;
  onSent?: (records: SegmentRecord[]) => void;
  onQueueChange?: (pending: number, rejected: number) => void;
  onLog?: (msg: string, level?: "info" | "warn" | "error") => void;
}

export class HashTransmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private running = false;
  private backoffMs = 0;
  private link: LinkState = "online";
  private simulatedOffline = false;

  constructor(private identity: DeviceIdentity, private ev: TransmitterEvents = {}) {}

  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    this.schedule(0);
  }

  stop() {
    this.running = false;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queue a signed record (persisted first) and try to send right away. */
  async enqueue(record: SegmentRecord) {
    const entry: OutboxEntry = {
      key: segmentKey(record.session_id, record.seq),
      record,
      queuedAt: Date.now(),
      attempts: 0,
    };
    await putOutbox(entry);
    await this.emitQueue();
    this.kick();
  }

  kick() {
    if (this.running && !this.busy) this.schedule(0);
  }

  setSimulatedOffline(v: boolean) {
    this.simulatedOffline = v;
    this.ev.onLog?.(v ? "Network loss simulated — uplink cut" : "Simulated network restored", v ? "warn" : "info");
    this.setLink(v ? "simulated_offline" : navigator.onLine ? "online" : "offline");
    if (!v) {
      this.backoffMs = 0;
      this.kick();
    }
  }

  get linkState() {
    return this.link;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private handleOnline = () => {
    this.ev.onLog?.("Browser reports connectivity restored — flushing outbox");
    this.backoffMs = 0;
    this.kick();
  };

  private handleOffline = () => {
    this.ev.onLog?.("Browser reports connectivity lost — buffering locally", "warn");
    if (!this.simulatedOffline) this.setLink("offline");
  };

  private setLink(s: LinkState) {
    if (s !== this.link) {
      this.link = s;
      this.ev.onLinkState?.(s);
    }
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pump(), ms);
  }

  private async emitQueue() {
    const all = await listOutbox();
    const rejected = all.filter((e) => e.rejected).length;
    this.ev.onQueueChange?.(all.length - rejected, rejected);
    return all;
  }

  private failTransient(reason: string) {
    this.setLink(this.simulatedOffline ? "simulated_offline" : "offline");
    this.backoffMs = Math.min(OUTBOX_BACKOFF_MAX_MS, this.backoffMs ? this.backoffMs * 2 : 1000);
    this.ev.onLog?.(`Uplink unavailable (${reason}) — retry in ${Math.round(this.backoffMs / 1000)} s`, "warn");
  }

  private async pump() {
    if (this.busy || !this.running) return;
    this.busy = true;
    let next = OUTBOX_POLL_MS;
    try {
      const all = await this.emitQueue();
      const pending = all.filter((e) => !e.rejected);
      if (pending.length === 0) return;

      if (this.simulatedOffline) {
        this.setLink("simulated_offline");
        return;
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        this.setLink("offline");
        return;
      }

      const reg = await registerDevice(this.identity);
      if (reg === "retry") {
        this.failTransient("device registration");
        next = this.backoffMs;
        return;
      }
      if (reg !== "ok") {
        this.ev.onLog?.(`Device registration refused: ${reg}`, "error");
        next = OUTBOX_BACKOFF_MAX_MS;
        return;
      }

      let sentTotal = 0;
      for (let i = 0; i < pending.length; i += OUTBOX_BATCH_SIZE) {
        if (this.simulatedOffline) break;
        const batch = pending.slice(i, i + OUTBOX_BATCH_SIZE);
        const ok = await this.sendBatch(batch);
        if (ok === "transient") {
          next = this.backoffMs;
          break;
        }
        sentTotal += ok;
      }
      if (sentTotal > 0) {
        const wasOffline = this.link !== "online";
        this.backoffMs = 0;
        this.setLink("online");
        if (wasOffline || sentTotal > 1)
          this.ev.onLog?.(`Transmitted ${sentTotal} buffered hash${sentTotal > 1 ? "es" : ""}`);
      }
      await this.emitQueue();
    } catch (e) {
      this.ev.onLog?.(`Transmitter error: ${(e as Error).message}`, "error");
    } finally {
      this.busy = false;
      this.schedule(next);
    }
  }

  /** Returns number of records confirmed, or "transient" if the link failed. */
  private async sendBatch(batch: OutboxEntry[]): Promise<number | "transient"> {
    const rows = batch.map((e) => e.record);
    const { error, status } = await supabase
      .from("video_segments")
      .upsert(rows, { onConflict: "session_id,seq", ignoreDuplicates: true });

    if (!error) {
      for (const e of batch) {
        await deleteOutbox(e.key);
        await updateSegment(e.key, { sent: true });
      }
      this.ev.onSent?.(rows);
      return batch.length;
    }

    if (isTransientFailure(status)) {
      for (const e of batch) await putOutbox({ ...e, attempts: e.attempts + 1, lastError: error.message });
      this.failTransient(error.message);
      return "transient";
    }

    // Permanent rejection: isolate the faulty row(s) by sending one by one.
    if (batch.length > 1) {
      let n = 0;
      for (const e of batch) {
        const r = await this.sendBatch([e]);
        if (r === "transient") return "transient";
        n += r;
      }
      return n;
    }
    const e = batch[0];
    await putOutbox({ ...e, attempts: e.attempts + 1, lastError: error.message, rejected: true });
    this.ev.onLog?.(`Server rejected segment #${e.record.seq}: ${error.message}`, "error");
    return 0;
  }
}
