"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type RecordRow = { id: number; driver_id: string; frame_number: number; fingerprint: string; timestamp: string; video_name: string; status: string; created_at?: string };
type Fingerprint = Omit<RecordRow, "id" | "created_at">;
const nav = ["Overview", "Capture evidence", "Verify a video", "Evaluation lab", "Records"] as const;
type Section = (typeof nav)[number];

function readableBytes(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export default function Home() {
  const [section, setSection] = useState<Section>("Overview");
  const [driverId, setDriverId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [sampleRate, setSampleRate] = useState(2);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileUrl = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  useEffect(() => { fetch("/api/health").then(r => r.ok ? setHealth("online") : setHealth("offline")).catch(() => setHealth("offline")); }, []);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked); setMessage(""); setProgress(0); setRecords([]);
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

  const hashVideo = async (source: File) => {
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
      setProgress(Math.round((i + 1) / count * 100));
    }
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(sourceUrl);
    return rows;
  };

  const submitHashes = async (rows: Fingerprint[]) => {
    for (let start = 0; start < rows.length; start += 200) {
      const response = await fetch("/api/fingerprints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: rows.slice(start, start + 200) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save fingerprints.");
    }
  };

  const runCapture = async () => {
    if (!file) { setMessage("Choose a video file to capture."); return; }
    setBusy(true); setMessage("Processing video locally in your browser…"); setProgress(0);
    try { const hashes = await hashVideo(file); await submitHashes(hashes); setMessage(`Saved ${hashes.length.toLocaleString()} sampled fingerprints. The video stayed on this device.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Capture failed."); }
    finally { setBusy(false); }
  };

  const runVerify = async () => {
    if (!file) { setMessage("Choose the video you want to verify."); return; }
    setBusy(true); setMessage("Checking stored evidence…"); setProgress(0);
    try {
      const [incoming, existing] = await Promise.all([hashVideo(file), loadRecords(file.name)]);
      const known = new Set(existing.map(row => row.fingerprint));
      const matches = incoming.filter(row => known.has(row.fingerprint)).length;
      setRecords(existing);
      setMessage(`${matches} of ${incoming.length} sampled fingerprints match stored records (${existing.length} records found for this driver and video).`);
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
            <label className="upload-box"><input type="file" accept="video/*" onChange={chooseFile} /><span className="upload-symbol">↑</span><strong>{file ? file.name : "Choose a dashcam video"}</strong><span>{file ? readableBytes(file.size) : "MP4, MOV, WebM and other browser-supported video formats"}</span></label>
            <div className="settings-row"><label htmlFor="sample-rate">Sampling rate</label><select id="sample-rate" value={sampleRate} onChange={e => setSampleRate(Number(e.target.value))}><option value={1}>1 frame per second</option><option value={2}>2 frames per second</option><option value={5}>5 frames per second</option></select><span className="settings-help">Downscaled to 640px before hashing</span></div>
            {busy && <div className="progress-wrap"><div><span>Processing locally</span><span>{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>}
            <div className="tool-actions">{section === "Capture evidence" ? <button className="button button-dark" onClick={runCapture} disabled={busy || health !== "online"}>{busy ? "Working…" : "Create fingerprints"} <span>→</span></button> : <button className="button button-dark" onClick={runVerify} disabled={busy || health !== "online"}>{busy ? "Working…" : "Verify video"} <span>→</span></button>}<span className="local-note">⌑ &nbsp;Video remains on this device</span></div>
            {message && <div className="result-message">{message}</div>}
          </div><video ref={videoRef} className="processor" playsInline /><canvas ref={canvasRef} className="processor" />
        </>}
        {section === "Records" && <div className="tool-card records-card"><div className="records-head"><div><h2>Evidence records</h2><p>Browse fingerprints attached to this driver ID.</p></div><button className="button button-dark" onClick={refreshRecords} disabled={busy || health !== "online"}>↻ &nbsp;Refresh</button></div>{message && <div className="result-message">{message}</div>}<div className="table-wrap"><table><thead><tr><th>FRAME</th><th>VIDEO</th><th>FINGERPRINT</th><th>RECORDED</th><th>STATUS</th></tr></thead><tbody>{records.map(row => <tr key={`${row.id}-${row.frame_number}`}><td>{row.frame_number}</td><td className="video-cell">{row.video_name}</td><td><code>{row.fingerprint.slice(0, 18)}…</code></td><td>{new Date(row.timestamp).toLocaleString()}</td><td><span className="status-chip">{row.status}</span></td></tr>)}{records.length === 0 && <tr><td colSpan={5} className="empty-state">Set a driver ID, then refresh to view records.</td></tr>}</tbody></table></div></div>}
        <footer><span>DRIVEPROOF <i>·</i> DASHCAM ASSURANCE</span><span>SHA-256 FINGERPRINTS <i>·</i> LOCAL VIDEO PROCESSING</span></footer>
      </div>
    </section>
  </main>;
}
