# Legacy Python prototype

The deployed Dashcam Assurance application is the Next.js project in `web/`. Read the [current code walkthrough](../README.md), [web guide](../web/README.md), and [setup instructions](../web/docs/SETUP.md) for that application.

The root Python code is a separate, earlier frame-based prototype. It is not imported by the Next.js application or included in its Vercel build.

## Prototype code map

| File or folder | Purpose |
| --- | --- |
| `app.py` | Streamlit capture, verification, and evaluation interface. |
| `encoder/` | Decode frames and generate SHA-256 frame fingerprints. |
| `decoder/` | Compare frame fingerprints with local or cloud records. |
| `database/evidence_store.py` | Local TXT evidence and SQLite transmission queue. |
| `evaluation/` | Generate video transformations and evaluate perceptual similarity. |
| `tests/test_core.py` | Tests for the Python prototype. |
| `requirements.txt` | Python dependencies only. |

Unlike the current app's signed, chained **segment-file** hashes, this prototype hashes **decoded frame** bytes. These protocols and database tables are different.

## Running the prototype separately

Use Python 3.10 or newer. From the repository root:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
streamlit run app.py
```

Local fingerprinting works without Supabase. Optional cloud transmission expects an older `public.fingerprints` table and reads `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the root `.env`. Use a separate backend for this prototype; the current Next.js schema does not create that table. Keep credentials local and out of Git.

Run its tests with:

```powershell
python -m unittest discover -s tests -v
```

`test_supabase.py` is a live integration script that may write a test row; it is not part of the current web application's checks.

## Removed web implementation

The old Next.js `web/app/` and `web/lib/` implementation has been replaced by `web/src/`. Its root Supabase migrations were removed because they defined an incompatible workspace-based `devices` table. The current backend is defined solely by `web/supabase/schema.sql`. Previous code and migrations remain recoverable from Git history.
