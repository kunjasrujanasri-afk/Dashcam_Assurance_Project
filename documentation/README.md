# Dashcam Assurance

Dashcam Assurance is a coursework prototype with two interfaces:

- **Encoder and transmitter:** the Streamlit application (`app.py`) captures a video from upload or browser camera, creates a SHA-256 digest for each decoded frame, writes local TXT evidence, and progressively sends fingerprint batches to Supabase.
- **Decoder and evaluation lab:** the same application verifies frame digests against cloud or local TXT evidence, reports exact mismatches and sequence anomalies, compares perceptual hashes for temporal alignment, and runs reproducible evaluation scenarios.
- **Browser capture demo:** `web/` contains the Next.js camera capture and Supabase viewer deployed to Vercel. It is a separate demonstration UI and does not replace the Streamlit encoder/decoder.

## Architecture and integrity model

OpenCV decodes video frames. `hashlib.sha256(frame.tobytes())` creates an exact byte-level digest of each decoded frame. Records carry the one-based frame number, timestamp, driver ID, video name, status, and digest. The Streamlit transmitter does not send the original video; it remains in the local `videos/` directory.

SHA-256 answers whether decoded frame bytes match a trusted record. It does not identify what visual edit occurred, and re-encoding generally changes frame bytes. The Evaluation Lab therefore uses separate aHash, dHash, pHash, and wHash algorithms with Hamming and normalized Hamming distances for visual similarity. Similarity is exploratory evidence; it never upgrades a failed SHA-256 check to `VERIFIED`.

`decoder/integrity.py` classifies exact matches, modified/corrupt frames, repeated digests, known digests found at a different reference position, absent reference positions, and leading/trailing trims. Perceptual temporal matching is available in the Evaluation Lab and reports frame offset, seconds, matched interval, and confidence.

## Encoder, transmission, and offline recovery

The Streamlit encoder handles uploaded files and WebRTC camera recordings while the page is open. It samples decoded frames, saves one-hash-per-line TXT files (`database/fingerprints.txt` and a video-specific file), and writes accompanying frame metadata to JSON sidecars.

New fingerprints enter `database/transmission_queue.sqlite3` in batches while frame processing continues. SQLite uses a unique driver/video/frame identity, so duplicate enqueues are ignored. Failed Supabase reads or writes leave records on disk. The Capture page reports queue size and offers retry. On retry, the app checks existing cloud frame numbers before inserting queued records. Delivery is at-least-once with cloud-read deduplication, not a server-attested exactly-once protocol.

The Streamlit queue is on the application host. The deployed browser capture page does not share this SQLite queue; browser users need a network connection when its fingerprint request is sent.

## Decoder and evidence sources

Open **Insurance Verification**, choose **Supabase** or **Local TXT**, and select the evidence video. TXT files accept one 64-character SHA-256 digest per line and legacy `frame | hash | timestamp` records. Verification reports the selected source and can download a text report.

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

The browser page requests camera/microphone access only after **Start camera** is chosen. It records a WebM file in the active page, then locally samples and hashes it. Background/locked-screen continuous dashcam recording is outside a browser page's reliable capabilities.

## Supabase and retention

The app expects a `public.fingerprints` table with `driver_id`, `frame_number`, `fingerprint`, `timestamp`, `video_name`, and `status` columns, plus an `id` and optionally `created_at`. The anon/publishable key must have the intended read/insert grants and RLS policies. Retention deletion targets only the selected expired record IDs in the Streamlit administration workflow.

Use a dedicated Supabase project for assessment. The deployed browser demo is public and its anonymous policies may allow visitors to submit or query data; do not use it for real insurance evidence or personal data.

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

The [CloudDash Integrity reference](https://github.com/asrieldev/clouddash-integrity) documents Supabase Auth and workspace roles, signed device metadata, chained capture sessions, IndexedDB persistence, private incident-video storage, and an authenticated insurer monitor. This repository has a Streamlit capture/decoder prototype, Supabase fingerprint storage, a local SQLite retry queue, a separate public Vercel camera demo, and reproducible local evaluation. It does **not** yet provide the reference's authentication/workspace model, device ECDSA signatures/hash chain, private incident-video locking/storage, realtime monitor, or server-attested audit history. Those features require schema, access-control, and device-key changes and are not represented as implemented.

The Streamlit camera works while its page is open; it is not an always-on native dashcam app. A demonstration video still needs to be recorded from the running application. TXT and SQLite evidence files are local artifacts and must be backed up separately.

## Security note

An earlier public Git commit included a `.env` file. It is ignored and not tracked in the current checkout, but removing it from the latest revision does not erase prior Git history. The repository owner must revoke/rotate any credential that appeared in that historic file and consider purging the exposed blob from Git history. This project is public-access coursework software; do not treat its public deployment as an authenticated evidence service.
