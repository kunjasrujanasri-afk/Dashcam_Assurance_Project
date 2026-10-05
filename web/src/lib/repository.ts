/**
 * src/lib/repository.ts — Decoder data access (Supabase)
 */

import { EVIDENCE_BUCKET } from "./config";
import { DeviceRow, SegmentRow, supabase } from "./supabaseClient";
import type { EvidenceFile, Repository } from "./verifier";

export const supabaseRepository: Repository = {
  async findByHashes(hashes) {
    if (!hashes.length) return [];
    const { data, error } = await supabase.from("video_segments").select("*").in("segment_hash", hashes);
    if (error) throw new Error(`Server query failed: ${error.message}`);
    return (data ?? []) as SegmentRow[];
  },
  async getSession(sessionId) {
    const out: SegmentRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("video_segments")
        .select("*")
        .eq("session_id", sessionId)
        .order("seq", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`Server query failed: ${error.message}`);
      out.push(...((data ?? []) as SegmentRow[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  },
  async getDevice(deviceId) {
    const { data, error } = await supabase.from("devices").select("*").eq("id", deviceId).maybeSingle();
    if (error) throw new Error(`Server query failed: ${error.message}`);
    return (data as DeviceRow) ?? null;
  },
};

// ── Evidence bucket (clips submitted by drivers) ─────────────────────────────

export interface EvidenceFolder {
  sessionId: string;
  files: { name: string; path: string; size: number; createdAt: string }[];
}

export async function listEvidenceFolders(): Promise<EvidenceFolder[]> {
  const bucket = supabase.storage.from(EVIDENCE_BUCKET);
  const { data: top, error } = await bucket.list("", { limit: 1000, sortBy: { column: "name", order: "desc" } });
  if (error) throw new Error(error.message);
  const folders: EvidenceFolder[] = [];
  for (const entry of top ?? []) {
    if (entry.id) continue; // a file at root, not a folder
    const { data: files, error: e2 } = await bucket.list(entry.name, {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    if (e2) throw new Error(e2.message);
    folders.push({
      sessionId: entry.name,
      files: (files ?? [])
        .filter((f) => f.id)
        .map((f) => ({
          name: f.name,
          path: `${entry.name}/${f.name}`,
          size: Number((f.metadata as { size?: number } | null)?.size ?? 0),
          createdAt: f.created_at ?? "",
        })),
    });
  }
  return folders;
}

export async function downloadEvidence(path: string): Promise<EvidenceFile> {
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).download(path);
  if (error || !data) throw new Error(`Download failed for ${path}: ${error?.message ?? "no data"}`);
  return { id: crypto.randomUUID(), name: path.split("/").pop()!, blob: data, origin: "cloud" };
}

/** Encoder side: submit a clip to the insurer. Never overwrites. */
export async function uploadEvidence(sessionId: string, fileName: string, blob: Blob) {
  const { error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .upload(`${sessionId}/${fileName}`, blob, { contentType: blob.type, upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw new Error(error.message);
}

export async function runServerPurge(): Promise<number> {
  const { data, error } = await supabase.rpc("purge_expired_segments");
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
