# Dashcam Assurance

A browser-based dashcam evidence workflow with local video capture, signed segment fingerprints, protected incident storage, and insurer verification.

## Secure workflow

1. Configure Supabase Auth and the public project URL/key in the deployment environment (`SUPABASE_URL` and `SUPABASE_KEY`, or the corresponding `NEXT_PUBLIC_SUPABASE_*` publishable/anon variables). Never expose `SUPABASE_SECRET_KEY` or a service-role key to the browser.
2. Apply every migration in `../supabase/migrations/` in filename order. The secure workflow and capture-upload migration create owner-bound session recovery, workspace policies, a private evidence bucket, and the video index table.
3. Sign up or sign in. Each captured segment is signed and saved locally first. Its fingerprint and original video are then sent to the private workspace storage. The IndexedDB outbox retries both when a network outage interrupts delivery.

The existing Vercel project can deploy this Next.js app from `web/`. Add the Supabase URL and **publishable/anon** key to the Vercel project environment, then redeploy. `SUPABASE_SECRET_KEY` may remain server-side for the legacy Streamlit application; the web app deliberately never returns it from `/api/config`.

## Encoder / transmitter

Camera-only recording is split into configurable segments. Each segment is SHA-256 hashed, linked to its session chain, signed with the browser device’s ECDSA P-256 key, and saved locally before transmission. The IndexedDB outbox retries both fingerprint and private video uploads without changing IDs or signatures. The driver can simulate an outage, lock an incident with pre/post-roll, manage its local cache, and download the original video for checking.

## Decoder / insurer

Authorized workspace members can inspect a live fingerprint stream, retrieve any uploaded video from private Supabase storage, compare an original video or a SHA-256 text list with database fingerprints, validate device signatures and complete session chains, and review/export audit and verification history. Video checks hash locally and use exact matching against the signed Supabase records. Similarity is a review lead only; it never turns an exact-integrity failure into a verified result. The evaluation lab supports pHash, aHash, dHash, wHash, threshold calibration, confusion metrics, and CSV export.

## Development

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run lint
npm run build
```
