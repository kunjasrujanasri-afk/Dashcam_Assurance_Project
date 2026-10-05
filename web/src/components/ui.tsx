/** Small presentational components shared by the Encoder and Decoder pages. */

import Link from "next/link";
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold whitespace-nowrap ${toneClasses[tone]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}

export function Stat({ label, value, tone = "slate", sub }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3 sm:p-4 min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold font-mono truncate ${valueTone[tone]}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

export function Card({ title, subtitle, right, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-slate-800/50 border border-slate-700/60 rounded-2xl p-4 sm:p-6 ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-white">{title}</h2>}
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
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
  const t = {
    primary: "bg-indigo-600 hover:bg-indigo-500 text-white",
    success: "bg-emerald-600 hover:bg-emerald-500 text-white",
    danger: "bg-red-600 hover:bg-red-500 text-white",
    warn: "bg-amber-500 hover:bg-amber-400 text-slate-950",
    slate: "bg-slate-700 hover:bg-slate-600 text-slate-100",
  }[tone];
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${small ? "px-2.5 py-1 text-xs" : "px-4 py-2.5 text-sm"} rounded-lg font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${t}`}
    >
      {children}
    </button>
  );
}

export function TopNav({ icon, kicker, title, href, hrefLabel, right }: { icon: string; kicker: string; title: string; href: string; hrefLabel: string; right?: ReactNode }) {
  return (
    <nav className="border-b border-slate-700/50 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xl">{icon}</span>
          <div className="min-w-0">
            <p className="text-[10px] text-slate-400 uppercase tracking-widest truncate">{kicker}</p>
            <h1 className="text-sm font-bold text-white leading-tight truncate">{title}</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {right}
          <Link href={href} className="text-xs text-slate-400 hover:text-white whitespace-nowrap">
            {hrefLabel} →
          </Link>
        </div>
      </div>
    </nav>
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
