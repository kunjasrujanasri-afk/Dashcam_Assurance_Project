/**
 * src/lib/supabaseClient.ts
 *
 * Single shared Supabase client (one WebSocket for Realtime) + typed helpers.
 *
 * Environment variables (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   (anon / publishable key)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { SegmentRecord } from "./integrity";

/** Row of public.video_segments as returned by the server. */
export interface SegmentRow extends SegmentRecord {
  id: string;
  created_at: string; // server arrival time (set by trigger)
  expires_at: string; // server retention deadline (set by trigger)
}

/** Row of public.devices. */
export interface DeviceRow {
  id: string;
  label: string | null;
  public_key: JsonWebKey;
  created_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

/**
 * Untyped client (no generated Database types); domain types are applied at
 * each call site. If the env vars are missing we still build a client against
 * a dummy URL so the UI can render and show a clear configuration error.
 */
export const supabase: SupabaseClient = createClient(
  supabaseUrl || "https://not-configured.invalid",
  supabaseKey || "not-configured",
  { auth: { persistSession: false } }
);

/**
 * True when a failed request should be retried later: transport failures
 * (no network, DNS, timeout → PostgREST reports status 0), server overload
 * (5xx) and rate limiting. Other 4xx errors are permanent rejections.
 */
export function isTransientFailure(status: number | undefined): boolean {
  return !status || status >= 500 || status === 408 || status === 429;
}
