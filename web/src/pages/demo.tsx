/**
 * src/pages/demo.tsx — FRAUD DETECTION DEMO
 *
 * Interactive walkthrough of insurance-fraud scenarios:
 *  1. Trimming — cutting unfavorable footage from the timeline
 *  2. Editing / Blurring — modifying video content to hide evidence
 *  3. Selective omission — submitting only favorable segments
 *
 * Each scenario generates tampered evidence in-memory and runs
 * the full verification engine (lib/verifier.ts) to prove detection.
 */

import Head from "next/head";
import { useCallback, useState } from "react";
import { Badge, Button, Card, ConfigWarning, Stat, Tone, TopNav } from "@/components/ui";
import { segmentFileName } from "@/lib/integrity";
import { listSegments, segmentKey } from "@/lib/localStore";
import { supabaseRepository } from "@/lib/repository";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import type { SegmentRow } from "@/lib/supabaseClient";
import {
  clearKeyCache,
  compactRanges,
  EvidenceFile,
  FileStatus,
  SessionAudit,
  VerificationReport,
  verifyEvidence,
} from "@/lib/verifier";
import { downloadBlob, formatBytes, short } from "@/utils/format";

// ── Types ──────────────────────────────────────────────────────────────────

type Scenario = "trim" | "blur" | "omit" | "offline";
type DemoPhase = "intro" | "setup" | "tamper" | "verify" | "result";

interface ScenarioConfig {
  key: Scenario;
  title: string;
  subtitle: string;
  fraudMethod: string;
  detection: string;
}

const SCENARIOS: ScenarioConfig[] = [
  {
    key: "trim",
    title: "Timeline cut",
    subtitle: "Compare shortened clips with the original recording.",
    fraudMethod: "Truncate the video file to 60-80% of its original length, removing the ending (or beginning) that contains incriminating footage.",
    detection: "SHA-256 of the truncated file differs from the hash registered at capture time. The file size also mismatches. The system flags it as MODIFIED immediately.",
  },
  {
    key: "blur",
    title: "Pixel rewrite",
    subtitle: "Test detection of changed video bytes.",
    fraudMethod: "Overwrite a block of bytes in the video (simulating the re-encoding that happens when blur/edit effects are applied). Even a 1-bit change is enough.",
    detection: "Any modification — even a single bit flip — produces a completely different SHA-256 hash. The re-encoded video cannot possibly match the original fingerprint anchored on the server.",
  },
  {
    key: "omit",
    title: "Missing moments",
    subtitle: "Check for gaps in a submitted timeline.",
    fraudMethod: "Exclude clips from the evidence set before submission. The individual files remain untampered, but the timeline has gaps.",
    detection: "The verification engine checks sequence continuity: every seq between the first and last submitted must be present. Missing segments are flagged, and the verdict becomes INCOMPLETE or TAMPERED.",
  },
  {
    key: "offline",
    title: "Offline alteration",
    subtitle: "Compare offline edits with registered records.",
    fraudMethod: "Modify the video file while the device is offline, hoping the edited version will be hashed and anchored instead of the original. This simulates editing footage before the system has a chance to register the real fingerprint.",
    detection: "Each record contains the video hash and previous chain hash, signed with the device key. An altered copy differs from the registered hash; altered records fail chain or signature checks. This trial compares changed copies against existing records.",
  },
];

const statusTone: Record<FileStatus, Tone> = {
  AUTHENTIC: "green",
  MODIFIED: "red",
  FORGED: "red",
  UNKNOWN: "red",
  DUPLICATE: "amber",
};

// ── Main Page ──────────────────────────────────────────────────────────────

export default function FraudDemoPage() {
  const [scenario, setScenario] = useState<Scenario>("trim");

  return (
    <>
      <Head>
        <title>Integrity Trials · Dashcam Assurance</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Interactive demo showing how video fingerprinting detects insurance fraud: trimming, blurring, and selective omission."
        />
      </Head>

      <div className="min-h-screen bg-slate-950 text-white">
        <TopNav kicker="03 / COPY EXPERIMENTS" title="Integrity Trials" />

        <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
          {!supabaseConfigured && <ConfigWarning />}

          <div className="experiment-layout">
            <div className="experiment-toolbar glass-card">
              <div className="trial-tabs" role="tablist" aria-label="Integrity trials">
                {SCENARIOS.map((trial) => (
                  <button key={trial.key} type="button" role="tab" id={`trial-tab-${trial.key}`}
                    aria-selected={scenario === trial.key} aria-controls="trial-panel"
                    onClick={() => setScenario(trial.key)}>{trial.title}</button>
                ))}
              </div>
              <div className="trial-dropdown">
              <label htmlFor="trial-select" className="section-caption">SELECT A TRIAL</label>
              <select id="trial-select" value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
                {SCENARIOS.map((trial) => <option key={trial.key} value={trial.key}>{trial.title}</option>)}
              </select>
              </div>
            </div>
            <div className="experiment-content" id="trial-panel" role="tabpanel" aria-labelledby={`trial-tab-${scenario}`}>
              <ScenarioDemo key={scenario} config={SCENARIOS.find((s) => s.key === scenario)!} />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Scenario Demo (interactive)
// ════════════════════════════════════════════════════════════════════════════

function ScenarioDemo({ config }: { config: ScenarioConfig }) {
  const [phase, setPhase] = useState<DemoPhase>("intro");
  const [sessions, setSessions] = useState<{ id: string; device: string; count: number; segments: SegmentRow[] }[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [origFiles, setOrigFiles] = useState<EvidenceFile[]>([]);
  const [tamperedFiles, setTamperedFiles] = useState<EvidenceFile[]>([]);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [origReport, setOrigReport] = useState<VerificationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [player, setPlayer] = useState<{ url: string; name: string; label: string } | null>(null);
  // For trim scenario: pick how much to cut
  const [trimPercent, setTrimPercent] = useState(70);
  // For blur scenario: pick how many bytes to corrupt
  const [blurBlockSize, setBlurBlockSize] = useState(8192);
  // For omit scenario: pick which segments to remove
  const [omitIndices, setOmitIndices] = useState<Set<number>>(new Set());



  // ── Step 1: Load sessions from server ──
  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase
        .from("video_segments")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (e) throw new Error(e.message);
      const rows = (data ?? []) as SegmentRow[];
      const map = new Map<string, SegmentRow[]>();
      for (const r of rows) {
        if (!map.has(r.session_id)) map.set(r.session_id, []);
        map.get(r.session_id)!.push(r);
      }
      const list = [...map.entries()].map(([id, segs]) => ({
        id,
        device: segs[0].device_id,
        count: segs.length,
        segments: segs.sort((a, b) => a.seq - b.seq),
      }));
      setSessions(list);
      setPhase("setup");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Step 2: Load evidence files (IndexedDB  cloud  synthetic) ──
  const loadSessionEvidence = useCallback(async (sessionId: string) => {
    setSelectedSession(sessionId);
    setLoading(true);
    setError(null);
    try {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session || session.segments.length === 0) throw new Error("No segments found for this session.");

      const evidenceFiles: EvidenceFile[] = [];

      // 1) Try IndexedDB (same browser that recorded — has real video blobs)
      try {
        const local = await listSegments();
        const localByKey = new Map(local.map((s) => [s.key, s]));
        for (const seg of session.segments) {
          const key = segmentKey(seg.session_id, seg.seq);
          const ls = localByKey.get(key);
          if (ls) {
            evidenceFiles.push({
              id: crypto.randomUUID(),
              name: ls.fileName,
              blob: ls.blob,
              origin: "local",
            });
          }
        }
      } catch {
        /* IndexedDB may not be available */
      }

      // 2) If nothing from IndexedDB, try the evidence bucket (cloud)
      if (evidenceFiles.length === 0) {
        const bucket = supabase.storage.from("evidence");
        const { data: bucketFiles } = await bucket.list(sessionId, { limit: 1000 });
        if (bucketFiles && bucketFiles.length > 0) {
          for (const bf of bucketFiles.filter((f) => f.id)) {
            const { data, error: dlErr } = await bucket.download(`${sessionId}/${bf.name}`);
            if (dlErr || !data) continue;
            evidenceFiles.push({
              id: crypto.randomUUID(),
              name: bf.name,
              blob: data,
              origin: "cloud",
            });
          }
        }
      }

      // 3) Last resort: synthetic placeholder blobs (not playable, but hashable)
      if (evidenceFiles.length === 0) {
        for (const seg of session.segments) {
          const rnd = new Uint8Array(1024);
          crypto.getRandomValues(rnd);
          const syntheticBlob = new Blob(
            [
              `SYNTHETIC-SEGMENT|${seg.session_id}|${seg.seq}|${seg.segment_hash}|` +
                `${seg.started_at}|${seg.ended_at}|${Date.now()}|`,
              rnd,
            ],
            { type: seg.mime_type || "video/webm" }
          );
          evidenceFiles.push({
            id: crypto.randomUUID(),
            name: segmentFileName(seg.session_id, seg.seq, seg.mime_type || "video/webm"),
            blob: syntheticBlob,
            origin: "local",
            note: "Synthetic placeholder (video not available locally or in the cloud)",
          });
        }
      }

      evidenceFiles.sort((a, b) => a.name.localeCompare(b.name));
      setOrigFiles(evidenceFiles);
      setPhase("tamper");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessions]);

  // ── Step 3: Apply tamper operations based on scenario ──
  const applyTamper = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let tampered: EvidenceFile[];
      switch (config.key) {
        case "trim": {
          // Truncate each file to trimPercent of its original size
          tampered = await Promise.all(
            origFiles.map(async (f) => {
              const keep = Math.floor(f.blob.size * (trimPercent / 100));
              return {
                id: crypto.randomUUID(),
                name: f.name,
                blob: f.blob.slice(0, keep, f.blob.type),
                origin: "tamper-lab" as const,
                note: `Trimmed to ${trimPercent}% (${formatBytes(keep)} of ${formatBytes(f.blob.size)})`,
              };
            })
          );
          break;
        }
        case "blur": {
          // Overwrite blocks in each file (simulating re-encoding after blur)
          tampered = await Promise.all(
            origFiles.map(async (f) => {
              const bytes = new Uint8Array(await f.blob.arrayBuffer());
              const start = Math.floor(bytes.length * 0.3);
              const len = Math.min(blurBlockSize, bytes.length - start);
              // Write a pattern that simulates re-encoded pixels
              for (let i = 0; i < len; i++) bytes[start + i] = (bytes[start + i] + 128) & 0xff;
              return {
                id: crypto.randomUUID(),
                name: f.name,
                blob: new Blob([bytes], { type: f.blob.type }),
                origin: "tamper-lab" as const,
                note: `Blur applied: ${formatBytes(len)} modified at offset ${start}`,
              };
            })
          );
          break;
        }
        case "omit": {
          // Remove selected segments from the evidence
          if (omitIndices.size === 0) {
            // Auto-select middle segments to remove
            const mid = Math.floor(origFiles.length / 2);
            const autoOmit = new Set<number>();
            autoOmit.add(mid);
            if (mid + 1 < origFiles.length) autoOmit.add(mid + 1);
            setOmitIndices(autoOmit);
            tampered = origFiles.filter((_, i) => !autoOmit.has(i)).map((f) => ({ ...f, id: crypto.randomUUID() }));
          } else {
            tampered = origFiles.filter((_, i) => !omitIndices.has(i)).map((f) => ({ ...f, id: crypto.randomUUID() }));
          }
          break;
        }
        case "offline": {
          // Simulate editing the video while offline, then re-hashing
          // The fraudster modifies bytes + tries to submit modified files
          // but cannot forge the device signature
          tampered = await Promise.all(
            origFiles.map(async (f) => {
              const bytes = new Uint8Array(await f.blob.arrayBuffer());
              // Substantial edit: overwrite 10% of bytes starting at 20%
              const start = Math.floor(bytes.length * 0.2);
              const len = Math.floor(bytes.length * 0.1);
              for (let i = 0; i < len && start + i < bytes.length; i++) {
                bytes[start + i] = (bytes[start + i] ^ 0xff) & 0xff;
              }
              return {
                id: crypto.randomUUID(),
                name: f.name,
                blob: new Blob([bytes], { type: f.blob.type }),
                origin: "tamper-lab" as const,
                note: `Offline edit: ${formatBytes(len)} rewritten before upload`,
              };
            })
          );
          break;
        }
        default:
          tampered = [...origFiles];
      }
      setTamperedFiles(tampered);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [config.key, origFiles, trimPercent, blurBlockSize, omitIndices]);

  // ── Step 4: Compare with registered evidence ──
  const runVerify = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReport(null);
    clearKeyCache();
    try {
      // First verify original (for comparison)
      const origR = await verifyEvidence(origFiles, supabaseRepository, {
        onProgress: (done, total, label) => setProgress({ done, total, label: `[Original] ${label}` }),
      });
      setOrigReport(origR);

      // Then verify tampered
      const tampR = await verifyEvidence(tamperedFiles, supabaseRepository, {
        onProgress: (done, total, label) => setProgress({ done, total, label: `[Tampered] ${label}` }),
      });
      setReport(tampR);
      setPhase("result");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [origFiles, tamperedFiles]);

  const play = (f: EvidenceFile, label: string) => {
    if (player) URL.revokeObjectURL(player.url);
    setPlayer({ url: URL.createObjectURL(f.blob), name: f.name, label });
  };

  return (
    <div className="space-y-5">
      {/* Scenario header */}
      <div
        className={`rounded-2xl border p-5 ${
          config.key === "trim"
            ? "border-orange-500/40 bg-orange-500/5"
            : config.key === "blur"
            ? "border-purple-500/40 bg-purple-500/5"
            : "border-rose-500/40 bg-rose-500/5"
        }`}
      >
        <div className="flex items-start gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">{config.title}</h2>
            <p className="text-sm text-amber-300 mt-0.5">{config.subtitle}</p>
          </div>
        </div>
      </div>

      {/* Progress steps */}
      <div className="trial-progress">
        {(
          [
            ["intro", "Brief"],
            ["setup", "Choose footage"],
            ["tamper", "Alter copy"],
            ["verify", "Compare"],
            ["result", "Findings"],
          ] as [DemoPhase, string][]
        ).map(([p, label], i) => {
          const phases: DemoPhase[] = ["intro", "setup", "tamper", "verify", "result"];
          const current = phases.indexOf(phase);
          const step = phases.indexOf(p);
          const active = step <= current;
          return (
            <div key={p} className="flex items-center">
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                  step === current
                    ? "bg-indigo-600 text-white"
                    : active
                    ? "bg-emerald-600/30 text-emerald-300"
                    : "bg-slate-800 text-slate-500"
                }`}
              >
                {label}
              </div>
              {i < 4 && (
                <div className={`w-6 h-0.5 ${active && step < current ? "bg-emerald-600/50" : "bg-slate-700"}`} />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 text-sm text-red-300"> {error}</div>
      )}

      {/* Phase: Intro */}
      {phase === "intro" && (
        <Card title="Begin a trial" subtitle="Choose a recorded journey, alter a copy, then compare the evidence.">
          <Button tone="primary" onClick={loadSessions} disabled={loading}>
            {loading ? "Loading journeys…" : "Choose a journey"}
          </Button>
        </Card>
      )}

      {/* Phase: Setup — pick a session */}
      {phase === "setup" && (
        <Card
          title="Choose your source"
          subtitle="Select a recording to use as the source."
        >
          {sessions.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-slate-400 text-sm">No recording sessions found.</p>
              <p className="text-slate-500 text-xs mt-1">
                Record a journey in Drive Studio to begin.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => loadSessionEvidence(s.id)}
                  disabled={loading}
                  className={`w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all ${
                    selectedSession === s.id
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-700/60 bg-slate-800/50 hover:border-slate-600 hover:bg-slate-800"
                  } disabled:opacity-40`}
                >
                  <div>
                    <span className="font-mono text-sm text-white">{s.id.slice(0, 8)}</span>
                    <span className="text-xs text-slate-400 ml-2">device {s.device.slice(0, 8)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="indigo">{s.count} segments</Badge>
                    {loading && selectedSession === s.id && (
                      <span className="text-xs text-slate-400 animate-pulse">Loading…</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Phase: Tamper — apply the fraud operation */}
      {phase === "tamper" && (
        <div className="space-y-5">
          <Card
            title="Source clips"
            subtitle={`${origFiles.length} segment(s) from session ${selectedSession?.slice(0, 8)}`}
          >
            <FileTable files={origFiles} label="Original" onPlay={play} />
          </Card>

          <Card
            title={`Alteration settings · ${config.title}`}
            subtitle="Configure and apply the tampering operation"
          >
            {config.key === "trim" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Choose how much of each clip to retain.
                </p>
                <label className="flex items-center gap-3 text-sm text-slate-400">
                  Keep
                  <input
                    type="range"
                    min={30}
                    max={95}
                    value={trimPercent}
                    onChange={(e) => setTrimPercent(Number(e.target.value))}
                    className="flex-1 accent-orange-500"
                  />
                  <span className="font-mono text-orange-400 w-12 text-right">{trimPercent}%</span>
                </label>
                <p className="text-xs text-slate-500">
                  Shortening changes the file hash.
                </p>
              </div>
            )}

            {config.key === "blur" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Choose the number of bytes to overwrite in each copy.
                </p>
                <label className="flex items-center gap-3 text-sm text-slate-400">
                  Changed bytes
                  <select
                    value={blurBlockSize}
                    onChange={(e) => setBlurBlockSize(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-100"
                  >
                    <option value={1}>1 byte (minimal)</option>
                    <option value={1024}>1 KB</option>
                    <option value={4096}>4 KB</option>
                    <option value={8192}>8 KB</option>
                    <option value={65536}>64 KB (large edit)</option>
                  </select>
                </label>
                <p className="text-xs text-slate-500">
                  This simulates byte changes; it does not render a blur effect.
                </p>
              </div>
            )}

            {config.key === "omit" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Select clips to exclude from the review.
                </p>
                <div className="flex flex-wrap gap-2">
                  {origFiles.map((f, i) => (
                    <button
                      key={f.id}
                      onClick={() =>
                        setOmitIndices((prev) => {
                          const n = new Set(prev);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        })
                      }
                      className={`px-3 py-2 rounded-lg text-xs font-mono border transition-all ${
                        omitIndices.has(i)
                          ? "border-red-500/60 bg-red-500/20 text-red-300 line-through"
                          : "border-slate-600 bg-slate-800/60 text-slate-300 hover:border-red-500/40"
                      }`}
                    >
                      #{i} {f.name.split("_").pop()?.replace(/\.[^.]+$/, "")}
                    </button>
                  ))}
                </div>
                {omitIndices.size === 0 && (
                  <p className="text-xs text-amber-400">
                    Choose clips, or continue to exclude the middle clips.
                  </p>
                )}
                {omitIndices.size > 0 && (
                  <p className="text-xs text-red-300">
                    {omitIndices.size} segment(s) will be withheld from the evidence.
                  </p>
                )}
              </div>
            )}

            {config.key === "offline" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Overwrite 10% of each copy and compare it with the registered source.
                </p>

                <p className="text-xs text-slate-500">
                  Cloud records remain unchanged.
                </p>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-slate-700/50 flex gap-3">
              <Button tone="warn" onClick={applyTamper} disabled={loading}>
                {config.key === "trim" ? " Shorten copies" : config.key === "blur" ? " Rewrite copies" : config.key === "offline" ? " Create offline alteration" : " Exclude clips"}
              </Button>
              <Button
                onClick={() => {
                  setPhase("setup");
                  setOrigFiles([]);
                  setTamperedFiles([]);
                  setReport(null);
                  setOrigReport(null);
                }}
              >
                 Back
              </Button>
            </div>
          </Card>

          {tamperedFiles.length > 0 && (
            <>
              <Card
                title="Altered copies"
                subtitle={`${tamperedFiles.length} file(s) — modifications highlighted`}
                right={
                  <Button small onClick={() => { for (const f of tamperedFiles) downloadBlob(f.blob, f.name); }}>
                     Save altered copies
                  </Button>
                }
              >
                <FileTable files={tamperedFiles} label="Tampered" onPlay={play} showNotes />
              </Card>

              {/* Side-by-side comparison */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <h4 className="text-sm font-semibold text-emerald-300 mb-2"> Source clips</h4>
                  <p className="text-xs text-slate-400">{origFiles.length} files, {formatBytes(origFiles.reduce((a, f) => a + f.blob.size, 0))} total</p>
                </div>
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                  <h4 className="text-sm font-semibold text-red-300 mb-2"> Tampered evidence</h4>
                  <p className="text-xs text-slate-400">
                    {tamperedFiles.length} files, {formatBytes(tamperedFiles.reduce((a, f) => a + f.blob.size, 0))} total
                    {config.key === "trim" && ` (${Math.round((1 - tamperedFiles.reduce((a, f) => a + f.blob.size, 0) / origFiles.reduce((a, f) => a + f.blob.size, 0)) * 100)}% smaller)`}
                    {config.key === "omit" && ` (${origFiles.length - tamperedFiles.length} segments removed)`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button tone="primary" onClick={runVerify} disabled={loading}>
                  {loading ? "Verifying…" : " Compare with registered evidence"}
                </Button>
                {progress && (
                  <div className="flex-1">
                    <div className="w-full bg-slate-800 rounded-full h-2">
                      <div
                        className="bg-indigo-500 h-2 rounded-full transition-all"
                        style={{ width: `${(progress.done / progress.total) * 100}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">{progress.label}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Phase: Result */}
      {phase === "result" && report && (
        <div className="space-y-5">
          {/* Verdict comparison */}
          <div className="grid md:grid-cols-2 gap-5">
            {origReport && (
              <VerdictBox
                report={origReport}
                label="Source clips (baseline)"
                />
            )}
            <VerdictBox
              report={report}
              label="Altered copies"
              />
          </div>

          <details className="glass-card trial-details p-5">
            <summary>Technical notes</summary>
            <p className="text-xs text-slate-400 mt-4">{config.fraudMethod}</p>
            <p className="text-xs text-slate-400 mt-3">{config.detection}</p>
          </details>

          {/* Per-file results */}
          <Card title="Clip comparison">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500 text-left">
                  <tr>
                    <th className="p-2">Status</th>
                    <th className="p-2">File</th>
                    <th className="p-2">SHA-256 (actual)</th>
                    <th className="p-2">Registered hash</th>
                    <th className="p-2">Findings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 align-top">
                  {report.files.map((v, i) => (
                    <tr
                      key={i}
                      className={
                        v.status === "AUTHENTIC" && !v.problems.length
                          ? ""
                          : v.status === "DUPLICATE"
                          ? "bg-amber-500/5"
                          : "bg-red-500/10"
                      }
                    >
                      <td className="p-2">
                        <Badge tone={statusTone[v.status]}>{v.status}</Badge>
                      </td>
                      <td className="p-2 font-mono break-all max-w-[14rem]">{v.file.name}</td>
                      <td className="p-2 font-mono break-all max-w-[12rem]">
                        <span
                          className={
                            v.record && v.record.segment_hash !== v.actualHash
                              ? "text-red-400"
                              : "text-emerald-400"
                          }
                        >
                          {short(v.actualHash, 20)}
                        </span>
                      </td>
                      <td className="p-2 font-mono break-all max-w-[12rem] text-slate-500">
                        {v.record ? short(v.record.segment_hash, 20) : "—"}
                      </td>
                      <td className="p-2 text-[11px] max-w-[18rem]">
                        {v.problems.map((p, j) => (
                          <p key={j} className="text-red-300">
                             {p}
                          </p>
                        ))}
                        {v.warnings.map((p, j) => (
                          <p key={j} className="text-amber-300">
                             {p}
                          </p>
                        ))}
                        {!v.problems.length && !v.warnings.length && (
                          <p className="text-emerald-300"> Authentic</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Session chain audit */}
          {report.sessions.map((s) => (
            <SessionAuditCard key={s.sessionId} audit={s} />
          ))}

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                setPhase("tamper");
                setReport(null);
                setOrigReport(null);
                setTamperedFiles([]);
              }}
            >
               Adjust this trial
            </Button>
            <Button
              onClick={() => {
                setPhase("intro");
                setOrigFiles([]);
                setTamperedFiles([]);
                setReport(null);
                setOrigReport(null);
                setSelectedSession(null);
              }}
            >
               Reset trial
            </Button>
          </div>
        </div>
      )}

      {/* Player */}
      {player && (
        <Card title={player.label}>
          <video
            key={player.url}
            src={player.url}
            controls
            autoPlay
            playsInline
            className="w-full max-w-xl rounded-lg border border-slate-700 bg-black"
          />
          <p className="text-[11px] text-slate-500 mt-1 font-mono">{player.name}</p>
        </Card>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════════════

function FileTable({
  files,
  label,
  onPlay,
  showNotes,
}: {
  files: EvidenceFile[];
  label: string;
  onPlay: (f: EvidenceFile, label: string) => void;
  showNotes?: boolean;
}) {
  return (
    <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-500 text-left sticky top-0 bg-slate-900">
          <tr>
            <th className="p-2">#</th>
            <th className="p-2">File</th>
            <th className="p-2">Size</th>
            {showNotes && <th className="p-2">Modification</th>}
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {files.map((f, i) => (
            <tr key={f.id} className={f.origin === "tamper-lab" ? "bg-amber-500/5" : ""}>
              <td className="p-2 font-mono text-slate-400">{i}</td>
              <td className="p-2 font-mono break-all">{f.name}</td>
              <td className="p-2 font-mono text-slate-400 whitespace-nowrap">{formatBytes(f.blob.size)}</td>
              {showNotes && (
                <td className="p-2">
                  {f.note ? (
                    <Badge tone="amber">{f.note}</Badge>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
              )}
              <td className="p-2 text-right whitespace-nowrap space-x-1">
                <Button small onClick={() => onPlay(f, `${label}: ${f.name}`)}>Play</Button>
                <Button small onClick={() => downloadBlob(f.blob, f.name)}>Save</Button>
              </td>
            </tr>
          ))}
          {!files.length && (
            <tr>
              <td colSpan={showNotes ? 5 : 4} className="p-6 text-center text-slate-500">
                No files.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VerdictBox({
  report,
  label,
}: {
  report: VerificationReport;
  label: string;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 ${
        report.verdict === "AUTHENTIC"
          ? "border-emerald-500/50 bg-emerald-500/10"
          : report.verdict === "INCOMPLETE"
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-red-500/50 bg-red-500/10"
      }`}
    >
      <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">{label}</p>
      <p
        className={`text-2xl font-black ${
          report.verdict === "AUTHENTIC"
            ? "text-emerald-400"
            : report.verdict === "INCOMPLETE"
            ? "text-amber-400"
            : "text-red-400"
        }`}
      >
        {report.verdict === "AUTHENTIC"
          ? "Original verified"
          : report.verdict === "INCOMPLETE"
          ? "Timeline incomplete"
          : "Changes detected"}
      </p>
      <p className="text-xs text-slate-300 mt-1">
        {report.verdict === "AUTHENTIC"
          ? "All files match their registered fingerprints."
          : report.verdict === "INCOMPLETE"
          ? "Files are genuine but segments are missing from the timeline."
          : "At least one file or record has been altered."}
      </p>
      <ul className="mt-2 text-[11px] text-slate-300 space-y-0.5 list-disc pl-5">
        {report.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <p className="text-[10px] text-slate-500 mt-2">Verified in {report.durationMs} ms</p>
    </div>
  );
}

function SessionAuditCard({ audit }: { audit: SessionAudit }) {
  const sigOk = audit.records.filter((r) => r.signatureOk).length;
  const chainOk = audit.records.filter((r) => r.chainOk).length;
  const linksBroken = audit.records.filter((r) => r.linkOk === false).length;
  const clean = !audit.problems.length && !audit.records.some((r) => r.problems.length);
  return (
    <Card
      title={
        <>
          Server chain audit · session <span className="font-mono">{audit.sessionId.slice(0, 8)}</span>
        </>
      }
      subtitle={
        <>
          device <span className="font-mono">{audit.deviceId?.slice(0, 8) ?? "?"}</span> (
          {audit.deviceLabel ?? "unknown"}) · public key{" "}
          <span className="font-mono">{audit.keyFingerprint ?? "not found"}</span>
        </>
      }
      right={
        clean ? (
          <Badge tone="green">chain intact</Badge>
        ) : (
          <Badge tone="red">chain inconsistent</Badge>
        )
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
        <Stat
          label="Records"
          value={audit.records.length}
          sub={audit.firstSeq !== null ? `seq #${audit.firstSeq}–#${audit.lastSeq}` : ""}
        />
        <Stat
          label="Genesis link"
          value={audit.genesisOk === null ? "n/a" : audit.genesisOk ? "OK" : "BAD"}
          tone={audit.genesisOk === false ? "red" : audit.genesisOk ? "green" : "slate"}
        />
        <Stat
          label="Valid signatures"
          value={`${sigOk}/${audit.records.length}`}
          tone={sigOk === audit.records.length ? "green" : "red"}
        />
        <Stat
          label="Chain hashes OK"
          value={`${chainOk}/${audit.records.length}`}
          tone={chainOk === audit.records.length ? "green" : "red"}
        />
        <Stat
          label="Broken links / gaps"
          value={`${linksBroken} / ${audit.missingInDb.length}`}
          tone={linksBroken || audit.missingInDb.length ? "red" : "green"}
        />
      </div>
      {audit.problems.map((p, i) => (
        <p key={i} className="text-xs text-red-300">
           {p}
        </p>
      ))}
      {audit.warnings.map((p, i) => (
        <p key={i} className="text-xs text-amber-300">
           {p}
        </p>
      ))}
      {audit.submittedSeqs.length > 0 && (
        <p className="text-xs text-slate-400 mt-1">
          Evidence covers {compactRanges(audit.submittedSeqs)}
          {audit.missingInEvidence.length
            ? `; missing ${compactRanges(audit.missingInEvidence)}`
            : " (contiguous)"}
          .
        </p>
      )}
      {/* timeline strip */}
      <div className="flex flex-wrap gap-0.5 mt-3">
        {audit.records.map((r) => {
          const inEv = audit.submittedSeqs.includes(r.row.seq);
          const missing = audit.missingInEvidence.includes(r.row.seq);
          return (
            <span
              key={r.row.seq}
              title={`#${r.row.seq} ${r.problems.join("; ") || "ok"}`}
              className={`w-3 h-5 rounded-sm ${
                r.problems.length
                  ? "bg-red-500"
                  : missing
                  ? "bg-amber-400"
                  : inEv
                  ? "bg-emerald-400"
                  : "bg-slate-600"
              }`}
            />
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500 mt-1">
        ■ green = submitted &amp; valid · amber = missing from evidence · grey = recorded, not submitted · red =
        failing record
      </p>
    </Card>
  );
}
