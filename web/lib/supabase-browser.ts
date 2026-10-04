"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let loading: Promise<SupabaseClient | null> | null = null;

export async function getBrowserSupabase() {
  if (client) return client;
  if (loading) return loading;
  loading = (async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) return null;
    const config = await response.json() as { configured: boolean; url?: string; key?: string };
    if (!config.configured || !config.url || !config.key) return null;
    client = createClient(config.url, config.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return client;
  })();
  try { return await loading; } finally { loading = null; }
}
