# Decoder — report

Web application used by the insurer to retrieve the recorded data and verify its integrity.

* URL: `/admin` (file `src/pages/admin.tsx`), engine in `src/lib/verifier.ts`
* Installation, configuration and run: see [SETUP.md](SETUP.md) (same project as the Encoder)
* Demo script for the video: see [DEMO_SCRIPT.md](DEMO_SCRIPT.md)

## 1. Functionalities

| Tab | What it does |
|---|---|
| **Live monitor** | Loads the latest records and subscribes to Supabase Realtime. Every incoming record is checked on arrival (chain hash, device signature, link to the previous segment). Sessions are listed with their anchoring delay; **Audit chain** re-verifies a whole session stored on the server. **Run retention purge** removes expired hashes. |
| **Verify evidence** | *Retrieve* the clips submitted by drivers from the Storage bucket `evidence` (or open files downloaded from the phone), *play* them, *verify* them, export the report as JSON. |
| **Tamper lab** (in the same tab) | Creates modified copies in memory — flip 1 bit, overwrite 4 KB, truncate 20 %, swap file names, remove a segment — and simulates an altered server record, to demonstrate detection. |
| **How verification works** | Explanation of the protocol inside the app. |

## 2. Integrity mechanism

### 2.1 What the dashcam registered (see ENCODER.md §2.3)
For each segment *i* of a session, the server holds (insert-only, server-timestamped):

```
segment_hash_i    = SHA-256(file_i)
prev_chain_hash_i = chain_hash_{i-1}            (i = 0 : SHA-256("GENESIS|" + session))
chain_hash_i      = SHA-256("dashcam-v1|device|session|i|start|end|frames|size|mime|w|h|lat|lon|segment_hash_i|prev_chain_hash_i")
signature_i       = ECDSA-P256-SHA256(device_private_key, chain_hash_i)
```

### 2.2 Verification algorithm (`verifyEvidence`)

1. **Hash** every submitted file: `h = SHA-256(bytes)`.
2. **Identify** by content: look up `segment_hash = h`. The file name is only a hint, used to say which
   record the file *claims* to be when the hash is unknown, and to detect renaming.
3. For every session involved, **audit the server chain** (`auditSession`), record by record:
   * recompute `chain_hash` from the stored fields → detects any edit of a stored record;
   * verify `signature` with the device public key → detects records not produced by the phone
     (e.g. inserted or rewritten by someone with database access, who does not have the private key);
   * check `prev_chain_hash == chain_hash(seq−1)` and the genesis link for seq 0 → detects deleted,
     inserted or re-ordered records; missing sequence numbers are listed;
   * check time continuity between consecutive segments.
4. **Per-file verdict**
   * `AUTHENTIC` – hash registered, size matches, its record passes all checks;
   * `MODIFIED` – the file claims to be segment *n* but its hash differs from the registered one
     (expected vs actual hash and size are displayed);
   * `FORGED` – the hash is registered but its record fails the signature or chain check;
   * `UNKNOWN` – no registered record (never recorded by a dashcam, or expired and purged);
   * `DUPLICATE` – the same segment submitted twice.
   Warnings: file renamed/re-ordered (identity comes from the hash, so it cannot fool the order),
   hash anchored late (> 60 s, buffered while offline).
5. **Completeness**: every sequence number between the first and the last submitted segment must be
   present, otherwise the missing segments are listed (part of the timeline withheld).
6. **Global verdict**: `TAMPERED` if any file or record fails; otherwise `INCOMPLETE` if segments are
   missing; otherwise `AUTHENTIC`.

### 2.3 What is detected

| Attack / incident | Detected by | Result |
|---|---|---|
| One bit changed, frames edited, re-encoded, trimmed, truncated upload | SHA-256 mismatch | MODIFIED |
| A segment removed from the submitted clip | seq gap in evidence | INCOMPLETE |
| Segments re-ordered / renamed | identity from hash, seq from signed record | warning, true order shown |
| Video from another source | hash not registered | UNKNOWN |
| Stored record edited in the DB (e.g. timestamps shifted) | chain hash recomputation + signature | FORGED / chain inconsistent |
| Record deleted from the DB | broken `prev_chain_hash` link / seq gap | chain gap |
| Record forged and re-signed with another key | ECDSA verification with registered key | FORGED |
| Hash produced after the fact | server `created_at` vs capture time (delay shown) | warning |

### 2.4 Reliability — why this is sound
* **SHA-256** is collision- and second-preimage-resistant (no practical attack): producing a different
  video with the same hash is computationally infeasible, and the avalanche effect makes any change,
  even a single bit, produce an unrelated hash.
* Hashing **the exact file bytes** is deterministic on every browser/OS. By contrast, re-extracting frames
  from a compressed video (what v1 of this project did) never reproduces the bytes hashed at capture,
  so an authentic video would be reported as tampered: that approach cannot be reliable.
* The **hash chain** makes the sequence tamper-evident as a whole; the **signature** makes the records
  tamper-evident even for someone who controls the database; the **server timestamp + insert-only
  table** prove the fingerprint existed shortly after capture, i.e. before any accident dispute.
* Only standard, audited primitives from the browser's Web Crypto API are used; the same code
  (`integrity.ts`) computes the values on both sides, so there is no format ambiguity.
* The engine is covered by an automated test (`npm run selftest`, 15 cases, see SETUP.md §7), and was
  tested end-to-end in a headless Chromium with a fake camera against an emulated backend (recording → offline buffering →
  reconnection → upload → retrieval → verification → tampering).

### 2.5 Limits
* Trust in the anchoring time relies on the database operator; a public timestamp authority (RFC 3161)
  or periodic Merkle-root anchoring would remove it.
* A compromised phone (malware before hashing) could record a fake scene; integrity proves the file was
  not changed *after* capture, not that the camera saw reality.
* Hashes older than the server retention (30 days) are purged unless the clip was submitted as evidence;
  such clips then verify as `UNKNOWN`.

## 3. Technical choices

| Choice | Justification |
|---|---|
| Web app (Next.js, same project as the Encoder) | Nothing to install for the insurer; shares `integrity.ts` with the Encoder, guaranteeing identical computations. |
| Verification in the browser | Evidence files never leave the insurer’s machine for checking; hashing uses the native Web Crypto API. |
| Supabase Realtime | Push of new fingerprints without polling. |
| Supabase Storage bucket `evidence` (private, no overwrite) | Retrieval of clips submitted by drivers. |
| JSON report export | Can be attached to the claim file. |
