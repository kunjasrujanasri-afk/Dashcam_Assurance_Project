/**
 * src/pages/index.tsx — ENCODER / TRANSMITTER (driver smartphone)
 *
 * UI around the recording engine (lib/recorder.ts), the store-and-forward
 * transmitter (lib/transmitter.ts) and the loop-recording retention
 * (lib/retention.ts). See docs/ENCODER.md for the full description.
 */

import Head from "next/head";
import { WorkspaceIcon } from "@/components/app-shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, ConfigWarning, Stat, TopNav } from "@/components/ui";
import {
  DEFAULT_RETENTION_MS,
  DEFAULT_SEGMENT_MS,
  INCIDENT_LOCK_AFTER_MS,
  INCIDENT_LOCK_BEFORE_MS,
  RETENTION_OPTIONS_MS,
  SEGMENT_OPTIONS_MS,
} from "@/lib/config";
import { DeviceIdentity, loadOrCreateIdentity } from "@/lib/deviceIdentity";
import type { SegmentRecord } from "@/lib/integrity";
import { clearRecordings, listSegments, LocalSegment } from "@/lib/localStore";
import { DashcamRecorder } from "@/lib/recorder";
import { uploadEvidence } from "@/lib/repository";
import { applyRetention, lockRange, setLocked } from "@/lib/retention";
import { supabaseConfigured } from "@/lib/supabaseClient";
import { HashTransmitter, LinkState } from "@/lib/transmitter";
import { downloadBlob, formatBytes, formatClock, formatElapsed, short } from "@/utils/format";

type RecState = "idle" | "starting" | "recording" | "stopping" | "error";
interface LogLine {
  t: number;
  msg: string;
  level: "info" | "warn" | "error";
}

export default function EncoderPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<DashcamRecorder | null>(null);
  const txRef = useRef<HashTransmitter | null>(null);
  const lockUntilRef = useRef(0);
  const retentionRef = useRef(DEFAULT_RETENTION_MS);

  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [rec, setRec] = useState<RecState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [segmentMs, setSegmentMs] = useState<number>(DEFAULT_SEGMENT_MS);
  const [retentionMs, setRetentionMs] = useState<number>(DEFAULT_RETENTION_MS);
  const [link, setLink] = useState<LinkState>("online");
  const [simOffline, setSimOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [segments, setSegments] = useState<LocalSegment[]>([]);
  const [stats, setStats] = useState({ recorded: 0, sent: 0, purged: 0 });
  const [last, setLast] = useState<SegmentRecord | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const log = useCallback((msg: string, level: LogLine["level"] = "info") => {
    setLogs((l) => [{ t: Date.now(), msg, level }, ...l].slice(0, 200));
  }, []);

  const refreshSegments = useCallback(async () => {
    setSegments(await listSegments());
    try {
      const e = await navigator.storage?.estimate?.();
      if (e) setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
    } catch {
      /* optional */
    }
  }, []);

  // ── Boot: identity, transmitter, stored segments ───────────────────────────
  useEffect(() => {
    let tx: HashTransmitter | null = null;
    (async () => {
      try {
        const id = await loadOrCreateIdentity();
        setIdentity(id);
        tx = new HashTransmitter(id, {
          onLinkState: setLink,
          onQueueChange: (p, r) => {
            setPending(p);
            setRejected(r);
          },
          onSent: (rows) => {
            setStats((s) => ({ ...s, sent: s.sent + rows.length }));
            void refreshSegments();
          },
          onLog: log,
        });
        txRef.current = tx;
        tx.start();
        await refreshSegments();
        void navigator.storage?.persist?.();
      } catch (e) {
        setInitError((e as Error).message);
      }
    })();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      tx?.stop();
      void recorderRef.current?.stop();
    };
  }, [log, refreshSegments]);

  // ── Retention (loop recording) — runs every 5 s ────────────────────────────
  useEffect(() => {
    retentionRef.current = retentionMs;
  }, [retentionMs]);

  useEffect(() => {
    const t = setInterval(async () => {
      const { deleted } = await applyRetention(retentionRef.current);
      if (deleted.length) {
        setStats((s) => ({ ...s, purged: s.purged + deleted.length }));
        log(
          `Retention: deleted ${deleted.length} expired segment(s) ${deleted
            .map((d) => `#${d.record.seq}`)
            .join(", ")} (older than ${retentionRef.current / 60000} min)`
        );
        await refreshSegments();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [log, refreshSegments]);

  // ── Recording control ──────────────────────────────────────────────────────
  const start = async () => {
    if (!identity || !videoRef.current || !canvasRef.current) return;
    setError(null);
    setRec("starting");
    const r = new DashcamRecorder({
      video: videoRef.current,
      canvas: canvasRef.current,
      identity,
      segmentMs,
      shouldLock: (s, e) => e <= lockUntilRef.current || s <= lockUntilRef.current,
      onLog: log,
      onSegment: (seg) => {
        setLast(seg.record);
        setStats((s) => ({ ...s, recorded: s.recorded + 1 }));
        log(
          `Segment #${seg.record.seq} closed: ${formatBytes(seg.blob.size)}, ${seg.record.frame_count} frames, SHA-256 ${short(
            seg.record.segment_hash,
            10
          )}${seg.locked ? " 🔒" : ""}`
        );
        void txRef.current?.enqueue(seg.record);
        void refreshSegments();
      },
    });
    recorderRef.current = r;
    try {
      await r.start();
      setStartedAt(Date.now());
      setRec("recording");
    } catch (e) {
      recorderRef.current = null;
      const msg = (e as Error).message;
      setError(msg);
      log(msg, "error");
      setRec("error");
    }
  };

  const stop = async () => {
    setRec("stopping");
    await recorderRef.current?.stop();
    recorderRef.current = null;
    setStartedAt(null);
    setRec("idle");
    await refreshSegments();
  };

  const incident = async () => {
    const t = Date.now();
    lockUntilRef.current = t + INCIDENT_LOCK_AFTER_MS;
    const n = await lockRange(t - INCIDENT_LOCK_BEFORE_MS, t);
    log(
      `INCIDENT marked: ${n} past segment(s) locked, next ${INCIDENT_LOCK_AFTER_MS / 1000} s will be locked too`,
      "warn"
    );
    await refreshSegments();
  };

  const toggleSim = () => {
    const v = !simOffline;
    setSimOffline(v);
    txRef.current?.setSimulatedOffline(v);
  };

  // ── Recordings actions ─────────────────────────────────────────────────────
  const chosen = segments.filter((s) => selected.has(s.key));

  const toggleSel = (key: string) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const downloadSelected = async () => {
    for (const s of chosen) {
      downloadBlob(s.blob, s.fileName);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const uploadSelected = async () => {
    setBusy("Uploading…");
    try {
      let i = 0;
      for (const s of chosen) {
        setBusy(`Uploading ${++i}/${chosen.length}…`);
        await uploadEvidence(s.record.session_id, s.fileName, s.blob);
        if (!s.locked) await setLocked(s.key, true);
      }
      log(`Submitted ${chosen.length} segment(s) to the insurer (evidence bucket) — locked locally`);
      setSelected(new Set());
      await refreshSegments();
    } catch (e) {
      log(`Upload failed: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const wipe = async () => {
    if (rec === "recording") return;
    await clearRecordings();
    setSelected(new Set());
    setStats({ recorded: 0, sent: 0, purged: 0 });
    log("All local recordings and pending hashes deleted", "warn");
    await refreshSegments();
    txRef.current?.kick();
  };

  const openPreview = (s: LocalSegment) => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview({ url: URL.createObjectURL(s.blob), name: s.fileName });
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const recording = rec === "recording";
  const videoGroups = useMemo(() => {
    const groups = new Map<string, LocalSegment[]>();
    for (const clip of segments) {
      const group = groups.get(clip.record.session_id) ?? [];
      group.push(clip);
      groups.set(clip.record.session_id, group);
    }
    return [...groups.entries()].map(([sessionId, clips]) => ({
      sessionId, clips: clips.sort((a, b) => a.record.seq - b.record.seq),
      startedAt: Math.min(...clips.map((c) => c.record.started_at)),
      endedAt: Math.max(...clips.map((c) => c.record.ended_at)),
    })).sort((a, b) => b.startedAt - a.startedAt);
  }, [segments]);
  const localBytes = segments.reduce((a, s) => a + s.blob.size, 0);
  const linkBadge =
    link === "online" ? (
      <Badge tone="green" pulse={recording}>Uplink online</Badge>
    ) : link === "simulated_offline" ? (
      <Badge tone="amber" pulse>Network loss (simulated)</Badge>
    ) : (
      <Badge tone="red" pulse>Offline — buffering</Badge>
    );

  return (
    <>
      <Head>
        <title>Drive Studio · Dashcam Assurance</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#e9f0f5" />
      </Head>

      <div className="min-h-screen bg-slate-950 text-white">
        <TopNav kicker="01 / JOURNEY CAPTURE" title="Drive Studio" />

        <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
          {!supabaseConfigured && <ConfigWarning />}
          {initError && (
            <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 text-sm text-red-300">
              Initialisation failed: {initError}
            </div>
          )}

          <div className="session-ribbon">
            {recording ? <Badge tone="red" pulse>REC</Badge> : <Badge tone="slate">{rec === "starting" ? "Starting…" : rec === "stopping" ? "Finalising…" : "Standby"}</Badge>}
            {linkBadge}
            {pending > 0 && <Badge tone="amber">{pending} hash(es) in outbox</Badge>}
            {rejected > 0 && <Badge tone="red">{rejected} rejected</Badge>}
            {identity && (
              <span className="text-[11px] text-slate-500 font-mono ml-auto">
                device {identity.deviceId.slice(0, 8)} · key {identity.fingerprint}
              </span>
            )}
          </div>

          <div className="drive-layout">
            <Card className="capture-stage" title="The view ahead" subtitle="Live canvas · signed video segments">
              <div className="capture-preview relative w-full aspect-video overflow-hidden">
                <canvas ref={canvasRef} className="w-full h-full object-contain" />
                {!recording && (
                  <div className="capture-empty absolute inset-0 flex items-center justify-center">
                    <WorkspaceIcon name="capture" /><strong>{rec === "starting" ? "Opening camera…" : "Ready for the road"}</strong><p>Your live view will appear here.</p><span>CAPTURE · PROTECT · VERIFY</span>
                  </div>
                )}
              </div>
              {/* Source video element: must be in the DOM for iOS, kept invisible */}
              <video ref={videoRef} playsInline muted className="absolute w-px h-px opacity-0 pointer-events-none" />

            </Card>
            <Card className="recording-console" title="Session controls" subtitle="Start a journey. Keep the moments that matter.">
              <div className="capture-actions">
                {!recording ? (
                  <Button tone="success" onClick={start} disabled={!identity || rec === "starting" || rec === "stopping"}>
                    Begin recording
                  </Button>
                ) : (
                  <Button tone="danger" onClick={stop}>Finish recording</Button>
                )}
                <Button tone="warn" onClick={incident} disabled={!recording} title="Lock the last 30 s and next 30 s of video">
                  Protect incident window
                </Button>
                <Button onClick={toggleSim} tone={simOffline ? "warn" : "slate"} title="Cut the uplink to demonstrate offline buffering">
                  {simOffline ? "Reconnect uplink" : "Pause uplink"}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
                <label className="flex flex-col gap-1 text-slate-400">
                  Clip duration
                  <select
                    value={segmentMs}
                    disabled={recording}
                    onChange={(e) => setSegmentMs(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                  >
                    {SEGMENT_OPTIONS_MS.map((v) => (
                      <option key={v} value={v}>{v / 1000} s</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-slate-400">
                  Keep unlocked clips for
                  <select
                    value={retentionMs}
                    onChange={(e) => setRetentionMs(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                  >
                    {RETENTION_OPTIONS_MS.map((v) => (
                      <option key={v} value={v}>{v / 60000} min</option>
                    ))}
                  </select>
                </label>
              </div>

              {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="drive-metrics grid grid-cols-2 gap-3">
            <Stat label="Session time" value={startedAt ? formatElapsed(now - startedAt) : "—"} tone="indigo" />
            <Stat label="Clips captured" value={stats.recorded} tone="green" />
            <Stat label="Cloud receipts" value={stats.sent} tone="sky" />
            <Stat label="Awaiting sync" value={pending} tone={pending ? "amber" : "slate"} />
            <Stat label="Local library" value={segments.length} sub={formatBytes(localBytes)} />
            <Stat label="Auto-cleared" value={stats.purged} sub={`after ${retentionMs / 60000} min`} />
          </div>
          {storage && storage.quota > 0 && (
            <p className="capture-storage">
              Browser storage: {formatBytes(storage.usage)} used of {formatBytes(storage.quota)}
            </p>
          )}


            </Card>
          </div>
          <div className="identity-grid">
              <Card title="Latest seal">
                {last ? (
                  <dl className="text-[11px] font-mono space-y-1.5 break-all">
                    <Row k="seq" v={`#${last.seq} · ${formatClock(last.started_at)} → ${formatClock(last.ended_at)}`} />
                    <Row k="segment_hash" v={last.segment_hash} color="text-emerald-400" />
                    <Row k="prev_chain" v={last.prev_chain_hash} />
                    <Row k="chain_hash" v={last.chain_hash} color="text-sky-400" />
                    <Row k="signature" v={short(last.signature, 44)} />
                  </dl>
                ) : (
                  <div className="fingerprint-empty"><div className="fingerprint-art"><WorkspaceIcon name="shield" /></div><strong>Each moment leaves its own seal.</strong><p>Begin a session to see its signed fingerprint.</p></div>
                )}
              </Card>
              <Card title="Recording identity" subtitle="The public fingerprint for this recording device.">
                <div className="flex items-center gap-3">
                  <span className="brand-emblem"><WorkspaceIcon name="shield" /></span>
                  <div className="min-w-0"><p className="text-sm font-mono text-indigo-300 break-all">{identity?.fingerprint ?? "Preparing your device…"}</p><p className="text-[10px] text-slate-500 mt-1 break-all">{identity?.deviceId}</p></div>
                </div>
              </Card>
          </div>

          {/* ── Local recordings ─────────────────────────────────────────── */}
          <Card
            title={`Video library (${videoGroups.length})`}
            subtitle="Each entry groups the clips from one recording session. Expand a video to select, play, or save its clips."
            right={
              <div className="flex flex-wrap gap-2">
                <Button small onClick={() => setSelected(new Set(segments.filter((s) => s.locked).map((s) => s.key)))}>
                  Choose protected
                </Button>
                <Button small onClick={downloadSelected} disabled={!chosen.length}>Save clips ({chosen.length})</Button>
                <Button small onClick={() => downloadBlob(new Blob([chosen.map((clip) => clip.record.segment_hash).join("\n") + "\n"], { type: "text/plain" }), `dashcam-hashes-${Date.now()}.txt`)} disabled={!chosen.length}>Save hash list</Button>
                <Button small tone="primary" onClick={uploadSelected} disabled={!chosen.length || !!busy}>
                  {busy ?? `Submit evidence (${chosen.length})`}
                </Button>
                <Button small tone="danger" onClick={wipe} disabled={recording}>Clear local library</Button>
              </div>
            }
          >
            {preview && (
              <div className="mb-4">
                <video src={preview.url} controls autoPlay className="w-full max-w-xl rounded-lg border border-slate-700 bg-black" />
                <p className="text-[11px] text-slate-500 mt-1 font-mono">{preview.name}</p>
              </div>
            )}
            {videoGroups.map((group) => (
              <details key={group.sessionId} className="video-session">
                <summary>
                  <div><strong>Video · {new Date(group.startedAt).toLocaleDateString()} · {formatClock(group.startedAt)}</strong>
                    <p>{group.clips.length} clips · {formatBytes(group.clips.reduce((sum, clip) => sum + clip.blob.size, 0))} · session {group.sessionId.slice(0, 8)}</p>
                  </div>
                  <span>View clips</span>
                </summary>
                <div className="px-4 pt-3"><Button small onClick={() => setSelected((current) => new Set([...current, ...group.clips.map((clip) => clip.key)]))}>Choose this video</Button></div>
            <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500 text-left sticky top-0 bg-slate-900">
                  <tr>
                    <th className="p-2"></th>
                    <th className="p-2">Clip</th>
                    <th className="p-2">Time</th>
                    <th className="p-2">Size</th>
                    <th className="p-2 hidden sm:table-cell">SHA-256</th>
                    <th className="p-2">Cloud sync</th>
                    <th className="p-2">Keep until</th>
                    <th className="p-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {group.clips.map((s) => {
                    const expiresIn = s.record.ended_at + retentionMs - now;
                    return (
                      <tr key={s.key} className={s.locked ? "bg-amber-500/5" : ""}>
                        <td className="p-2">
                          <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggleSel(s.key)} />
                        </td>
                        <td className="p-2 font-mono">
                          #{s.record.seq}
                          <span className="text-slate-600"> {s.record.session_id.slice(0, 4)}</span>
                        </td>
                        <td className="p-2 font-mono text-slate-400">{formatClock(s.record.started_at)}</td>
                        <td className="p-2 font-mono text-slate-400">{formatBytes(s.blob.size)}</td>
                        <td className="p-2 font-mono text-slate-500 hidden sm:table-cell">{short(s.record.segment_hash, 16)}</td>
                        <td className="p-2">{s.sent ? <Badge tone="green">Synced</Badge> : <Badge tone="amber">Pending</Badge>}</td>
                        <td className="p-2">
                          <button onClick={async () => { await setLocked(s.key, !s.locked); await refreshSegments(); }} className="text-left">
                            {s.locked ? <Badge tone="amber">Protected</Badge> : <span className="font-mono text-slate-400">{expiresIn > 0 ? `${Math.ceil(expiresIn / 1000)} s` : "expiring"}</span>}
                          </button>
                        </td>
                        <td className="p-2 text-right whitespace-nowrap space-x-1">
                          <Button small onClick={() => openPreview(s)}>Play</Button>
                          <Button small onClick={() => downloadBlob(s.blob, s.fileName)}>Save</Button>
                        </td>
                      </tr>
                    );
                  })}

                </tbody>
              </table>
            </div>
              </details>
            ))}
            {!videoGroups.length && <p className="empty-note">Begin a journey to create your first video.</p>}
          </Card>

          {/* ── Event log ────────────────────────────────────────────────── */}
          <Card title="Session activity">
            <div className="max-h-56 overflow-y-auto font-mono text-[11px] space-y-0.5">
              {logs.map((l, i) => (
                <p key={i} className={l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-amber-300" : "text-slate-400"}>
                  <span className="text-slate-600">{formatClock(l.t)}</span> {l.msg}
                </p>
              ))}
              {!logs.length && <p className="text-slate-600">—</p>}
            </div>
          </Card>
        </main>
      </div>
    </>
  );
}

function Row({ k, v, color = "text-slate-300" }: { k: string; v: string; color?: string }) {
  return (
    <div>
      <dt className="text-slate-500">{k}</dt>
      <dd className={color}>{v}</dd>
    </div>
  );
}
