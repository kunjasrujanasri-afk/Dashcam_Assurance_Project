import os
import hashlib
from pathlib import Path
from datetime import datetime

import cv2
import streamlit as st
from dotenv import load_dotenv
from supabase import create_client


# =========================================================
# PROJECT PATHS
# =========================================================

BASE_DIR = Path(__file__).resolve().parent.parent

ENV_FILE = BASE_DIR / ".env"

VIDEO_PATH = BASE_DIR / "videos" / "dashcam_test.mp4"

TXT_PATH = BASE_DIR / "database" / "fingerprints.txt"


# =========================================================
# LOAD ENVIRONMENT VARIABLES
# =========================================================

load_dotenv(dotenv_path=ENV_FILE)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    st.error("Supabase environment variables were not loaded.")
    st.stop()


# =========================================================
# SUPABASE CONNECTION
# =========================================================

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
)


# =========================================================
# PAGE CONFIGURATION
# =========================================================

st.set_page_config(
    page_title="Dashcam Assurance",
    page_icon="🚗",
    layout="wide"
)


# =========================================================
# TITLE
# =========================================================

st.title("🚗 Dashcam Assurance")

st.subheader(
    "Video Evidence Collection System"
)


# =========================================================
# SUPABASE STATUS
# =========================================================

st.success(
    "☁️ Supabase cloud database connected"
)


# =========================================================
# SESSION VARIABLES
# =========================================================

if "recording" not in st.session_state:
    st.session_state.recording = False

if "frames" not in st.session_state:
    st.session_state.frames = 0

if "hashes_sent" not in st.session_state:
    st.session_state.hashes_sent = 0

if "offline_pending" not in st.session_state:
    st.session_state.offline_pending = 0

if "pending_records" not in st.session_state:
    st.session_state.pending_records = []

if "total_attempted" not in st.session_state:
    st.session_state.total_attempted = 0

if "retry_successful" not in st.session_state:
    st.session_state.retry_successful = 0

if "retry_failed" not in st.session_state:
    st.session_state.retry_failed = 0


# =========================================================
# SIDEBAR CONFIGURATION
# =========================================================

st.sidebar.header("Configuration")

driver_id = st.sidebar.text_input(
    "Driver ID",
    value="driver-01"
)

st.sidebar.markdown("---")

st.sidebar.markdown("### 📡 Network Simulation")

simulate_network = st.sidebar.checkbox(
    "Simulate Network Interruption",
    value=False
)

if simulate_network:
    st.sidebar.warning(
        "Network interruption simulation is enabled."
    )
else:
    st.sidebar.success(
        "Network connection is operating normally."
    )


# =========================================================
# START / STOP RECORDING
# =========================================================

col1, col2 = st.columns(2)

with col1:

    if st.button("▶️ Start Recording"):

        st.session_state.recording = True


with col2:

    if st.button("⏹️ Stop Recording"):

        st.session_state.recording = False


# =========================================================
# RECORDING STATUS
# =========================================================

if st.session_state.recording:

    st.success(
        "🟢 Recording in progress"
    )

else:

    st.info(
        "⚪ Recording stopped"
    )


# =========================================================
# COLLECTION STATUS
# =========================================================

st.markdown("### 📊 Collection Status")

col1, col2, col3, col4 = st.columns(4)

with col1:

    st.metric(
        "Frames Captured",
        st.session_state.frames
    )

with col2:

    st.metric(
        "Hashes Sent",
        st.session_state.hashes_sent
    )

with col3:

    st.metric(
        "Offline Pending",
        st.session_state.offline_pending
    )

with col4:

    if simulate_network:

        st.metric(
            "Network Status",
            "🔴 Interrupted"
        )

    elif st.session_state.recording:

        st.metric(
            "Network Status",
            "🟢 Online"
        )

    else:

        st.metric(
            "Network Status",
            "⚪ Inactive"
        )


# =========================================================
# VIDEO PREVIEW
# =========================================================

st.markdown("### 🎥 Dashcam Preview")

try:

    with open(
        VIDEO_PATH,
        "rb"
    ) as video_file:

        video_bytes = video_file.read()

    st.video(
        video_bytes
    )

    st.success(
        "✅ Dashcam video ready"
    )

except FileNotFoundError:

    st.warning(
        "⚠️ Dashcam video was not found."
    )


# =========================================================
# INFORMATION
# =========================================================

st.markdown("### ℹ️ Information")

st.write(
    f"**Driver ID:** {driver_id}"
)

st.write(
    "**Mode:** Video Evidence Collection"
)

st.write(
    "**Fingerprint Algorithm:** SHA-256"
)

st.write(
    "**Storage:** Supabase Cloud Database"
)

st.write(
    "**Transmission:** Progressive frame-by-frame upload"
)


# =========================================================
# FINGERPRINT GENERATION
# =========================================================

st.markdown("### 🔐 Fingerprint Generation")

if st.button(
    "🔍 Analyze Video and Generate Fingerprints"
):

    # -----------------------------------------------------
    # RESET COUNTERS
    # -----------------------------------------------------

    st.session_state.frames = 0

    st.session_state.hashes_sent = 0

    st.session_state.offline_pending = 0

    st.session_state.pending_records = []

    st.session_state.total_attempted = 0

    st.session_state.retry_successful = 0

    st.session_state.retry_failed = 0


    # -----------------------------------------------------
    # OPEN VIDEO
    # -----------------------------------------------------

    cap = cv2.VideoCapture(
        str(VIDEO_PATH)
    )

    if not cap.isOpened():

        st.error(
            "❌ Unable to open the video."
        )

        st.stop()


    # -----------------------------------------------------
    # VIDEO INFORMATION
    # -----------------------------------------------------

    total_frames = int(
        cap.get(
            cv2.CAP_PROP_FRAME_COUNT
        )
    )

    fps = cap.get(
        cv2.CAP_PROP_FPS
    )

    if fps <= 0:

        fps = 20

    duration = (
        total_frames / fps
    )


    # -----------------------------------------------------
    # LOCAL FINGERPRINT STORAGE
    # -----------------------------------------------------

    fingerprints = []

    frame_number = 0


    # -----------------------------------------------------
    # PROGRESS BAR
    # -----------------------------------------------------

    progress = st.progress(0)


    # -----------------------------------------------------
    # PROCESS EACH FRAME
    # -----------------------------------------------------

    while True:

        success, frame = cap.read()

        if not success:

            break

        frame_number += 1


        # -------------------------------------------------
        # CONVERT FRAME TO BYTES
        # -------------------------------------------------

        frame_bytes = frame.tobytes()


        # -------------------------------------------------
        # GENERATE SHA-256 FINGERPRINT
        # -------------------------------------------------

        fingerprint = hashlib.sha256(
            frame_bytes
        ).hexdigest()


        # -------------------------------------------------
        # GENERATE TIMESTAMP
        # -------------------------------------------------

        timestamp = datetime.now().strftime(
            "%Y-%m-%d %H:%M:%S"
        )


        # -------------------------------------------------
        # STORE LOCAL RECORD
        # -------------------------------------------------

        local_record = {

            "frame": frame_number,

            "fingerprint": fingerprint,

            "timestamp": timestamp

        }

        fingerprints.append(
            local_record
        )


        # -------------------------------------------------
        # CLOUD RECORD
        # -------------------------------------------------

        cloud_record = {

            "driver_id": driver_id,

            "frame_number": frame_number,

            "fingerprint": fingerprint,

            "timestamp": timestamp,

            "video_name": "dashcam_test.mp4",

            "status": "sent"

        }


        st.session_state.total_attempted += 1


        # -------------------------------------------------
        # NETWORK INTERRUPTION SIMULATION
        # -------------------------------------------------

        if simulate_network:

            pending_record = {

                "driver_id": driver_id,

                "frame_number": frame_number,

                "fingerprint": fingerprint,

                "timestamp": timestamp,

                "video_name": "dashcam_test.mp4",

                "status": "pending"

            }

            st.session_state.pending_records.append(
                pending_record
            )

            st.session_state.offline_pending = len(
                st.session_state.pending_records
            )

        else:

            # -------------------------------------------------
            # SEND TO SUPABASE
            # -------------------------------------------------

            try:

                supabase.table(
                    "fingerprints"
                ).insert(
                    cloud_record
                ).execute()

                st.session_state.hashes_sent += 1

            except Exception:

                pending_record = {

                    "driver_id": driver_id,

                    "frame_number": frame_number,

                    "fingerprint": fingerprint,

                    "timestamp": timestamp,

                    "video_name": "dashcam_test.mp4",

                    "status": "pending"

                }

                st.session_state.pending_records.append(
                    pending_record
                )

                st.session_state.offline_pending = len(
                    st.session_state.pending_records
                )


        # -------------------------------------------------
        # UPDATE PROGRESS
        # -------------------------------------------------

        progress.progress(
            min(
                frame_number / total_frames,
                1.0
            )
        )


    # =====================================================
    # RELEASE VIDEO
    # =====================================================

    cap.release()


    # =====================================================
    # SAVE FINGERPRINTS TO TXT
    # =====================================================

    TXT_PATH.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    with open(
        TXT_PATH,
        "w"
    ) as txt_file:

        for record in fingerprints:

            txt_file.write(
                record["fingerprint"]
                + "\n"
            )


    # =====================================================
    # UPDATE FRAME COUNT
    # =====================================================

    st.session_state.frames = len(
        fingerprints
    )


    # =====================================================
    # FINAL RESULT
    # =====================================================

    st.success(
        "✅ Video analysis completed successfully."
    )

    st.write(
        f"**Frames analyzed:** "
        f"{len(fingerprints)}"
    )

    st.write(
        f"**FPS:** "
        f"{fps:.2f}"
    )

    st.write(
        f"**Duration:** "
        f"{duration:.2f} seconds"
    )

    st.write(
        f"**SHA-256 fingerprints generated:** "
        f"{len(fingerprints)}"
    )


    # =====================================================
    # CLOUD UPLOAD STATUS
    # =====================================================

    st.markdown(
        "### ☁️ Cloud Upload Status"
    )

    st.write(
        f"**Hashes successfully sent:** "
        f"{st.session_state.hashes_sent}"
    )

    st.write(
        f"**Pending uploads:** "
        f"{st.session_state.offline_pending}"
    )


    # =====================================================
    # TRANSMISSION STATUS
    # =====================================================

    if st.session_state.offline_pending == 0:

        st.success(
            "✅ All fingerprints were successfully transmitted to the cloud."
        )

    else:

        st.warning(
            f"⚠️ {st.session_state.offline_pending} "
            "fingerprints are waiting for transmission."
        )


    # =====================================================
    # LOCAL STORAGE STATUS
    # =====================================================

    st.success(
        "✅ Fingerprints saved to "
        "database/fingerprints.txt"
    )


    # =====================================================
    # EXAMPLE FINGERPRINT
    # =====================================================

    if fingerprints:

        st.markdown(
            "#### Example Fingerprint Record"
        )

        first_record = fingerprints[0]

        st.write(
            f"**Frame:** "
            f"{first_record['frame']}"
        )

        st.write(
            f"**Fingerprint:** "
            f"{first_record['fingerprint']}"
        )

        st.write(
            f"**Timestamp:** "
            f"{first_record['timestamp']}"
        )


# =========================================================
# PENDING TRANSMISSION RECOVERY
# =========================================================

st.markdown(
    "### 🔄 Pending Transmission Recovery"
)

if st.session_state.offline_pending > 0:

    st.warning(
        f"{st.session_state.offline_pending} "
        "fingerprints are currently waiting for transmission."
    )

    if st.button(
        "🔄 Restore Network and Retry Pending Uploads"
    ):

        remaining_records = []

        retry_success = 0

        retry_failed = 0


        for record in st.session_state.pending_records:

            try:

                retry_record = record.copy()

                retry_record["status"] = "sent"


                supabase.table(
                    "fingerprints"
                ).insert(
                    retry_record
                ).execute()


                retry_success += 1

                st.session_state.hashes_sent += 1


            except Exception:

                remaining_records.append(
                    record
                )

                retry_failed += 1


        st.session_state.pending_records = (
            remaining_records
        )

        st.session_state.offline_pending = (
            len(remaining_records)
        )

        st.session_state.retry_successful += (
            retry_success
        )

        st.session_state.retry_failed += (
            retry_failed
        )


        if retry_success > 0:

            st.success(
                f"✅ {retry_success} pending fingerprints "
                "were successfully transmitted."
            )


        if retry_failed > 0:

            st.error(
                f"❌ {retry_failed} fingerprints "
                "could not be transmitted."
            )


        if st.session_state.offline_pending == 0:

            st.success(
                "🎉 All pending fingerprints have been transmitted successfully."
            )

else:

    st.info(
        "No pending fingerprints. Transmission queue is empty."
    )


# =========================================================
# TRANSMISSION SUMMARY
# =========================================================

st.markdown(
    "### 📡 Transmission Summary"
)

col1, col2, col3, col4 = st.columns(4)

with col1:

    st.metric(
        "Frames",
        st.session_state.frames
    )

with col2:

    st.metric(
        "Successfully Sent",
        st.session_state.hashes_sent
    )

with col3:

    st.metric(
        "Currently Pending",
        st.session_state.offline_pending
    )

with col4:

    if st.session_state.offline_pending == 0:

        st.metric(
            "Final Status",
            "✅ Complete"
        )

    else:

        st.metric(
            "Final Status",
            "⚠️ Pending"
        )


# =========================================================
# RETRY STATISTICS
# =========================================================

if (
    st.session_state.retry_successful > 0
    or
    st.session_state.retry_failed > 0
):

    st.markdown(
        "### 🔁 Recovery Statistics"
    )

    col1, col2 = st.columns(2)

    with col1:

        st.metric(
            "Successful Retries",
            st.session_state.retry_successful
        )

    with col2:

        st.metric(
            "Failed Retries",
            st.session_state.retry_failed
        )