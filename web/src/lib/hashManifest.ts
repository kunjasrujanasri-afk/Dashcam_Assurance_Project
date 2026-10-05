import { isSha256Hex } from "./integrity";
import { auditSession, type Repository, type SessionAudit } from "./verifier";
import type { SegmentRow } from "./supabaseClient";

export interface ManifestEntry { line: number; hash: string; }
export interface ManifestMatch extends ManifestEntry {
  status: "REGISTERED" | "NOT_FOUND" | "DUPLICATE" | "INVALID_RECORD";
  sessionId?: string;
  seq?: number;
}
export interface ManifestReport {
  entries: ManifestMatch[];
  sessions: SessionAudit[];
  videoContentChecked: false;
}

/** One SHA-256 per non-empty line; also accepts sha256sum's optional filename. */
export function parseHashManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([a-f0-9]{64})(?:[ \t]+\*?.+)?$/i.exec(line);
    if (!match || !isSha256Hex(match[1].toLowerCase())) throw new Error(`Line ${index + 1} must start with a 64-character SHA-256 hash.`);
    entries.push({ line: index + 1, hash: match[1].toLowerCase() });
    if (entries.length > 2000) throw new Error("Use no more than 2,000 hashes per list.");
  }
  if (!entries.length) throw new Error("Add at least one SHA-256 hash.");
  return entries;
}

/** Checks registration and signed cloud records; never claims to check video bytes. */
export async function verifyHashManifest(text: string, repo: Repository): Promise<ManifestReport> {
  const entries = parseHashManifest(text);
  const hashes = [...new Set(entries.map((entry) => entry.hash))];
  const records: SegmentRow[] = [];
  for (let i = 0; i < hashes.length; i += 100) records.push(...await repo.findByHashes(hashes.slice(i, i + 100)));
  const audits = new Map<string, SessionAudit>();
  for (const sessionId of new Set(records.map((record) => record.session_id))) {
    audits.set(sessionId, await auditSession(sessionId, await repo.getSession(sessionId), repo));
  }
  const seen = new Set<string>();
  const matches: ManifestMatch[] = entries.map((entry) => {
    if (seen.has(entry.hash)) return { ...entry, status: "DUPLICATE" };
    seen.add(entry.hash);
    const candidates = records.filter((record) => record.segment_hash === entry.hash);
    if (!candidates.length) return { ...entry, status: "NOT_FOUND" };
    const valid = candidates.find((record) => {
      const audit = audits.get(record.session_id);
      const check = audit?.records.find((item) => item.row.seq === record.seq);
      return check && !check.problems.length && !audit?.problems.length;
    });
    const record = valid ?? candidates[0];
    return { ...entry, status: valid ? "REGISTERED" : "INVALID_RECORD", sessionId: record.session_id, seq: record.seq };
  });
  return { entries: matches, sessions: [...audits.values()], videoContentChecked: false };
}
