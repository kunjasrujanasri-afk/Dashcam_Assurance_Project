"use client";

import { FormEvent, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export function AuthPanel({ client, onPublicDemo }: { client: SupabaseClient | null; onPublicDemo: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (!client) throw new Error("Secure cloud mode is unavailable. Set a Supabase project URL and publishable key, then apply the evidence migration.");
      if (mode === "sign-up") {
        if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
        const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() || email.split("@")[0] } } });
        if (error) throw error;
        setMessage(data.session ? "Account created. Your secure workspace is loading." : "Check your email to confirm your account, then sign in here.");
      } else {
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Authentication failed."); }
    finally { setBusy(false); }
  };
  return <div className="auth-screen"><section className="auth-card"><div className="auth-mark">D</div><p className="eyebrow">DASHCAM ASSURANCE · SECURE WORKSPACE</p><h1>{mode === "sign-in" ? "Welcome back" : "Create your workspace"}</h1><p className="auth-copy">Sign in to use the encoder, signed evidence, protected incident clips, and insurer verification workflows.</p>
    <form onSubmit={submit}>
      {mode === "sign-up" && <label>Display name<input value={name} onChange={event => setName(event.target.value)} autoComplete="name" maxLength={100} required /></label>}
      <label>Email<input value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" type="email" required /></label>
      <label>Password<input value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} type="password" minLength={8} required /></label>
      <button className="button button-primary full-width" disabled={busy || !client}>{busy ? "Please wait…" : mode === "sign-in" ? "Sign in securely" : "Create account"}</button>
    </form>
    {message && <div className="result-message">{message}</div>}
    <button className="auth-switch" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setMessage(""); }}>{mode === "sign-in" ? "New here? Create an account" : "Already registered? Sign in"}</button>
    <button className="auth-demo" onClick={onPublicDemo}>Continue to local-only demo</button>
    <small>The first account created in a workspace becomes its administrator. Sign in with your own email and password; there is no shared admin login. Videos are processed on your device, and Supabase workspace roles protect cloud records.</small>
  </section></div>;
}
