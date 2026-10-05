# Dashcam Assurance

Dashcam Assurance is a coursework prototype with two interfaces:

- **Encoder and transmitter:** the Streamlit application (`app.py`) captures a video from upload or browser camera, creates a SHA-256 digest for each decoded frame, writes local TXT evidence, and progressively sends fingerprint batches to Supabase.
- **Decoder and evaluation lab:** the same application verifies frame digests against cloud or local TXT evidence, reports exact mismatches and sequence anomalies, compares perceptual hashes for temporal alignment, and runs reproducible evaluation scenarios.
- **Browser evidence console:** `web/` contains the Next.js camera capture and Supabase verification workflow deployed to Vercel. It is separate from the Streamlit frame-based prototype.

## Architecture and integrity model

OpenCV decodes video frames. `hashlib.sha256(frame.tobytes())` creates an exact byte-level digest of each decoded frame. Records carry the one-based frame number, timestamp, driver ID, video name, status, and digest. The Streamlit transmitter does not send the original video; it remains in the local `videos/` directory.

SHA-256 answers whether decoded frame bytes match a trusted record. It does not identify what visual edit occurred, and re-encoding generally changes frame bytes. The Evaluation Lab therefore uses separate aHash, dHash, pHash, and wHash algorithms with Hamming and normalized Hamming distances for visual similarity. Similarity is exploratory evidence; it never upgrades a failed SHA-256 check to `VERIFIED`.

`decoder/integrity.py` classifies exact matches, modified/corrupt frames, repeated digests, known digests found at a different reference position, absent reference positions, and leading/trailing trims. Perceptual temporal matching is available in the Evaluation Lab and reports frame offset, seconds, matched interval, and confidence.

## Encoder, transmission, and offline recovery

The Streamlit encoder handles uploaded files and WebRTC camera recordings while the page is open. It samples decoded frames, saves one-hash-per-line TXT files (`database/fingerprints.txt` and a video-specific file), and writes accompanying frame metadata to JSON sidecars.

New fingerprints enter `database/transmission_queue.sqlite3` in batches while frame processing continues. SQLite uses a unique driver/video/frame identity, so duplicate enqueues are ignored. Failed Supabase reads or writes leave records on disk. The Capture page reports queue size and offers retry. On retry, the app checks existing cloud frame numbers before inserting queued records. Delivery is at-least-once with cloud-read deduplication, not a server-attested exactly-once protocol.

The Streamlit queue is on the application host. The browser app instead uses an IndexedDB outbox and can record locally during a simulated or actual outage; session rows, fingerprints, and original segment videos retry after connectivity returns. The web app stores video in a private Supabase bucket and a workspace-scoped `evidence_recordings` table.

## Decoder and evidence sources

The Streamlit **Insurance Verification** workflow can compare against Supabase or local TXT evidence. The Next.js decoder has one input for an original video or a TXT hash list: video checks are compared with signed workspace fingerprints, and TXT lists are compared with database SHA-256 values. TXT matches remain review-only because a text list alone does not prove ownership of a video.

Cloud records are queried by driver ID and video name. Public access and row-level policy settings depend on the linked Supabase project's configuration. Do not enter sensitive personal information as a driver ID.

## Dataset and evaluation

`evaluation/generate_test_dataset.py` deterministically creates authentic, temporal, transformed, and synthetic-other-trip cases. The generator includes beginning/end trims, extracted segments, shifts, changed playback speed/FPS, missing/duplicated/reordered frames, brightness/contrast, noise, crop, watermark, codec, bitrate, and resolution transformations when FFmpeg encoders are available. It creates an explicitly labeled synthetic other-trip clip when a second real source is not supplied, and a partially modified clip using that video.

Run the full sweep with:

```powershell
.\venv\Scripts\python.exe evaluation\generate_test_dataset.py
.\venv\Scripts\python.exe -m evaluation.run_evaluation
```

The generator rewrites standard generated filenames. Keep a copy of any custom dataset before regenerating. The runner writes `scenario_results.csv`, `threshold_results.csv`, `summary.csv`, and `confusion_matrix.csv` under `evaluation/results/`. Threshold sweeps record TP, TN, FP, FN, accuracy, precision, recall, specificity, F1, balanced accuracy, false-positive rate, and false-negative rate for all four perceptual hashes. The runner deterministically balances positive and negative frame pairs, then recommends thresholds by balanced accuracy and F1. It does not recommend a threshold if the best balanced accuracy is at or below chance (50%); the UI labels its fallback as provisional. These are dataset measurements, not production guarantees; results depend on the labeled clips, codecs, and sampling settings.

Optional fuzzy libraries such as ssdeep and TLSH are not required or currently used. L1, L2, cosine similarity, and cosine distance helpers are available for numeric frame descriptors; these do not replace cryptographic verification.

## Setup: Streamlit encoder and decoder

Requirements: Python 3.10 or newer, Git, a webcam-capable HTTPS browser for camera recording, and FFmpeg with `libx264`/`libx265` encoders to produce every optional codec scenario.

```powershell
git clone https://github.com/kunjasrujanasri-afk/Dashcam_Assurance_Project.git
cd Dashcam_Assurance_Project
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` locally and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` using the current Supabase project credentials. The admin page also reads those variables. Never commit `.env`; `.env.example` contains placeholders only.

```powershell
streamlit run app.py
```

Open the URL printed by Streamlit, select a driver ID, upload or record evidence, and choose **Fingerprint & Certify Evidence**. Verification, evaluation, evidence records, and administration are available from the sidebar.

If Supabase is offline or unconfigured, local fingerprinting and TXT export still work; transmissions remain queued and can be retried after recovery.

## Setup: Vercel browser app

The Next.js source is under `web/` and deploys from that root. Install Node.js 20 or newer, then:

```powershell
cd web
npm ci
npm run dev
```

Configure `SUPABASE_URL` and a publishable/anon key in the local Next/Vercel environment. Never use a service-role or secret key in browser-visible variables. Pushes to `main` trigger Vercel deployments.

The browser page requests camera/microphone access only after **Start dashcam** is chosen. It records WebM segments while the page is active, hashes and signs each segment, saves a local cache copy, then uploads the signed fingerprint and video to a private workspace. Background/locked-screen continuous dashcam recording is outside a browser page's reliable capabilities. The Streamlit capture workflow remains frame-based and keeps its original video local.

## Supabase and retention

The app expects a `public.fingerprints` table with `driver_id`, `frame_number`, `fingerprint`, `timestamp`, `video_name`, and `status` columns, plus an `id` and optionally `created_at`. The anon/publishable key must have the intended read/insert grants and RLS policies. Retention deletion targets only the selected expired record IDs in the Streamlit administration workflow.

The browser app requires Supabase Auth and uses workspace/device row-level policies. Captured WebM segments are stored in the private `evidence` bucket; its signing metadata and object path are indexed in workspace-scoped tables. Apply all SQL migrations before using camera capture or cloud verification. The public Vercel URL does not make Supabase evidence rows or objects public, but this coursework application has client-reported audit results and should not be represented as an insurer-certified system.

## Validation

Run local tests (they do not contact Supabase):

```powershell
.\venv\Scripts\python.exe -m unittest discover -s tests -v
```

Tests cover SHA-256 behavior, perceptual hashes and distances, bounded temporal shifts, threshold metrics, TXT parsing, SQLite queue durability/dedup/retry, dataset generation, and CSV outputs.

Run the Next.js production build:

```powershell
cd web
npm run build
```

`test_supabase.py` is a live integration script and may write a test row; run it only against an isolated test project.

## Reference-informed scope and remaining limits

The [CloudDash Integrity reference](https://github.com/asrieldev/clouddash-integrity) documents workspace evidence workflows. The Next.js app now has Supabase Auth and workspace scoping, ECDSA-signed chained capture sessions, an IndexedDB retry queue, private video storage, a live monitor, incident workflows, and an evaluation lab. The separate Streamlit prototype remains frame-hash based and does not use the browser app's device keys or private video storage. Verification and audit outcomes are client-reported; they are not server-attested.

Both capture interfaces require their page to stay open while recording; neither is an always-on native dashcam app. The browser keeps a local cache and also uploads captured segments to private Supabase storage when online. Streamlit TXT and SQLite evidence files are local artifacts and must be backed up separately.

## Security note

An earlier public Git commit included a `.env` file. It is ignored and not tracked in the current checkout, but removing it from the latest revision does not erase prior Git history. The repository owner must revoke/rotate any credential that appeared in that historic file and consider purging the exposed blob from Git history. This project is public-access coursework software; do not treat its public deployment as an authenticated evidence service.
