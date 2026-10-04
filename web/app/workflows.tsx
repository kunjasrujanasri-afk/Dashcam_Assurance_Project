"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { addLocalAttempt, getSegment, listLocalAttempts, listOutbox, removeLocalAttempt, removeOutbox, updateOutbox, putSegment, type LocalSegment, type VerificationAttempt } from "@/lib/local-vault";
import { alignVideos, confusion, hashMethodScores, type HashMethod } from "@/lib/video-matching";
import { extractPerceptual, parseFingerprintFile, sha256, verifyChain, verifySignature, type SignedFingerprint } from "@/lib/signed-evidence";
import { downloadProtectedSegment, ensureCaptureSession, fetchWorkspaceFingerprints, listIncidents, loadAuditEvents, loadVerificationHistory, logAuditEvent, logVerification, prepareIdentity, subscribeWorkspace, transmitFingerprint, uploadProtectedSegment } from "@/lib/secure-store";

type BaseProps = { client: SupabaseClient; user: User; workspaceId: string; notify: (message: string) => void };
const fmt = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—";
const bytes = (value: number) => value > 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
function fromRow(row: Record<string, unknown>): SignedFingerprint {
  return {
    version: Number(row.version) as 3, workspaceId: String(row.workspace_id), deviceId: String(row.device_id), sessionId: String(row.session_id),
    segmentId: String(row.segment_id), sequence: Number(row.sequence), capturedAt: String(row.captured_at), bytes: Number(row.bytes),
    sha256: String(row.sha256), previousHash: row.previous_hash ? String(row.previous_hash) : null, chainHash: String(row.chain_hash),
    signature: String(row.signature), signatureAlgorithm: "ECDSA_P256_SHA256", perceptual: row.perceptual as SignedFingerprint["perceptual"],
    perceptualHash: String(row.perceptual_hash), source: String(row.source), metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}
function deviceKey(row: Record<string, unknown>): JsonWebKey | null {
  const device = row.devices as { public_key?: JsonWebKey } | null;
  return device?.public_key ?? null;
}
function saveFile(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ResultBadge({ value }: { value: string }) { return <span className={`status-pill ${value === "VERIFIED" || value === "CONTENT_MATCH" ? "success" : value === "ERROR" ? "neutral" : "warning"}`}>{value}</span>; }

export function LiveMonitor({ client, workspaceId, notify }: BaseProps) {
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]), [incidents, setIncidents] = useState<Array<Record<string, unknown>>>([]), [state, setState] = useState("connecting"), [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [fingerprints, open] = await Promise.all([fetchWorkspaceFingerprints(client, workspaceId), listIncidents(client, workspaceId)]);
      setRecords(fingerprints.reverse()); setIncidents(open); setState("live");
    } catch (error) { setState("offline"); notify(error instanceof Error ? error.message : "Could not load the live workspace monitor."); }
    finally { setLoading(false); }
  }, [client, workspaceId, notify]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); let channel: ReturnType<typeof client.channel> | null = null; void subscribeWorkspace(client, workspaceId, () => void refresh()).then(value => { channel = value; }); return () => { window.clearTimeout(timer); if (channel) void client.removeChannel(channel); }; }, [client, workspaceId, refresh]);
  const totalBytes = incidents.reduce((sum, incident) => sum + ((incident.incident_videos as Array<{ bytes: number }> | undefined) ?? []).reduce((s, row) => s + Number(row.bytes || 0), 0), 0);
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">DECODER / INSURER</p><h1>Live monitor</h1><p>Workspace-scoped signed evidence, protected incidents, and real-time status.</p></div><button className="button button-primary" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh stream"}</button></div>
    <div className="metric-grid metric-grid-wide">{[["Cloud fingerprints", records.length.toLocaleString(), "Signed SHA-256 records"], ["Realtime stream", state === "live" ? "Live" : state === "offline" ? "Unavailable" : "Connecting", "Workspace-scoped updates"], ["Open incidents", incidents.filter(row => row.status === "open").length, "Protected clips available to authorized members"], ["Protected storage", bytes(totalBytes), "Private incident video only"]].map(([label, value, help]) => <article className="metric-card" key={String(label)}><span className="metric-icon blush">✦</span><div><span>{label}</span><b>{value}</b><small>{help}</small></div></article>)}</div>
    <section className="panel"><div className="panel-heading"><div><h2>Recent signed evidence</h2><p>New transmissions appear automatically when Realtime is enabled for the migrated tables.</p></div><span className="quiet-label">WORKSPACE: {workspaceId.slice(0, 8)}…</span></div><div className="table-scroll"><table><thead><tr><th>Captured</th><th>Device</th><th>Session</th><th>Seq.</th><th>SHA-256</th><th>Signature</th></tr></thead><tbody>{records.slice(0, 100).map(row => <tr key={String(row.id)}><td>{fmt(row.captured_at)}</td><td>{String((row.devices as { label?: string } | null)?.label || String(row.device_id).slice(0, 8))}</td><td><code>{String(row.session_id).slice(0, 8)}…</code></td><td>{String(row.sequence)}</td><td><code>{String(row.sha256).slice(0, 16)}…</code></td><td><ResultBadge value="SIGNED" /></td></tr>)}{!records.length && <tr><td colSpan={6} className="empty-state">No signed segments have arrived in this workspace.</td></tr>}</tbody></table></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>Incident queue</h2><p>Only selected, locked segments are stored in the private evidence bucket.</p></div></div><div className="incident-list">{incidents.map(incident => <article className="incident-row" key={String(incident.id)}><span className="incident-mark">!</span><div><b>{String(incident.title)}</b><small>{fmt(incident.created_at)} · {String((incident.devices as { label?: string } | null)?.label || "Driver device")}</small></div><span>{((incident.incident_videos as unknown[]) ?? []).length} protected clip(s)</span><ResultBadge value={String(incident.status).toUpperCase()} /></article>)}{!incidents.length && <p className="empty-state">No active incidents.</p>}</div></section>
  </div>;
}

export function EvidenceDecoder({ client, user, workspaceId, notify }: BaseProps) {
  const [references, setReferences] = useState<Array<Record<string, unknown>>>([]), [file, setFile] = useState<File | null>(null), [manifest, setManifest] = useState<File | null>(null), [textFile, setTextFile] = useState<File | null>(null), [referenceId, setReferenceId] = useState(""), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [result, setResult] = useState<{ status: string; details: Record<string, unknown>; name: string } | null>(null), [incidents, setIncidents] = useState<Array<Record<string, unknown>>>([]);
  const refresh = useCallback(async () => {
    try { const [rows, open] = await Promise.all([fetchWorkspaceFingerprints(client, workspaceId), listIncidents(client, workspaceId)]); setReferences(rows); setIncidents(open); setReferenceId(value => value && rows.some(row => row.segment_id === value) ? value : String(rows[0]?.segment_id ?? "")); }
    catch (error) { notify(error instanceof Error ? error.message : "Could not load trusted references."); }
  }, [client, workspaceId, notify]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const selectedReference = references.find(row => row.segment_id === referenceId) ?? null;


  const persistAttempt = async (status: string, name: string, details: Record<string, unknown>) => {
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const local: VerificationAttempt = { id, workspaceId, actorId: user.id, kind: "video", status, name, details: { ...details, attemptId: id }, createdAt };
    await addLocalAttempt(local);
    try { await logVerification(client, workspaceId, user.id, "video", status, name, { ...details, attemptId: id }); await removeLocalAttempt(id); }
    catch { notify("The check is saved locally and will remain in your history while the cloud is unavailable."); }
  };

  const verify = async () => {
    if (!file) return;
    setBusy(true); setProgress(5); setResult(null);
    let status = "ERROR", details: Record<string, unknown> = {};
    try {
      const calculated = await sha256(file); setProgress(35);

      type ParsedManifest = { manifestVersion?: number; devicePublicKey?: JsonWebKey; evidence?: SignedFingerprint };
      let manifestValue: ParsedManifest | null = null;
      if (manifest) {
        try { manifestValue = JSON.parse(await manifest.text()) as ParsedManifest; }
        catch { status = "INVALID_MANIFEST"; throw new Error("The selected JSON evidence manifest is malformed."); }
        if (manifestValue?.manifestVersion !== 1 || !manifestValue.evidence?.segmentId) { status = "INVALID_MANIFEST"; throw new Error("The manifest version or segment identity is not supported."); }
      }
      const evidenceId = manifestValue?.evidence?.segmentId ?? referenceId;
      const cloudRow = references.find(row => row.segment_id === evidenceId) ?? null;
      if (!cloudRow) { status = "FINGERPRINT_NOT_FOUND"; details = { calculatedHash: calculated, referenceSegment: evidenceId || null }; }
      else {
        const trusted = fromRow(cloudRow), publicKey = deviceKey(cloudRow) ?? manifestValue?.devicePublicKey ?? null;
        const videoMatches = calculated === trusted.sha256 && file.size === trusted.bytes;
        if (manifestValue?.evidence && (manifestValue.evidence.sha256 !== trusted.sha256 || manifestValue.evidence.chainHash !== trusted.chainHash || manifestValue.evidence.signature !== trusted.signature || manifestValue.evidence.sessionId !== trusted.sessionId || manifestValue.evidence.segmentId !== trusted.segmentId)) {
          status = "INVALID_MANIFEST";
        } else if (!videoMatches) status = "FILE_HASH_MISMATCH";
        else if (!publicKey || !(await verifySignature(trusted, publicKey))) status = "INVALID_SIGNATURE";
        else {
          const records = references.filter(row => row.session_id === trusted.sessionId).map(fromRow);
          const chain = await verifyChain(records);
          status = chain.valid ? "VERIFIED" : chain.status;
        }
        details = { calculatedHash: calculated, expectedHash: trusted.sha256, bytes: file.size, expectedBytes: trusted.bytes, segmentId: trusted.segmentId, sessionId: trusted.sessionId, sequence: trusted.sequence };
        if (status === "FILE_HASH_MISMATCH" && trusted.perceptual.frames.length) {
          setProgress(48);
          try {
            const perceptual = await extractPerceptual(file);
            const matched = alignVideos(perceptual, trusted.perceptual, { minimumCoverage: 0.45 });
            details.visualComparison = { status: matched.status, score: matched.score, matchedPercentage: matched.matchedPercentage, anomalies: matched.anomalies, sections: matched.sections };
            if (matched.match) status = "CONTENT_MATCH";
          } catch (error) { details.visualComparisonError = error instanceof Error ? error.message : "Perceptual comparison could not decode the submitted file."; }
        }
      }
      if (textFile) {
        const parsed = parseFingerprintFile(await textFile.text());
        details.legacyText = { filename: textFile.name, hashCount: parsed.fingerprints.length, invalidLines: parsed.invalidLines };
        if (parsed.fingerprints.includes(calculated) && status === "FINGERPRINT_NOT_FOUND") status = "LEGACY_MATCH_REVIEW";
      }
      setProgress(90); await persistAttempt(status, file.name, details); setResult({ status, details, name: file.name });
      if (["VERIFIED", "FILE_HASH_MISMATCH", "CONTENT_MATCH", "INVALID_SIGNATURE", "BROKEN_CHAIN", "MISSING_SEQUENCE", "SESSION_MISMATCH", "DEVICE_MISMATCH", "FINGERPRINT_NOT_FOUND", "INVALID_MANIFEST", "LEGACY_MATCH_REVIEW"].includes(status)) {
        await logAuditEvent(client, workspaceId, user.id, "video_verification", file.name, { status, segmentId: details.segmentId ?? null });
      }
    } catch (error) {
      if (status === "ERROR") status = "ERROR";
      details = { ...details, error: error instanceof Error ? error.message : "Verification could not finish." };
      await persistAttempt(status, file.name, details).catch(() => undefined);
      setResult({ status, details, name: file.name });
    } finally { setProgress(100); setBusy(false); }
  };

  const downloadManifest = () => {
    if (!selectedReference) return;
    const record = fromRow(selectedReference), key = deviceKey(selectedReference);
    if (!key) { notify("This evidence record has no registered device public key."); return; }
    saveFile(`evidence-${record.segmentId}.json`, JSON.stringify({ manifestVersion: 1, devicePublicKey: key, evidence: record }, null, 2));
  };
  const protectedVideos: Array<Record<string, unknown>> = incidents.flatMap(incident => ((incident.incident_videos as Array<Record<string, unknown>> | undefined) ?? []).map(video => ({ ...video, incidentTitle: incident.title })));
  const retrieveProtected = async (row: Record<string, unknown>) => {
    try {
      const blob = await downloadProtectedSegment(client, String(row.storage_path)); if (!blob) throw new Error("The private incident object returned no data.");
      const digest = await sha256(blob), trusted = references.find(item => item.segment_id === row.segment_id);
      const status = trusted && digest === trusted.sha256 && blob.size === Number(trusted.bytes) ? "VERIFIED" : "STORAGE_OBJECT_MISMATCH";
      const local = new File([blob], `incident-${String(row.segment_id)}.webm`, { type: String(row.mime_type || "video/webm") }); setFile(local); setReferenceId(String(row.segment_id));
      await persistAttempt(status, local.name, { storagePath: row.storage_path, calculatedHash: digest, segmentId: row.segment_id });
      setResult({ status, name: local.name, details: { storagePath: row.storage_path, calculatedHash: digest, expectedHash: trusted?.sha256 } });
    } catch (error) { notify(error instanceof Error ? error.message : "Could not retrieve the protected incident video."); }
  };

  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">DECODER / INSURER</p><h1>Verify evidence</h1><p>Check original bytes, signed device identity, session sequence, and matching video sections.</p></div><div className="button-row compact"><button className="button button-neutral" onClick={() => void refresh()}>Refresh stream</button><button className="button button-primary" onClick={downloadManifest} disabled={!selectedReference}>Download manifest</button></div></div>
    <div className="metric-grid metric-grid-wide"><article className="metric-card"><span className="metric-icon mint">✓</span><div><span>Cloud fingerprints</span><b>{references.length.toLocaleString()}</b><small>Trusted session-bound records</small></div></article><article className="metric-card"><span className="metric-icon blush">⌁</span><div><span>Realtime stream</span><b>Scoped</b><small>Authorized workspace only</small></div></article><article className="metric-card"><span className="metric-icon gold">♢</span><div><span>Last verification</span><b>{result?.status ?? "—"}</b><small>{result?.name ?? "No file checked"}</small></div></article></div>
    <section className="panel decoder-panel"><p className="eyebrow">VIDEO VERIFICATION</p><h2>Verify a downloaded video</h2><p>Choose the exact trusted segment or its signed JSON manifest. Hashing remains on this device; the video is never uploaded for verification.</p>
      <div className="settings-grid decoder-settings"><label>Trusted cloud segment<select value={referenceId} onChange={event => setReferenceId(event.target.value)}><option value="">Select a trusted segment…</option>{references.map(row => <option value={String(row.segment_id)} key={String(row.segment_id)}>Seq {String(row.sequence)} · {String(row.device_id).slice(0, 8)}… · {fmt(row.captured_at)}</option>)}</select></label><label>Open video file<input type="file" accept="video/mp4,video/webm,video/quicktime,video/*" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)} /></label><label>Signed evidence manifest (.json)<input type="file" accept=".json,application/json" onChange={event => setManifest(event.target.files?.[0] ?? null)} /></label><label>Legacy SHA-256 list (.txt)<input type="file" accept=".txt,text/plain" onChange={event => setTextFile(event.target.files?.[0] ?? null)} /></label></div>
      {file && <div className="file-summary"><b>{file.name}</b><span>{bytes(file.size)}</span></div>}
      {busy && <div className="progress-wrap"><div><span>Hashing and checking chain</span><span>{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>}
      <button className="button button-primary" onClick={() => void verify()} disabled={!file || busy}>{busy ? "Verifying…" : "Verify exact integrity"}</button>
      {result && <section className={`verification-result ${result.status === "VERIFIED" ? "verified" : result.status === "CONTENT_MATCH" ? "review" : "failed"}`}><div className="panel-heading"><div><p className="eyebrow">RESULT · {result.name}</p><h3>{result.status}</h3></div><ResultBadge value={result.status} /></div><p>{resultExplanation(result.status)}</p><details><summary>Technical details</summary><pre>{JSON.stringify(result.details, null, 2)}</pre></details></section>}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Protected incident videos</h2><p>Authorized workspace members can retrieve, replay, and verify privately stored incident clips.</p></div></div><div className="table-scroll"><table><thead><tr><th>Incident</th><th>Segment</th><th>Size</th><th>Protected object</th><th></th></tr></thead><tbody>{protectedVideos.map(row => <tr key={String(row.id)}><td>{String(row.incidentTitle)}</td><td>{String(row.sequence)}</td><td>{bytes(Number(row.bytes))}</td><td><code>{String(row.storage_path)}</code></td><td><button className="text-action" onClick={() => void retrieveProtected(row)}>Retrieve &amp; verify</button></td></tr>)}{!protectedVideos.length && <tr><td colSpan={5} className="empty-state">No protected video is stored. Lock an incident in Driver capture to preserve clips here.</td></tr>}</tbody></table></div></section>
  </div>;
}

function resultExplanation(status: string) {
  const copy: Record<string, string> = {
    VERIFIED: "Exact file bytes match a trusted cloud fingerprint. The device signature and complete ordered session hash chain are valid.",
    FILE_HASH_MISMATCH: "The supplied file differs byte-for-byte from the trusted recording. Perceptual similarity cannot make it authentic.",
    CONTENT_MATCH: "Some visual frames align with the trusted video, but the file hash differs. This is a review lead, not a verified result.",
    FINGERPRINT_NOT_FOUND: "No matching trusted cloud fingerprint was found. The file cannot be authenticated from this workspace.",
    INVALID_SIGNATURE: "The device signature does not verify against the registered device public key.",
    BROKEN_CHAIN: "A chain hash or previous-hash link failed. The session sequence cannot be trusted.",
    MISSING_SEQUENCE: "The trusted stream is missing one or more segments before this evidence item.",
    SESSION_MISMATCH: "The fingerprint sequence spans more than one capture session.",
    INVALID_MANIFEST: "The supplied manifest is malformed or its identity fields differ from the trusted cloud row.",
    LEGACY_MATCH_REVIEW: "A legacy TXT digest matches, but it has no signed session identity or chain. Manual review is required.",
    STORAGE_OBJECT_MISMATCH: "The protected storage object does not match its trusted exact-file fingerprint.",
    ERROR: "The check could not finish. This processing error is kept separate from integrity failures.",
  };
  return copy[status] ?? "The evidence check found a sequence, signature, or reference issue that needs manual review.";
}

export function VerificationHistory({ client, user, workspaceId, notify }: BaseProps) {
  const [cloud, setCloud] = useState<Array<Record<string, unknown>>>([]), [audit, setAudit] = useState<Array<Record<string, unknown>>>([]), [local, setLocal] = useState<VerificationAttempt[]>([]), [filter, setFilter] = useState("all"), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [attempts, events, localRows] = await Promise.all([loadVerificationHistory(client, workspaceId), loadAuditEvents(client, workspaceId), listLocalAttempts(workspaceId)]);
      setCloud(attempts); setAudit(events); setLocal(localRows);
      for (const row of localRows) {
        try { await logVerification(client, workspaceId, user.id, row.kind, row.status, row.name, { ...row.details, attemptId: row.id }); await removeLocalAttempt(row.id); }
        catch { /* the durable local history remains available for retry */ }
      }
      setLocal(await listLocalAttempts(workspaceId));
    } catch (error) { notify(error instanceof Error ? error.message : "Could not refresh verification history."); }
    finally { setBusy(false); }
  }, [client, workspaceId, user.id, notify]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const merged = useMemo(() => {
    const rows = new Map<string, Record<string, unknown>>();
    for (const row of cloud) rows.set(String(row.id), { ...row, localOnly: false });
    for (const row of local) if (!rows.has(row.id)) rows.set(row.id, { id: row.id, kind: row.kind, status: row.status, name: row.name, details: row.details, created_at: row.createdAt, localOnly: true });
    return [...rows.values()].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
  }, [cloud, local]);
  const exactChecks = merged.filter(row => row.kind === "video" && row.status !== "ERROR"), verified = exactChecks.filter(row => row.status === "VERIFIED").length, errors = merged.filter(row => row.status === "ERROR").length;
  const visible = merged.filter(row => filter === "all" || (filter === "passed" ? row.status === "VERIFIED" : filter === "errors" ? row.status === "ERROR" : row.status !== "VERIFIED" && row.status !== "ERROR"));
  const exportLog = () => saveFile("dashcam-integrity-history.json", JSON.stringify({ exportedAt: new Date().toISOString(), exactVideoPassRate: exactChecks.length ? verified / exactChecks.length : null, attempts: merged, auditEvents: audit }, null, 2));
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">AUDIT &amp; RELIABILITY</p><h1>Integrity &amp; history</h1><p>Each result explains what failed and keeps a durable local outbox through network interruptions.</p></div><div className="button-row compact"><button className="button button-neutral" onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing…" : "Refresh log"}</button><button className="button button-primary" onClick={exportLog}>Export full log</button></div></div>
    <section className="panel reliability-card"><div className="panel-heading"><div><h2>Verification history &amp; reliability</h2><p>Exact-video pass rate: <b>{exactChecks.length ? `${(100 * verified / exactChecks.length).toFixed(1)}%` : "Not evaluated"}</b> · {verified} passed / {exactChecks.length} completed / {merged.length - exactChecks.length - errors} failed / {errors} errors</p></div></div><details><summary>How reliability is calculated</summary><p>Verified exact-video checks divided by completed exact-video checks. Missing references, invalid signatures, chain failures, and byte mismatches lower this rate. Processing errors are reported separately. Manifest checks, evaluation batches, and network-recovery tests do not inflate it.</p></details><div className="history-filter"><label>Show<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All attempts</option><option value="passed">Verified only</option><option value="failed">Review and failures</option><option value="errors">Processing errors</option></select></label></div><div className="table-scroll"><table><thead><tr><th>Time / file</th><th>Check</th><th>Result</th><th>What happened</th></tr></thead><tbody>{visible.map(row => <tr key={String(row.id)}><td>{fmt(row.created_at)}<small>{String(row.name || "Unnamed check")}{row.localOnly ? " · local outbox" : ""}</small></td><td>{String(row.kind)}</td><td><ResultBadge value={String(row.status)} /></td><td>{resultExplanation(String(row.status))}<details><summary>Technical details</summary><pre>{JSON.stringify(row.details, null, 2)}</pre></details></td></tr>)}{!visible.length && <tr><td colSpan={4} className="empty-state">No checks match this filter.</td></tr>}</tbody></table></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>Audit events</h2><p>Client-reported workspace activity is retained with its signed evidence references.</p></div></div><div className="table-scroll"><table><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>{audit.map(row => <tr key={String(row.id)}><td>{fmt(row.created_at)}</td><td>{String(row.action)}</td><td>{String(row.target)}</td><td><code>{JSON.stringify(row.payload)}</code></td></tr>)}{!audit.length && <tr><td colSpan={4} className="empty-state">No audit events recorded.</td></tr>}</tbody></table></div></section>
  </div>;
}

export function IngestionQueue({ client, user, workspaceId, notify }: BaseProps) {
  const [identity, setIdentity] = useState(""); const [rows, setRows] = useState<Array<{ id: string; fingerprint: SignedFingerprint; attempts: number; lastError?: string; queuedAt?: string }>>([]); const [working, setWorking] = useState(false);
  const refresh = useCallback(async () => { try { const device = await prepareIdentity(client, user); setIdentity(device.deviceId); setRows(await listOutbox(device.deviceId)); } catch (error) { notify(error instanceof Error ? error.message : "Could not read the evidence outbox."); } }, [client, user, notify]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 8000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  const retry = async () => {
    if (!identity || !navigator.onLine) { notify("Restore the network before retrying the outbox."); return; }
    setWorking(true); let sent = 0;
    try {
      const current = await prepareIdentity(client, user), pending = await listOutbox(identity);
      for (const item of pending) {
        const record = await getSegment(item.id); if (!record) continue;
        try {
          await putSegment({ ...record, state: "SENDING", attempts: item.attempts + 1 }); await updateOutbox(item.id, { attempts: item.attempts + 1, lastError: null });
          await ensureCaptureSession(client, item.fingerprint, user.id);
          const { data: existing, error } = await client.from("evidence_fingerprints").select("id,sha256,chain_hash").eq("segment_id", item.fingerprint.segmentId).maybeSingle();
          if (error) throw error;
          const fingerprintId = existing ? existing.id as string : await transmitFingerprint(client, item.fingerprint);
          if (existing && (existing.sha256 !== item.fingerprint.sha256 || existing.chain_hash !== item.fingerprint.chainHash)) throw new Error("Evidence ID conflict: queued data differs from the server record.");
          let updated: LocalSegment = { ...record, fingerprintId, state: "SENT" };
          await putSegment(updated);
          if (record.locked && record.incidentId) { const uploaded = await uploadProtectedSegment(client, updated, record.incidentId); updated = { ...updated, storagePath: String(uploaded?.storage_path ?? "") }; await putSegment(updated); }
          await removeOutbox(item.id); sent++;
        } catch (error) { const message = error instanceof Error ? error.message : "Retry failed"; await putSegment({ ...record, state: "FAILED", attempts: item.attempts + 1, lastError: message }); await updateOutbox(item.id, { lastError: message }); }
      }
      await logAuditEvent(client, workspaceId, user.id, "outbox_retry", current.deviceId, { sent, remaining: (await listOutbox(current.deviceId)).length });
      notify(`${sent} record(s) sent; remaining records retain their original signatures.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Could not retry outbox."); }
    finally { setWorking(false); await refresh(); }
  };
  const total = rows.reduce((sum, item) => sum + Number(item.fingerprint.bytes || 0), 0);
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">OPERATIONS</p><h1>Ingestion queue</h1><p>Persistent local write-ahead records wait here until the cloud confirms delivery.</p></div><button className="button button-primary" onClick={() => void retry()} disabled={working || !rows.length}>{working ? "Retrying…" : "Retry outbox"}</button></div><div className="metric-grid"><article className="metric-card"><span className="metric-icon gold">↗</span><div><span>Queued fingerprints</span><b>{rows.length}</b><small>Across capture sessions</small></div></article><article className="metric-card"><span className="metric-icon blush">▤</span><div><span>Pending metadata</span><b>{bytes(total)}</b><small>Original videos remain local</small></div></article><article className="metric-card"><span className="metric-icon lavender">◈</span><div><span>Device</span><b>{identity ? identity.slice(0, 8) : "—"}</b><small>Original signatures are preserved</small></div></article></div><section className="panel"><div className="table-scroll"><table><thead><tr><th>Queued</th><th>Session / sequence</th><th>Segment</th><th>State</th><th>Attempts</th><th>Last error</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{fmt(row.queuedAt)}</td><td><code>{row.fingerprint.sessionId.slice(0, 8)}… / {row.fingerprint.sequence}</code></td><td><code>{row.fingerprint.segmentId.slice(0, 14)}…</code></td><td><ResultBadge value={row.lastError ? "FAILED" : "QUEUED"} /></td><td>{row.attempts}</td><td>{row.lastError || "Waiting for a retry."}</td></tr>)}{!rows.length && <tr><td colSpan={6} className="empty-state">The device outbox is empty.</td></tr>}</tbody></table></div></section></div>;
}

export function EvaluationLab({ notify }: { notify: (message: string) => void }) {
  const [reference, setReference] = useState<File | null>(null), [scenarios, setScenarios] = useState<File[]>([]), [maximumDistance, setMaximumDistance] = useState(14), [minimumCoverage, setMinimumCoverage] = useState(0.6), [results, setResults] = useState<Array<Record<string, unknown>>>([]), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [method, setMethod] = useState<HashMethod>("phash");
  const evaluate = async () => {
    if (!reference || !scenarios.length) { notify("Choose an original reference and at least one labeled scenario video."); return; }
    setBusy(true); setProgress(0); const rows: Array<Record<string, unknown>> = [];
    try {
      const referenceHash = await extractPerceptual(reference); const samples: Array<{ distance: number; expected: boolean }> = [];
      for (let index = 0; index < scenarios.length; index++) {
        const file = scenarios[index], candidate = await extractPerceptual(file), result = alignVideos(candidate, referenceHash, { method, maximumDistance, minimumCoverage });
        const label = !/(other[-_ ]trip|another[-_ ]trip)/i.test(file.name);
        const decision = result.match, scenario = { file: file.name, expectedContentMatch: label, detectedContentMatch: decision, classification: label ? decision ? "TRUE_MATCH" : "MISSED_MATCH" : decision ? "FALSE_MATCH" : "TRUE_NEGATIVE", ...result, methods: hashMethodScores(candidate.frames, referenceHash.frames) };
        rows.push(scenario);
        for (const frame of candidate.frames) {
          const nearest = referenceHash.frames.reduce((best, current) => { const distance = hammingDistanceSafe(frame[method], current[method]); return distance < best ? distance : best; }, 64);
          samples.push({ distance: nearest, expected: label });
        }
        setProgress(Math.round((index + 1) / scenarios.length * 100));
      }
      const thresholds = Array.from({ length: 33 }, (_, index) => confusion(samples, index));
      const best = thresholds.reduce((a, b) => b.balancedAccuracy > a.balancedAccuracy ? b : a, thresholds[0]);
      setResults([{ type: "calibration", thresholdRows: thresholds, selectedThreshold: best }, ...rows]);
    } catch (error) { notify(error instanceof Error ? error.message : "Evaluation failed."); }
    finally { setBusy(false); }
  };
  const scenarioRows = results.filter(row => row.type !== "calibration"), calibration = results.find(row => row.type === "calibration")?.selectedThreshold as ReturnType<typeof confusion> | undefined;
  const downloadCsv = () => {
    const header = ["file", "expectedContentMatch", "detectedContentMatch", "classification", "matchedPercentage", "score", "method", "anomalyCount"];
    const lines = [header.join(","), ...scenarioRows.map(row => [row.file, row.expectedContentMatch, row.detectedContentMatch, row.classification, row.matchedPercentage, row.score, row.method, (row.anomalies as unknown[]).length].map(value => `"${String(value).replaceAll('"', '""')}"`).join(","))];
    saveFile("video-evaluation.csv", lines.join("\n"), "text/csv");
  };
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">LOCAL EVALUATION</p><h1>Video evaluation lab</h1><p>Run reproducible temporal matching and threshold sweeps in this browser. Video files stay on this device.</p></div>{scenarioRows.length > 0 && <button className="button button-neutral" onClick={downloadCsv}>Export CSV</button>}</div>
    <section className="panel"><div className="panel-heading"><div><h2>Original / test / run</h2><p>Label every reference from the same trip as positive. Name different-trip negatives with “other-trip”.</p></div></div><div className="settings-grid decoder-settings"><label>Original reference video<input type="file" accept="video/*" onChange={event => setReference(event.target.files?.[0] ?? null)} /></label><label>Scenario videos<input type="file" accept="video/*" multiple onChange={event => setScenarios(Array.from(event.target.files ?? []))} /></label><label>Perceptual method<select value={method} onChange={event => setMethod(event.target.value as HashMethod)}><option value="phash">pHash</option><option value="ahash">aHash</option><option value="dhash">dHash</option><option value="whash">wHash</option></select></label><label>Hamming distance threshold<input type="range" min="0" max="32" value={maximumDistance} onChange={event => setMaximumDistance(Number(event.target.value))} /><span>{maximumDistance} / 64 bits</span></label><label>Minimum matching coverage<input type="range" min="0.2" max="1" step="0.05" value={minimumCoverage} onChange={event => setMinimumCoverage(Number(event.target.value))} /><span>{Math.round(minimumCoverage * 100)}%</span></label></div><button className="button button-primary" onClick={() => void evaluate()} disabled={busy}>{busy ? "Evaluating…" : "Run video evaluation"}</button>{busy && <div className="progress-wrap"><div><span>Evaluating scenarios</span><span>{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>}</section>
    {calibration && <section className="metric-grid metric-grid-wide"><article className="metric-card"><span className="metric-icon mint">✓</span><div><span>True matches</span><b>{calibration.TP}</b><small>Same-trip footage found</small></div></article><article className="metric-card"><span className="metric-icon blush">×</span><div><span>False matches</span><b>{calibration.FP}</b><small>Negative samples accepted</small></div></article><article className="metric-card"><span className="metric-icon gold">!</span><div><span>Missed matches</span><b>{calibration.FN}</b><small>Positive samples missed</small></div></article><article className="metric-card"><span className="metric-icon lavender">◎</span><div><span>Balanced accuracy</span><b>{(calibration.balancedAccuracy * 100).toFixed(1)}%</b><small>Measured threshold {calibration.threshold}/64</small></div></article></section>}
    {scenarioRows.length > 0 && <section className="panel"><div className="panel-heading"><div><h2>Scenario results</h2><p>A content match is a visual lead only; exact SHA-256, device signature, and session chain determine authenticity.</p></div></div><div className="table-scroll"><table><thead><tr><th>Video</th><th>Expected</th><th>Detected</th><th>Coverage</th><th>Similarity</th><th>Time offset</th><th>Findings</th></tr></thead><tbody>{scenarioRows.map(row => <tr key={String(row.file)}><td>{String(row.file)}</td><td>{row.expectedContentMatch ? "Same-trip" : "Other trip"}</td><td><ResultBadge value={String(row.classification)} /></td><td>{Number(row.matchedPercentage).toFixed(1)}%</td><td>{Number(row.score).toFixed(1)}%</td><td>{String((row.anomalies as Array<{ detail?: string }>).length)} indicator(s)</td><td>{(row.anomalies as Array<{ type: string }>).map(anomaly => String(anomaly.type)).join(", ") || "None found"}</td></tr>)}</tbody></table></div><details><summary>All four perceptual-hash scores</summary>{scenarioRows.map(row => <div className="method-score-row" key={String(row.file)}><b>{String(row.file)}</b>{(row.methods as Array<{ method: string; similarity: number; meanDistance: number }>).map(item => <span key={item.method}>{item.method}: {item.similarity.toFixed(1)}% (mean {item.meanDistance?.toFixed(1) ?? "—"})</span>)}</div>)}</details></section>}
    <section className="panel"><h2>Interpretation limits</h2><p>Blur, cropping, overlays, and different trips can have similar perceptual hashes. All anomaly labels are cautious review indicators. A perceptual match never changes a failed exact-file verification into VERIFIED.</p></section>
  </div>;
}
function hammingDistanceSafe(a: string, b: string) { let count = 0; for (let i = 0; i < 16; i++) { let v = parseInt(a.slice(i, i + 1), 16) ^ parseInt(b.slice(i, i + 1), 16); while (v) { count += v & 1; v >>>= 1; } } return count; }

export function SettingsPanel({ client, user, workspaceId, notify }: BaseProps) {
  const [profile, setProfile] = useState(""), [members, setMembers] = useState<Array<Record<string, unknown>>>([]), [memberId, setMemberId] = useState(""), [role, setRole] = useState("analyst"), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [{ data: profileRow, error: profileError }, { data: membership, error: memberError }] = await Promise.all([
        client.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
        client.from("workspace_members").select("user_id,role,profiles(display_name)").eq("workspace_id", workspaceId),
      ]);
      if (profileError) throw profileError; if (memberError) throw memberError;
      setProfile(String(profileRow?.display_name ?? user.user_metadata.display_name ?? "")); setMembers(membership ?? []);
    } catch (error) { notify(error instanceof Error ? error.message : "Could not load workspace settings."); }
  }, [client, user, workspaceId, notify]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const saveProfile = async () => { setBusy(true); try { const { error } = await client.from("profiles").update({ display_name: profile }).eq("id", user.id); if (error) throw error; await client.auth.updateUser({ data: { display_name: profile } }); notify("Profile saved."); } catch (error) { notify(error instanceof Error ? error.message : "Could not save profile."); } finally { setBusy(false); } };
  const addMember = async () => { setBusy(true); try { const { error } = await client.from("workspace_members").upsert({ workspace_id: workspaceId, user_id: memberId.trim(), role }, { onConflict: "workspace_id,user_id" }); if (error) throw error; setMemberId(""); await refresh(); notify("Workspace role updated."); } catch (error) { notify(error instanceof Error ? error.message : "Could not update membership."); } finally { setBusy(false); } };
  const removeMember = async (id: string) => { if (id === user.id || !window.confirm("Remove this member from the workspace?")) return; const { error } = await client.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", id); if (error) notify(error.message); else await refresh(); };
  const currentRole = members.find(row => row.user_id === user.id)?.role;
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">WORKSPACE</p><h1>Settings</h1><p>Manage profile, trusted browser signing device, and workspace roles.</p></div></div><section className="panel"><h2>My profile</h2><div className="settings-grid"><label>Display name<input value={profile} onChange={event => setProfile(event.target.value)} maxLength={100} /></label><label>Account email<input value={user.email ?? ""} disabled /></label><label>Workspace role<input value={String(currentRole ?? "member")} disabled /></label><label>Workspace ID<input value={workspaceId} readOnly /></label></div><button className="button button-primary" onClick={() => void saveProfile()} disabled={busy}>Save profile</button></section><section className="panel"><h2>Workspace members</h2><p>Add a confirmed Supabase Auth user by their account UUID. Workspace RLS still enforces each assigned role.</p><div className="member-add"><label>User UUID<input value={memberId} onChange={event => setMemberId(event.target.value)} placeholder="Supabase Auth user ID" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}><option value="driver">Driver</option><option value="analyst">Analyst</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><button className="button button-primary" onClick={() => void addMember()} disabled={busy || currentRole !== "admin" || !memberId.trim()}>Add member</button></div><div className="table-scroll"><table><thead><tr><th>Member</th><th>User ID</th><th>Role</th><th></th></tr></thead><tbody>{members.map(row => <tr key={String(row.user_id)}><td>{String((row.profiles as { display_name?: string } | null)?.display_name ?? "Workspace member")}</td><td><code>{String(row.user_id)}</code></td><td>{String(row.role)}</td><td><button className="text-action" disabled={currentRole !== "admin" || row.user_id === user.id} onClick={() => void removeMember(String(row.user_id))}>Remove</button></td></tr>)}</tbody></table></div></section><section className="panel"><h2>Device key and data boundaries</h2><ul><li>ECDSA P-256 private keys are non-exported Web Crypto keys stored in this browser’s IndexedDB.</li><li>The matching public key is stored with the workspace device record.</li><li>Normal video is local-only; the private evidence bucket receives only incident clips you explicitly lock.</li><li>Browser site data removal also removes local videos, signing keys, and any unsynced outbox entries. Export important files before clearing browser storage.</li></ul></section></div>;
}

export function DocumentationPanel() {
  return <div className="module-stack"><div className="module-title"><div><p className="eyebrow">HELP &amp; SECURITY MODEL</p><h1>Documentation</h1><p>Quick operating guide for evidence capture and verification.</p></div></div><section className="panel"><h2>Encoder workflow</h2><ol><li>Sign in and open Driver capture. Grant camera access, or choose the synthetic road simulation.</li><li>Choose segment length, local retention, and incident pre/post-roll windows, then start dashcam.</li><li>Segments are hashed over original encoded bytes, linked into a session hash chain, signed by the browser device key, and saved to IndexedDB before upload.</li><li>Use Simulate network loss, capture a segment, then restore uplink or retry the ingestion queue. Retries preserve the original segment identity and signature.</li><li>Lock an incident to protect its before/current/after window. Only locked clips are uploaded to the private evidence bucket.</li><li>Download the original WebM and signed JSON manifest for the Decoder.</li></ol><h2>Decoder workflow</h2><ol><li>Select the matching trusted cloud segment or its signed JSON manifest and open the downloaded original video.</li><li>VERIFIED requires byte-for-byte SHA-256 equality, the cloud reference, a valid device signature, and a complete session chain.</li><li>Changed or re-encoded files fail exact verification. Temporal/perceptual similarity can suggest matching footage but never establishes authenticity.</li><li>Legacy TXT hashes are accepted for comparison and remain clearly labeled review-only because they do not bind a signed session.</li><li>Protected incident videos can be retrieved by authorized workspace members; their bytes are checked against the same trusted fingerprint.</li></ol><h2>Data boundaries</h2><p>Supabase Auth and row-level security scope cloud evidence by workspace. Normal driving video remains in the browser’s IndexedDB and is removed after the configured retention period, except for queued or locked clips. Verification attempts and audit events are client-reported records, not server-attested verdicts.</p></section></div>;
}
