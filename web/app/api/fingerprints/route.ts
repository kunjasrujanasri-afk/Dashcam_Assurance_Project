import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = 5000;
const digestPattern = /^[a-f0-9]{64}$/i;
const errorResponse = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(request: NextRequest) {
  const driverId = request.nextUrl.searchParams.get("driverId")?.trim();
  const videoName = request.nextUrl.searchParams.get("videoName")?.trim();
  if (!driverId || driverId.length > 100) return errorResponse("A valid driver ID is required.", 400);
  if (videoName && videoName.length > 200) return errorResponse("Video name is too long.", 400);
  try {
    const supabase = getSupabase();
    const all: Record<string, unknown>[] = [];
    for (let start = 0; start < limit; start += 1000) {
      let query = supabase.from("fingerprints").select("id,driver_id,frame_number,fingerprint,timestamp,video_name,status,created_at").eq("driver_id", driverId).order("frame_number", { ascending: true }).range(start, start + 999);
      if (videoName) query = query.eq("video_name", videoName);
      const { data, error } = await query;
      if (error) throw error;
      all.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return NextResponse.json({ records: all, truncated: all.length === limit });
  } catch {
    return errorResponse("Could not read the evidence database. Check the Supabase configuration and fingerprints table.", 503);
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return errorResponse("Request body must be valid JSON.", 400); }
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 200) return errorResponse("Send between 1 and 200 fingerprint records per request.", 400);
  const normalized = [];
  for (const value of records) {
    if (!value || typeof value !== "object") return errorResponse("Invalid fingerprint record.", 400);
    const row = value as Record<string, unknown>;
    if (typeof row.driver_id !== "string" || !row.driver_id.trim() || row.driver_id.length > 100) return errorResponse("Each record needs a valid driver ID.", 400);
    if (!Number.isInteger(row.frame_number) || Number(row.frame_number) < 0) return errorResponse("Frame numbers must be non-negative integers.", 400);
    if (typeof row.fingerprint !== "string" || !digestPattern.test(row.fingerprint)) return errorResponse("Fingerprints must be SHA-256 hex digests.", 400);
    if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return errorResponse("Each record needs a valid timestamp.", 400);
    if (typeof row.video_name !== "string" || !row.video_name.trim() || row.video_name.length > 200) return errorResponse("Each record needs a valid video name.", 400);
    normalized.push({ driver_id: row.driver_id.trim(), frame_number: row.frame_number, fingerprint: row.fingerprint.toLowerCase(), timestamp: row.timestamp, video_name: row.video_name.trim(), status: "sent" });
  }
  try {
    const supabase = getSupabase();
    const first = normalized[0];
    if (normalized.some(row => row.driver_id !== first.driver_id || row.video_name !== first.video_name)) return errorResponse("A batch can contain only one driver and video.", 400);
    const frames = normalized.map(row => row.frame_number);
    const { data: existing, error: lookupError } = await supabase.from("fingerprints").select("frame_number").eq("driver_id", first.driver_id).eq("video_name", first.video_name).in("frame_number", frames);
    if (lookupError) throw lookupError;
    const existingFrames = new Set((existing ?? []).map(row => row.frame_number));
    const fresh = normalized.filter(row => !existingFrames.has(row.frame_number));
    if (fresh.length === 0) return NextResponse.json({ saved: 0, skipped: normalized.length });
    const { error } = await supabase.from("fingerprints").insert(fresh);
    if (error) throw error;
    return NextResponse.json({ saved: fresh.length, skipped: normalized.length - fresh.length });
  } catch {
    return errorResponse("Could not save fingerprints. Check Supabase permissions and the fingerprints table schema.", 503);
  }
}
