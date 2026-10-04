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


# =========================================================
# LOAD ENVIRONMENT VARIABLES
# =========================================================

load_dotenv(dotenv_path=ENV_FILE)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:

    st.error(
        "Supabase environment variables were not loaded."
    )

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
    page_title="Insurance Integrity Verification",
    page_icon="🔐",
    layout="wide"
)


# =========================================================
# SESSION VARIABLES
# =========================================================

if "verification_completed" not in st.session_state:
    st.session_state.verification_completed = False

if "verification_report" not in st.session_state:
    st.session_state.verification_report = ""

if "verified_count" not in st.session_state:
    st.session_state.verified_count = 0

if "corrupted_count" not in st.session_state:
    st.session_state.corrupted_count = 0

if "missing_count" not in st.session_state:
    st.session_state.missing_count = 0

if "checked_count" not in st.session_state:
    st.session_state.checked_count = 0

if "integrity_percentage" not in st.session_state:
    st.session_state.integrity_percentage = 0.0


# =========================================================
# TITLE
# =========================================================

st.title(
    "🔐 Insurance Integrity Verification"
)

st.subheader(
    "Certified Dashcam Evidence Verification System"
)


# =========================================================
# SYSTEM STATUS
# =========================================================

st.markdown(
    "### System Status"
)

col1, col2, col3 = st.columns(3)


with col1:

    st.success(
        "☁️\n\nCloud Database Connected"
    )


with col2:

    st.success(
        "🔐\n\nVerification Engine Ready"
    )


with col3:

    if VIDEO_PATH.exists():

        st.success(
            "🎥\n\nVideo Available"
        )

    else:

        st.error(
            "🎥\n\nVideo Not Available"
        )


# =========================================================
# SIDEBAR
# =========================================================

st.sidebar.header(
    "Verification Configuration"
)

driver_id = st.sidebar.text_input(
    "Driver ID",
    value="driver-01"
)

video_name = st.sidebar.text_input(
    "Video Name",
    value="dashcam_test.mp4"
)

st.sidebar.markdown("---")

st.sidebar.info(
    "Fingerprint Algorithm: SHA-256"
)


# =========================================================
# CERTIFIED VIDEO REPLAY
# =========================================================

st.markdown(
    "### 🎥 Certified Video Replay"
)

col1, col2 = st.columns(2)


with col1:

    st.write(
        "**Driver ID**"
    )

    st.write(
        driver_id
    )


with col2:

    st.write(
        "**Video Name**"
    )

    st.write(
        video_name
    )


st.write(
    "**Fingerprint Algorithm**"
)

st.write(
    "SHA-256"
)


if VIDEO_PATH.exists():

    try:

        with open(
            VIDEO_PATH,
            "rb"
        ) as video_file:

            video_bytes = video_file.read()

        st.video(
            video_bytes
        )

    except Exception as error:

        st.error(
            f"Unable to load video: {error}"
        )

else:

    st.warning(
        "Certified video file was not found."
    )


# =========================================================
# CLOUD EVIDENCE
# =========================================================

st.markdown(
    "### ☁️ Certified Cloud Evidence"
)

st.write(
    "The verification engine will retrieve the certified "
    "SHA-256 fingerprints stored in the cloud database."
)


# =========================================================
# VERIFICATION BUTTON
# =========================================================

st.markdown(
    "### 🔎 Integrity Verification"
)

st.write(
    "Compare every video frame against its certified "
    "cloud fingerprint."
)


verify_button = st.button(
    "🔎 Verify Video Integrity",
    type="primary",
    use_container_width=True
)


# =========================================================
# VERIFICATION PROCESS
# =========================================================

if verify_button:

    # -----------------------------------------------------
    # RESET RESULTS
    # -----------------------------------------------------

    st.session_state.verification_completed = False

    st.session_state.verified_count = 0

    st.session_state.corrupted_count = 0

    st.session_state.missing_count = 0

    st.session_state.checked_count = 0

    st.session_state.integrity_percentage = 0.0


    # -----------------------------------------------------
    # CHECK VIDEO
    # -----------------------------------------------------

    if not VIDEO_PATH.exists():

        st.error(
            "❌ Certified video file was not found."
        )

        st.stop()


    # -----------------------------------------------------
    # LOAD CLOUD RECORDS
    # -----------------------------------------------------

    with st.spinner(
        "☁️ Loading certified fingerprints from cloud..."
    ):

        cloud_records = []

        start = 0

        batch_size = 1000

        while True:

            end = start + batch_size - 1

            response = (
                supabase
                .table("fingerprints")
                .select("*")
                .eq("driver_id", driver_id)
                .eq("video_name", video_name)
                .range(start, end)
                .execute()
            )

            batch = response.data or []

            cloud_records.extend(
                batch
            )

            if len(batch) < batch_size:

                break

            start += batch_size


    # -----------------------------------------------------
    # CHECK CLOUD DATA
    # -----------------------------------------------------

    if not cloud_records:

        st.error(
            "❌ No certified fingerprints were found "
            "for this driver and video."
        )

        st.stop()


    st.success(
        f"☁️ {len(cloud_records):,} certified cloud "
        "records loaded."
    )


    # -----------------------------------------------------
    # CREATE FINGERPRINT LOOKUP
    # -----------------------------------------------------

    cloud_fingerprints = {}

    for record in cloud_records:

        frame_number = record.get(
            "frame_number"
        )

        fingerprint = record.get(
            "fingerprint"
        )

        if frame_number is not None and fingerprint:

            cloud_fingerprints[
                int(frame_number)
            ] = fingerprint


    # -----------------------------------------------------
    # OPEN VIDEO
    # -----------------------------------------------------

    cap = cv2.VideoCapture(
        str(VIDEO_PATH)
    )

    if not cap.isOpened():

        st.error(
            "❌ Unable to open the certified video."
        )

        st.stop()


    total_video_frames = int(
        cap.get(
            cv2.CAP_PROP_FRAME_COUNT
        )
    )


    # -----------------------------------------------------
    # VERIFICATION COUNTERS
    # -----------------------------------------------------

    checked = 0

    verified = 0

    corrupted = 0

    missing = 0

    corrupted_frames = []

    missing_frames = []


    # -----------------------------------------------------
    # PROGRESS
    # -----------------------------------------------------

    st.markdown(
        "### 🔄 Verification Progress"
    )

    progress = st.progress(0)

    status_text = st.empty()


    # -----------------------------------------------------
    # VERIFY EACH FRAME
    # -----------------------------------------------------

    frame_number = 0

    while True:

        success, frame = cap.read()

        if not success:

            break

        frame_number += 1

        checked += 1


        # -------------------------------------------------
        # GENERATE CURRENT FRAME HASH
        # -------------------------------------------------

        frame_bytes = frame.tobytes()

        current_fingerprint = hashlib.sha256(
            frame_bytes
        ).hexdigest()


        # -------------------------------------------------
        # GET CERTIFIED HASH
        # -------------------------------------------------

        certified_fingerprint = (
            cloud_fingerprints.get(
                frame_number
            )
        )


        # -------------------------------------------------
        # COMPARE
        # -------------------------------------------------

        if certified_fingerprint is None:

            missing += 1

            missing_frames.append(
                frame_number
            )

        elif current_fingerprint == certified_fingerprint:

            verified += 1

        else:

            corrupted += 1

            corrupted_frames.append(
                frame_number
            )


        # -------------------------------------------------
        # UPDATE PROGRESS
        # -------------------------------------------------

        if total_video_frames > 0:

            progress_value = min(
                frame_number / total_video_frames,
                1.0
            )

            progress.progress(
                progress_value
            )

        status_text.write(
            f"Checking frame {frame_number:,} "
            f"of {total_video_frames:,}..."
        )


    # =====================================================
    # RELEASE VIDEO
    # =====================================================

    cap.release()


    # =====================================================
    # CALCULATE INTEGRITY
    # =====================================================

    if checked > 0:

        integrity_percentage = (
            verified / checked
        ) * 100

    else:

        integrity_percentage = 0.0


    # =====================================================
    # SAVE SESSION RESULTS
    # =====================================================

    st.session_state.checked_count = checked

    st.session_state.verified_count = verified

    st.session_state.corrupted_count = corrupted

    st.session_state.missing_count = missing

    st.session_state.integrity_percentage = (
        integrity_percentage
    )

    st.session_state.verification_completed = True


    # =====================================================
    # VERIFICATION TIME
    # =====================================================

    verification_time = datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )


    # =====================================================
    # VERIFICATION STATUS
    # =====================================================

    if (
        corrupted == 0
        and
        missing == 0
        and
        verified == checked
    ):

        verification_status = "VERIFIED"

    else:

        verification_status = "INTEGRITY ISSUE DETECTED"


    # =====================================================
    # VERIFICATION REPORT
    # =====================================================

    report_lines = [

        "INSURANCE INTEGRITY VERIFICATION REPORT",

        "========================================",

        f"Verification Time: {verification_time}",

        f"Driver ID: {driver_id}",

        f"Video Name: {video_name}",

        "Fingerprint Algorithm: SHA-256",

        "",

        f"Frames Checked: {checked}",

        f"Verified Frames: {verified}",

        f"Corrupted Frames: {corrupted}",

        f"Missing Frames: {missing}",

        f"Integrity: {integrity_percentage:.2f}%",

        f"Status: {verification_status}",

        ""

    ]


    if corrupted_frames:

        report_lines.append(
            "Corrupted Frame Numbers:"
        )

        report_lines.append(
            ", ".join(
                str(number)
                for number in corrupted_frames
            )
        )

        report_lines.append("")


    if missing_frames:

        report_lines.append(
            "Missing Frame Numbers:"
        )

        report_lines.append(
            ", ".join(
                str(number)
                for number in missing_frames
            )
        )

        report_lines.append("")


    report_lines.append(
        "Verification completed successfully."
    )


    verification_report = "\n".join(
        report_lines
    )


    st.session_state.verification_report = (
        verification_report
    )


    # =====================================================
    # CLEAR PROGRESS MESSAGE
    # =====================================================

    status_text.empty()

    progress.progress(1.0)


    # =====================================================
    # FINAL STATUS
    # =====================================================

    if verification_status == "VERIFIED":

        st.success(
            "✅ VIDEO INTEGRITY VERIFIED"
        )

        st.success(
            "All video frames match the certified "
            "cloud fingerprints."
        )

    else:

        st.error(
            "⚠️ INTEGRITY ISSUE DETECTED"
        )


# =========================================================
# VERIFICATION RESULTS
# =========================================================

if st.session_state.verification_completed:

    st.markdown(
        "## 📋 Verification Report"
    )


    # -----------------------------------------------------
    # METRICS
    # -----------------------------------------------------

    col1, col2, col3, col4 = st.columns(4)


    with col1:

        st.metric(
            "Frames Checked",
            f"{st.session_state.checked_count:,}"
        )


    with col2:

        st.metric(
            "Verified",
            f"{st.session_state.verified_count:,}"
        )


    with col3:

        st.metric(
            "Corrupted",
            f"{st.session_state.corrupted_count:,}"
        )


    with col4:

        st.metric(
            "Missing",
            f"{st.session_state.missing_count:,}"
        )


    # -----------------------------------------------------
    # INTEGRITY SCORE
    # -----------------------------------------------------

    st.markdown(
        "### 🔐 Integrity Score"
    )

    st.progress(
        st.session_state.integrity_percentage / 100
    )

    st.write(
        f"**Integrity:** "
        f"{st.session_state.integrity_percentage:.2f}%"
    )


    # -----------------------------------------------------
    # STATUS
    # -----------------------------------------------------

    if (
        st.session_state.corrupted_count == 0
        and
        st.session_state.missing_count == 0
    ):

        st.success(
            "### ✅ VERIFIED"
        )

        st.write(
            "The certified video evidence is consistent "
            "with the fingerprints stored in the cloud."
        )

    else:

        st.error(
            "### ⚠️ INTEGRITY ISSUE DETECTED"
        )

        st.write(
            "One or more video frames do not match "
            "the certified cloud evidence."
        )


    # -----------------------------------------------------
    # JOURNAL
    # -----------------------------------------------------

    st.markdown(
        "### 📖 Verification Journal"
    )

    st.text_area(
        "Verification Log",
        value=st.session_state.verification_report,
        height=250
    )


    # -----------------------------------------------------
    # DOWNLOAD REPORT
    # -----------------------------------------------------

    st.download_button(
        label="📄 Download Verification Report",
        data=st.session_state.verification_report,
        file_name="insurance_verification_report.txt",
        mime="text/plain",
        use_container_width=True
    )