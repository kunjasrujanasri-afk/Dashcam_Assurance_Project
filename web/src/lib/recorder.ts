/**
 * src/lib/recorder.ts — Dashcam recording engine (Encoder core)
 *
 * Pipeline:
 *
 *   camera (getUserMedia) ──► <video> ──► frame acquisition @ CAPTURE_FPS
 *        ──► composition on <canvas> (frame + burnt-in timestamp/GPS/ids overlay)
 *        ──► canvas.captureStream() ──► MediaRecorder
 *        ──► fixed-length segments (independent, playable video files)
 *        ──► SHA-256(segment bytes) ──► hash chain ──► ECDSA signature
 *        ──► IndexedDB (video, loop-recording) + outbox (hash transmission)
 *
 * Segments are produced with two overlapping MediaRecorders (the next one is
 * started before the previous one is stopped) so that no footage is lost at
 * segment boundaries. Finalisation is serialised through a promise queue so
 * the hash chain is always built in capture order.
 */

import {
  CAPTURE_FPS,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  VIDEO_BITS_PER_SECOND,
} from "./config";
import type { DeviceIdentity } from "./deviceIdentity";
import { buildSignedRecord, genesisHash, hashBlob, segmentFileName, SegmentCore } from "./integrity";
import { LocalSegment, putSegment, segmentKey } from "./localStore";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not supported by this browser.");
  const m = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!m) throw new Error("No supported video container (WebM/MP4) for MediaRecorder.");
  return m;
}

interface OpenSegment {
  rec: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  framesAtStart: number;
  stopped: Promise<void>;
}

export interface RecorderOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  identity: DeviceIdentity;
  segmentMs: number;
  /** Returns true if a segment ending at `endedAt` must be locked (incident). */
  shouldLock: (startedAt: number, endedAt: number) => boolean;
  onSegment: (seg: LocalSegment) => void;
  onLog?: (msg: string, level?: "info" | "warn" | "error") => void;
}

export class DashcamRecorder {
  readonly sessionId = crypto.randomUUID();
  mimeType = "";
  width = 0;
  height = 0;
  frameCount = 0;
  position: { lat: number; lon: number } | null = null;

  private stream: MediaStream | null = null;
  private canvasStream: MediaStream | null = null;
  private drawTimer: ReturnType<typeof setInterval> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private geoWatch: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private current: OpenSegment | null = null;
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private prevChain = "";
  private running = false;

  constructor(private o: RecorderOptions) {}

  async start() {
    if (!window.isSecureContext)
      throw new Error("Camera and Web Crypto need a secure context: open the app over HTTPS (or localhost).");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API not available in this browser.");

    this.mimeType = pickMimeType();
    this.prevChain = await genesisHash(this.sessionId);

    // 1. Acquire the camera (rear camera preferred — the phone faces the road)
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: CAPTURE_WIDTH },
        height: { ideal: CAPTURE_HEIGHT },
        frameRate: { ideal: 30 },
      },
    });
    const { video, canvas } = this.o;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await waitFor(() => video.videoWidth > 0, 5000);

    const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth);
    this.width = canvas.width = Math.round(video.videoWidth * scale) & ~1;
    this.height = canvas.height = Math.round(video.videoHeight * scale) & ~1;

    // 2. Frame acquisition + composition loop
    this.running = true;
    this.drawFrame();
    this.drawTimer = setInterval(() => this.drawFrame(), 1000 / CAPTURE_FPS);

    // 3. Video composition from the canvas frames
    this.canvasStream = canvas.captureStream(CAPTURE_FPS);
    this.openSegment();

    this.startGeolocation();
    await this.acquireWakeLock();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.o.onLog?.(
      `Recording started — session ${this.sessionId.slice(0, 8)}, ${this.width}×${this.height} @ ${CAPTURE_FPS} fps, ${this.mimeType}`
    );
  }

  /** Stops recording; resolves when the last segment is hashed and stored. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    const last = this.current;
    this.current = null;
    if (last) this.closeSegment(last);
    await this.queue;
    if (this.drawTimer) clearInterval(this.drawTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.canvasStream?.getTracks().forEach((t) => t.stop());
    this.o.video.srcObject = null;
    const { canvas } = this.o;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (this.geoWatch !== null) navigator.geolocation.clearWatch(this.geoWatch);
    document.removeEventListener("visibilitychange", this.onVisibility);
    await this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.o.onLog?.("Recording stopped");
  }

  // ── Frame acquisition & composition ────────────────────────────────────────

  private drawFrame() {
    const { video, canvas } = this.o;
    const ctx = canvas.getContext("2d");
    if (!ctx || video.readyState < 2) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.drawImage(video, 0, 0, w, h);

    // Burnt-in overlay: makes each frame self-describing for the insurer.
    const now = new Date();
    const barH = Math.max(22, Math.round(h * 0.045));
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, h - barH, w, barH);
    ctx.font = `${Math.round(barH * 0.6)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    const gps = this.position
      ? `GPS ${this.position.lat.toFixed(5)},${this.position.lon.toFixed(5)}`
      : "GPS --";
    const text = `${now.toISOString().replace("T", " ").slice(0, 23)}Z  DEV ${this.o.identity.deviceId.slice(
      0,
      8
    )}  SES ${this.sessionId.slice(0, 8)}  F${this.frameCount}  ${gps}`;
    ctx.fillText(text, 8, h - barH / 2, w - 16);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(w - 18, 18, 7, 0, Math.PI * 2);
    ctx.fill();
    this.frameCount++;
  }

  // ── Segmentation ───────────────────────────────────────────────────────────

  private openSegment() {
    if (!this.canvasStream) return;
    const rec = new MediaRecorder(this.canvasStream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    const seg: OpenSegment = {
      rec,
      chunks: [],
      startedAt: Date.now(),
      framesAtStart: this.frameCount,
      stopped: new Promise<void>((resolve) => (rec.onstop = () => resolve())),
    };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) seg.chunks.push(e.data);
    };
    rec.onerror = (e) => this.o.onLog?.(`MediaRecorder error: ${String((e as ErrorEvent).message ?? e)}`, "error");
    rec.start(1000);
    this.current = seg;
    this.rotateTimer = setTimeout(() => this.rotate(), this.o.segmentMs);
  }

  private rotate() {
    if (!this.running) return;
    const old = this.current;
    this.openSegment(); // start next first → no gap in footage
    if (old) this.closeSegment(old);
  }

  private closeSegment(seg: OpenSegment) {
    const endedAt = Date.now();
    const frames = this.frameCount - seg.framesAtStart;
    if (seg.rec.state !== "inactive") seg.rec.stop();
    this.queue = this.queue
      .then(() => seg.stopped)
      .then(() => this.finalize(seg, endedAt, frames))
      .catch((e) => this.o.onLog?.(`Segment finalisation failed: ${(e as Error).message}`, "error"));
  }

  /** Hash → chain → sign → store. Runs strictly in capture order. */
  private async finalize(seg: OpenSegment, endedAt: number, frames: number) {
    const blob = new Blob(seg.chunks, { type: this.mimeType.split(";")[0] });
    if (blob.size === 0) {
      this.o.onLog?.("Empty segment discarded (camera paused?)", "warn");
      return;
    }
    const seq = this.seq++;
    const segment_hash = await hashBlob(blob);
    const core: SegmentCore = {
      device_id: this.o.identity.deviceId,
      session_id: this.sessionId,
      seq,
      started_at: seg.startedAt,
      ended_at: endedAt,
      frame_count: frames,
      byte_size: blob.size,
      mime_type: blob.type,
      width: this.width,
      height: this.height,
      latitude: this.position ? round6(this.position.lat) : null,
      longitude: this.position ? round6(this.position.lon) : null,
      segment_hash,
      prev_chain_hash: this.prevChain,
    };
    const record = await buildSignedRecord(core, this.o.identity.keyPair.privateKey);
    this.prevChain = record.chain_hash;

    const local: LocalSegment = {
      key: segmentKey(this.sessionId, seq),
      record,
      blob,
      fileName: segmentFileName(this.sessionId, seq, blob.type),
      locked: this.o.shouldLock(seg.startedAt, endedAt),
      sent: false,
    };
    await putSegment(local);
    this.o.onSegment(local);
  }

  // ── Extras: GPS + screen wake lock ─────────────────────────────────────────

  private startGeolocation() {
    if (!("geolocation" in navigator)) return;
    this.geoWatch = navigator.geolocation.watchPosition(
      (p) => (this.position = { lat: p.coords.latitude, lon: p.coords.longitude }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }

  private async acquireWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* optional feature */
    }
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.running) void this.acquireWakeLock();
    else if (this.running)
      this.o.onLog?.("App went to background — browsers may throttle recording", "warn");
  };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("Camera did not deliver frames"));
      setTimeout(tick, 50);
    };
    tick();
  });
}
