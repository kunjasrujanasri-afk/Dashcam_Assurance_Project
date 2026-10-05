# Dashcam Assurance web application

This is the deployed Next.js application. Its glass/bento interface is customized for Dashcam Assurance; its integrity protocol and Supabase schema are adapted from the pinned upstream reference.

Read the [root README](../README.md) for the full code walkthrough: recording, IndexedDB, device identity, SHA-256 hash chains, ECDSA signatures, the persistent outbox, retention, Supabase policies, verification, and evaluation.

## Routes

- `/`: Capture studio.
- `/admin`: Evidence workspace (live monitor and evidence verification).
- `/demo`: Integrity playground.
- `/evaluation`: Evaluation lab.

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

`src/components/app-shell.tsx` provides vertical navigation, `src/components/ui.tsx` provides shared controls, and `src/styles/globals.css` defines the glass surfaces, palette, and responsive bento presentation. Capture, transmission, signatures, retention, and verification remain in `src/lib/`.

The “How verification works” tab and explanatory overview panels have been removed from the interface; the explanation is maintained in the README.

[Setup](docs/SETUP.md) · [Reference analysis](docs/REFERENCE_ANALYSIS.md) · [Encoder](docs/ENCODER.md) · [Decoder](docs/DECODER.md) · [Evaluation](docs/EVALUATION.md)
