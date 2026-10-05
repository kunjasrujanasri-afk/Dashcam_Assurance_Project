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

const destinations = [
  { href: "/", label: "Drive Studio", detail: "Capture & keep", number: "01" },
  { href: "/admin", label: "Evidence Desk", detail: "Review & validate", number: "02" },
  { href: "/demo", label: "Integrity Trials", detail: "Explore & compare", number: "03" },
  { href: "/evaluation", label: "Signal Lab", detail: "Measure & refine", number: "04" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useRouter();
  const current = destinations.find((item) => item.href === pathname);
  return (
    <div className="assurance-app">
      <div className="liquid-atmosphere" aria-hidden="true"><span /><span /><span /></div>
      <a href="#workspace-content" className="skip-link">Skip to workspace</a>
      <aside className="workspace-sidebar">
        <Link href="/" className="workspace-brand" aria-label="Dashcam Assurance home">
          <span className="brand-monogram">d<span>a</span></span>
          <span><strong>Dashcam<br />Assurance</strong><small>A quieter kind of confidence.</small></span>
        </Link>
        <p className="sidebar-label">YOUR SPACE</p>
        <nav aria-label="Workspace navigation" className="workspace-navigation">
          {destinations.map((item) => (
            <Link key={item.href} href={item.href} aria-label={item.label} title={item.label}
              aria-current={pathname === item.href ? "page" : undefined}
              className={`workspace-link ${pathname === item.href ? "is-active" : ""}`}>
              <span className="nav-number">{item.number}</span>
              <span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-note"><span>KEEP THE MOMENT</span><p>Every mile.<br />A little more<br /><em>peace of mind.</em></p></div>
        <div className="sidebar-signature"><span className="status-light" />Designed with care.</div>
      </aside>
      <div className="workspace-body" id="workspace-content" tabIndex={-1} data-page={pathname}>
        <div className="workspace-topline"><span>{current?.number ?? "DA"} <span className="crumb-divider">/</span> {current?.label ?? "Dashcam Assurance"}</span><span className="workspace-topline-note">PERSONAL EVIDENCE WORKSPACE</span></div>
        {children}
        <footer className="workspace-footer"><span>Dashcam Assurance</span><span>Capture thoughtfully. Keep confidently.</span></footer>
      </div>
    </div>
  );
}
