"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type RecordRow = { id: number; driver_id: string; frame_number: number; fingerprint: string; timestamp: string; video_name: string; status: string; created_at?: string };
type Fingerprint = Omit<RecordRow, "id" | "created_at">;
const nav = ["Overview", "Capture evidence", "Verify a video", "Evaluation lab", "Records"] as const;
type Section = (typeof nav)[number];
const OUTBOX_DB = "driveproof-fingerprint-outbox";
const OUTBOX_STORE = "pending";

function openOutbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE, { keyPath: "queueId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local fingerprint queue."));
  });
}

async function enqueueFingerprints(records: Fingerprint[]) {
  const db = await openOutbox();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    for (const record of records) {
      const queueId = `${record.driver_id}\u0000${record.video_name}\u0000${record.frame_number}`;
      store.put({ queueId, record });
    }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  db.close();
}

async function readOutbox(limit = 200): Promise<Array<{ queueId: string; record: Fingerprint }>> {
  const db = await openOutbox();
  const rows = await new Promise<Array<{ queueId: string; record: Fingerprint }>>((resolve, reject) => {
    const request = db.transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE).getAll();
    request.onsuccess = () => resolve((request.result as Array<{ queueId: string; record: Fingerprint }>).slice(0, limit));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

async function removeOutbox(queueIds: string[]) {
  const db = await openOutbox();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE); queueIds.forEach(id => store.delete(id));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  db.close();
}

async function outboxCount() {
  const db = await openOutbox();
  const count = await new Promise<number>((resolve, reject) => {
    const request = db.transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE).count();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return count;
}

function parseLocalFingerprints(text: string): Set<string> {
  const hashes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split("|");
    const candidate = (fields.length > 1 ? fields[1] : fields[0]).trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(candidate)) hashes.add(candidate);
  }
  return hashes;
}

function readableBytes(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export default function Home() {
  const [section, setSection] = useState<Section>("Overview");
  const [driverId, setDriverId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localEvidenceFile, setLocalEvidenceFile] = useState<File | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [sampleRate, setSampleRate] = useState(2);
  const [cameraActive, setCameraActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [pendingFingerprints, setPendingFingerprints] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const fileUrl = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);

  const refreshOutboxCount = useCallback(async () => {
    try { setPendingFingerprints(await outboxCount()); } catch { setPendingFingerprints(0); }
  }, []);

  const flushOutbox = useCallback(async () => {
    if (!navigator.onLine) { await refreshOutboxCount(); return 0; }
    let sent = 0;
    try {
      while (true) {
        const batch = await readOutbox(200);
        if (!batch.length) break;
        const response = await fetch("/api/fingerprints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: batch.map(item => item.record) }) });
        if (!response.ok) break;
        await removeOutbox(batch.map(item => item.queueId));
        sent += batch.length;
      }
    } catch {
      // Keep all unacknowledged records in IndexedDB for the next retry.
    }
    await refreshOutboxCount();
    return sent;
  }, [refreshOutboxCount]);

  const queueAndTransmit = useCallback(async (batch: Fingerprint[]) => {
    await enqueueFingerprints(batch);
    await refreshOutboxCount();
    await flushOutbox();
  }, [flushOutbox, refreshOutboxCount]);

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  useEffect(() => { fetch("/api/health").then(r => r.ok ? setHealth("online") : setHealth("offline")).catch(() => setHealth("offline")); }, []);
  useEffect(() => {
    const initialRead = window.setTimeout(() => { void refreshOutboxCount(); }, 0);
    const retry = () => { void flushOutbox(); };
    window.addEventListener("online", retry);
    return () => { window.clearTimeout(initialRead); window.removeEventListener("online", retry); };
  }, [flushOutbox, refreshOutboxCount]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => () => { cameraStreamRef.current?.getTracks().forEach(track => track.stop()); }, []);

  const closeCamera = () => {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
    if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
    setCameraActive(false);
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    if (cameraStreamRef.current) closeCamera();
    setFile(picked); setMessage(""); setProgress(0); setRecords([]);
  };

  const openCamera = async () => {
    setMessage("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("Camera recording is not supported in this browser. Choose a video file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      cameraStreamRef.current = stream;
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = stream;
      setCameraActive(true);
    } catch {
      setMessage("Camera access was not granted. Allow camera and microphone access in your browser, or choose a video file.");
    }
  };

  const startCameraRecording = () => {
    const stream = cameraStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return;
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size > 0) recordingChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "video/webm" });
        if (blob.size > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const recordedFile = new File([blob], `dashcam-${stamp}.webm`, { type: blob.type });
          setFile(recordedFile); setProgress(0); setMessage("Camera recording is ready. Create fingerprints to save its evidence trail.");
        } else {
          setMessage("The camera recording was empty. Try recording again.");
        }
        closeCamera();
      };
      recorder.onerror = () => setMessage("Camera recording stopped unexpectedly. Please try again.");
      recorderRef.current = recorder;
      recorder.start(1000);
      setRecordingSeconds(0); setRecording(true); setMessage("");
    } catch {
      setMessage("Could not start camera recording. Try another browser or choose a video file.");
    }
  };

  const stopCameraRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const loadRecords = useCallback(async (videoName?: string) => {
    if (!driverId.trim()) throw new Error("Enter a driver ID first.");
    const query = new URLSearchParams({ driverId: driverId.trim() });
    if (videoName) query.set("videoName", videoName);
    const response = await fetch(`/api/fingerprints?${query}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load records.");
    return payload.records as RecordRow[];
  }, [driverId]);

  const hashVideo = async (source: File, onBatch?: (batch: Fingerprint[]) => Promise<void>) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) throw new Error("Video processor is not ready.");
    const sourceUrl = URL.createObjectURL(source);
    video.src = sourceUrl;
    video.muted = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("This video format could not be read in your browser."));
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("This video has no readable duration.");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create a video frame processor.");
    const width = Math.min(video.videoWidth, 640);
    const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
    canvas.width = width; canvas.height = height;
    const count = Math.min(6000, Math.ceil(duration * sampleRate));
    const rows: Fingerprint[] = [];
    let transmitBatch: Fingerprint[] = [];
    for (let i = 0; i < count; i++) {
      const time = Math.min(i / sampleRate, Math.max(0, duration - 0.025));
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("Unable to seek through this video."));
        video.currentTime = Math.min(time + 0.001, Math.max(0, duration - 0.025));
      });
      ctx.drawImage(video, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let p = 0, q = 0; p < pixels.length; p += 4) { rgb[q++] = pixels[p]; rgb[q++] = pixels[p + 1]; rgb[q++] = pixels[p + 2]; }
      const digest = await crypto.subtle.digest("SHA-256", rgb);
      const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      rows.push({ driver_id: driverId.trim(), frame_number: i, fingerprint, timestamp: new Date(Date.now() + time * 1000).toISOString(), video_name: source.name.slice(0, 200), status: "sent" });
      if (onBatch) {
        transmitBatch.push(rows[rows.length - 1]);
        if (transmitBatch.length >= 100) {
          await onBatch(transmitBatch);
          transmitBatch = [];
        }
      }
      setProgress(Math.round((i + 1) / count * 100));
    }
    if (onBatch && transmitBatch.length) await onBatch(transmitBatch);
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(sourceUrl);
    return rows;
  };

  const runCapture = async () => {
    if (!file) { setMessage("Choose a video file to capture."); return; }
    setBusy(true); setMessage("Processing video locally in your browser…"); setProgress(0);
    try { const hashes = await hashVideo(file, queueAndTransmit); const remaining = await outboxCount(); setPendingFingerprints(remaining); setMessage(`Processed ${hashes.length.toLocaleString()} fingerprints. ${remaining} remain queued on this device. The video stayed on this device.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Capture failed."); }
    finally { setBusy(false); }
  };

  const runVerify = async () => {
    if (!file) { setMessage("Choose the video you want to verify."); return; }
    setBusy(true); setMessage("Checking stored evidence…"); setProgress(0);
    try {
      const incoming = await hashVideo(file);
      const existing = localEvidenceFile ? [] : await loadRecords(file.name);
      const known = localEvidenceFile ? parseLocalFingerprints(await localEvidenceFile.text()) : new Set(existing.map(row => row.fingerprint));
      const matches = incoming.filter(row => known.has(row.fingerprint)).length;
      setRecords(existing);
      setMessage(`${matches} of ${incoming.length} sampled fingerprints match ${localEvidenceFile ? `local TXT evidence (${known.size} hashes)` : `Supabase records (${existing.length} records)`}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Verification failed."); }
    finally { setBusy(false); }
  };

  const refreshRecords = async () => {
    setBusy(true); setMessage("");
    try { setRecords(await loadRecords()); setMessage("Records refreshed."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load records."); }
    finally { setBusy(false); }
  };

  return <main className="shell">
    <aside className="sidebar">
      <a className="brand" href="#overview"><span className="brand-icon">D</span><span>Drive<span className="brand-light">Proof</span><small>ASSURANCE CONSOLE</small></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav>{nav.map((item, index) => <button key={item} className={`nav-item ${section === item ? "active" : ""}`} onClick={() => { setSection(item); setMessage(""); }}><span className="nav-icon">{["⌂", "◉", "⌕", "▥", "▤"][index]}</span>{item}{item === "Records" && <span className="nav-count">{records.length || "—"}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-mark">⌑</div><div><strong>Evidence stays yours</strong><p>Videos are processed locally in your browser.</p></div></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="crumb">Workspace <span>/</span> <strong>{section}</strong></div><div className="top-actions"><span className={`connection ${health}`}><i />{health === "checking" ? "Connecting" : health === "online" ? "Cloud connected" : "Cloud unavailable"}</span><span className="avatar">DP</span></div></header>
      <div className="content">
        <div className="welcome-row"><div><p className="eyebrow">DASHCAM ASSURANCE PLATFORM</p><h1>{section === "Overview" ? "Evidence, made clear." : section}</h1><p className="subhead">Capture, verify, and review trusted video evidence.</p></div><div className="driver-field"><label htmlFor="driver-id">DRIVER ID</label><input id="driver-id" value={driverId} onChange={e => setDriverId(e.target.value)} placeholder="e.g. DRV-1042" maxLength={100} /></div></div>
        {section === "Overview" && <>
          <div className="hero-card"><div className="hero-copy"><span className="hero-kicker">A clearer chain of custody</span><h2>Every frame tells<br />a verifiable story.</h2><p>Create a secure fingerprint trail for dashcam footage. Your video is processed on this device; only compact hashes are sent to the evidence database.</p><button className="button button-light" onClick={() => setSection("Capture evidence")}>Capture evidence <span>↗</span></button></div><div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="shield"><span>✓</span></div><div className="scan-line"/><span className="art-label label-top">FRAME VERIFIED</span><span className="art-label label-bottom">SHA-256 · LOCAL PROCESSING</span></div></div>
          <div className="section-heading"><div><h2>Evidence workflow</h2><p>Three simple steps to a trustworthy record.</p></div><span className="quiet-label">BUILT FOR CLARITY</span></div>
          <div className="workflow-grid">{[["01", "Capture", "Sample frames from a video and create SHA-256 fingerprints."], ["02", "Verify", "Compare a video’s sampled frames with stored evidence."], ["03", "Review", "Browse records by driver ID and keep an auditable trail."]].map(([n, title, body]) => <article className="workflow-card" key={n}><span className="step-no">{n}</span><h3>{title}</h3><p>{body}</p><span className="card-arrow">↗</span></article>)}</div>
          <div className="notice"><span>i</span><p><strong>Public workspace.</strong> Anyone with the site link can submit fingerprints and query records. Do not enter sensitive personal information in the driver ID.</p></div>
        </>}
        {(section === "Capture evidence" || section === "Verify a video" || section === "Evaluation lab") && <>
          <div className="tool-card"><div className="tool-intro"><div className="tool-icon">{section === "Capture evidence" ? "◉" : section === "Verify a video" ? "⌕" : "▥"}</div><div><h2>{section === "Capture evidence" ? "Create an evidence record" : section === "Verify a video" ? "Check video against records" : "Compare a video to evidence"}</h2><p>Frames are sampled and hashed on this device. The original video is never uploaded.</p></div></div>
            {section === "Capture evidence" && <div className="camera-recorder">
              <div className="camera-copy"><div><strong>Record with this device</strong><p>Use your camera to record a clip, then fingerprint it here. Video stays in your browser.</p></div>
                {!cameraActive ? <button className="button button-outline" onClick={openCamera} disabled={busy}>Start camera</button> : <div className="camera-controls">{recording ? <><span className="rec-indicator"><i />REC {Math.floor(recordingSeconds / 60).toString().padStart(2, "0")}:{(recordingSeconds % 60).toString().padStart(2, "0")}</span><button className="button button-dark" onClick={stopCameraRecording}>Stop &amp; use recording</button></> : <><button className="button button-dark" onClick={startCameraRecording}>Start recording</button><button className="text-button" onClick={closeCamera}>Cancel</button></>}</div>}
              </div>
              {cameraActive && <video ref={cameraPreviewRef} className="camera-video" autoPlay muted playsInline />}
            </div>}
            <label className="upload-box"><input type="file" accept="video/*" onChange={chooseFile} /><span className="upload-symbol">↑</span><strong>{file ? file.name : "Choose a dashcam video"}</strong><span>{file ? readableBytes(file.size) : "MP4, MOV, WebM and other browser-supported video formats"}</span></label>
            {section === "Verify a video" && <label className="local-evidence"><span>Optional local fingerprint evidence (.txt)</span><input type="file" accept=".txt,text/plain" onChange={e => { setLocalEvidenceFile(e.target.files?.[0] ?? null); setMessage(""); }} /><small>{localEvidenceFile ? `Using ${localEvidenceFile.name}; verification stays local.` : "Choose a one-hash-per-line SHA-256 file to verify offline. Leave empty to query Supabase."}</small></label>}
            {file && <video className="selected-preview" src={fileUrl} controls playsInline preload="metadata" aria-label="Selected video preview" />}
            <div className="settings-row"><label htmlFor="sample-rate">Sampling rate</label><select id="sample-rate" value={sampleRate} onChange={e => setSampleRate(Number(e.target.value))}><option value={1}>1 frame per second</option><option value={2}>2 frames per second</option><option value={5}>5 frames per second</option></select><span className="settings-help">Downscaled to 640px before hashing</span></div>
            {busy && <div className="progress-wrap"><div><span>Processing locally</span><span>{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>}
            <div className="tool-actions">{section === "Capture evidence" ? <button className="button button-dark" onClick={runCapture} disabled={busy}>{busy ? "Working…" : "Create fingerprints"} <span>→</span></button> : <button className="button button-dark" onClick={runVerify} disabled={busy || (health !== "online" && !localEvidenceFile)}>{busy ? "Working…" : "Verify video"} <span>→</span></button>}<span className="local-note">⌑ &nbsp;Video remains on this device</span></div>
            {section === "Capture evidence" && <div className="outbox-status"><span>{pendingFingerprints ? `${pendingFingerprints} fingerprint(s) safely queued in this browser` : "Browser retry queue is clear"}</span>{pendingFingerprints > 0 && <button className="text-button" onClick={async () => { const sent = await flushOutbox(); setMessage(`Retry sent ${sent} fingerprints; ${await outboxCount()} remain queued.`); }}>Retry queued hashes</button>}</div>}
            {message && <div className="result-message">{message}</div>}
          </div><video ref={videoRef} className="processor" playsInline /><canvas ref={canvasRef} className="processor" />
        </>}
        {section === "Records" && <div className="tool-card records-card"><div className="records-head"><div><h2>Evidence records</h2><p>Browse fingerprints attached to this driver ID.</p></div><button className="button button-dark" onClick={refreshRecords} disabled={busy || health !== "online"}>↻ &nbsp;Refresh</button></div>{message && <div className="result-message">{message}</div>}<div className="table-wrap"><table><thead><tr><th>FRAME</th><th>VIDEO</th><th>FINGERPRINT</th><th>RECORDED</th><th>STATUS</th></tr></thead><tbody>{records.map(row => <tr key={`${row.id}-${row.frame_number}`}><td>{row.frame_number}</td><td className="video-cell">{row.video_name}</td><td><code>{row.fingerprint.slice(0, 18)}…</code></td><td>{new Date(row.timestamp).toLocaleString()}</td><td><span className="status-chip">{row.status}</span></td></tr>)}{records.length === 0 && <tr><td colSpan={5} className="empty-state">Set a driver ID, then refresh to view records.</td></tr>}</tbody></table></div></div>}
        <footer><span>DRIVEPROOF <i>·</i> DASHCAM ASSURANCE</span><span>SHA-256 FINGERPRINTS <i>·</i> LOCAL VIDEO PROCESSING</span></footer>
      </div>
    </section>
  </main>;
}
