# Dashcam Assurance

A browser-based dashcam evidence workflow with local video capture, signed segment fingerprints, protected incident storage, and insurer verification.

## Secure workflow

1. Configure Supabase Auth and the public project URL/key in the deployment environment (`SUPABASE_URL` and `SUPABASE_KEY`, or the corresponding `NEXT_PUBLIC_SUPABASE_*` publishable/anon variables). Never expose `SUPABASE_SECRET_KEY` or a service-role key to the browser.
2. Apply [`../supabase/migrations/20261004000000_secure_evidence_workflow.sql`](../supabase/migrations/20261004000000_secure_evidence_workflow.sql) to the Supabase project. It creates the workspace tables, row-level policies, private incident bucket, and Realtime publication entries while leaving the legacy Streamlit table intact.
3. Sign up or sign in. The first authenticated session creates a private workspace. The browser stores the device signing key and ordinary video segments in IndexedDB; only signed fingerprints are sent to the workspace. Video is uploaded only for incident clips that the driver locks.

The existing Vercel project can deploy this Next.js app from `web/`. Add the Supabase URL and **publishable/anon** key to the Vercel project environment, then redeploy. `SUPABASE_SECRET_KEY` may remain server-side for the legacy Streamlit application; the web app deliberately never returns it from `/api/config`.

## Encoder / transmitter

Camera or synthetic-road recording is split into configurable segments. Each segment is SHA-256 hashed, linked to its session chain, signed with the browser device’s ECDSA P-256 key, and saved locally before transmission. The IndexedDB outbox retains unacknowledged segments and retries without changing IDs or signatures. The driver can simulate an outage, lock an incident with pre/post-roll, manage local retention, and export original video plus its signed manifest.

## Decoder / insurer

Authorized workspace members can inspect a live fingerprint stream, retrieve protected incident videos, verify exact file bytes, validate the device signature and complete session chain, compare altered or re-encoded videos using temporal perceptual fingerprints, and review/export audit and verification history. Similarity is a review lead only; it never turns an exact-integrity failure into a verified result. The evaluation lab supports pHash, aHash, dHash, wHash, threshold calibration, confusion metrics, and CSV export.

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
