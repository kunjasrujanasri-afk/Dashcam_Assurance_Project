/**
 * scripts/selftest.ts — automated test of the integrity protocol + Decoder
 * verification engine, without camera or network (in-memory repository).
 *
 *   npm run selftest
 */

import { buildSignedRecord, exportPublicJwk, generateDeviceKeyPair, genesisHash, hashBlob, segmentFileName, SegmentCore } from "../src/lib/integrity";
import type { DeviceRow, SegmentRow } from "../src/lib/supabaseClient";
import { flipOneBit, overwriteBlock, swapNames, tamperServerRecord, truncate } from "../src/lib/tamperLab";
import { EvidenceFile, Repository, verifyEvidence } from "../src/lib/verifier";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  → ${detail}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const deviceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const kp = await generateDeviceKeyPair();
  const device: DeviceRow = { id: deviceId, label: "test", public_key: await exportPublicJwk(kp.publicKey), created_at: new Date().toISOString() };

  // Build a session of 6 "segments" with random content
  const rows: SegmentRow[] = [];
  const files: EvidenceFile[] = [];
  let prev = await genesisHash(sessionId);
  const t0 = Date.now() - 60_000;
  for (let seq = 0; seq < 6; seq++) {
    const bytes = crypto.getRandomValues(new Uint8Array(50_000));
    const blob = new Blob([bytes], { type: "video/webm" });
    const core: SegmentCore = {
      device_id: deviceId, session_id: sessionId, seq,
      started_at: t0 + seq * 5000, ended_at: t0 + (seq + 1) * 5000,
      frame_count: 75, byte_size: blob.size, mime_type: blob.type,
      width: 1280, height: 720, latitude: 49.383742, longitude: 1.074511,
      segment_hash: await hashBlob(blob), prev_chain_hash: prev,
    };
    const rec = await buildSignedRecord(core, kp.privateKey);
    prev = rec.chain_hash;
    // simulate PostgREST round-trip (JSON)
    rows.push(JSON.parse(JSON.stringify({ ...rec, id: crypto.randomUUID(), created_at: new Date(core.ended_at + 800).toISOString(), expires_at: "" })));
    files.push({ id: String(seq), name: segmentFileName(sessionId, seq, blob.type), blob, origin: "local" });
  }

  const repo = (list: SegmentRow[] = rows): Repository => ({
    findByHashes: async (h) => list.filter((r) => h.includes(r.segment_hash)),
    getSession: async (s) => list.filter((r) => r.session_id === s),
    getDevice: async (id) => (id === deviceId ? device : null),
  });

  let r = await verifyEvidence(files, repo());
  expect("untouched evidence → AUTHENTIC", r.verdict === "AUTHENTIC", JSON.stringify(r.summary));
  expect("all signatures valid", r.sessions[0].records.every((c) => c.signatureOk && c.chainOk && c.linkOk));

  r = await verifyEvidence([files[0], await flipOneBit(files[1]), files[2]], repo());
  expect("1 bit flipped → TAMPERED", r.verdict === "TAMPERED");
  expect("flipped file reported MODIFIED", r.files[1].status === "MODIFIED");

  r = await verifyEvidence([files[0], await overwriteBlock(files[1])], repo());
  expect("block overwritten → MODIFIED", r.files[1].status === "MODIFIED");

  r = await verifyEvidence([await truncate(files[3])], repo());
  expect("truncated → MODIFIED", r.files[0].status === "MODIFIED");

  r = await verifyEvidence([files[0], files[1], files[3], files[4]], repo());
  expect("segment removed from evidence → INCOMPLETE", r.verdict === "INCOMPLETE");
  expect("missing seq #2 reported", r.sessions[0].missingInEvidence.join() === "2");

  const [a, b] = swapNames(files[1], files[2]);
  r = await verifyEvidence([files[0], a, b], repo());
  expect("renamed files still identified by content", r.files[1].record?.seq === 1 && r.files[1].renamed);

  r = await verifyEvidence(files, repo(), { mutateRows: tamperServerRecord(2) });
  expect("server record altered → TAMPERED", r.verdict === "TAMPERED");
  expect("altered record fails chain check", r.sessions[0].records[2].chainOk === false);

  const withoutRow3 = rows.filter((x) => x.seq !== 3);
  r = await verifyEvidence(files.slice(0, 3), repo(withoutRow3));
  expect("record deleted on server → chain gap detected", r.sessions[0].missingInDb.join() === "3");

  // Forged record: attacker re-computes chain hash with his own key
  const evil = await generateDeviceKeyPair();
  const forgedBlob = new Blob([crypto.getRandomValues(new Uint8Array(1000))], { type: "video/webm" });
  const forgedCore = { ...rows[5], segment_hash: await hashBlob(forgedBlob), byte_size: forgedBlob.size } as SegmentCore;
  const forged = await buildSignedRecord(forgedCore, evil.privateKey);
  const rowsForged = rows.map((x) => (x.seq === 5 ? { ...x, ...forged } : x));
  r = await verifyEvidence([{ id: "f", name: files[5].name, blob: forgedBlob, origin: "local" }], repo(rowsForged));
  expect("record re-signed with foreign key → FORGED", r.files[0].status === "FORGED");

  r = await verifyEvidence([{ id: "x", name: "holiday.webm", blob: new Blob(["abc"]), origin: "local" }], repo());
  expect("unrelated file → UNKNOWN", r.files[0].status === "UNKNOWN" && r.verdict === "TAMPERED");

  r = await verifyEvidence([files[0], files[0]], repo());
  expect("duplicate detected", r.files[1].status === "DUPLICATE");

  console.log(failures ? `\n${failures} test(s) FAILED` : "\nAll tests passed");
  process.exit(failures ? 1 : 0);
}

main();
