from pathlib import Path
import os

from dotenv import load_dotenv
from supabase import create_client


# Project folder
BASE_DIR = Path(__file__).resolve().parent

# Load .env
load_dotenv(BASE_DIR / ".env")


SUPABASE_URL = os.getenv("SUPABASE_URL")

# IMPORTANT:
# Add your Supabase Secret Key to .env as SUPABASE_SECRET_KEY
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")


print("SUPABASE URL:", SUPABASE_URL)
print("SECRET KEY FOUND:", bool(SUPABASE_SECRET_KEY))


if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    print("ERROR: Supabase URL or secret key was not loaded.")
    raise SystemExit


supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
)


test_record = {
    "driver_id": "python-test",
    "frame_number": 999999,
    "fingerprint": "python-test-fingerprint",
    "timestamp": "2026-09-24 12:00:00",
    "video_name": "python_test",
    "status": "sent"
}


try:

    response = (
        supabase
        .table("fingerprints")
        .insert(test_record)
        .execute()
    )

    print()
    print("SUCCESS!")
    print("Supabase response:")
    print(response)


except Exception as e:

    print()
    print("UPLOAD FAILED")
    print("ERROR:")
    print(e)