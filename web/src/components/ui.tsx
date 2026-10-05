/** Small presentational components shared by the Encoder and Decoder pages. */

import Link from "next/link";
import { useRouter } from "next/router";
import { WorkspaceIcon } from "./app-shell";
import type { ReactNode } from "react";

export type Tone = "green" | "amber" | "red" | "sky" | "slate" | "indigo";

const toneClasses: Record<Tone, string> = {
  green: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  red: "bg-red-500/10 text-red-300 border-red-500/40",
  sky: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  slate: "bg-slate-700/40 text-slate-300 border-slate-600",
  indigo: "bg-indigo-500/10 text-indigo-300 border-indigo-500/30",
};

const valueTone: Record<Tone, string> = {
  green: "text-emerald-400",
  amber: "text-amber-400",
  red: "text-red-400",
  sky: "text-sky-400",
  slate: "text-slate-300",
  indigo: "text-indigo-300",
};

export function Badge({ tone, children, pulse, title }: { tone: Tone; children: ReactNode; pulse?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`status-badge inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold whitespace-nowrap ${toneClasses[tone]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}

export function Stat({ label, value, tone = "slate", sub }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode }) {
  return (
    <div className={`metric-tile metric-${tone} min-w-0`}>
      <div className="metric-caption"><p>{label}</p><span aria-hidden="true">◇</span></div>
      <p className={`metric-value ${valueTone[tone]}`}>{value}</p>
      {sub && <p className="metric-detail">{sub}</p>}
    </div>
  );
}

export function Card({ title, subtitle, right, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass-card p-5 sm:p-6 ${className}`}>
      {(title || right) && (
        <div className="card-heading flex flex-wrap items-start justify-between gap-3 mb-5">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="card-subtitle text-xs mt-1">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  tone = "slate",
  disabled,
  small,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "primary" | "danger" | "warn" | "slate" | "success";
  disabled?: boolean;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`studio-button button-${tone} ${small ? "button-small" : ""}`}
    >
      {children}
    </button>
  );
}

export function TopNav({ kicker, title, href, hrefLabel, right }: { icon: string; kicker: string; title: string; href: string; hrefLabel: string; right?: ReactNode }) {
  const { pathname } = useRouter();
  const descriptions: Record<string, string> = {
    "/": "A little peace of mind, for every mile ahead.",
    "/admin": "Bring every detail into focus. Verify the story behind the footage.",
    "/demo": "Explore how small changes leave a trace.",
    "/evaluation": "A clearer perspective on fingerprints, metrics, and thresholds.",
  };
  return (
    <header className="page-heading">
      <div className="page-heading-copy"><p className="page-eyebrow"><span />{kicker}</p><h1>{title}</h1><p className="page-description">{descriptions[pathname]}</p></div>
      <div className="page-shortcuts">{right}<Link href={href}>{hrefLabel}<WorkspaceIcon name="arrow" /></Link></div>
    </header>
  );
}

export function ConfigWarning() {
  return (
    <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 text-sm text-red-300">
      Supabase is not configured. Create <code>.env.local</code> with <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
      <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, then restart <code>npm run dev</code>.
    </div>
  );
}
