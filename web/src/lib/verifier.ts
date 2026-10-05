/**
 * src/lib/verifier.ts — Decoder integrity verification engine
 *
 * Input : a set of evidence files (video segments) + read access to the
 *         server records (video_segments, devices).
 * Output: a per-file verdict, a per-session chain audit and a global verdict.
 *
 * Checks performed
 * ────────────────
 *  File level
 *   1. Content integrity  – SHA-256(file bytes) must equal a registered
 *                           segment_hash. One flipped bit ⇒ different hash.
 *   2. Identification     – the hash itself identifies (session, seq). The file
 *                           name is only a hint used to explain a mismatch
 *                           ("expected X, got Y") and to detect renaming.
 *   3. Size               – byte_size recorded at capture must match.
 *  Record level (for every server record of the involved sessions)
 *   4. Record integrity   – chain_hash recomputed from the canonical record.
 *   5. Authenticity       – ECDSA-P256 signature of chain_hash verified with the
 *                           device public key (only the phone holds the key).
 *   6. Chain continuity   – prev_chain_hash == chain_hash of seq-1, and seq 0
 *                           links to SHA-256("GENESIS|"+session). Detects
 *                           deleted, inserted or reordered records.
 *   7. Timeline           – segments are contiguous in time; anchoring delay
 *                           (server arrival − end of capture) is reported.
 *  Evidence level
 *   8. Completeness       – every seq between the first and last submitted
 *                           segment must be present (no cut-out portion).
 *   9. Duplicates         – the same segment submitted twice is flagged.
 */

import { ANCHOR_DELAY_WARN_MS } from "./config";
import {
  computeChainHash,
  genesisHash,
  hashBlob,
  importPublicJwk,
  parseSegmentFileName,
  publicKeyFingerprint,
  verifyChainSignature,
} from "./integrity";
import type { DeviceRow, SegmentRow } from "./supabaseClient";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceFile {
  id: string;
  name: string;
  blob: Blob;
  origin: "local" | "cloud" | "tamper-lab";
  note?: string;
}

export interface Repository {
  findByHashes(hashes: string[]): Promise<SegmentRow[]>;
  getSession(sessionId: string): Promise<SegmentRow[]>;
  getDevice(deviceId: string): Promise<DeviceRow | null>;
}

export type FileStatus = "AUTHENTIC" | "MODIFIED" | "UNKNOWN" | "FORGED" | "DUPLICATE";

export interface FileVerdict {
  file: EvidenceFile;
  actualHash: string;
  size: number;
  status: FileStatus;
  record: SegmentRow | null; // matching or expected record
  matchedBy: "hash" | "filename" | null;
  renamed: boolean;
  anchorDelayMs: number | null;
  problems: string[];
  warnings: string[];
}

export interface RecordCheck {
  row: SegmentRow;
  chainOk: boolean;
  signatureOk: boolean;
  linkOk: boolean | null; // null = previous record not available
  problems: string[];
}

export interface SessionAudit {
  sessionId: string;
  deviceId: string | null;
  deviceLabel: string | null;
  keyFingerprint: string | null;
  records: RecordCheck[];
  firstSeq: number | null;
  lastSeq: number | null;
  missingInDb: number[];
  genesisOk: boolean | null; // null when seq 0 has expired
  problems: string[];
  warnings: string[];
  // evidence coverage
  submittedSeqs: number[];
  missingInEvidence: number[];
}

export type Verdict = "AUTHENTIC" | "INCOMPLETE" | "TAMPERED";

export interface VerificationReport {
  verdict: Verdict;
  files: FileVerdict[];
  sessions: SessionAudit[];
  summary: string[];
  startedAt: number;
  durationMs: number;
}

export interface VerifyOptions {
  /** Demo only: mutate server rows in memory before auditing them. */
  mutateRows?: (rows: SegmentRow[]) => SegmentRow[];
  onProgress?: (done: number, total: number, label: string) => void;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export async function verifyEvidence(
  files: EvidenceFile[],
  repo: Repository,
  opts: VerifyOptions = {}
): Promise<VerificationReport> {
  const t0 = Date.now();
  const total = files.length + 1;

  // 1. Hash every file (streaming the exact bytes)
  const hashed: { file: EvidenceFile; hash: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    opts.onProgress?.(i, total, `Hashing ${files[i].name}`);
    hashed.push({ file: files[i], hash: await hashBlob(files[i].blob) });
  }
  opts.onProgress?.(files.length, total, "Querying server records");

  // 2. Look records up by content hash
  const unique = [...new Set(hashed.map((h) => h.hash))];
  const byHash = new Map<string, SegmentRow>();
  for (let i = 0; i < unique.length; i += 100) {
    for (const r of await repo.findByHashes(unique.slice(i, i + 100))) byHash.set(r.segment_hash, r);
  }

  // 3. Sessions involved (from matched hashes and from filename hints)
  const sessionIds = new Set<string>();
  for (const h of hashed) {
    const r = byHash.get(h.hash);
    if (r) sessionIds.add(r.session_id);
    else {
      const hint = parseSegmentFileName(h.file.name);
      if (hint) sessionIds.add(hint.session_id);
    }
  }

  // 4. Audit each session chain
  const sessions = new Map<string, SessionAudit>();
  const rowsBySession = new Map<string, Map<number, RecordCheck>>();
  for (const sid of sessionIds) {
    let rows = await repo.getSession(sid);
    if (opts.mutateRows) rows = opts.mutateRows(rows);
    const audit = await auditSession(sid, rows, repo);
    sessions.set(sid, audit);
    rowsBySession.set(sid, new Map(audit.records.map((c) => [c.row.seq, c])));
  }

  // 5. Per-file verdicts
  const seen = new Map<string, FileVerdict>();
  const verdicts: FileVerdict[] = [];
  for (const { file, hash } of hashed) {
    const v: FileVerdict = {
      file,
      actualHash: hash,
      size: file.blob.size,
      status: "UNKNOWN",
      record: null,
      matchedBy: null,
      renamed: false,
      anchorDelayMs: null,
      problems: [],
      warnings: [],
    };
    const hint = parseSegmentFileName(file.name);
    const matched = byHash.get(hash);

    if (matched) {
      // Use the audited copy of the row (may be mutated in the DB-tamper demo)
      const check = rowsBySession.get(matched.session_id)?.get(matched.seq);
      const row = check?.row ?? matched;
      v.record = row;
      v.matchedBy = "hash";
      v.status = "AUTHENTIC";
      if (row.segment_hash !== hash) {
        v.status = "MODIFIED";
        v.problems.push("Server record for this segment no longer matches its original hash.");
      }
      if (row.byte_size !== file.blob.size) v.problems.push("Size differs from the size recorded at capture.");
      if (check && !check.signatureOk) {
        v.status = "FORGED";
        v.problems.push("Record signature is invalid (not produced by the registered device).");
      }
      if (check && !check.chainOk) {
        v.status = "FORGED";
        v.problems.push("Record content does not match its chain hash (record altered).");
      }
      if (check && check.linkOk === false) v.problems.push("Hash-chain link to the previous segment is broken.");
      if (hint && (hint.session_id !== row.session_id || hint.seq !== row.seq)) {
        v.renamed = true;
        v.warnings.push(
          `File name says seq ${hint.seq} but content is seq ${row.seq} — file renamed or reordered.`
        );
      }
      v.anchorDelayMs = new Date(row.created_at).getTime() - Number(row.ended_at);
      if (v.anchorDelayMs > ANCHOR_DELAY_WARN_MS)
        v.warnings.push(
          `Hash anchored ${formatDuration(v.anchorDelayMs)} after capture (buffered while offline).`
        );
      const key = `${row.session_id}:${row.seq}`;
      if (seen.has(key)) {
        v.status = "DUPLICATE";
        v.warnings.push("Same segment submitted more than once.");
      } else seen.set(key, v);
    } else if (hint) {
      const expected = rowsBySession.get(hint.session_id)?.get(hint.seq)?.row ?? null;
      v.record = expected;
      v.matchedBy = expected ? "filename" : null;
      if (expected) {
        v.status = "MODIFIED";
        v.problems.push("Content hash does not match the hash registered at capture time.");
        if (expected.byte_size !== file.blob.size)
          v.problems.push(
            `Size ${file.blob.size.toLocaleString()} B ≠ recorded ${Number(expected.byte_size).toLocaleString()} B.`
          );
      } else {
        v.status = "UNKNOWN";
        v.problems.push("No server record for this segment (never registered, or expired and purged).");
      }
    } else {
      v.problems.push("Hash not registered on the server and file name carries no segment id.");
    }
    verdicts.push(v);
  }

  // 6. Evidence completeness per session
  for (const audit of sessions.values()) {
    const seqs = verdicts
      .filter((v) => v.record?.session_id === audit.sessionId && v.status !== "DUPLICATE")
      .map((v) => v.record!.seq)
      .sort((a, b) => a - b);
    audit.submittedSeqs = [...new Set(seqs)];
    if (seqs.length) {
      const have = new Set(seqs);
      for (let s = seqs[0]; s <= seqs[seqs.length - 1]; s++) if (!have.has(s)) audit.missingInEvidence.push(s);
    }
    if (audit.missingInEvidence.length)
      audit.problems.push(
        `Evidence is missing segment(s) ${compactRanges(audit.missingInEvidence)} inside the submitted time range.`
      );
  }

  // 7. Global verdict
  const fileBad = verdicts.some((v) => ["MODIFIED", "UNKNOWN", "FORGED"].includes(v.status) || v.problems.length);
  const auditBad = [...sessions.values()].some((a) =>
    a.records.some((r) => !r.chainOk || !r.signatureOk || r.linkOk === false)
  );
  const incomplete = [...sessions.values()].some((a) => a.missingInEvidence.length || a.missingInDb.length);
  const verdict: Verdict = fileBad || auditBad ? "TAMPERED" : incomplete ? "INCOMPLETE" : "AUTHENTIC";

  const count = (s: FileStatus) => verdicts.filter((v) => v.status === s).length;
  const summary = [
    `${verdicts.length} file(s) checked: ${count("AUTHENTIC")} authentic, ${count("MODIFIED")} modified, ${count(
      "FORGED"
    )} forged, ${count("UNKNOWN")} unknown, ${count("DUPLICATE")} duplicate.`,
    ...[...sessions.values()].map(
      (a) =>
        `Session ${a.sessionId.slice(0, 8)}: ${a.records.length} server record(s), ` +
        `${a.records.filter((r) => r.signatureOk).length} valid signature(s), ` +
        `${a.records.filter((r) => r.linkOk === false).length} broken link(s), ` +
        `${a.missingInEvidence.length} segment(s) missing from evidence.`
    ),
  ];

  opts.onProgress?.(total, total, "Done");
  return {
    verdict,
    files: verdicts,
    sessions: [...sessions.values()],
    summary,
    startedAt: t0,
    durationMs: Date.now() - t0,
  };
}

// ── Session chain audit (also used by the live monitor) ──────────────────────

const keyCache = new Map<string, Promise<{ key: CryptoKey; fp: string; label: string | null } | null>>();

async function deviceKey(repo: Repository, deviceId: string) {
  if (!keyCache.has(deviceId)) {
    keyCache.set(
      deviceId,
      (async () => {
        const d = await repo.getDevice(deviceId);
        if (!d) return null;
        return {
          key: await importPublicJwk(d.public_key),
          fp: await publicKeyFingerprint(d.public_key),
          label: d.label,
        };
      })().catch(() => null)
    );
  }
  return keyCache.get(deviceId)!;
}

export function clearKeyCache() {
  keyCache.clear();
}

export async function auditSession(
  sessionId: string,
  rowsIn: SegmentRow[],
  repo: Repository
): Promise<SessionAudit> {
  const rows = [...rowsIn].sort((a, b) => a.seq - b.seq);
  const audit: SessionAudit = {
    sessionId,
    deviceId: rows[0]?.device_id ?? null,
    deviceLabel: null,
    keyFingerprint: null,
    records: [],
    firstSeq: rows[0]?.seq ?? null,
    lastSeq: rows.length ? rows[rows.length - 1].seq : null,
    missingInDb: [],
    genesisOk: null,
    problems: [],
    warnings: [],
    submittedSeqs: [],
    missingInEvidence: [],
  };
  if (!rows.length) {
    audit.warnings.push("No server records for this session (expired or never transmitted).");
    return audit;
  }

  const dev = audit.deviceId ? await deviceKey(repo, audit.deviceId) : null;
  audit.deviceLabel = dev?.label ?? null;
  audit.keyFingerprint = dev?.fp ?? null;
  if (!dev) audit.problems.push("Device public key not found — signatures cannot be verified.");

  const genesis = await genesisHash(sessionId);
  let prev: SegmentRow | null = null;
  for (const row of rows) {
    const problems: string[] = [];
    const chainOk = (await computeChainHash(row)) === row.chain_hash;
    if (!chainOk) problems.push("Record fields do not match chain_hash.");
    const signatureOk = dev ? await verifyChainSignature(dev.key, row.chain_hash, row.signature) : false;
    if (!signatureOk) problems.push("Invalid device signature.");
    if (row.device_id !== audit.deviceId) problems.push("Record signed by a different device.");
    if (row.session_id !== sessionId) problems.push("Record belongs to another session.");

    let linkOk: boolean | null = null;
    if (row.seq === 0) {
      linkOk = row.prev_chain_hash === genesis;
      audit.genesisOk = linkOk;
    } else if (prev && prev.seq === row.seq - 1) {
      linkOk = row.prev_chain_hash === prev.chain_hash;
      const gapMs = Number(row.started_at) - Number(prev.ended_at);
      if (gapMs > 2000) audit.warnings.push(`Time gap of ${formatDuration(gapMs)} before seq ${row.seq}.`);
    }
    if (linkOk === false) problems.push("prev_chain_hash does not link to the previous record.");

    if (prev && row.seq > prev.seq + 1)
      for (let s = prev.seq + 1; s < row.seq; s++) audit.missingInDb.push(s);
    if (prev && row.seq === prev.seq) problems.push("Duplicate sequence number.");

    audit.records.push({ row, chainOk, signatureOk, linkOk, problems });
    prev = row;
  }

  if (audit.firstSeq !== null && audit.firstSeq > 0)
    audit.warnings.push(
      `Records before seq ${audit.firstSeq} are no longer on the server (expired) — chain verified from seq ${audit.firstSeq}.`
    );
  if (audit.missingInDb.length)
    audit.problems.push(`Server chain has missing record(s): ${compactRanges(audit.missingInDb)}.`);
  const bad = audit.records.filter((r) => r.problems.length);
  if (bad.length)
    audit.problems.push(`${bad.length} server record(s) fail integrity checks: seq ${compactRanges(bad.map((b) => b.row.seq))}.`);
  return audit;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function compactRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `#${s[i]}` : `#${s[i]}–#${s[j]}`);
    i = j;
  }
  return out.join(", ");
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
