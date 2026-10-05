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
import Link from "next/link";
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

type Scenario = "overview" | "trim" | "blur" | "omit" | "offline";
type DemoPhase = "intro" | "setup" | "tamper" | "verify" | "result";

interface ScenarioConfig {
  key: Scenario;
  icon: string;
  title: string;
  subtitle: string;
  description: string;
  fraudMethod: string;
  detection: string;
}

const SCENARIOS: ScenarioConfig[] = [
  {
    key: "trim",
    icon: "✂️",
    title: "Video Trimming Fraud",
    subtitle: "Cut or shorten the video to remove incriminating footage",
    description:
      "The fraudster trims or shortens a video segment to remove the portion that shows they were at fault (e.g., running a red light before the collision). They submit the shortened clip hoping the insurer only sees the aftermath.",
    fraudMethod: "Truncate the video file to 60-80% of its original length, removing the ending (or beginning) that contains incriminating footage.",
    detection: "SHA-256 of the truncated file differs from the hash registered at capture time. The file size also mismatches. The system flags it as MODIFIED immediately.",
  },
  {
    key: "blur",
    icon: "🔍",
    title: "Video Blur / Edit Fraud",
    subtitle: "Blur or edit unfavorable regions in the video",
    description:
      "The fraudster uses video editing software to blur license plates, speedometer readings, traffic signals, or other incriminating details. The re-exported file looks similar but its bytes are completely different.",
    fraudMethod: "Overwrite a block of bytes in the video (simulating the re-encoding that happens when blur/edit effects are applied). Even a 1-bit change is enough.",
    detection: "Any modification — even a single bit flip — produces a completely different SHA-256 hash. The re-encoded video cannot possibly match the original fingerprint anchored on the server.",
  },
  {
    key: "omit",
    icon: "🗑️",
    title: "Selective Omission",
    subtitle: "Submit only favorable segments, hide the rest",
    description:
      "Instead of modifying video files, the fraudster submits only the segments that support their version of events and withholds the segments that prove their fault. For example, submitting segments #0-#3 and #6-#8 but hiding #4-#5 which show them texting while driving.",
    fraudMethod: "Remove segments from the evidence set before submission. The individual files remain untampered, but the timeline has gaps.",
    detection: "The verification engine checks sequence continuity: every seq between the first and last submitted must be present. Missing segments are flagged, and the verdict becomes INCOMPLETE or TAMPERED.",
  },
  {
    key: "offline",
    icon: "📡",
    title: "Offline / Pre-Upload Tampering",
    subtitle: "Edit the video before the hash reaches the server",
    description:
      "The fraudster notices an accident occurred while the dashcam was offline (e.g., no cellular signal, tunnel, remote area). The hashes have not yet been anchored on the server. They attempt to edit the local video files on their phone before the device reconnects and transmits the fingerprints.",
    fraudMethod: "Modify the video file while the device is offline, hoping the edited version will be hashed and anchored instead of the original. This simulates editing footage before the system has a chance to register the real fingerprint.",
    detection: "The system uses a hash chain: each segment links to the previous via prev_chain_hash. Even if the fraudster re-hashes the modified file, the chain hash computation also covers the device signature (ECDSA private key). Without the private key, they cannot forge a valid signature. The Decoder detects an invalid signature or a broken chain link.",
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
  const [scenario, setScenario] = useState<Scenario>("overview");

  return (
    <>
      <Head>
        <title>Fraud Detection Demo — Dashcam Integrity</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Interactive demo showing how video fingerprinting detects insurance fraud: trimming, blurring, and selective omission."
        />
      </Head>

      <div className="min-h-screen bg-slate-950 text-white">
        <TopNav
          icon="🕵️"
          kicker="Insurance Fraud Detection"
          title="Interactive Demo"
          href="/admin"
          hrefLabel="Decoder"
          right={
            <Link href="/" className="text-xs text-slate-400 hover:text-white whitespace-nowrap">
              Encoder →
            </Link>
          }
        />

        <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
          {!supabaseConfigured && <ConfigWarning />}

          {/* Scenario picker */}
          <div className="scenario-tabs flex gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
            <button
              onClick={() => setScenario("overview")}
              className={`px-3.5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${
                scenario === "overview"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              📋 Overview
            </button>
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                onClick={() => setScenario(s.key)}
                className={`px-3.5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${
                  scenario === s.key
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {s.icon} {s.title}
              </button>
            ))}
          </div>

          {scenario === "overview" ? (
            <Overview onSelect={setScenario} />
          ) : (
            <ScenarioDemo key={scenario} config={SCENARIOS.find((s) => s.key === scenario)!} />
          )}
        </main>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Overview
// ════════════════════════════════════════════════════════════════════════════

function Overview({ onSelect }: { onSelect: (s: Scenario) => void }) {
  return (
    <div className="space-y-6">
      <Card
        title="How fraudsters try to exploit dashcam evidence"
        subtitle="And how cryptographic fingerprinting catches every attempt"
      >
        <div className="text-sm text-slate-300 space-y-4 max-w-3xl leading-relaxed">
          <p>
            In insurance claims, dashcam video is critical evidence. Fraudsters use several techniques to
            manipulate video before submitting it — hoping the insurer will accept their altered version of events.
          </p>
          <p>
            Our system defeats all of these attacks because <strong>every video segment is fingerprinted at the
            moment of recording</strong> using SHA-256 hashing, chained together in a tamper-evident sequence,
            and signed with the device&apos;s private key. These fingerprints are anchored on the server within
            seconds of capture — long before any fraud attempt.
          </p>
          <p className="text-indigo-300 font-semibold">
            Select a scenario below to see a live, interactive demonstration.
          </p>
        </div>
      </Card>

      <div className="grid md:grid-cols-3 gap-5">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            onClick={() => onSelect(s.key)}
            className="group text-left bg-slate-800/50 border border-slate-700/60 rounded-2xl p-5 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all"
          >
            <span className="text-3xl">{s.icon}</span>
            <h3 className="text-base font-semibold text-white mt-3 group-hover:text-indigo-300 transition-colors">
              {s.title}
            </h3>
            <p className="text-xs text-amber-300 mt-1">{s.subtitle}</p>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">{s.description}</p>
            <span className="inline-flex items-center gap-1 text-xs text-indigo-400 mt-3 group-hover:text-indigo-300">
              Try this demo →
            </span>
          </button>
        ))}
      </div>

      <Card title="How the system protects against fraud" subtitle="End-to-end integrity at every stage">
        <div className="grid md:grid-cols-2 gap-6 text-sm text-slate-300">
          <div className="space-y-3">
            <h4 className="font-semibold text-white flex items-center gap-2">
              <span className="text-lg">📱</span> At Recording (Phone)
            </h4>
            <ul className="space-y-1.5 text-xs list-disc pl-5">
              <li>Every segment is hashed (<code className="text-emerald-400">SHA-256</code>) immediately after recording</li>
              <li>Hashes are chained: each segment references the previous hash</li>
              <li>Each chain hash is signed with the device&apos;s ECDSA private key</li>
              <li>Breaking one link breaks the entire chain from that point</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h4 className="font-semibold text-white flex items-center gap-2">
              <span className="text-lg">☁️</span> At Anchoring (Server)
            </h4>
            <ul className="space-y-1.5 text-xs list-disc pl-5">
              <li>Hash records are transmitted in real-time (or buffered offline)</li>
              <li>Server timestamps when each hash arrives (proof of existence)</li>
              <li>Records are append-only — no updates or deletes allowed</li>
              <li>Anchored hash becomes the ground truth for verification</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h4 className="font-semibold text-white flex items-center gap-2">
              <span className="text-lg">🛡️</span> At Verification (Insurer)
            </h4>
            <ul className="space-y-1.5 text-xs list-disc pl-5">
              <li>SHA-256 of submitted file is recomputed and looked up on the server</li>
              <li>Device signature and chain hash are validated</li>
              <li>Sequence continuity is checked (no gaps allowed)</li>
              <li>Any mismatch → <span className="text-red-400 font-semibold">TAMPERED</span> verdict</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h4 className="font-semibold text-white flex items-center gap-2">
              <span className="text-lg">❌</span> What Fraud Cannot Do
            </h4>
            <ul className="space-y-1.5 text-xs list-disc pl-5">
              <li>Cannot edit a single byte without changing the SHA-256 hash</li>
              <li>Cannot forge a signature without the device&apos;s private key</li>
              <li>Cannot insert/delete segments without breaking chain links</li>
              <li>Cannot hide gaps — the verifier checks sequence completeness</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
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
        .from("dashcam_video_segments")
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

  // ── Step 2: Load evidence files (IndexedDB → cloud → synthetic) ──
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

  // ── Step 4: Run verification on tampered evidence ──
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
          <span className="text-4xl">{config.icon}</span>
          <div>
            <h2 className="text-xl font-bold text-white">{config.title}</h2>
            <p className="text-sm text-amber-300 mt-0.5">{config.subtitle}</p>
            <p className="text-sm text-slate-300 mt-2 leading-relaxed max-w-3xl">{config.description}</p>
          </div>
        </div>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-0 overflow-x-auto">
        {(
          [
            ["intro", "1. Understand"],
            ["setup", "2. Select session"],
            ["tamper", "3. Apply fraud"],
            ["verify", "4. Verify"],
            ["result", "5. Result"],
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
                {active && step < current ? "✓" : ""} {label}
              </div>
              {i < 4 && (
                <div className={`w-6 h-0.5 ${active && step < current ? "bg-emerald-600/50" : "bg-slate-700"}`} />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 text-sm text-red-300">⚠ {error}</div>
      )}

      {/* Phase: Intro */}
      {phase === "intro" && (
        <Card title="Fraud technique & detection method">
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-sm font-semibold text-red-300 flex items-center gap-2 mb-2">
                <span>🦹</span> What the fraudster does
              </h4>
              <p className="text-sm text-slate-300 leading-relaxed">{config.fraudMethod}</p>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-emerald-300 flex items-center gap-2 mb-2">
                <span>🛡️</span> How the system detects it
              </h4>
              <p className="text-sm text-slate-300 leading-relaxed">{config.detection}</p>
            </div>
          </div>
          <div className="mt-5 pt-4 border-t border-slate-700/50">
            <Button tone="primary" onClick={loadSessions} disabled={loading}>
              {loading ? "Loading sessions…" : "→ Start demo: Load recorded sessions"}
            </Button>
          </div>
        </Card>
      )}

      {/* Phase: Setup — pick a session */}
      {phase === "setup" && (
        <Card
          title="Select a recorded session"
          subtitle="Pick a session from the Encoder. Its segments will become the original evidence."
        >
          {sessions.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-slate-400 text-sm">No recording sessions found.</p>
              <p className="text-slate-500 text-xs mt-1">
                Go to the <Link href="/" className="text-indigo-400 hover:underline">Encoder</Link> page, start the dashcam,
                record a few segments, and come back here.
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
            title="Original evidence"
            subtitle={`${origFiles.length} segment(s) from session ${selectedSession?.slice(0, 8)}`}
          >
            <FileTable files={origFiles} label="Original" onPlay={play} />
          </Card>

          <Card
            title={`Apply fraud: ${config.title}`}
            subtitle="Configure and apply the tampering operation"
          >
            {config.key === "trim" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Simulate cutting the video short — keeping only a portion and discarding the rest.
                  The fraudster hopes the removed portion (showing their fault) goes unnoticed.
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
                  Removing even 5% of the file changes the SHA-256 hash completely.
                </p>
              </div>
            )}

            {config.key === "blur" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Simulate applying a blur or edit effect to a region of the video. When a video editor re-encodes
                  the file, the bytes change throughout — even in &quot;unedited&quot; regions due to codec compression.
                </p>
                <label className="flex items-center gap-3 text-sm text-slate-400">
                  Edited region size
                  <select
                    value={blurBlockSize}
                    onChange={(e) => setBlurBlockSize(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-100"
                  >
                    <option value={1}>1 byte (minimal)</option>
                    <option value={1024}>1 KB</option>
                    <option value={4096}>4 KB</option>
                    <option value={8192}>8 KB (typical blur region)</option>
                    <option value={65536}>64 KB (large edit)</option>
                  </select>
                </label>
                <p className="text-xs text-slate-500">
                  Even changing 1 single byte makes the SHA-256 completely different (avalanche effect).
                </p>
              </div>
            )}

            {config.key === "omit" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-300">
                  Select which segments to <strong className="text-red-400">remove</strong> from the evidence.
                  The remaining files are untouched — but the gaps in the sequence reveal the deception.
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
                    Click segments above to mark them for removal, or proceed to auto-select middle segments.
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
                  Simulate editing the video <strong className="text-amber-300">before</strong> the hashes are uploaded to the server.
                  The fraudster modifies the footage while the device has no network, hoping to submit
                  the tampered version as if it were the original.
                </p>
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-xs text-amber-300 font-semibold mb-1">⚡ Why this still fails:</p>
                  <ul className="text-xs text-slate-400 list-disc pl-5 space-y-1">
                    <li>The hash is computed <strong>at recording time</strong> on the device, not at upload time</li>
                    <li>Even offline, the segment hash is already sealed into the hash chain</li>
                    <li>The chain hash is signed with the device&apos;s ECDSA private key (stored in secure browser storage)</li>
                    <li>The fraudster would need to re-sign the entire chain — but the private key is non-extractable</li>
                    <li>When the device reconnects, it transmits the <strong>original</strong> signed hashes, not the tampered ones</li>
                  </ul>
                </div>
                <p className="text-xs text-slate-500">
                  This demo modifies 10% of each file&apos;s bytes (simulating a video edit) and submits the modified files against the original server records.
                </p>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-slate-700/50 flex gap-3">
              <Button tone="warn" onClick={applyTamper} disabled={loading}>
                {config.key === "trim" ? "✂️ Trim videos" : config.key === "blur" ? "🔍 Apply blur effect" : config.key === "offline" ? "📡 Simulate offline edit" : "🗑️ Remove segments"}
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
                ← Back
              </Button>
            </div>
          </Card>

          {tamperedFiles.length > 0 && (
            <>
              <Card
                title="Tampered evidence (what the fraudster submits)"
                subtitle={`${tamperedFiles.length} file(s) — modifications highlighted`}
                right={
                  <Button small onClick={() => { for (const f of tamperedFiles) downloadBlob(f.blob, f.name); }}>
                    ⬇ Download all tampered
                  </Button>
                }
              >
                <FileTable files={tamperedFiles} label="Tampered" onPlay={play} showNotes />
              </Card>

              {/* Side-by-side comparison */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <h4 className="text-sm font-semibold text-emerald-300 mb-2">✓ Original evidence</h4>
                  <p className="text-xs text-slate-400">{origFiles.length} files, {formatBytes(origFiles.reduce((a, f) => a + f.blob.size, 0))} total</p>
                </div>
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                  <h4 className="text-sm font-semibold text-red-300 mb-2">✖ Tampered evidence</h4>
                  <p className="text-xs text-slate-400">
                    {tamperedFiles.length} files, {formatBytes(tamperedFiles.reduce((a, f) => a + f.blob.size, 0))} total
                    {config.key === "trim" && ` (${Math.round((1 - tamperedFiles.reduce((a, f) => a + f.blob.size, 0) / origFiles.reduce((a, f) => a + f.blob.size, 0)) * 100)}% smaller)`}
                    {config.key === "omit" && ` (${origFiles.length - tamperedFiles.length} segments removed)`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button tone="primary" onClick={runVerify} disabled={loading}>
                  {loading ? "Verifying…" : "🛡️ Run verification on tampered evidence"}
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
                label="Original evidence (baseline)"
                icon="✓"
              />
            )}
            <VerdictBox
              report={report}
              label="Tampered evidence (fraud attempt)"
              icon="✖"
            />
          </div>

          {/* Detailed explanation */}
          <Card
            title="What happened?"
            subtitle={`Detection analysis for: ${config.title}`}
          >
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                <h4 className="text-sm font-semibold text-red-300 mb-2">🦹 The fraud attempt</h4>
                <p className="text-sm text-slate-300">{config.fraudMethod}</p>
              </div>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                <h4 className="text-sm font-semibold text-emerald-300 mb-2">🛡️ Why it was caught</h4>
                <p className="text-sm text-slate-300">{config.detection}</p>
                {config.key === "trim" && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400 list-disc pl-5">
                    <li>The truncated file has fewer bytes → different SHA-256</li>
                    <li>File size doesn&apos;t match the size recorded at capture</li>
                    <li>The filename matches a known segment, but the content is different → <strong className="text-red-400">MODIFIED</strong></li>
                  </ul>
                )}
                {config.key === "blur" && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400 list-disc pl-5">
                    <li>Re-encoding with blur changes bytes throughout the file</li>
                    <li>SHA-256 avalanche effect: even 1 byte change → completely different hash</li>
                    <li>The edited file cannot match any registered fingerprint → <strong className="text-red-400">MODIFIED</strong></li>
                  </ul>
                )}
                {config.key === "omit" && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400 list-disc pl-5">
                    <li>Individual files may be authentic (untouched)</li>
                    <li>But the verifier checks sequence numbers: first to last must be contiguous</li>
                    <li>Missing segments in the range → <strong className="text-amber-400">INCOMPLETE</strong> or <strong className="text-red-400">TAMPERED</strong></li>
                  </ul>
                )}
                {config.key === "offline" && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400 list-disc pl-5">
                    <li>The hash was computed and signed <strong>at recording time</strong>, before any edit could occur</li>
                    <li>The device transmits the <strong>original</strong> signed fingerprints when it reconnects</li>
                    <li>The modified file&apos;s SHA-256 does not match the anchored hash → <strong className="text-red-400">MODIFIED</strong></li>
                    <li>Even if the fraudster somehow re-hashes, they cannot forge the ECDSA device signature</li>
                    <li>The chain link (prev_chain_hash) would also break, compounding the evidence of tampering</li>
                  </ul>
                )}
              </div>
            </div>
          </Card>

          {/* Per-file results */}
          <Card title="Per-file verification results">
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
                            ✖ {p}
                          </p>
                        ))}
                        {v.warnings.map((p, j) => (
                          <p key={j} className="text-amber-300">
                            ⚠ {p}
                          </p>
                        ))}
                        {!v.problems.length && !v.warnings.length && (
                          <p className="text-emerald-300">✔ Authentic</p>
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
              ← Modify fraud parameters
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
              ↺ Start over
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
                <Button small onClick={() => onPlay(f, `${label}: ${f.name}`)}>
                  ▶
                </Button>
                <Button small onClick={() => downloadBlob(f.blob, f.name)}>
                  ⬇
                </Button>
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
  icon: string;
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
          ? "✔ AUTHENTIC"
          : report.verdict === "INCOMPLETE"
          ? "◐ INCOMPLETE"
          : "✖ TAMPERED"}
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
          ✖ {p}
        </p>
      ))}
      {audit.warnings.map((p, i) => (
        <p key={i} className="text-xs text-amber-300">
          ⚠ {p}
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
