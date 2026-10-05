import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { Session } from "@supabase/supabase-js";
import { initializeSupabase, supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { setLocalAccount } from "@/lib/localStore";

export function AccountGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false), [session, setSession] = useState<Session | null>(null);
  const [signup, setSignup] = useState(false), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};
    void (async () => {
      try {
        await initializeSupabase();
        if (!alive) return;
        const accept = (next: Session | null) => {
          if (!alive) return;
          if (next) setLocalAccount(next.user.id);
          setSession(next);
        };
        const listener = supabase.auth.onAuthStateChange((_event, next) => accept(next));
        unsubscribe = () => listener.data.subscription.unsubscribe();
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        accept(data.session);
      } catch (error) { if (alive) setMessage(error instanceof Error ? error.message : "Could not initialize sign-in."); }
      finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; unsubscribe(); };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const { data, error } = signup
        ? await supabase.auth.signUp({ email: email.trim(), password })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      if (signup && !data.session) setMessage("Check your email to confirm your account, then sign in.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };

  if (!ready) return <main className="min-h-screen bg-slate-950 text-slate-300 grid place-items-center">Opening Dashcam Assurance…</main>;
  const publicPage = router.pathname === "/evaluation";
  if (session || publicPage) return <><div key={session?.user.id ?? "evaluation"}>{children}</div>{session && <div className="fixed bottom-3 right-3 z-50 flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-xs text-slate-300"><span>{session.user.email}</span><button type="button" className="text-indigo-300" onClick={() => { void supabase.auth.signOut().then(({ error }) => { if (error) setMessage(error.message); else router.reload(); }); }}>Sign out</button>{message && <span role="alert">{message}</span>}</div>}</>;
  return <main className="min-h-screen bg-slate-950 px-5 py-12 grid place-items-center text-slate-100"><section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8"><p className="text-xs uppercase tracking-widest text-indigo-300">Dashcam Assurance</p><h1 className="mt-3 text-3xl font-bold">{signup ? "Create an account" : "Sign in to your dashcam"}</h1><p className="mt-3 text-sm text-slate-400">Record signed video, submit incident clips, and verify evidence in your account.</p><form onSubmit={submit} className="mt-6 grid gap-4"><label className="text-sm">Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 p-3" /></label><label className="text-sm">Password<input type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={8} value={password} onChange={e => setPassword(e.target.value)} required className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 p-3" /></label><button disabled={busy || !supabaseConfigured} className="rounded-lg bg-indigo-600 p-3 font-semibold disabled:opacity-50">{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button></form>{!supabaseConfigured && <p role="alert" className="mt-4 text-sm text-amber-300">Cloud configuration is missing. Set the Supabase URL and publishable key.</p>}{message && <p role="alert" className="mt-4 text-sm text-amber-300">{message}</p>}<button className="mt-5 text-sm text-indigo-300" onClick={() => { setSignup(!signup); setMessage(""); }}>{signup ? "Already registered? Sign in" : "Create an account"}</button><Link className="mt-4 block text-sm text-slate-400" href="/evaluation">Open local evaluation</Link></section></main>;
}
