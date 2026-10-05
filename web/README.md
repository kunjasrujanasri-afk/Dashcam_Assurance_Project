# Dashcam Assurance web application

This is the deployed Next.js application. Its liquid glass/bento interface is customized for Dashcam Assurance; its integrity protocol and Supabase schema are adapted from the pinned upstream reference.

Read the [root README](../README.md) for the full code walkthrough: recording, IndexedDB, device identity, SHA-256 hash chains, ECDSA signatures, the persistent outbox, retention, Supabase policies, verification, and evaluation.

## Routes

- `/`: Drive Studio.
- `/admin`: Evidence Desk (Cloud timeline and File review).
- `/demo`: Integrity Trials.
- `/evaluation`: Signal Lab.

## Development

```bash
npm ci
# Copy .env.example to .env.local and configure the public Supabase values.
npm run dev -- --port 3010
```

Use the separate Dashcam Reference App backend and apply `supabase/schema.sql`. The incompatible root migrations have been removed; this is the current app's schema.

## Checks

```bash
npm run typecheck
npm run lint
npm run selftest
npm run build
```

## Design and implementation

`src/components/app-shell.tsx` provides vertical navigation, `src/components/ui.tsx` provides shared controls, and `src/styles/globals.css` defines the glass surfaces, palette, and responsive bento presentation. Capture, transmission, signatures, retention, and verification remain in `src/lib/`. Video libraries and review results group clips by recording session. File review uses one input panel with a choice of video files or a TXT list of SHA-256 hashes; hash lists check registration and signed records, while videos also verify file bytes.

The “How verification works” tab and explanatory overview panels have been removed from the interface; technical notes remain available as a collapsed disclosure in Integrity Trials and in the README.

[Setup](docs/SETUP.md) · [Reference analysis](docs/REFERENCE_ANALYSIS.md) · [Encoder](docs/ENCODER.md) · [Decoder](docs/DECODER.md) · [Evaluation](docs/EVALUATION.md)
