# Encoder / Transmitter — report

Mobile web application running on the driver's smartphone, fixed on the windshield.
It records the road continuously, fingerprints the recording and anchors the
fingerprints on the server within seconds, while keeping the video itself on the phone.

* URL: `/` (file `src/pages/index.tsx`)
* Installation, configuration and run: see [SETUP.md](SETUP.md)
* Demo script for the video: see [DEMO_SCRIPT.md](DEMO_SCRIPT.md)

## 1. Architecture

```
 ┌──────────────── Smartphone (browser) ─────────────────────────────────────────┐
 │ camera ─► <video> ─► frame acquisition 15 fps ─► <canvas> composition         │
 │                           (frame + burnt-in UTC time, device, session, GPS)   │
 │ canvas.captureStream ─► MediaRecorder ─► 5 s segments (WebM/VP9 or MP4/H.264) │
 │        │                                                                      │
 │        ├─► SHA-256(segment) ─► chain hash ─► ECDSA-P256 signature             │
 │        │                                                                      │
 │        ├─► IndexedDB "segments" (video, loop recording, retention, lock)      │
 │        └─► IndexedDB "outbox" ─► transmitter (retry / back-off / idempotent)  │
 └────────────────────────────────────┬──────────────────────────────────────────┘
                                      │ HTTPS (PostgREST)          on incident:
                                      ▼                            clip upload
             Supabase: devices · video_segments (insert-only) · Storage "evidence"
```

| Module | Role |
|---|---|
| `src/lib/recorder.ts` | camera acquisition, composition, segmentation, hashing, signing |
| `src/lib/integrity.ts` | the protocol (SHA-256, canonical record, chain, ECDSA) — shared with the Decoder |
| `src/lib/deviceIdentity.ts` | device id + non-extractable key pair, public-key registration |
| `src/lib/localStore.ts` | IndexedDB persistence (segments, outbox, identity) |
| `src/lib/transmitter.ts` | store-and-forward transmission, connectivity handling |
| `src/lib/retention.ts` | loop recording: expiry, storage cap, incident lock |
| `src/lib/config.ts` | all tunable values |

## 2. Functionalities and implementation

### 2.1 Acquisition of frames from the camera
`navigator.mediaDevices.getUserMedia` with `facingMode: environment` (rear camera, facing the road),
1280×720 ideal. The stream is played in a (hidden) `<video>` element; a timer grabs a frame
every 1/15 s with `drawImage` onto a `<canvas>`. The hidden video must stay in the DOM for iOS Safari.

### 2.2 Composition / processing of the video
Each acquired frame is composed on the canvas with a burnt-in overlay: UTC timestamp (ms), device id,
session id, frame counter and GPS position (Geolocation API, if allowed). The composed canvas is
turned back into a video stream (`canvas.captureStream(15)`) and encoded by `MediaRecorder`
(VP9/VP8 WebM, or H.264 MP4 on Safari, 1.5 Mbit/s).

The stream is cut into **fixed-length segments (5 s by default; 10/30 s selectable)**. Each segment is
a complete, independently playable file. To avoid losing footage at the boundary, the next
`MediaRecorder` is started *before* the previous one is stopped. Segments are named
`dashcam_<session>_<seq>.webm`.

Why segments? A single endless file could only be hashed once the recording stops — too late to
prove anything. Short segments give a fingerprint every few seconds, bound the loss if the phone is
destroyed in the crash, allow the driver to share only the relevant minute, and make retention
possible (old segments are simply deleted).

### 2.3 Generation of hashes for the relevant data
For each segment, in capture order (promise queue):

| Value | Definition | Purpose |
|---|---|---|
| `segment_hash` | SHA-256 of the exact file bytes | content integrity |
| `prev_chain_hash` | `chain_hash` of seq−1; for seq 0: SHA-256(`GENESIS|session`) | ordering / completeness |
| `chain_hash` | SHA-256 of the canonical record `dashcam-v1|device|session|seq|start|end|frames|size|mime|w|h|lat|lon|segment_hash|prev_chain_hash` | binds content + metadata + position in the sequence |
| `signature` | ECDSA P-256/SHA-256 of `chain_hash` with the device private key | authenticity (who produced it) |

The key pair is generated on first launch with `extractable: false` and stored in IndexedDB:
the page can sign with it but nobody (not even the app) can export the private key.
The public key (JWK) is registered once in `public.devices`.

All hashing uses the browser's native **Web Crypto API** (`crypto.subtle`), no library.

### 2.4 Dynamic transmission of hashes to the storage server
As soon as a segment is closed (every 5 s), its signed record is written to the **outbox** and the
transmitter sends it to `public.video_segments` (Supabase PostgREST over HTTPS). The server stamps its own
`created_at` (trigger — the phone cannot back-date) and rows are insert-only. The Decoder receives
the new rows live through Supabase Realtime (WebSocket).

The video itself is *not* uploaded continuously (bandwidth, privacy, mobile data): only the 64-byte
fingerprints are. After an incident the driver selects the locked segments and presses
**Send to insurer**, which uploads them to the private Storage bucket `evidence/<session>/…`
(no overwrite allowed).

### 2.5 Handling of network interruptions
* **Persistent outbox** (IndexedDB): records survive network loss, page reload, browser crash.
  A record leaves the outbox only after the server acknowledges it.
* Connectivity is judged by **real request results** (status 0, 5xx, 408, 429 → retry) and by the
  `online`/`offline` events; `navigator.onLine` alone is unreliable on phones.
* **Exponential back-off** 1 s → 2 s → … → 30 s, and immediate flush when `online` fires.
* Batches of 25 rows; **idempotent** inserts (`unique(session_id, seq)` + `ON CONFLICT DO NOTHING`)
  so that a retry after a lost acknowledgement never creates duplicates.
* A permanently rejected row (4xx) is isolated and shown, so it cannot block the queue.
* Recording never depends on the network: hashing/signing is local.
* UI: link badge (online / offline-buffering / simulated), outbox counter, event log, and a
  **"Simulate network loss"** button for the demo (airplane mode works too).
* The Decoder shows the *anchoring delay* of each record, so a hash sent late after a tunnel is
  visible as such (transparency).

### 2.6 Management and deletion of data no longer valid
* **Loop recording**: every 5 s, segments older than the *local retention* (1/3/10/60 min selectable;
  3 min default so it can be shown in a demo) are deleted from the phone.
* **Storage cap**: at most 400 unlocked segments are kept (oldest removed first); browser storage
  usage is displayed and persistent storage is requested.
* **Incident lock**: "⚠ Incident" locks the previous 30 s and the next 30 s; locked segments are
  never deleted automatically (can be unlocked manually). Segments sent to the insurer are locked.
* **Server side**: every hash gets `expires_at = now() + 30 days` (trigger); `purge_expired_segments()`
  (pg_cron every 15 min, or the Decoder button) deletes expired hashes — except those of sessions
  whose clips were submitted as evidence, which are part of a claim.
* Pending hashes are never dropped by retention, so the server-side chain stays complete.

## 3. Technical choices and justification

| Choice | Why |
|---|---|
| Mobile **web** app (Next.js 16 + React 19 + TypeScript) | Runs on Android and iPhone without store publication; same code base as the Decoder; camera, crypto, storage and wake-lock are standard Web APIs. |
| Canvas composition + MediaRecorder | The only portable way in a browser to *process* frames (overlay) and re-encode them into a video. |
| Hash of the encoded file, not of frames | Deterministic: the insurer recomputes exactly the same bytes. Re-decoding video never reproduces the pixels/JPEG bytes hashed at capture, so per-frame hashes cannot be verified reliably. |
| SHA-256 | Standard, collision-resistant, native in every browser. |
| Hash chain | Detects deletion, insertion and re-ordering of segments, not only modification. |
| ECDSA P-256, non-extractable key | Proves the record comes from the registered phone; a database administrator cannot forge records. |
| IndexedDB | Only browser storage able to hold large Blobs and CryptoKeys persistently. |
| Supabase (PostgreSQL, Storage, Realtime) | Managed HTTPS backend, server timestamps, RLS, triggers, WebSocket push, free tier. |

## 4. Limits and possible improvements
* Browsers throttle timers when the app is in the background; a native app (or a PWA with
  a foreground service) would record with the screen off.
* The anon key allows any client to insert; production would use authenticated device accounts
  (JWT) and an Edge Function checking the signature before insert.
* A trusted timestamping service (RFC 3161) or a public blockchain anchor of periodic Merkle roots
  would remove the need to trust the database operator for the time of anchoring.
