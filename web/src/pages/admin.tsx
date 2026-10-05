/** Evidence Desk: cloud timeline, grouped journeys, and one video/TXT input panel. */

import Head from "next/head";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, ConfigWarning, Stat, SegmentedControl, Tone, TopNav } from "@/components/ui";
import { ANCHOR_DELAY_WARN_MS } from "@/lib/config";
import { computeChainHash, genesisHash, importPublicJwk, parseSegmentFileName, verifyChainSignature } from "@/lib/integrity";
import { runServerPurge, supabaseRepository } from "@/lib/repository";
import { DeviceRow, SegmentRow, supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { verifyHashManifest, type ManifestReport } from "@/lib/hashManifest";
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

type Tab = "live" | "verify";
type RowCheck = "pending" | "ok" | "bad";
interface LiveRow extends SegmentRow {
  check: RowCheck;
  checkNote?: string;
}

export default function EvidenceDeskPage() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <>
      <Head>
        <title>Evidence Desk · Dashcam Assurance</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className="min-h-screen bg-slate-950 text-white">
        <TopNav kicker="02 / EVIDENCE REVIEW" title="Evidence Desk" />
        <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
          {!supabaseConfigured && <ConfigWarning />}
          <div className="desk-switcher"><p className="section-caption">CHOOSE YOUR VIEW</p>
            <SegmentedControl<Tab> label="Evidence view" value={tab} onChange={setTab}
              items={[{ value: "live", label: "Cloud timeline" }, { value: "verify", label: "File review" }]} />
          </div>
          {/* keep both mounted so state survives tab switches */}
          <div className={tab === "live" ? "" : "hidden"}>
            <LiveMonitor />
          </div>
          <div className={tab === "verify" ? "" : "hidden"}>
            <VerifyEvidence />
          </div>
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
          Cloud feed {rt}
        </Badge>
        <Button small onClick={load}>Refresh feed</Button>
        <Button small onClick={purge} title="Delete server hashes whose retention period has expired">Clear expired receipts</Button>
        {purgeMsg && <span className="text-xs text-slate-400">{purgeMsg}</span>}
      </div>
      {loadErr && <p className="text-sm text-red-400">⚠ {loadErr}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Cloud receipts" value={rows.length} tone="indigo" />
        <Stat label="Validated seals" value={ok} tone="green" />
        <Stat label="Review flags" value={bad} tone={bad ? "red" : "slate"} />
        <Stat label="Buffered uploads" value={delayed} tone={delayed ? "amber" : "slate"} sub="sent after offline buffering" />
      </div>

      <div className="ledger-grid">
      <Card title="Journey index" subtitle="Choose a session to inspect its signed chain.">
        <div className="journey-list">
          {sessions.map((s) => (
            <article key={s.id} className="journey-entry">
              <div className="flex items-center justify-between gap-3"><strong className="font-mono">{s.id.slice(0, 8)}</strong>
                {s.bad ? <Badge tone="red">{s.bad} issues</Badge> : <Badge tone="green">Consistent</Badge>}
              </div>
              <p>{new Date(s.first).toLocaleDateString()} · {formatClock(s.first)}–{formatClock(s.last)}</p>
              <dl><div><dt>Clips</dt><dd>{s.count}</dd></div><div><dt>Device</dt><dd>{s.device.slice(0, 8)}</dd></div><div><dt>Sync delay</dt><dd>{formatDuration(Math.max(0, s.maxDelay))}</dd></div></dl>
              <Button small onClick={() => runAudit(s.id)} disabled={!!auditing}>{auditing === s.id ? "Inspecting…" : "Inspect chain"}</Button>
            </article>
          ))}
          {!sessions.length && <p className="empty-note">Your journeys will appear after recording in Drive Studio.</p>}
        </div>
      </Card>

      <Card title="Receipt stream" subtitle="Each record is verified on arrival: chain hash recomputed, device signature checked, link to previous segment checked.">
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
                        <Badge tone="green">Validated</Badge>
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
      {audit && <SessionAuditCard audit={audit} />}
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
  const [mode, setMode] = useState<"video" | "hashes">("video");
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [hashText, setHashText] = useState("");
  const [manifestName, setManifestName] = useState("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [manifestReport, setManifestReport] = useState<ManifestReport | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [player, setPlayer] = useState<{ url: string; name: string } | null>(null);
  const [drag, setDrag] = useState(false);

  const selectedVideos = useMemo(() => {
    const groups = new Map<string, EvidenceFile[]>();
    for (const file of files) {
      const session = parseSegmentFileName(file.name)?.session_id ?? "unidentified";
      groups.set(session, [...(groups.get(session) ?? []), file]);
    }
    return [...groups.entries()];
  }, [files]);

  const addFiles = (list: FileList | File[]) => {
    const chosen = [...list].filter((file) => file.type.startsWith("video/") || /\.(webm|mp4|mkv|mov)$/i.test(file.name));
    if (!chosen.length) { setErr("Choose video clips in WebM, MP4, MKV, or MOV format."); return; }
    setFiles((current) => [...current, ...chosen.map((file) => ({
      id: crypto.randomUUID(), name: file.name, blob: file as Blob, origin: "local" as const,
    }))].sort((left, right) => left.name.localeCompare(right.name)));
    setReport(null);
    setErr(null);
  };
  const readManifest = async (file: File) => {
    if (!/\.txt$/i.test(file.name)) { setErr("Choose a TXT hash list."); return; }
    if (file.size > 1_000_000) { setErr("Choose a TXT file smaller than 1 MB."); return; }
    try { setHashText(await file.text()); setManifestName(file.name); setManifestReport(null); setErr(null); }
    catch { setErr("The TXT file could not be read."); }
  };
  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault(); setDrag(false);
    if (working) return;
    if (mode === "video") addFiles(event.dataTransfer.files);
    else if (event.dataTransfer.files[0]) void readManifest(event.dataTransfer.files[0]);
  };
  const run = async () => {
    setWorking(true); setErr(null); setProgress("Checking registered evidence…"); clearKeyCache();
    try {
      if (mode === "video") {
        setReport(null);
        setReport(await verifyEvidence(files, supabaseRepository, {
          onProgress: (_done, _total, label) => setProgress(label),
        }));
      } else {
        setManifestReport(null);
        setManifestReport(await verifyHashManifest(hashText, supabaseRepository));
      }
    } catch (error) { setErr((error as Error).message); }
    finally { setWorking(false); setProgress(null); }
  };
  const play = (file: EvidenceFile) => {
    if (player) URL.revokeObjectURL(player.url);
    setPlayer({ url: URL.createObjectURL(file.blob), name: file.name });
  };
  const saveReport = () => {
    const result = mode === "hashes" ? manifestReport : report && {
      verdict: report.verdict, summary: report.summary, durationMs: report.durationMs,
      files: report.files.map((entry) => ({
        name: entry.file.name, status: entry.status, sha256: entry.actualHash,
        session_id: entry.record?.session_id, seq: entry.record?.seq,
        problems: entry.problems, warnings: entry.warnings,
      })), sessions: report.sessions,
    };
    if (result) downloadBlob(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `evidence-review-${Date.now()}.json`);
  };

  return (
    <div className="space-y-5">
      <Card className="verification-input" title="Choose evidence" subtitle="One place to review video clips or a TXT list of SHA-256 fingerprints."
        right={<SegmentedControl<"video" | "hashes"> label="Evidence input type" value={mode}
          onChange={(next) => { if (!working) { setMode(next); setErr(null); } }}
          items={[{ value: "video", label: "Video clips" }, { value: "hashes", label: "TXT hash list" }]} />}>
        <div onDragOver={(event) => { event.preventDefault(); if (!working) setDrag(true); }}
          onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          {mode === "video" ? (
            <>
              <label className={`verification-drop ${drag ? "is-dragging" : ""}`} htmlFor="review-videos">
                <strong>Choose a video to review</strong><span>Drop its clips here, or select them from your device.</span>
                <span className="trial-card-action">Choose video clips</span>
                <input id="review-videos" aria-label="Choose video clips" type="file" accept="video/*,.webm,.mp4,.mkv,.mov" multiple onChange={onPick} disabled={working} className="sr-only" />
              </label>
              <div className="verification-file-list">
                {selectedVideos.map(([session, clips]) => (
                  <details key={session} className="video-session" open>
                    <summary><div><strong>{session === "unidentified" ? "Selected footage" : `Video · ${session.slice(0, 8)}`}</strong><p>{clips.length} clips · {formatBytes(clips.reduce((sum, clip) => sum + clip.blob.size, 0))}</p></div><span>Review clips</span></summary>
                    {clips.map((file) => (
                      <div key={file.id} className="verification-file-row"><div><p>{file.name}</p><small>{formatBytes(file.blob.size)}</small></div>
                        <div className="flex gap-2"><Button small onClick={() => play(file)}>Preview</Button><Button small onClick={() => { setFiles((current) => current.filter((item) => item.id !== file.id)); setReport(null); }} disabled={working}>Remove</Button></div>
                      </div>
                    ))}
                  </details>
                ))}
              </div>
            </>
          ) : (
            <div className="manifest-input">
              <label htmlFor="hash-list" className="section-caption">PASTE YOUR SHA-256 HASHES</label>
              <textarea id="hash-list" value={hashText} disabled={working}
                onChange={(event) => { setHashText(event.target.value); setManifestName(""); setManifestReport(null); }}
                placeholder="One 64-character SHA-256 hash per line" spellCheck={false} />
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="review-manifest" className="studio-button">Choose TXT file
                  <input id="review-manifest" aria-label="Choose TXT file" type="file" accept=".txt,text/plain" disabled={working} className="sr-only"
                    onChange={(event) => { if (event.target.files?.[0]) void readManifest(event.target.files[0]); event.target.value = ""; }} />
                </label><span className="text-xs text-slate-500">{manifestName || "You can also drop a TXT file here."}</span>
              </div>
              <p className="text-xs text-slate-400">Hashes are checked against registered records. Select video clips to verify their actual content.</p>
            </div>
          )}
        </div>
        <div className="verification-controls">
          <span className="text-xs text-slate-500">{mode === "video" ? `${files.length} clips selected` : "One SHA-256 per line · optional filename"}</span>
          <div className="flex gap-2">
            <Button onClick={() => { if (mode === "video") { setFiles([]); setReport(null); } else { setHashText(""); setManifestName(""); setManifestReport(null); } setErr(null); }} disabled={working}>Reset input</Button>
            <Button tone="primary" onClick={run} disabled={working || (mode === "video" ? !files.length : !hashText.trim())}>{working ? "Reviewing…" : mode === "video" ? "Verify video" : "Check hash list"}</Button>
          </div>
        </div>
        {progress && <p className="text-xs text-slate-500 mt-4" role="status">{progress}</p>}
        {err && <p className="text-sm text-red-400 mt-4" role="alert">{err}</p>}
      </Card>
      {player && mode === "video" && <Card title="Clip preview"><video src={player.url} controls autoPlay className="w-full max-w-2xl rounded-2xl bg-black" /><p className="text-xs text-slate-500 mt-3">{player.name}</p></Card>}
      {mode === "video" && report && (
        <>
          <Card title={report.verdict === "AUTHENTIC" ? "Original verified" : report.verdict === "INCOMPLETE" ? "Timeline incomplete" : "Changes detected"}
            right={<Button small onClick={saveReport}>Save review report</Button>}>
            <ul className="text-xs text-slate-400 space-y-2">{report.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
          </Card>
          {[...new Set(report.files.map((entry) => entry.record?.session_id ?? "unidentified"))].map((session) => (
            <Card key={session} title={session === "unidentified" ? "Unmatched footage" : `Video review · ${session.slice(0, 8)}`}>
              <div className="overflow-x-auto"><table><thead><tr><th>Clip</th><th>Finding</th><th>SHA-256</th><th>Details</th></tr></thead>
                <tbody>{report.files.filter((entry) => (entry.record?.session_id ?? "unidentified") === session).map((entry) => (
                  <tr key={entry.file.id}><td className="break-all">{entry.file.name}</td><td><Badge tone={statusTone[entry.status]}>{entry.status}</Badge></td><td className="font-mono">{short(entry.actualHash, 20)}</td><td>{[...entry.problems, ...entry.warnings].join(" · ") || "Hash, size, signature, and chain validated."}</td></tr>
                ))}</tbody></table></div>
            </Card>
          ))}
          {report.sessions.map((session) => <SessionAuditCard key={session.sessionId} audit={session} />)}
        </>
      )}
      {mode === "hashes" && manifestReport && (
        <>
          <Card title="Hash registration results" subtitle="This review checks registered fingerprints and their signed records; it does not verify video content."
            right={<Button small onClick={saveReport}>Save review report</Button>}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <Stat label="Hashes supplied" value={manifestReport.entries.length} />
              <Stat label="Registered & valid" value={manifestReport.entries.filter((entry) => entry.status === "REGISTERED").length} tone="green" />
              <Stat label="Not found / invalid" value={manifestReport.entries.filter((entry) => entry.status === "NOT_FOUND" || entry.status === "INVALID_RECORD").length} tone="red" />
              <Stat label="Repeated" value={manifestReport.entries.filter((entry) => entry.status === "DUPLICATE").length} tone="amber" />
            </div>
            <div className="overflow-x-auto"><table><thead><tr><th>Line</th><th>Fingerprint</th><th>Registration</th><th>Video / clip</th></tr></thead>
              <tbody>{manifestReport.entries.map((entry) => <tr key={entry.line}><td>{entry.line}</td><td className="font-mono break-all">{entry.hash}</td><td><Badge tone={entry.status === "REGISTERED" ? "green" : entry.status === "DUPLICATE" ? "amber" : "red"}>{entry.status === "REGISTERED" ? "Registered" : entry.status === "NOT_FOUND" ? "Not found" : entry.status === "DUPLICATE" ? "Repeated" : "Record invalid"}</Badge></td><td>{entry.sessionId ? `${entry.sessionId.slice(0, 8)} / #${entry.seq}` : "—"}</td></tr>)}</tbody>
            </table></div>
          </Card>
          {manifestReport.sessions.map((session) => <SessionAuditCard key={session.sessionId} audit={session} />)}
        </>
      )}
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
      title={<>Chain inspection · <span className="font-mono">{audit.sessionId.slice(0, 8)}</span></>}
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
