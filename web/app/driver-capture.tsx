"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createEvidenceManifest, createSignedFingerprint, extractPerceptual, sha256, type SignedFingerprint } from "@/lib/signed-evidence";
import { endCaptureSession, ensureCaptureSession, getDeviceFingerprintSummary, openIncident, prepareIdentity, startCaptureSession, transmitFingerprint, uploadProtectedSegment, type DeviceIdentity } from "@/lib/secure-store";
import { deleteSegments, enqueueSegment, getSegment, listOutbox, listSegments, purgeExpired, putSegment, removeOutbox, updateOutbox, type LocalSegment } from "@/lib/local-vault";

const readable = (bytes: number) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
const timeLabel = (value: string) => new Date(value).toLocaleString();
function drawSimulation(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not start the road simulation.");
  canvas.width = 960; canvas.height = 540; const start = performance.now(); let frame = 0;
  const draw = () => {
    const w = canvas.width, h = canvas.height, phase = (performance.now() - start) / 1000;
    const sky = ctx.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#f2c8c6"); sky.addColorStop(.56, "#f6e5d5"); sky.addColorStop(.57, "#96a28b"); sky.addColorStop(1, "#d4c8ad");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#7d896f"; ctx.fillRect(0, h * .53, w, h * .47);
    ctx.fillStyle = "#45413f"; ctx.beginPath(); ctx.moveTo(w * .44, h * .53); ctx.lineTo(w * .56, h * .53); ctx.lineTo(w * .91, h); ctx.lineTo(w * .09, h); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#fff7e9"; ctx.lineWidth = 8; ctx.setLineDash([32, 38]); ctx.lineDashOffset = -phase * 92; ctx.beginPath(); ctx.moveTo(w * .5, h * .54); ctx.lineTo(w * .5, h); ctx.stroke(); ctx.setLineDash([]);
    for (let n = 0; n < 12; n++) { const side = n % 2 ? 1 : -1, z = ((n / 12 + phase * .04) % 1), y = h * (.45 + z * .55), x = w * (.5 + side * (.22 + z * .4)), size = 10 + z * 58; ctx.fillStyle = n % 3 ? "#5a735f" : "#806d61"; ctx.beginPath(); ctx.moveTo(x, y - size * 2); ctx.lineTo(x - size, y); ctx.lineTo(x + size, y); ctx.fill(); }
    ctx.fillStyle = "rgba(48,38,37,.55)"; ctx.fillRect(20, 20, 185, 37); ctx.fillStyle = "#fff9f3"; ctx.font = "16px sans-serif"; ctx.fillText(`SIMULATED ROAD · ${new Date().toLocaleTimeString()}`, 32, 44);
    frame = requestAnimationFrame(draw);
  };
  draw(); return () => cancelAnimationFrame(frame);
}

export function DriverCapture({ client, user, workspaceId, notify }: { client: SupabaseClient; user: User; workspaceId: string; notify: (value: string) => void }) {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null), [segments, setSegments] = useState<LocalSegment[]>([]), [queue, setQueue] = useState<Array<{ id: string; fingerprint: SignedFingerprint; attempts: number; lastError?: string }>>([]);
  const [recording, setRecording] = useState(false), [offline, setOffline] = useState(false), [syncing, setSyncing] = useState(false);
  const [elapsed, setElapsed] = useState(0), [segmentLength, setSegmentLength] = useState(5), [retention, setRetention] = useState(3), [beforeCount, setBeforeCount] = useState(2), [afterCount, setAfterCount] = useState(2);
  const [source, setSource] = useState<"camera" | "simulation">("camera"), [message, setMessage] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [cloudCount, setCloudCount] = useState(0), [activeSession, setActiveSession] = useState<string | null>(null), [lastFingerprint, setLastFingerprint] = useState<SignedFingerprint | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [networkOnline, setNetworkOnline] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), streamRef = useRef<MediaStream | null>(null), recorderRef = useRef<MediaRecorder | null>(null), chunksRef = useRef<Blob[]>([]);
  const identityRef = useRef<DeviceIdentity | null>(null), sessionRef = useRef<{ id: string; startedAt: string } | null>(null), sequenceRef = useRef(0), previousHashRef = useRef<string | null>(null);
  const recordingRef = useRef(false), incidentRef = useRef<{ id: string; remaining: number } | null>(null), segmentTimerRef = useRef<number | null>(null), elapsedTimerRef = useRef<number | null>(null);
  const offlineRef = useRef(false), animationRef = useRef<(() => void) | null>(null);
  const syncingRef = useRef(false);
  const persistBlobRef = useRef<(blob: Blob) => Promise<void>>(async () => undefined), beginRecorderRef = useRef<(stream: MediaStream) => void>(() => undefined);

  const refreshLocal = useCallback(async (deviceId = identityRef.current?.deviceId) => {
    if (!deviceId) return;
    const [rows, pending] = await Promise.all([listSegments(deviceId), listOutbox(deviceId)]);
    setSegments(rows); setQueue(pending);
    try { const summary = await getDeviceFingerprintSummary(client, workspaceId, deviceId); setCloudCount(summary.count); if (summary.latest) setLastFingerprint(mapStoredFingerprint(summary.latest)); }
    catch { /* local evidence remains available when the cloud is down */ }
  }, [client, workspaceId]);

  const transmitPending = useCallback(async () => {
    const current = identityRef.current;
    if (!current || offlineRef.current || !navigator.onLine || syncingRef.current) return 0;
    syncingRef.current = true; setSyncing(true); let delivered = 0;
    try {
      const pending = await listOutbox(current.deviceId);
      for (const queued of pending) {
        const record = await getSegment(queued.id);
        if (!record) { await removeOutbox(queued.id); continue; }
        try {
          await putSegment({ ...record, state: "SENDING", attempts: queued.attempts + 1, lastError: undefined });
          await updateOutbox(queued.id, { attempts: queued.attempts + 1, lastError: null });
          await ensureCaptureSession(client, queued.fingerprint, user.id);
          const fingerprintId = await transmitFingerprint(client, queued.fingerprint);
          let protectedPath: string | undefined;
          const refreshed = { ...record, fingerprintId, state: "SENT" as const };
          await putSegment(refreshed);
          if (record.locked && record.incidentId) {
            const uploaded = await uploadProtectedSegment(client, refreshed, record.incidentId);
            protectedPath = String(uploaded?.storage_path ?? "");
            await putSegment({ ...refreshed, storagePath: protectedPath });
          }
          await removeOutbox(queued.id); delivered++; setLastFingerprint(queued.fingerprint);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Evidence transmission failed.";
          await putSegment({ ...record, state: "FAILED", attempts: queued.attempts + 1, lastError: detail });
          await updateOutbox(queued.id, { lastError: detail });
        }
      }
    } finally { syncingRef.current = false; setSyncing(false); await refreshLocal(current.deviceId); }
    if (delivered) notify(`${delivered} signed segment${delivered === 1 ? "" : "s"} acknowledged by the secure workspace.`);
    return delivered;
  }, [client, notify, refreshLocal, user.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const current = await prepareIdentity(client, user);
        if (!alive) return;
        identityRef.current = current; setIdentity(current); await refreshLocal(current.deviceId); await transmitPending();
      } catch (error) { if (alive) setMessage(error instanceof Error ? error.message : "Secure device setup failed."); }
    })();
    const updateNetwork = () => { setNetworkOnline(navigator.onLine); if (navigator.onLine && !offlineRef.current) void transmitPending(); };
    window.addEventListener("online", updateNetwork); window.addEventListener("offline", updateNetwork);
    const initialNetworkTimer = window.setTimeout(updateNetwork, 0);
    return () => { alive = false; window.clearTimeout(initialNetworkTimer); window.removeEventListener("online", updateNetwork); window.removeEventListener("offline", updateNetwork); };
  }, [client, user, refreshLocal, transmitPending]);

  useEffect(() => {
    if (!recording) return;
    elapsedTimerRef.current = window.setInterval(() => setElapsed(value => value + 1), 1000);
    return () => { if (elapsedTimerRef.current) window.clearInterval(elapsedTimerRef.current); };
  }, [recording]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (identityRef.current) void purgeExpired(identityRef.current.deviceId, retention).then(deleted => { if (deleted) void refreshLocal(); }); }, 10_000);
    return () => window.clearInterval(timer);
  }, [retention, refreshLocal]);

  useEffect(() => () => {
    recordingRef.current = false;
    if (segmentTimerRef.current) window.clearTimeout(segmentTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(track => track.stop()); animationRef.current?.();
  }, []);

  const persistBlob = useCallback(async (blob: Blob) => {
    if (!blob.size) return;
    const current = identityRef.current, session = sessionRef.current;
    if (!current || !session) throw new Error("The trusted capture session is unavailable.");
    const sequence = sequenceRef.current++, segmentId = crypto.randomUUID(), capturedAt = new Date().toISOString();
    const activeIncident = incidentRef.current;
    const locked = Boolean(activeIncident && activeIncident.remaining > 0), incidentId = locked ? activeIncident?.id ?? null : null;
    let perceptual;
    try { perceptual = await extractPerceptual(blob); }
    catch (error) {
      perceptual = { schema: "dashcam-perceptual-v1" as const, interval: 0.5, duration: 0, frames: [] };
      notify(`Exact signed evidence will be kept; visual matching is unavailable for this clip: ${error instanceof Error ? error.message : "unsupported video codec"}`);
    }
    const fingerprint = await createSignedFingerprint({
      workspaceId: current.workspaceId, deviceId: current.deviceId, sessionId: session.id, segmentId, sequence,
      capturedAt, blob, previousHash: previousHashRef.current, perceptual, privateKey: current.keys.privateKey, locked, incidentId,
    });
    previousHashRef.current = fingerprint.chainHash;
    const record: LocalSegment = { id: segmentId, sessionId: session.id, deviceId: current.deviceId, workspaceId: current.workspaceId,
      sequence, capturedAt, blob, mimeType: blob.type || "video/webm", fingerprint, state: offlineRef.current ? "QUEUED" : "LOCAL", locked,
      incidentId, attempts: 0 };
    await putSegment(record); await enqueueSegment(record); setLastFingerprint(fingerprint);
    if (locked && activeIncident) {
      activeIncident.remaining -= 1;
      if (!activeIncident.remaining) incidentRef.current = null;
    }
    await refreshLocal(current.deviceId);
    await transmitPending();
  }, [notify, refreshLocal, transmitPending]);

  const beginRecorder = useCallback((stream: MediaStream) => {
    const formats = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = formats.find(value => MediaRecorder.isTypeSupported(value));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder; chunksRef.current = [];
    recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
    recorder.onerror = () => setMessage("The recorder encountered an error. The last complete segment remains saved locally.");
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      chunksRef.current = [];
      try { await persistBlobRef.current(blob); }
      catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the recording segment."); }
      if (recordingRef.current) {
        try { beginRecorderRef.current(stream); segmentTimerRef.current = window.setTimeout(() => recorderRef.current?.state === "recording" && recorderRef.current.stop(), segmentLength * 1000); }
        catch { recordingRef.current = false; setRecording(false); stream.getTracks().forEach(track => track.stop()); setMessage("Could not restart the segmented recorder."); }
      } else {
        stream.getTracks().forEach(track => track.stop()); animationRef.current?.(); animationRef.current = null;
        if (sessionRef.current) void endCaptureSession(client, sessionRef.current.id).catch(() => undefined);
        sessionRef.current = null; setActiveSession(null); streamRef.current = null;
      }
    };
    recorder.start();
  }, [client, segmentLength]);

  const startDashcam = async () => {
    try {
      if (!identityRef.current) {
        const prepared = await prepareIdentity(client, user); identityRef.current = prepared; setIdentity(prepared);
      }
      if (sessionRef.current) return;
      const prepared = identityRef.current;
      if (!prepared) throw new Error("Device signing key is not ready.");
      const session = { id: crypto.randomUUID(), startedAt: new Date().toISOString() };
      sessionRef.current = session; sequenceRef.current = 0; previousHashRef.current = null; setActiveSession(session.id); setElapsed(0);
      let stream: MediaStream;
      if (source === "camera") {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires a secure HTTPS origin or localhost.");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      } else {
        const canvas = canvasRef.current; if (!canvas) throw new Error("The driving simulation is not ready.");
        animationRef.current = drawSimulation(canvas);
        stream = canvas.captureStream(24);
      }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => undefined); }
      recordingRef.current = true; setRecording(true); setMessage("Capture session started. Each segment is signed and saved locally before transmission.");
      persistBlobRef.current = persistBlob; beginRecorderRef.current = beginRecorder;
      beginRecorder(stream); segmentTimerRef.current = window.setTimeout(() => recorderRef.current?.state === "recording" && recorderRef.current.stop(), segmentLength * 1000);
      void startCaptureSession(client, prepared, session.id, session.startedAt).catch(() => undefined);
    } catch (error) {
      recordingRef.current = false; setRecording(false); streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; animationRef.current?.(); animationRef.current = null; sessionRef.current = null; setActiveSession(null);
      setMessage(error instanceof Error ? error.message : "Could not start dashcam recording.");
    }
  };

  const stopDashcam = () => {
    recordingRef.current = false; if (segmentTimerRef.current) window.clearTimeout(segmentTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop(); else streamRef.current?.getTracks().forEach(track => track.stop());
    setRecording(false); setMessage("Stopping the recorder and saving the final signed segment…");
  };

  const toggleSimulatedOffline = () => {
    const next = !offlineRef.current; offlineRef.current = next; setOffline(next);
    if (!next) void transmitPending();
  };

  const lockIncident = async () => {
    try {
      if (!identityRef.current) throw new Error("Start a secure device session before locking incident evidence.");
      if (offline || !navigator.onLine) throw new Error("Restore the uplink before creating a protected incident record.");
      const id = await openIncident(client, identityRef.current);
      const recent = [...segments].filter(segment => segment.sessionId === sessionRef.current?.id || !sessionRef.current).slice(0, beforeCount).reverse();
      incidentRef.current = { id, remaining: afterCount };
      for (const previous of recent) {
        const protectedRecord = { ...previous, locked: true, incidentId: id };
        await putSegment(protectedRecord); await enqueueSegment(protectedRecord);
      }
      await refreshLocal(); await transmitPending();
      notify(`Incident locked. Preserving ${recent.length} pre-roll and ${afterCount} post-roll segments.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not lock this incident."); }
  };

  const download = async (segment: LocalSegment, manifest = false) => {
    try {
      if (await sha256(segment.blob) !== segment.fingerprint.sha256) throw new Error("LOCAL_TAMPER_DETECTED: the clip no longer matches its signed digest.");
      const payload = manifest ? JSON.stringify(createEvidenceManifest(segment.fingerprint, identity?.keys.publicJwk ?? {}), null, 2) : segment.blob;
      const url = URL.createObjectURL(manifest ? new Blob([payload as string], { type: "application/json" }) : payload as Blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = manifest ? `evidence-${segment.id}.json` : `dashcam-${segment.sessionId}-${segment.sequence}.webm`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Download verification failed."); }
  };

  const play = async (id: string) => {
    const row = await getSegment(id); if (!row) return;
    if (playing) URL.revokeObjectURL(playing);
    const url = URL.createObjectURL(row.blob); setPlaying(url);
  };

  const deleteSelected = async () => {
    const eligible = segments.filter(row => selected.includes(row.id) && row.state === "SENT" && !row.locked);
    if (!eligible.length) { setMessage("Only cloud-acknowledged, unlocked local videos can be removed."); return; }
    if (!window.confirm(`Delete ${eligible.length} selected local clip(s)? Cloud fingerprints remain.`)) return;
    await deleteSegments(eligible.map(row => row.id)); setSelected([]); await refreshLocal();
  };

  const clearStorage = async () => {
    const eligible = segments.filter(row => row.state === "SENT" && !row.locked);
    if (!eligible.length) { setMessage("No unlocked, acknowledged clips are available to clear."); return; }
    if (!window.confirm(`Remove ${eligible.length} local clips? Protected incidents and queued evidence will remain.`)) return;
    await deleteSegments(eligible.map(row => row.id)); await refreshLocal();
  };

  const totalBytes = segments.reduce((sum, row) => sum + row.blob.size, 0), hh = String(Math.floor(elapsed / 3600)).padStart(2, "0"), mm = String(Math.floor(elapsed / 60) % 60).padStart(2, "0"), ss = String(elapsed % 60).padStart(2, "0");
  return <div className="module-stack">
    <div className="module-title"><div><p className="eyebrow">ENCODER / TRANSMITTER</p><h1>Dashcam encoder</h1><p>Device-side recording, segment signing, and resilient evidence transmission.</p></div><span className={`status-pill ${offline || !networkOnline ? "warning" : "success"}`}><i />{offline ? "Simulated uplink loss" : networkOnline ? "Uplink online" : "Offline"}</span></div>
    <div className="capture-grid">
      <section className="panel capture-panel"><div className="panel-heading"><div><h2>Live road recording</h2><p>Video is split into signed, fixed-length evidence segments.</p></div><span className={`status-pill ${recording ? "recording" : "neutral"}`}>{recording ? "Recording" : "Standby"}</span></div>
        <div className="camera-stage"><video className={`camera-feed ${recording && source === "camera" ? "visible-feed" : "hidden-feed"}`} ref={videoRef} autoPlay muted playsInline />{!recording && <div><span className="camera-mark">⌖</span><b>{source === "camera" ? "Camera inactive" : "Road simulation ready"}</b><p>{source === "camera" ? "Choose Start dashcam to begin a signed recording." : "Start the synthetic road-scene simulator."}</p></div>}<canvas ref={canvasRef} className={recording && source === "simulation" ? "simulation-feed" : "simulation-canvas"} /></div>
        <div className="button-row"><button className="button button-primary" onClick={recording ? stopDashcam : startDashcam} disabled={!identity}>{recording ? "Stop dashcam" : "Start dashcam"}</button><button className="button button-warning" onClick={lockIncident} disabled={!recording || offline || !identity}>Lock incident clip</button><button className="button button-neutral" onClick={toggleSimulatedOffline}>{offline ? "Restore uplink" : "Simulate network loss"}</button><button className="button button-quiet" onClick={() => void transmitPending()} disabled={syncing || !queue.length}>{syncing ? "Retrying…" : "Retry outbox"}</button></div>
        <div className="settings-grid"><label>Recording source<select value={source} onChange={event => setSource(event.target.value as typeof source)} disabled={recording}><option value="camera">Camera</option><option value="simulation">Driving simulation</option></select></label><label>Segment length<select value={segmentLength} onChange={event => setSegmentLength(Number(event.target.value))} disabled={recording}><option value={3}>3 seconds</option><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={15}>15 seconds</option></select></label><label>Local retention<select value={retention} onChange={event => setRetention(Number(event.target.value))}><option value={3}>3 minutes</option><option value={10}>10 minutes</option><option value={60}>1 hour</option><option value={1440}>24 hours</option></select></label><label>Incident pre-roll<select value={beforeCount} onChange={event => setBeforeCount(Number(event.target.value))}><option value={1}>1 segment</option><option value={2}>2 segments</option><option value={3}>3 segments</option><option value={5}>5 segments</option></select></label><label>Incident post-roll<select value={afterCount} onChange={event => setAfterCount(Number(event.target.value))}><option value={1}>1 segment</option><option value={2}>2 segments</option><option value={3}>3 segments</option><option value={5}>5 segments</option></select></label></div>
        {message && <div className="result-message">{message}</div>}
      </section>
      <aside className="capture-aside"><div className="metric-grid"><article className="metric-card"><span className="metric-icon blush">◷</span><div><span>Elapsed</span><b>{hh}:{mm}:{ss}</b><small>{recording ? "Session active" : "Ready"}</small></div></article><article className="metric-card"><span className="metric-icon mint">▣</span><div><span>Session segments</span><b>{activeSession ? segments.filter(segment => segment.sessionId === activeSession).length : 0}</b><small>{activeSession ? `Session ${activeSession.slice(0, 8)}…` : "No session started"}</small></div></article><article className="metric-card"><span className="metric-icon lavender">♢</span><div><span>Cloud fingerprints</span><b>{cloudCount}</b><small>Acknowledged for this device</small></div></article><article className="metric-card"><span className="metric-icon gold">↗</span><div><span>Outbox pending</span><b>{queue.length}</b><small>{queue.some(item => item.lastError) ? "Includes failed transmission" : "Durable browser queue"}</small></div></article></div>
        <section className="panel last-fingerprint"><div className="panel-heading"><div><h2>Last transmitted fingerprint</h2><p>Only signed metadata is stored; normal video stays local.</p></div><span className="lock-mark">♧</span></div>{lastFingerprint ? <><code>{lastFingerprint.sha256}</code><dl><div><dt>Segment</dt><dd>{lastFingerprint.segmentId.slice(0, 12)}…</dd></div><div><dt>Session / sequence</dt><dd>{lastFingerprint.sessionId.slice(0, 8)}… / {lastFingerprint.sequence}</dd></div><div><dt>Chain hash</dt><dd>{lastFingerprint.chainHash.slice(0, 16)}…</dd></div></dl></> : <p className="empty-hint">No cloud-acknowledged fingerprint yet. Record a clip to begin.</p>}</section></aside>
    </div>
    <section className="panel recordings-panel"><div className="panel-heading"><div><h2>Local recordings on this device <span>({segments.length})</span></h2><p>Original video remains in this browser. Locked incident clips are protected from automatic retention.</p></div><div className="recording-actions"><span>Browser storage: {readable(totalBytes)} used</span><button className="button button-danger" onClick={deleteSelected} disabled={!selected.length}>Delete selected</button><button className="button button-neutral" onClick={clearStorage}>Clear local storage</button></div></div>
      <div className="table-scroll"><table><thead><tr><th></th><th>Sequence</th><th>Captured</th><th>Size</th><th>SHA-256</th><th>Fingerprint transmission</th><th>Retention</th><th>Play</th><th>Download</th><th>Manifest</th></tr></thead><tbody>{segments.map(row => <tr key={row.id}><td><input type="checkbox" checked={selected.includes(row.id)} onChange={event => setSelected(value => event.target.checked ? [...value, row.id] : value.filter(id => id !== row.id))} disabled={row.locked || row.state !== "SENT"} /></td><td>{row.sequence}</td><td>{timeLabel(row.capturedAt)}</td><td>{readable(row.blob.size)}</td><td><code title={row.fingerprint.sha256}>{row.fingerprint.sha256.slice(0, 14)}…</code></td><td><span className={`status-pill ${row.state === "SENT" ? "success" : row.state === "FAILED" ? "warning" : "neutral"}`}>{row.state}{row.lastError ? ` · ${row.lastError.slice(0, 50)}` : ""}</span>{row.locked && <small className="locked-label">Protected incident</small>}</td><td>{row.locked ? "Protected" : `${retention} min`}</td><td><button className="text-action" onClick={() => void play(row.id)}>Play</button></td><td><button className="text-action" onClick={() => void download(row)}>Video</button></td><td><button className="text-action" onClick={() => void download(row, true)}>JSON</button></td></tr>)}{!segments.length && <tr><td colSpan={10} className="empty-state">Local recordings will appear here as each signed segment completes.</td></tr>}</tbody></table></div>
    </section>
    {playing && <div className="modal-backdrop" onClick={() => { URL.revokeObjectURL(playing); setPlaying(null); }}><section className="video-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => { URL.revokeObjectURL(playing); setPlaying(null); }}>Close</button><video src={playing} controls autoPlay playsInline /></section></div>}
  </div>;
}

function mapStoredFingerprint(row: Record<string, unknown>): SignedFingerprint {
  return {
    version: Number(row.version) as 3, workspaceId: String(row.workspace_id), deviceId: String(row.device_id), sessionId: String(row.session_id),
    segmentId: String(row.segment_id), sequence: Number(row.sequence), capturedAt: String(row.captured_at), bytes: Number(row.bytes),
    sha256: String(row.sha256), previousHash: row.previous_hash ? String(row.previous_hash) : null, chainHash: String(row.chain_hash),
    signature: String(row.signature), signatureAlgorithm: "ECDSA_P256_SHA256", perceptual: row.perceptual as SignedFingerprint["perceptual"],
    perceptualHash: String(row.perceptual_hash), source: String(row.source), metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}
