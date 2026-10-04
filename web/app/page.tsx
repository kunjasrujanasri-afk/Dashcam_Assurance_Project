"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AuthPanel } from "@/app/auth-panel";
import { DriverCapture } from "@/app/driver-capture";
import { EvaluationLab, EvidenceDecoder } from "@/app/workflows";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { bootstrapWorkspace } from "@/lib/secure-store";

type Page = "Driver capture" | "Verify evidence" | "Evaluation lab";
const tabs: Array<{ page: Page; mark: string }> = [
  { page: "Driver capture", mark: "◉" },
  { page: "Verify evidence", mark: "◇" },
  { page: "Evaluation lab", mark: "◎" },
];

export default function Home() {
  const [client, setClient] = useState<SupabaseClient | null>(null), [session, setSession] = useState<Session | null>(null), [workspaceId, setWorkspaceId] = useState(""), [page, setPage] = useState<Page>("Driver capture"), [demo, setDemo] = useState(false), [notice, setNotice] = useState("");
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
  let content;
  if (page === "Evaluation lab") content = <EvaluationLab notify={notify} />;
  else if (demo) content = <div className="module-stack"><div className="module-title"><div><p className="eyebrow">LOCAL EVALUATION</p><h1>Video evaluation lab</h1><p>Compare downloaded dashcam clips on this device. Sign in for workspace verification.</p></div><button className="button button-neutral" onClick={() => { setDemo(false); setPage("Driver capture"); }}>Sign in for secure workflows</button></div><EvaluationLab notify={notify} /></div>;
  else if (!signedIn) content = <AuthPanel client={client} onPublicDemo={() => { setDemo(true); setPage("Evaluation lab"); }} />;
  else if (page === "Driver capture") content = <DriverCapture client={client!} user={session!.user} workspaceId={workspaceId} notify={notify} />;
  else content = <EvidenceDecoder client={client!} user={session!.user} workspaceId={workspaceId} notify={notify} />;

  if (!signedIn && !demo) return <>{content}{notice && <div className="toast">{notice}</div>}</>;
  return <div className="app-shell">
    <header className="app-header">
      <button className="app-brand" onClick={() => { setDemo(false); setPage("Driver capture"); }} aria-label="Dashcam Assurance home">
        <span className="app-brand-icon"><span>●</span><i>↗</i></span>
        <span className="app-brand-copy"><strong>Dashcam Assurance</strong><small>Digital Evidence Integrity Platform</small></span>
      </button>
      <nav className="top-nav" aria-label="Main navigation">{tabs.map(tab => <button key={tab.page} className={`top-nav-tab ${page === tab.page ? "active" : ""}`} onClick={() => setPage(tab.page)}><span>{tab.mark}</span>{tab.page}</button>)}</nav>
      <div className="header-account"><span className="connection"><i />{demo ? "Local only" : "Secure sync"}</span>{session && client && <button className="text-action" onClick={() => { void client.auth.signOut(); setPage("Driver capture"); }}>Sign out</button>}{demo && <span className="account-email">Evaluation mode</span>}</div>
    </header>
    <main className="app-content">{content}<footer><span>DASHCAM ASSURANCE <i>·</i> DIGITAL EVIDENCE INTEGRITY PLATFORM</span><span>LOCAL VIDEO <i>·</i> SIGNED CLOUD FINGERPRINTS</span></footer></main>
    {notice && <div className="toast">{notice}</div>}
  </div>;
}
