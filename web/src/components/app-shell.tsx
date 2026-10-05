import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";

export type IconName = "capture" | "shield" | "lab" | "chart" | "arrow";
export function WorkspaceIcon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    capture: <><rect x="3" y="5" width="18" height="14" rx="4" /><circle cx="12" cy="12" r="3" /><path d="M7 5V3m10 2V3" /></>,
    shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
    lab: <><path d="M9 3h6m-5 0v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 15h10" /><path d="M10 18h.01m4-1h.01" /></>,
    chart: <path d="M4 4v16h16M8 15v-4m5 4V7m5 8v-6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  };
  return <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const destinations: { href: string; label: string; detail: string; icon: IconName }[] = [
  { href: "/", label: "Capture studio", detail: "Record your journey", icon: "capture" },
  { href: "/admin", label: "Evidence workspace", detail: "Verify with confidence", icon: "shield" },
  { href: "/demo", label: "Integrity playground", detail: "Explore tamper detection", icon: "lab" },
  { href: "/evaluation", label: "Evaluation lab", detail: "Measure & compare", icon: "chart" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useRouter();
  const current = destinations.find((item) => item.href === pathname);
  return (
    <div className="assurance-app">
      <a href="#workspace-content" className="skip-link">Skip to workspace</a>
      <aside className="workspace-sidebar">
        <Link href="/" className="workspace-brand" aria-label="Dashcam Assurance home">
          <span className="brand-emblem"><WorkspaceIcon name="shield" /></span>
          <span><strong>Dashcam<br />Assurance<span className="brand-dot">.</span></strong><small>Clarity on every journey</small></span>
        </Link>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Workspace navigation" className="workspace-navigation">
          {destinations.map((item) => (
            <Link key={item.href} href={item.href} aria-label={item.label} title={item.label} aria-current={pathname === item.href ? "page" : undefined} className={`workspace-link ${pathname === item.href ? "is-active" : ""}`}>
              <WorkspaceIcon name={item.icon} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><span className="nav-indicator" />
            </Link>
          ))}
        </nav>
        <div className="sidebar-note"><div className="assurance-orbit" aria-hidden="true"><WorkspaceIcon name="shield" /></div><p>Every journey.<br /><span>Every detail.</span></p><small>Capture. Protect. Verify.</small></div>
        <div className="sidebar-signature"><span className="signature-mark">✧</span><span>Evidence, with clarity.<small>Designed with care.</small></span></div>
      </aside>
      <div className="workspace-body" id="workspace-content" tabIndex={-1}>
        <div className="workspace-topline"><span>Workspace <span className="crumb-divider">/</span> <strong>{current?.label ?? "Dashcam Assurance"}</strong></span><span className="workspace-topline-note">DIGITAL EVIDENCE PLATFORM <span>✧</span></span></div>
        {children}
        <footer className="workspace-footer"><span>Dashcam Assurance</span><span>Your journey. Your evidence. Your peace of mind.</span></footer>
      </div>
    </div>
  );
}
