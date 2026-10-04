"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AuthPanel } from "@/app/auth-panel";
import { DriverCapture } from "@/app/driver-capture";
import { DocumentationPanel, EvaluationLab, EvidenceDecoder, IngestionQueue, LiveMonitor, SettingsPanel, VerificationHistory } from "@/app/workflows";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { bootstrapWorkspace } from "@/lib/secure-store";

type Page = "Overview" | "Driver capture" | "Live monitor" | "Verify evidence" | "Integrity & history" | "Evaluation lab" | "Ingestion queue" | "Settings" | "Documentation";
const groups: Array<{ title: string; items: Array<[Page, string]> }> = [
  { title: "ENCODER / TRANSMITTER", items: [["Driver capture", "◉"]] },
  { title: "DECODER / INSURER", items: [["Live monitor", "⌁"], ["Verify evidence", "◇"], ["Integrity & history", "▤"], ["Evaluation lab", "◎"]] },
  { title: "OPERATIONS", items: [["Ingestion queue", "↗"], ["Settings", "⚙"], ["Documentation", "▧"]] },
];

export default function Home() {
  const [client, setClient] = useState<SupabaseClient | null>(null), [session, setSession] = useState<Session | null>(null), [workspaceId, setWorkspaceId] = useState(""), [page, setPage] = useState<Page>("Overview"), [demo, setDemo] = useState(false), [notice, setNotice] = useState("");
  const notify = useCallback((value: string) => { setNotice(value); window.setTimeout(() => setNotice(""), 6000); }, []);
  useEffect(() => {
    let alive = true, unsubscribe: () => void = () => {};
    const timer = window.setTimeout(() => { void (async () => {
      const sb = await getBrowserSupabase(); if (!alive) return; setClient(sb);
      if (!sb) return;
      const { data } = await sb.auth.getSession(); if (alive) setSession(data.session);
      const listener = sb.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) setWorkspaceId(""); });
      unsubscribe = () => listener.data.subscription.unsubscribe();
    })(); }, 0);
    return () => { alive = false; window.clearTimeout(timer); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!client || !session?.user) return;
    let alive = true;
    const timer = window.setTimeout(() => { void bootstrapWorkspace(client).then(id => { if (alive) setWorkspaceId(id); }).catch(error => notify(error instanceof Error ? error.message : "Could not prepare your workspace.")); }, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, session, notify]);

  const signedIn = Boolean(client && session && workspaceId);
  const goto = (item: Page) => setPage(item);
  let content;
  if (page === "Evaluation lab") content = <EvaluationLab notify={notify} />;
  else if (demo) content = <div className="module-stack"><div className="module-title"><div><p className="eyebrow">LOCAL EVALUATION</p><h1>Video evaluation lab</h1><p>Run same-trip video comparisons in this browser. Authentication is needed for cloud evidence workflows.</p></div><button className="button button-neutral" onClick={() => setDemo(false)}>Sign in for secure workflows</button></div><EvaluationLab notify={notify} /></div>;
  else if (!signedIn) content = <AuthPanel client={client} onPublicDemo={() => { setDemo(true); setPage("Evaluation lab"); }} />;
  else {
    const props = { client: client!, user: session!.user, workspaceId, notify };
    switch (page) {
      case "Driver capture": content = <DriverCapture {...props} />; break;
      case "Live monitor": content = <LiveMonitor {...props} />; break;
      case "Verify evidence": content = <EvidenceDecoder {...props} />; break;
      case "Integrity & history": content = <VerificationHistory {...props} />; break;
      case "Ingestion queue": content = <IngestionQueue {...props} />; break;
      case "Settings": content = <SettingsPanel {...props} />; break;
      case "Documentation": content = <DocumentationPanel />; break;
      default: content = <div className="module-stack"><div className="module-title"><div><p className="eyebrow">CLOUDDASH · INTEGRITY RELAY</p><h1>Evidence, with a clear chain of custody.</h1><p>Capture locally, sign every segment, and give insurers a transparent way to verify it.</p></div><span className="status-pill success"><i />Secure workspace</span></div><div className="hero-card"><div className="hero-copy"><span className="hero-kicker">PRIVATE BY DEFAULT · VERIFIED BY DESIGN</span><h2>From road to evidence,<br />with every step accounted for.</h2><p>Device-side recording, cryptographic signing, resilient transmission, and exact video verification in one workspace.</p><button className="button button-light" onClick={() => goto("Driver capture")}>Open driver capture <span>↗</span></button></div><div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="shield"><span>✓</span></div><span className="art-label label-top">SIGNED EVIDENCE</span><span className="art-label label-bottom">LOCAL VIDEO · PRIVATE CLOUD</span></div></div><div className="workflow-grid">{([["01","Capture","Segmented camera recording with local retention and offline retry."],["02","Protect","Lock incident clips, sign metadata, and keep originals private."],["03","Verify","Check exact bytes, device identity, chain integrity, and visual matches."]] as const).map(([number,title,description]) => <button className="workflow-card" key={number} onClick={() => goto(title === "Capture" ? "Driver capture" : title === "Protect" ? "Live monitor" : "Verify evidence")}><span className="step-no">{number}</span><h3>{title}</h3><p>{description}</p><span className="card-arrow">↗</span></button>)}</div><section className="panel welcome-panel"><div className="panel-heading"><div><h2>Your secure evidence workspace</h2><p>Supabase Auth controls access. Workspace roles and row-level security scope the cloud records.</p></div></div><div className="button-row"><button className="button button-primary" onClick={() => goto("Driver capture")}>Start a recording</button><button className="button button-neutral" onClick={() => goto("Verify evidence")}>Verify a video</button><button className="button button-neutral" onClick={() => goto("Integrity & history")}>View verification history</button></div></section></div>;
  }
  }

  if (!signedIn && !demo) return <>{content}{notice && <div className="toast">{notice}</div>}</>;
  return <div className="shell"><aside className="sidebar"><button className="brand" onClick={() => goto("Overview")}><span className="brand-icon">✿</span><span><span className="brand-light">INTEGRITY RELAY</span><br/>CloudDash<small>SECURE EVIDENCE</small></span></button><p className="workspace-label">WORKSPACE</p><nav><button className={`nav-item ${page === "Overview" ? "active" : ""}`} onClick={() => goto("Overview")}><span className="nav-icon">⌂</span>Overview</button>{groups.map(group => <div className="nav-group" key={group.title}><p className="nav-group-title">{group.title}</p>{group.items.map(([item, icon]) => <button key={item} className={`nav-item ${page === item ? "active" : ""}`} onClick={() => goto(item)}><span className="nav-icon">{icon}</span>{item}</button>)}</div>)}</nav><div className="sidebar-bottom"><span className="privacy-mark">♧</span><div><strong>{demo ? "Local evaluation" : "Secure sync"}</strong><p>{demo ? "Files remain on this device" : session?.user.email}</p></div></div></aside><main className="main-area"><header className="topbar"><span className="crumb">CloudDash <span>/</span> <strong>{demo ? "Evaluation lab" : page}</strong></span><div className="top-actions"><span className="connection"><i />{demo ? "Local only" : "Workspace connected"}</span>{session && client && <button className="text-action" onClick={() => { void client.auth.signOut(); setPage("Overview"); }}>Sign out</button>}</div></header><div className="content">{content}<footer><span>CLOUDDASH <i>·</i> DASHCAM ASSURANCE</span><span>LOCAL VIDEO <i>·</i> SIGNED CLOUD FINGERPRINTS</span></footer></div></main>{notice && <div className="toast">{notice}</div>}</div>;
}
