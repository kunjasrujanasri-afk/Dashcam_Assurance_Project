/**
 * src/pages/admin.tsx — DECODER (insurer side)
 *
 *  1. Live monitor   – hashes arriving from dashcams in real time, each record
 *                      checked on arrival (chain hash + device signature + link).
 *  2. Verify evidence – retrieve clips (evidence bucket or local files) and run
 *                      the full integrity verification (lib/verifier.ts).
 *  3. Tamper lab      – modify / corrupt / remove / reorder evidence to show
 *                      that the verification detects it.
 *  4. How it works    – description of the protocol.
 */

import Head from "next/head";
import Link from "next/link";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, ConfigWarning, Stat, Tone, TopNav } from "@/components/ui";
import { ANCHOR_DELAY_WARN_MS } from "@/lib/config";
import { computeChainHash, genesisHash, importPublicJwk, verifyChainSignature } from "@/lib/integrity";
import { downloadEvidence, EvidenceFolder, listEvidenceFolders, runServerPurge, supabaseRepository } from "@/lib/repository";
import { DeviceRow, SegmentRow, supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { flipOneBit, overwriteBlock, swapNames, tamperServerRecord, truncate } from "@/lib/tamperLab";
import {
  auditSession,
  clearKeyCache,
  compactRanges,
  EvidenceFile,
  FileStatus,
  formatDuration,
  SessionAudit,
  VerificationReport,
  verifyEvidence,
} from "@/lib/verifier";
import { downloadBlob, formatBytes, formatClock, short } from "@/utils/format";

type Tab = "live" | "verify" | "how";
type RowCheck = "pending" | "ok" | "bad";
interface LiveRow extends SegmentRow {
  check: RowCheck;
  checkNote?: string;
}

export default function DecoderPage() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <>
      <Head>
        <title>Dashcam Decoder</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className="min-h-screen bg-slate-950 text-white">
        <TopNav icon="🛡️" kicker="Insurer · Decoder" title="Evidence Integrity Console" href="/" hrefLabel="Encoder" right={<Link href="/demo" className="text-xs text-slate-400 hover:text-white whitespace-nowrap">Fraud Demo →</Link>} />
        <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
          {!supabaseConfigured && <ConfigWarning />}
          <div className="flex gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
            {(
              [
                ["live", "Live monitor"],
                ["verify", "Verify evidence"],
                ["how", "How verification works"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-3.5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${
                  tab === k ? "bg-indigo-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* keep both mounted so state survives tab switches */}
          <div className={tab === "live" ? "" : "hidden"}>
            <LiveMonitor />
          </div>
          <div className={tab === "verify" ? "" : "hidden"}>
            <VerifyEvidence />
          </div>
          {tab === "how" && <HowItWorks />}
        </main>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Live monitor
// ════════════════════════════════════════════════════════════════════════════

function LiveMonitor() {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [rt, setRt] = useState<"connecting" | "live" | "error">("connecting");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<SessionAudit | null>(null);
  const [auditing, setAuditing] = useState<string | null>(null);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const keys = useRef(new Map<string, Promise<CryptoKey | null>>());
  const chainIndex = useRef(new Map<string, string>()); // `${session}:${seq}` → chain_hash

  const keyFor = useCallback((deviceId: string) => {
    if (!keys.current.has(deviceId)) {
      keys.current.set(
        deviceId,
        Promise.resolve(supabase.from("devices").select("*").eq("id", deviceId).maybeSingle())
          .then(({ data }) => (data ? importPublicJwk((data as DeviceRow).public_key) : null))
          .catch(() => null)
      );
    }
    return keys.current.get(deviceId)!;
  }, []);

  /** Quick per-record check on arrival: chain hash, signature, link to seq-1. */
  const checkRow = useCallback(
    async (r: SegmentRow): Promise<{ check: RowCheck; note?: string }> => {
      const notes: string[] = [];
      if ((await computeChainHash(r)) !== r.chain_hash) notes.push("chain hash mismatch");
      const key = await keyFor(r.device_id);
      if (!key || !(await verifyChainSignature(key, r.chain_hash, r.signature))) notes.push("bad signature");
      const prev = r.seq === 0 ? await genesisHash(r.session_id) : chainIndex.current.get(`${r.session_id}:${r.seq - 1}`);
      if (prev && prev !== r.prev_chain_hash) notes.push("broken chain link");
      chainIndex.current.set(`${r.session_id}:${r.seq}`, r.chain_hash);
      return notes.length ? { check: "bad", note: notes.join(", ") } : { check: "ok" };
    },
    [keyFor]
  );

  const load = useCallback(async () => {
    setLoadErr(null);
    const { data, error } = await supabase
      .from("video_segments")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) {
      setLoadErr(error.message);
      return;
    }
    const list = (data ?? []) as SegmentRow[];
    // index chain hashes in seq order first, then check
    const checked: LiveRow[] = [];
    for (const r of [...list].sort((a, b) => a.seq - b.seq)) checked.push({ ...r, ...(await checkRow(r)) } as LiveRow);
    checked.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.seq - a.seq);
    setRows(checked);
  }, [checkRow]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const ch = supabase
      .channel("segments-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "video_segments" }, async (p) => {
        const r = p.new as SegmentRow;
        const c = await checkRow(r);
        setRows((prev) => (prev.some((x) => x.id === r.id) ? prev : [{ ...r, check: c.check, checkNote: c.note }, ...prev].slice(0, 500)));
      })
      .subscribe((s) => setRt(s === "SUBSCRIBED" ? "live" : s === "CHANNEL_ERROR" || s === "TIMED_OUT" ? "error" : "connecting"));
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [load, checkRow]);

  const sessions = useMemo(() => {
    const m = new Map<string, { id: string; device: string; count: number; first: number; last: number; bad: number; maxDelay: number }>();
    for (const r of rows) {
      const s = m.get(r.session_id) ?? { id: r.session_id, device: r.device_id, count: 0, first: Infinity, last: 0, bad: 0, maxDelay: 0 };
      s.count++;
      s.first = Math.min(s.first, Number(r.started_at));
      s.last = Math.max(s.last, Number(r.ended_at));
      if (r.check === "bad") s.bad++;
      s.maxDelay = Math.max(s.maxDelay, new Date(r.created_at).getTime() - Number(r.ended_at));
      m.set(r.session_id, s);
    }
    return [...m.values()].sort((a, b) => b.last - a.last);
  }, [rows]);

  const runAudit = async (sid: string) => {
    setAuditing(sid);
    try {
      clearKeyCache();
      setAudit(await auditSession(sid, await supabaseRepository.getSession(sid), supabaseRepository));
    } catch (e) {
      setLoadErr((e as Error).message);
    } finally {
      setAuditing(null);
    }
  };

  const purge = async () => {
    try {
      const n = await runServerPurge();
      setPurgeMsg(`Retention purge removed ${n} expired record(s).`);
      await load();
    } catch (e) {
      setPurgeMsg(`Purge failed: ${(e as Error).message}`);
    }
  };

  const ok = rows.filter((r) => r.check === "ok").length;
  const bad = rows.filter((r) => r.check === "bad").length;
  const delayed = rows.filter((r) => new Date(r.created_at).getTime() - Number(r.ended_at) > ANCHOR_DELAY_WARN_MS).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={rt === "live" ? "green" : rt === "error" ? "red" : "amber"} pulse={rt === "live"}>
          Realtime {rt}
        </Badge>
        <Button small onClick={load}>↻ Reload</Button>
        <Button small onClick={purge} title="Delete server hashes whose retention period has expired">🗑 Run retention purge</Button>
        {purgeMsg && <span className="text-xs text-slate-400">{purgeMsg}</span>}
      </div>
      {loadErr && <p className="text-sm text-red-400">⚠ {loadErr}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Records (latest 300)" value={rows.length} tone="indigo" />
        <Stat label="Signature + chain OK" value={ok} tone="green" />
        <Stat label="Integrity failures" value={bad} tone={bad ? "red" : "slate"} />
        <Stat label="Delayed anchoring" value={delayed} tone={delayed ? "amber" : "slate"} sub="sent after offline buffering" />
      </div>

      <Card title="Recording sessions" subtitle="One session = one Start→Stop on a phone. Audit re-verifies the complete hash chain stored on the server.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-left">
              <tr>
                <th className="p-2">Session</th>
                <th className="p-2">Device</th>
                <th className="p-2">Recorded</th>
                <th className="p-2">Segments</th>
                <th className="p-2">Max anchor delay</th>
                <th className="p-2">Status</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="p-2 font-mono">{s.id.slice(0, 8)}</td>
                  <td className="p-2 font-mono text-slate-400">{s.device.slice(0, 8)}</td>
                  <td className="p-2 font-mono text-slate-400">
                    {new Date(s.first).toLocaleDateString()} {formatClock(s.first)} → {formatClock(s.last)}
                  </td>
                  <td className="p-2 font-mono">{s.count}</td>
                  <td className="p-2 font-mono text-slate-400">{formatDuration(Math.max(0, s.maxDelay))}</td>
                  <td className="p-2">{s.bad ? <Badge tone="red">{s.bad} failing</Badge> : <Badge tone="green">consistent</Badge>}</td>
                  <td className="p-2 text-right">
                    <Button small onClick={() => runAudit(s.id)} disabled={!!auditing}>
                      {auditing === s.id ? "Auditing…" : "Audit chain"}
                    </Button>
                  </td>
                </tr>
              ))}
              {!sessions.length && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">No records yet. Start the dashcam on the Encoder.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {audit && (
          <div className="mt-4">
            <SessionAuditCard audit={audit} />
          </div>
        )}
      </Card>

      <Card title="Incoming fingerprints" subtitle="Each record is verified on arrival: chain hash recomputed, device signature checked, link to previous segment checked.">
        <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-left sticky top-0 bg-slate-900">
              <tr>
                <th className="p-2">Session / seq</th>
                <th className="p-2">Captured</th>
                <th className="p-2">Anchored</th>
                <th className="p-2">Segment SHA-256</th>
                <th className="p-2 hidden md:table-cell">Chain hash</th>
                <th className="p-2">Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r) => {
                const delay = new Date(r.created_at).getTime() - Number(r.ended_at);
                return (
                  <tr key={r.id} className={r.check === "bad" ? "bg-red-500/10" : ""}>
                    <td className="p-2 font-mono">
                      {r.session_id.slice(0, 8)} <span className="text-slate-400">#{r.seq}</span>
                    </td>
                    <td className="p-2 font-mono text-slate-400">{formatClock(Number(r.started_at))}</td>
                    <td className={`p-2 font-mono ${delay > ANCHOR_DELAY_WARN_MS ? "text-amber-400" : "text-slate-400"}`}>
                      +{formatDuration(Math.max(0, delay))}
                    </td>
                    <td className="p-2 font-mono text-slate-300">{short(r.segment_hash, 20)}</td>
                    <td className="p-2 font-mono text-slate-500 hidden md:table-cell">{short(r.chain_hash, 14)}</td>
                    <td className="p-2">
                      {r.check === "ok" ? (
                        <Badge tone="green">signed ✓</Badge>
                      ) : r.check === "bad" ? (
                        <Badge tone="red" title={r.checkNote}>{r.checkNote}</Badge>
                      ) : (
                        <Badge tone="slate">…</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Evidence verification + tamper lab
// ════════════════════════════════════════════════════════════════════════════

const statusTone: Record<FileStatus, Tone> = {
  AUTHENTIC: "green",
  MODIFIED: "red",
  FORGED: "red",
  UNKNOWN: "red",
  DUPLICATE: "amber",
};

function VerifyEvidence() {
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [folders, setFolders] = useState<EvidenceFolder[] | null>(null);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dbTamper, setDbTamper] = useState(false);
  const [dbTamperSeq, setDbTamperSeq] = useState(1);
  const [player, setPlayer] = useState<{ url: string; name: string } | null>(null);
  const [drag, setDrag] = useState(false);

  const addFiles = (list: FileList | File[]) => {
    const add = [...list]
      .filter((f) => f.type.startsWith("video/") || /\.(webm|mp4|mkv|mov)$/i.test(f.name))
      .map((f) => ({ id: crypto.randomUUID(), name: f.name, blob: f as Blob, origin: "local" as const }));
    setFiles((p) => sortFiles([...p, ...add]));
    setReport(null);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    addFiles(e.dataTransfer.files);
  };

  const browseCloud = async () => {
    setCloudErr(null);
    setCloudBusy("Listing…");
    try {
      setFolders(await listEvidenceFolders());
    } catch (e) {
      setCloudErr((e as Error).message);
    } finally {
      setCloudBusy(null);
    }
  };

  const loadFolder = async (f: EvidenceFolder) => {
    setCloudErr(null);
    try {
      const got: EvidenceFile[] = [];
      for (let i = 0; i < f.files.length; i++) {
        setCloudBusy(`Downloading ${i + 1}/${f.files.length}…`);
        got.push(await downloadEvidence(f.files[i].path));
      }
      setFiles((p) => sortFiles([...p, ...got]));
      setReport(null);
    } catch (e) {
      setCloudErr((e as Error).message);
    } finally {
      setCloudBusy(null);
    }
  };

  const replace = (id: string, nf: EvidenceFile) => {
    setFiles((p) => p.map((f) => (f.id === id ? nf : f)));
    setReport(null);
  };

  const tamper = async (f: EvidenceFile, op: "bit" | "block" | "trunc" | "remove" | "swap") => {
    if (op === "remove") {
      setFiles((p) => p.filter((x) => x.id !== f.id));
    } else if (op === "swap") {
      const i = files.findIndex((x) => x.id === f.id);
      const other = files[i + 1];
      if (!other) return;
      const [a, b] = swapNames(f, other);
      setFiles((p) => p.map((x) => (x.id === f.id ? a : x.id === other.id ? b : x)));
    } else {
      replace(f.id, await (op === "bit" ? flipOneBit(f) : op === "block" ? overwriteBlock(f) : truncate(f)));
    }
    setReport(null);
  };

  const run = async () => {
    setErr(null);
    setReport(null);
    clearKeyCache();
    try {
      const r = await verifyEvidence(files, supabaseRepository, {
        mutateRows: dbTamper ? tamperServerRecord(dbTamperSeq) : undefined,
        onProgress: (done, total, label) => setProgress({ done, total, label }),
      });
      setReport(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const play = (f: EvidenceFile) => {
    if (player) URL.revokeObjectURL(player.url);
    setPlayer({ url: URL.createObjectURL(f.blob), name: f.name });
  };

  const exportReport = () => {
    if (!report) return;
    const json = {
      verdict: report.verdict,
      verifiedAt: new Date(report.startedAt).toISOString(),
      summary: report.summary,
      files: report.files.map((v) => ({
        name: v.file.name,
        origin: v.file.origin,
        note: v.file.note,
        status: v.status,
        sha256: v.actualHash,
        expected_sha256: v.record?.segment_hash ?? null,
        session_id: v.record?.session_id ?? null,
        seq: v.record?.seq ?? null,
        problems: v.problems,
        warnings: v.warnings,
      })),
      sessions: report.sessions.map((s) => ({
        session_id: s.sessionId,
        device_id: s.deviceId,
        key_fingerprint: s.keyFingerprint,
        records: s.records.length,
        missing_in_db: s.missingInDb,
        missing_in_evidence: s.missingInEvidence,
        problems: s.problems,
        warnings: s.warnings,
      })),
    };
    downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), `verification-report-${Date.now()}.json`);
  };

  const verdictBox = report && (
    <div
      className={`rounded-2xl border p-5 ${
        report.verdict === "AUTHENTIC"
          ? "border-emerald-500/50 bg-emerald-500/10"
          : report.verdict === "INCOMPLETE"
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-red-500/50 bg-red-500/10"
      }`}
    >
      <p className="text-xs uppercase tracking-widest text-slate-400">Verdict</p>
      <p
        className={`text-3xl font-black ${
          report.verdict === "AUTHENTIC" ? "text-emerald-400" : report.verdict === "INCOMPLETE" ? "text-amber-400" : "text-red-400"
        }`}
      >
        {report.verdict === "AUTHENTIC" ? "✔ AUTHENTIC" : report.verdict === "INCOMPLETE" ? "◐ INCOMPLETE" : "✖ TAMPERED"}
      </p>
      <p className="text-xs text-slate-300 mt-1">
        {report.verdict === "AUTHENTIC"
          ? "Every file is bit-for-bit identical to what the dashcam registered, signatures are valid and the sequence is complete."
          : report.verdict === "INCOMPLETE"
          ? "Submitted files are genuine, but segments are missing from the submitted time range."
          : "At least one file or record is not consistent with what the dashcam registered at capture time."}
      </p>
      <ul className="mt-3 text-xs text-slate-300 space-y-0.5 list-disc pl-5">
        {report.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button small onClick={exportReport}>⬇ Export report (JSON)</Button>
        <span className="text-[11px] text-slate-500 self-center">verified in {report.durationMs} ms</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-2 gap-5">
        <Card title="1 · Retrieve evidence from the cloud" subtitle="Clips submitted by drivers (Supabase Storage bucket “evidence”).">
          <Button onClick={browseCloud} disabled={!!cloudBusy}>{cloudBusy ?? "☁ Browse submitted clips"}</Button>
          {cloudErr && <p className="text-xs text-red-400 mt-2">⚠ {cloudErr}</p>}
          {folders && (
            <ul className="mt-3 space-y-2 max-h-56 overflow-y-auto">
              {folders.map((f) => (
                <li key={f.sessionId} className="flex items-center justify-between gap-2 text-xs bg-slate-900/60 rounded-lg px-3 py-2">
                  <span className="font-mono">
                    session {f.sessionId.slice(0, 8)} · {f.files.length} file(s) · {formatBytes(f.files.reduce((a, x) => a + x.size, 0))}
                  </span>
                  <Button small tone="primary" onClick={() => loadFolder(f)} disabled={!!cloudBusy}>Load</Button>
                </li>
              ))}
              {!folders.length && <li className="text-xs text-slate-500">No submitted clips yet.</li>}
            </ul>
          )}
        </Card>

        <Card title="…or open video files" subtitle="Segments downloaded from the phone (dashcam_<session>_<seq>.webm / .mp4).">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-6 cursor-pointer text-sm ${
              drag ? "border-indigo-400 bg-indigo-500/10" : "border-slate-600 text-slate-400"
            }`}
          >
            <span>Drop files here or click to choose</span>
            <input type="file" accept="video/*,.webm,.mp4" multiple onChange={onPick} className="hidden" />
          </label>
        </Card>
      </div>

      <Card
        title={`2 · Evidence set (${files.length})`}
        subtitle="Tamper-lab buttons create modified copies in memory to demonstrate detection. Originals on the server are never changed."
        right={
          <div className="flex gap-2">
            <Button small onClick={() => { setFiles([]); setReport(null); }} disabled={!files.length}>Clear</Button>
          </div>
        }
      >
        {player && (
          <div className="mb-4">
            <video src={player.url} controls autoPlay className="w-full max-w-xl rounded-lg border border-slate-700 bg-black" />
            <p className="text-[11px] text-slate-500 mt-1 font-mono">{player.name}</p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-left">
              <tr>
                <th className="p-2">File</th>
                <th className="p-2">Size</th>
                <th className="p-2">Origin</th>
                <th className="p-2 text-right">Tamper lab</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {files.map((f, i) => (
                <tr key={f.id} className={f.origin === "tamper-lab" ? "bg-amber-500/5" : ""}>
                  <td className="p-2 font-mono break-all">
                    <button className="hover:text-indigo-300 text-left" onClick={() => play(f)} title="Play">▶ {f.name}</button>
                  </td>
                  <td className="p-2 font-mono text-slate-400 whitespace-nowrap">{formatBytes(f.blob.size)}</td>
                  <td className="p-2">
                    {f.origin === "tamper-lab" ? <Badge tone="amber" title={f.note}>{f.note}</Badge> : <Badge tone={f.origin === "cloud" ? "sky" : "slate"}>{f.origin}</Badge>}
                  </td>
                  <td className="p-2 text-right whitespace-nowrap space-x-1">
                    <Button small onClick={() => tamper(f, "bit")} title="Flip a single bit">1 bit</Button>
                    <Button small onClick={() => tamper(f, "block")} title="Zero 4 KB (edited frames)">edit</Button>
                    <Button small onClick={() => tamper(f, "trunc")} title="Cut the last 20 %">truncate</Button>
                    <Button small onClick={() => tamper(f, "swap")} disabled={i === files.length - 1} title="Swap file names with next (reorder)">swap↓</Button>
                    <Button small tone="danger" onClick={() => tamper(f, "remove")} title="Remove this segment from the evidence">remove</Button>
                  </td>
                </tr>
              ))}
              {!files.length && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-slate-500">No evidence loaded.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <label className="flex flex-wrap items-center gap-2 mt-4 text-xs text-slate-400">
          <input type="checkbox" checked={dbTamper} onChange={(e) => setDbTamper(e.target.checked)} />
          Simulate server-side tampering: shift the timestamps of record seq
          <input
            type="number"
            min={0}
            value={dbTamperSeq}
            onChange={(e) => setDbTamperSeq(Number(e.target.value))}
            className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100"
          />
          by −60 s (in memory only)
        </label>
      </Card>

      <div className="flex items-center gap-3">
        <Button tone="primary" onClick={run} disabled={!files.length || !!progress}>
          {progress ? "Verifying…" : "3 · Verify integrity"}
        </Button>
        {progress && (
          <div className="flex-1">
            <div className="w-full bg-slate-800 rounded-full h-2">
              <div className="bg-indigo-500 h-2 rounded-full transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{progress.label}</p>
          </div>
        )}
      </div>
      {err && <p className="text-sm text-red-400">⚠ {err}</p>}

      {report && (
        <>
          {verdictBox}
          <Card title="Per-file results">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500 text-left">
                  <tr>
                    <th className="p-2">Status</th>
                    <th className="p-2">File</th>
                    <th className="p-2">Identified as</th>
                    <th className="p-2">SHA-256 (actual / registered)</th>
                    <th className="p-2">Findings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 align-top">
                  {report.files.map((v, i) => (
                    <tr key={i} className={v.status === "AUTHENTIC" && !v.problems.length ? "" : v.status === "DUPLICATE" ? "bg-amber-500/5" : "bg-red-500/10"}>
                      <td className="p-2"><Badge tone={statusTone[v.status]}>{v.status}</Badge></td>
                      <td className="p-2 font-mono break-all max-w-[14rem]">
                        <button className="hover:text-indigo-300 text-left" onClick={() => play(v.file)}>▶ {v.file.name}</button>
                      </td>
                      <td className="p-2 font-mono text-slate-400 whitespace-nowrap">
                        {v.record ? (
                          <>
                            {v.record.session_id.slice(0, 8)} #{v.record.seq}
                            <br />
                            {formatClock(Number(v.record.started_at))}–{formatClock(Number(v.record.ended_at))}
                            {v.anchorDelayMs !== null && (
                              <>
                                <br />anchored +{formatDuration(Math.max(0, v.anchorDelayMs))}
                              </>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-2 font-mono break-all max-w-[18rem]">
                        <span className={v.record && v.record.segment_hash !== v.actualHash ? "text-red-400" : "text-emerald-400"}>{v.actualHash}</span>
                        {v.record && v.record.segment_hash !== v.actualHash && (
                          <>
                            <br />
                            <span className="text-slate-500">{v.record.segment_hash}</span>
                          </>
                        )}
                      </td>
                      <td className="p-2 text-[11px] max-w-[18rem]">
                        {v.problems.map((p, j) => (
                          <p key={j} className="text-red-300">✖ {p}</p>
                        ))}
                        {v.warnings.map((p, j) => (
                          <p key={j} className="text-amber-300">⚠ {p}</p>
                        ))}
                        {!v.problems.length && !v.warnings.length && <p className="text-emerald-300">✔ hash, size, signature and chain link valid</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {report.sessions.map((s) => (
            <SessionAuditCard key={s.sessionId} audit={s} />
          ))}
        </>
      )}
    </div>
  );
}

const sortFiles = (f: EvidenceFile[]) => [...f].sort((a, b) => a.name.localeCompare(b.name));

function SessionAuditCard({ audit }: { audit: SessionAudit }) {
  const sigOk = audit.records.filter((r) => r.signatureOk).length;
  const chainOk = audit.records.filter((r) => r.chainOk).length;
  const linksBroken = audit.records.filter((r) => r.linkOk === false).length;
  const clean = !audit.problems.length && !audit.records.some((r) => r.problems.length);
  return (
    <Card
      title={<>Server chain audit · session <span className="font-mono">{audit.sessionId.slice(0, 8)}</span></>}
      subtitle={
        <>
          device <span className="font-mono">{audit.deviceId?.slice(0, 8) ?? "?"}</span> ({audit.deviceLabel ?? "unknown"}) · public key{" "}
          <span className="font-mono">{audit.keyFingerprint ?? "not found"}</span>
        </>
      }
      right={clean ? <Badge tone="green">chain intact</Badge> : <Badge tone="red">chain inconsistent</Badge>}
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
        <Stat label="Records" value={audit.records.length} sub={audit.firstSeq !== null ? `seq #${audit.firstSeq}–#${audit.lastSeq}` : ""} />
        <Stat label="Genesis link" value={audit.genesisOk === null ? "n/a" : audit.genesisOk ? "OK" : "BAD"} tone={audit.genesisOk === false ? "red" : audit.genesisOk ? "green" : "slate"} />
        <Stat label="Valid signatures" value={`${sigOk}/${audit.records.length}`} tone={sigOk === audit.records.length ? "green" : "red"} />
        <Stat label="Chain hashes OK" value={`${chainOk}/${audit.records.length}`} tone={chainOk === audit.records.length ? "green" : "red"} />
        <Stat label="Broken links / gaps" value={`${linksBroken} / ${audit.missingInDb.length}`} tone={linksBroken || audit.missingInDb.length ? "red" : "green"} />
      </div>
      {audit.problems.map((p, i) => (
        <p key={i} className="text-xs text-red-300">✖ {p}</p>
      ))}
      {audit.warnings.map((p, i) => (
        <p key={i} className="text-xs text-amber-300">⚠ {p}</p>
      ))}
      {audit.submittedSeqs.length > 0 && (
        <p className="text-xs text-slate-400 mt-1">
          Evidence covers {compactRanges(audit.submittedSeqs)}
          {audit.missingInEvidence.length ? `; missing ${compactRanges(audit.missingInEvidence)}` : " (contiguous)"}.
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
                r.problems.length ? "bg-red-500" : missing ? "bg-amber-400" : inEv ? "bg-emerald-400" : "bg-slate-600"
              }`}
            />
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500 mt-1">
        ■ green = submitted &amp; valid · amber = missing from evidence · grey = recorded, not submitted · red = failing record
      </p>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Explanation
// ════════════════════════════════════════════════════════════════════════════

function HowItWorks() {
  return (
    <Card title="Integrity protocol">
      <div className="text-sm text-slate-300 space-y-3 max-w-3xl leading-relaxed">
        <p>
          <b>At capture (phone).</b> The dashcam cuts the recording into short, self-contained video segments. For each segment it
          computes <code>segment_hash = SHA-256(file bytes)</code>, then a chain hash over the segment metadata and the previous chain
          hash, <code>chain_hash = SHA-256(v1 | device | session | seq | times | frames | size | type | GPS | segment_hash | prev_chain_hash)</code>,
          and signs <code>chain_hash</code> with an ECDSA P-256 private key that never leaves the phone.
        </p>
        <p>
          <b>Anchoring (server).</b> The signed record is sent within seconds (or buffered offline and sent on reconnection). The
          database stamps its own arrival time, and rows can only be inserted, never updated. The video itself stays on the phone
          until the driver submits it after an incident.
        </p>
        <p>
          <b>Verification (insurer).</b> The Decoder recomputes SHA-256 of each submitted file and looks it up. A match proves the
          file is bit-for-bit what was recorded at that time: SHA-256 is collision-resistant and changing even one bit gives a
          completely different hash. It then checks the signature (the record comes from the registered phone), recomputes the
          chain hash (the record was not edited) and follows <code>prev_chain_hash</code> links (nothing was removed, inserted or
          reordered). Missing sequence numbers inside the submitted range show that part of the timeline was withheld.
        </p>
        <p>
          <b>Why not per-frame hashes?</b> Decoding a compressed video never gives back the exact pixels or JPEG bytes that were
          hashed at capture (codec, seek precision, browser differences), so frame hashes cannot be matched reliably.
          Hashing the exact file bytes is deterministic on every platform, which makes a mismatch an unambiguous proof of
          modification.
        </p>
      </div>
    </Card>
  );
}
