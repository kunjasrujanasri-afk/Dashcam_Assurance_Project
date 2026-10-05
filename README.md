# Dashcam Assurance

Dashcam Assurance is a browser application for recording journeys, anchoring signed video fingerprints in Supabase, and checking submitted evidence for changes.

[Live application](https://dashcamassuranceproject.vercel.app/) · [Web application guide](web/README.md) · [Setup](web/docs/SETUP.md)

The application lives in **`web/`**. Its interface uses a vertical navigation rail, liquid glass panels, and a responsive bento layout. Vercel builds the Next.js application from `web/`.

The unused Python prototype, its tests and configuration, sample API route, and starter assets have been removed. Old recordings, fingerprint exports, and generated datasets are no longer tracked in Git; existing local copies are preserved and ignored. Previous implementations remain recoverable from Git history.

## Pages

| Route | Purpose |
| --- | --- |
| `/` — Drive Studio | Record journeys, protect incident clips, browse videos grouped by session, save clips or TXT hash lists, and submit evidence. |
| `/admin` — Evidence Desk | Monitor cloud fingerprints and audit session chains. One File review panel accepts videos or a TXT hash list and exports results. |
| `/demo` — Integrity Trials | Choose a trial from a vertical dropdown to compare altered copies with registered evidence. |
| `/evaluation` — Signal Lab | Adjust similarity thresholds and run synthetic fingerprint comparisons. |

The explanatory “How verification works” tab has been removed from the interface. Technical explanations are maintained here and in the documentation.

## Architecture and data flow

```text
Camera → canvas composition → encoded segment file
                                ├─ video → local IndexedDB cache
                                └─ SHA-256 → chained record → ECDSA signature
                                                         ↓
                                                persistent outbox
                                                         ↓
                                                Supabase fingerprints
                                                         ↓
                                                Realtime Evidence Desk audit

Selected incident files → Supabase evidence storage → download → verify
```

### 1. Device identity

`web/src/lib/deviceIdentity.ts` creates a random device UUID and an ECDSA P-256 key pair on first use. The private key is non-extractable and stored as a CryptoKey in IndexedDB. The public key is registered in the `devices` table so the verifier can check the device's signatures.

A device identity belongs to a browser's storage. Clearing that storage creates a new identity the next time the application initializes.

### 2. Recording and local persistence

`recorder.ts` requests camera access, draws frames and capture metadata onto a canvas, and records separate video segments using MediaRecorder. Each completed segment is hashed, signed, and persisted before transmission.

`localStore.ts` stores device identity, segment blobs, and pending fingerprints in IndexedDB. `retention.ts` removes expired unlocked clips and locks the incident window around an incident button press. Locked clips remain available for submission.

Settings are centralized in `config.ts`: the default segment length is 5 seconds, default local retention is 3 minutes, target composition is 1280×720 at 15 fps, and an incident locks 30 seconds before and after the event. Camera capabilities can reduce the actual resolution.

### 3. Fingerprinting and signatures

`integrity.ts` contains the shared cryptographic protocol:

```text
segment_hash    = SHA-256(exact encoded file bytes)
prev_chain_hash = previous segment's chain hash
                  or SHA-256("GENESIS|" + session_id) for sequence 0
chain_hash      = SHA-256(canonicalRecord(segment))
signature       = ECDSA-P256-SHA256(private_key, chain_hash)
```

Canonical metadata includes protocol version, device/session IDs, sequence number, capture timestamps, frame count, byte size, MIME type, dimensions, and optional coordinates. A fixed field order and number format allow the Encoder and Decoder to recompute the same hash.

`canonicalRecord()` also includes `segment_hash` and `prev_chain_hash`. It joins the fields with `|`, uses integer formatting for timestamps and counts, and rounds coordinates to six decimal places. `chain_hash` and `signature` are calculated afterward and are not included in that serialized record.

The exact-file hash detects byte changes. The signature checks the signing key. The chain and sequence checks detect altered records, broken links, and missing segments. These checks establish consistency with registered records; they do not establish that the scene itself was truthful.

### 4. Store-and-forward transmission

`transmitter.ts` persists every signed fingerprint in an outbox. It registers the public device key, uploads batches, and removes an outbox entry only after a successful response.

Retries use exponential backoff, capped at 30 seconds. Unique session/sequence constraints and duplicate-safe upserts prevent repeated uploads from creating duplicate records. Transient network/server failures are retried; permanently rejected records retain their error details. The “Pause uplink” control exercises this buffering path.

Ordinary video segments remain on the device. Sending selected evidence explicitly uploads the video files.

### 5. Supabase backend

Apply **`web/supabase/schema.sql`** to the separate Dashcam Reference App project. The obsolete root migrations have been removed because their workspace-based `devices` table conflicts with this schema. They remain recoverable from Git history.

| Resource | Responsibility |
| --- | --- |
| `public.devices` | Device ID, label, public signing key, and registration time. |
| `public.video_segments` | Signed fingerprints, chain links, metadata, server arrival time, and expiry. |
| `evidence` storage bucket | Submitted incident files, grouped by session. |
| Insert triggers | Force arrival and expiry timestamps to server time. |
| Update triggers | Reject changes to existing device and fingerprint records. |
| `purge_expired_segments()` | Remove expired fingerprints unless the session has submitted evidence. |
| `pg_cron` | Run the retention purge every 15 minutes when available. |
| Realtime publication | Notify the Decoder when new fingerprint rows arrive. |

The retained reference schema allows anonymous and authenticated clients to insert and read records and evidence. The bucket is marked private, but its read policy still permits anonymous access through the public app key. There is no account-based ownership isolation in this implementation. Update and delete policies are not granted to application clients; the retention function removes eligible expired rows.

### 6. Evidence verification

`repository.ts` retrieves fingerprint records, device public keys, and evidence files. `verifier.ts` hashes submitted files, matches their bytes to cloud fingerprints, verifies signatures, recomputes chain hashes, and checks sequence continuity.

Evidence Desk presents original verified, changes detected, and timeline incomplete results, with per-file authenticity findings. Clips are grouped by the signed session ID; filenames are only grouping hints before verification.

`hashManifest.ts` accepts one SHA-256 hash per non-empty line, including optional sha256sum filenames. It normalizes case, reports invalid line numbers, limits lists to 2,000 entries, queries unique hashes in batches of 100, and audits matched cloud records. TXT results distinguish registered, missing, repeated, and invalid entries. A hash list checks registration and signed records; it does not verify video content. Use video review to check the actual file bytes. A session audit verifies the server's chain independently of the submitted file set. `tamperLab.ts` creates altered copies in memory for demonstrations; it does not change the stored originals.

### 7. Evaluation

`fingerprintMetrics.ts` implements perceptual/fuzzy fingerprint and vector-distance comparisons. The Signal Lab runs synthetic scenarios and reports threshold-dependent precision, recall, F1, and accuracy. Its displayed metrics are simulations, not measurements of real camera footage. Cryptographic evidence verification remains the exact-byte SHA-256/signature/chain path.

## Code map

To follow one recording through the code, start with the controls in `src/pages/index.tsx`. They create and control the recorder and transmitter. Follow the completed segment into `recorder.ts`, then the hashing/signing helpers in `integrity.ts`, the writes in `localStore.ts`, and the upload queue in `transmitter.ts`. For the reverse path, start at `src/pages/admin.tsx`, then read `repository.ts` and `verifier.ts`.

`src/pages/_app.tsx` wraps every page in the shared `AppShell`. Page components keep their controls and state; the shell and shared UI components supply navigation and presentation. `supabaseClient.ts` constructs the public browser client from environment variables. Database and storage requests go directly to Supabase; the integrity workflow does not depend on a custom Next.js API endpoint.

| Location in `web/` | What to change there |
| --- | --- |
| `src/components/app-shell.tsx` | Shared vertical navigation, brand, and page frame. |
| `src/components/ui.tsx` | Cards, metrics, status badges, page headings, and action buttons. |
| `src/styles/globals.css` | Glass surfaces, bento styling, palette, responsive rail, and focus styles. |
| `src/pages/index.tsx` | Capture screen and recording controls. |
| `src/pages/admin.tsx` | Live monitoring, chain audits, and evidence verification screens. |
| `src/pages/demo.tsx` | Interactive tampering workflows. |
| `src/pages/evaluation.tsx` | Evaluation controls, filtering, and results. |
| `src/lib/hashManifest.ts` | TXT parsing, bounded cloud lookups, and signed-record checks. |
| `src/lib/` | Capture, storage, transmission, retention, and verification logic. |
| `scripts/selftest.ts` | Integrity and verification regression checks. |
| `supabase/schema.sql` | Database tables, policies, storage, triggers, and retention. |

## Run locally

Use Node.js 20.9 or newer, as required by the installed Next.js package.

```bash
cd web
npm ci
```

Copy `web/.env.example` to `web/.env.local` and configure the public values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<public-publishable-or-anon-key>
```

`.env.local` is ignored by Git. Never put a service-role key in a `NEXT_PUBLIC_` variable.

```bash
npm run dev -- --port 3010
# Open http://localhost:3010
```

Camera access and Web Crypto require HTTPS or localhost. A deployed HTTPS URL is appropriate for phone testing.

## Verify and deploy

```bash
npm run typecheck
npm run lint
npm run selftest
npm run build
npm run start -- --port 3010
```

The integrity self-test covers authentic evidence, bit corruption, overwritten blocks, truncation, missing files and records, renamed files, modified server metadata, foreign-key signatures, unrelated files, and duplicate submissions, TXT parsing and size limits, hash registration, invalid cloud records, and bounded manifest queries.

Vercel's root directory is `web`. Set the two public Supabase variables for Production and Preview before building. Environment changes require a new deployment because these values are embedded in the client bundle.

## Reference and project history

The core integrity and Supabase implementation is adapted from [hoangtrietdev/video-fingerprint-app](https://github.com/hoangtrietdev/video-fingerprint-app), pinned at `2320d470b2bedf5836de35c98d1c6cf6bfbf39fb`. The liquid glass/bento presentation is customized for Dashcam Assurance.

See [reference analysis](web/docs/REFERENCE_ANALYSIS.md), [Encoder guide](web/docs/ENCODER.md), [Decoder guide](web/docs/DECODER.md), and [evaluation guide](web/docs/EVALUATION.md) for additional details.
