/**
 * src/lib/tamperLab.ts — attacks used to demonstrate that the Decoder
 * detects modification, corruption and inconsistency. Every operation works on
 * an in-memory copy; the original evidence is never altered.
 */

import type { SegmentRow } from "./supabaseClient";
import type { EvidenceFile } from "./verifier";

const copy = (f: EvidenceFile, blob: Blob, name: string, note: string): EvidenceFile => ({
  id: crypto.randomUUID(),
  name,
  blob,
  origin: "tamper-lab",
  note,
});

/** Flip one single bit in the middle of the file (silent corruption). */
export async function flipOneBit(f: EvidenceFile): Promise<EvidenceFile> {
  const bytes = new Uint8Array(await f.blob.arrayBuffer());
  const pos = Math.floor(bytes.length / 2);
  bytes[pos] ^= 0x01;
  return copy(f, new Blob([bytes], { type: f.blob.type }), f.name, `1 bit flipped at byte ${pos}`);
}

/** Overwrite a block of bytes (e.g. a region of frames edited). */
export async function overwriteBlock(f: EvidenceFile): Promise<EvidenceFile> {
  const bytes = new Uint8Array(await f.blob.arrayBuffer());
  const start = Math.floor(bytes.length * 0.6);
  const len = Math.min(4096, bytes.length - start);
  for (let i = 0; i < len; i++) bytes[start + i] = 0;
  return copy(f, new Blob([bytes], { type: f.blob.type }), f.name, `${len} bytes zeroed at ${start}`);
}

/** Cut the end of the file (truncated / incomplete transfer). */
export async function truncate(f: EvidenceFile): Promise<EvidenceFile> {
  const keep = Math.floor(f.blob.size * 0.8);
  return copy(f, f.blob.slice(0, keep, f.blob.type), f.name, `truncated to ${keep} bytes (80 %)`);
}

/** Swap the names of two files (attempt to reorder the timeline). */
export function swapNames(a: EvidenceFile, b: EvidenceFile): [EvidenceFile, EvidenceFile] {
  return [
    copy(a, a.blob, b.name, `renamed from ${a.name}`),
    copy(b, b.blob, a.name, `renamed from ${b.name}`),
  ];
}

/** Demo of server-side tampering: change the metadata of one stored record. */
export function tamperServerRecord(targetSeq: number) {
  return (rows: SegmentRow[]): SegmentRow[] =>
    rows.map((r) =>
      r.seq === targetSeq ? { ...r, started_at: Number(r.started_at) - 60_000, ended_at: Number(r.ended_at) - 60_000 } : r
    );
}
