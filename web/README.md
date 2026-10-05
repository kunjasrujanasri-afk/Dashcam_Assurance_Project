> Rebuilt from the supplied Encoder, Decoder, Evaluation and Fraud Demo reference app.
> Cloud capture and verification require a signed-in Supabase account. Evaluation is a local synthetic simulation, not a measured production benchmark.
>
> Before deploying, apply `../supabase/migrations/20261005020000_reference_dashcam_app.sql` in the existing Supabase project. It creates isolated `dashcam_devices`, `dashcam_video_segments`, and a private `dashcam-evidence` bucket, with account ownership enforced by RLS. Existing evidence tables and the original browser vault remain intact; old queued segments are not converted to the new protocol.
>
> The transmitter sends fingerprints in batches without per-segment Auth user requests, uses exponential backoff for outages and HTTP 429, and retains unacknowledged segments locally. Incident clips are uploaded explicitly from the Encoder.
# Dashcam Integrity System — Encoder & Decoder

A smartphone used as a **dashcam** records the road, fingerprints every few seconds of video and
anchors the fingerprints on a server; an **insurer** later retrieves the clip and proves, cryptographically,
that it has not been modified, cut or forged.

| Component | Runs on | URL | Report |
|---|---|---|---|
| **Encoder / Transmitter** | driver's smartphone (mobile web app) | `/` | [docs/ENCODER.md](docs/ENCODER.md) |
| **Decoder** | insurer's computer (web app) | `/admin` | [docs/DECODER.md](docs/DECODER.md) |
| **Evaluation Dashboard** | any browser | `/evaluation` | [docs/EVALUATION.md](docs/EVALUATION.md) |
| Installation / configuration / run (both) | | | [docs/SETUP.md](docs/SETUP.md) |


## Quick start

```bash
npm ci
# 1. create a Supabase project and run supabase/schema.sql in its SQL editor
# 2. create .env.local:
#    NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
#    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon key>
npm run dev            # computer: http://localhost:3000 and /admin
npm run dev:https      # phone on same Wi-Fi: https://<LAN-IP>:3000
npm run selftest       # automated integrity tests
```

## How it works (one minute)

```
PHONE (Encoder)                                   SERVER (Supabase)             INSURER (Decoder)
camera → frames → canvas overlay → 5 s segments
  segment_hash = SHA-256(file)
  chain_hash   = SHA-256(record ‖ prev_chain_hash)  ── HTTPS ──►  video_segments   ◄── Realtime / queries
  signature    = ECDSA-P256(device key, chain)      (outbox,      insert-only,
video kept on phone (loop recording, retention)      retry)       server time
incident → clip uploaded ───────────────────────────────────────► Storage "dashcam-evidence" ──► retrieve + verify:
                                                                                 hash · signature · chain · gaps
```

## Requirement coverage

| Requirement | Where |
|---|---|
| Frame acquisition from the camera | `src/lib/recorder.ts` (`getUserMedia`, 15 fps frame grab) |
| Video composition / processing | canvas overlay + `MediaRecorder` segments — `recorder.ts` |
| Hash generation | SHA-256 + hash chain + ECDSA — `src/lib/integrity.ts` |
| Dynamic transmission | outbox + transmitter — `src/lib/transmitter.ts`, Realtime on Decoder |
| Network interruptions | persistent outbox, back-off, idempotent inserts, simulate button |
| Deletion of expired data | loop recording `src/lib/retention.ts`; server purge `dashcam_purge_expired_segments()` |
| Integrity verification + detection | `src/lib/verifier.ts`, Decoder "Verify evidence" + tamper lab |
| Perceptual hash metrics (aHash/dHash/pHash/wHash) | `src/lib/fingerprintMetrics.ts` |
| Fuzzy hashing (ssdeep, TLSH) | `src/lib/fingerprintMetrics.ts` |
| Vector metrics (L1, L2, cosine) | `src/lib/fingerprintMetrics.ts` |
| Threshold evaluation (precision/recall/F1) | `src/lib/fingerprintMetrics.ts` + `/evaluation` |
| Evaluation dashboard (all §1–§7 scenarios) | `src/pages/evaluation.tsx` — `/evaluation` |
| Evaluation report | [docs/EVALUATION.md](docs/EVALUATION.md) |
| Environment reproduction | `docs/SETUP.md` |

## Project structure

```
supabase/schema.sql        tables, triggers (server time, immutability), RLS, purge, bucket, realtime
src/lib/config.ts          tunable parameters
src/lib/integrity.ts       protocol shared by both apps (SHA-256, canonical record, chain, ECDSA)
src/lib/fingerprintMetrics.ts perceptual hashes, fuzzy hashes, vector metrics, threshold evaluation
src/lib/recorder.ts        Encoder: camera → composition → segments → hash/sign → store
src/lib/transmitter.ts     Encoder: store-and-forward hash transmission
src/lib/retention.ts       Encoder: loop recording, incident lock
src/lib/localStore.ts      Encoder: IndexedDB persistence
src/lib/deviceIdentity.ts  Encoder: device id + non-extractable key pair
src/lib/verifier.ts        Decoder: verification engine
src/lib/repository.ts      Decoder: Supabase queries, evidence bucket
src/lib/tamperLab.ts       Decoder: tampering simulations for the demo
src/pages/index.tsx        Encoder UI
src/pages/admin.tsx        Decoder UI
src/pages/evaluation.tsx   Evaluation dashboard (§1–§7 scenarios + metrics + thresholds)
scripts/selftest.ts        automated tests of the protocol and the verifier
docs/EVALUATION.md         comprehensive evaluation report
```

## Open-source components

Next.js, React, TypeScript, Tailwind CSS, Supabase (`@supabase/supabase-js`), tsx (tests).
Cryptography uses only the browser-native Web Crypto API. All application logic is original.
