# Reference implementation

Source: [hoangtrietdev/video-fingerprint-app](https://github.com/hoangtrietdev/video-fingerprint-app), commit `2320d470b2bedf5836de35c98d1c6cf6bfbf39fb`.

The application uses Next.js Pages Router and Tailwind CSS. `/` is the driver Encoder, `/admin` is the Decoder, `/demo` demonstrates tampering, and `/evaluation` runs synthetic fingerprint comparisons. The presentation is customized for Dashcam Assurance: frosted glass panels, an asymmetric bento capture layout, a vertical sidebar, and a restrained pearl/rose/lavender palette. The explanatory tab and static demo explanation panels were removed at the user's request.

The Encoder captures camera frames onto a canvas with timestamp/device/GPS overlays, encodes video segments, hashes their exact bytes using SHA-256, links their hashes, and signs records using ECDSA P-256. Device keys, local videos, and the outbox live in IndexedDB. The transmitter sends batches and retries transient failures with exponential backoff. Incident clips are uploaded explicitly; ordinary segments remain in the local loop cache.

Supabase uses `devices`, `video_segments`, the private `evidence` bucket, and Realtime for the Decoder. Triggers force server arrival/expiry times and reject updates. The supplied schema permits anonymous inserts and reads, including evidence storage access, and exposes the expired-record purge RPC. This reproduces the reference proof of concept; it does not use the previous app's account/workspace access model.

**Use a separate Supabase project.** The original schema's `devices` table and `evidence` bucket collide with the earlier secure app. Do not apply this schema to that existing project: its anonymous storage policy would also apply to existing evidence. Apply only `web/supabase/schema.sql` to the separate project, set the two public environment variables, and rebuild. Do not apply the repository's older root migrations to this reference backend.

Core library files and the SQL schema were copied from the pinned reference. Shared UI components, global CSS, and page layout are customized; the capture, storage, transmission, retention, and verification libraries remain unchanged. The page-only repairs use Next.js Link for internal navigation, remove unused variables, rename a non-hook callback, reset demo state by mounting the selected scenario, and defer the initial evaluation run to satisfy React lint. These repairs preserve the rendered interface and protocol. The current project's Next.js patch version is retained.

The evaluation dashboard is a synthetic simulation. Its displayed comparisons and example report are not measured results from real dashcam clips. The protocol self-test uses an in-memory repository and does not verify a live Supabase deployment.
