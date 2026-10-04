import os
import cv2
import time
import hashlib
import threading
import pandas as pd
from pathlib import Path
from datetime import datetime, timedelta

import streamlit as st
from dotenv import load_dotenv
from supabase import create_client

from aiortc.contrib.media import MediaRecorder
from streamlit_webrtc import (
    WebRtcMode,
    webrtc_streamer,
)
from evaluation.evaluation_engine import (
    match_video_frames,
    find_best_temporal_match,
    classify_similarity,
    create_trimmed_video,
    ahash,
    dhash,
    phash,
    whash,
)


# ============================================================
# PROJECT PATHS
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

VIDEO_DIR = BASE_DIR / "videos"
DATABASE_DIR = BASE_DIR / "database"
ASSETS_DIR = BASE_DIR / "assets"

VIDEO_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_DIR.mkdir(parents=True, exist_ok=True)
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================
# PAGE CONFIGURATION
# ============================================================

st.set_page_config(
    page_title="Dashcam Assurance ",
    page_icon=str(ASSETS_DIR / "dashcam_assurance_olive_cream.svg"),
    layout="wide",
    initial_sidebar_state="expanded",
)


# ============================================================
# PROJECT PATHS
# ============================================================

# No default evidence is selected automatically.
LOCAL_FINGERPRINT_FILE = DATABASE_DIR / "fingerprints.txt"


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv(BASE_DIR / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SECRET_KEY")


# ============================================================
# SUPABASE
# ============================================================

@st.cache_resource
def get_supabase():

    if not SUPABASE_URL or not SUPABASE_KEY:
        return None

    try:
        return create_client(
            SUPABASE_URL,
            SUPABASE_KEY,
        )

    except Exception:
        return None


supabase = get_supabase()


# ============================================================
# CUSTOM FRONTEND STYLE
# ============================================================

st.markdown(
    """
    <style>
    :root {
        --ink: #27321f;
        --muted: #66705a;
        --muted-2: #858c76;
        --line: #dedfcf;
        --surface: #fffdf5;
        --surface-2: #f3f0df;
        --navy: #34452a;
        --navy-2: #4d6035;
        --blue: #66783c;
        --blue-2: #87984d;
        --cyan: #a2ad67;
        --green: #16a34a;
        --amber: #d97706;
        --red: #dc2626;
        --shadow: 0 10px 30px rgba(15, 23, 42, .07);
        --shadow-lg: 0 18px 45px rgba(15, 23, 42, .10);
    }

    /* ---------- APP CANVAS ---------- */
    .stApp,
    [data-testid="stAppViewContainer"],
    [data-testid="stAppViewContainer"] > .main {
        background: #f5f0df !important;
    }

    [data-testid="stHeader"] {
        background: rgba(250,248,239,.94) !important;
    }

    [data-testid="stMainBlockContainer"] {
        padding-top: 2.1rem !important;
        padding-bottom: 3rem !important;
        max-width: 1500px !important;
    }

    /* Force readable typography even when the browser/Streamlit theme is dark. */
    .stApp, .stApp p, .stApp label, .stApp span,
    .stApp h1, .stApp h2, .stApp h3, .stApp h4,
    .stApp [data-testid="stMetricLabel"],
    .stApp [data-testid="stMetricValue"] {
        color: var(--ink);
    }

    .stMarkdown, .stCaption, .stText, .stRadio, .stSelectbox,
    .stTextInput, .stNumberInput {
        color: var(--ink);
    }

    hr {
        border: 0 !important;
        border-top: 1px solid var(--line) !important;
        margin: 1.6rem 0 !important;
    }

    /* ---------- SIDEBAR ---------- */
    section[data-testid="stSidebar"] {
        background: linear-gradient(180deg, #24311c 0%, #34452a 58%, #293820 100%) !important;
        border-right: 1px solid rgba(255,255,255,.07);
    }

    section[data-testid="stSidebar"] * {
        color: #e8eef5 !important;
    }

    section[data-testid="stSidebar"] .stRadio label {
        border-radius: 10px;
        padding: 9px 11px;
        margin: 2px 0;
        transition: all .15s ease;
    }

    section[data-testid="stSidebar"] .stRadio label:hover {
        background: rgba(255,255,255,.07);
    }

    section[data-testid="stSidebar"] [data-testid="stWidgetLabel"] p {
        color: #a4af95 !important;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .12em;
        text-transform: uppercase;
    }

    .brand-block {
        padding: 8px 4px 20px;
    }

    .brand-mark {
        width: 54px;
        height: 54px;
        border-radius: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #2f4026;
        border: 1px solid rgba(147,197,253,.20);
        box-shadow: 0 12px 28px rgba(0,0,0,.22), 0 0 0 1px rgba(37,99,235,.08);
        margin-bottom: 14px;
        overflow: hidden;
    }

    .brand-mark svg {
        width: 54px;
        height: 54px;
        display: block;
    }

    .brand-name {
        color: #ffffff !important;
        font-size: 20px;
        font-weight: 800;
        letter-spacing: -.02em;
    }

    .brand-sub {
        color: #a5b095 !important;
        font-size: 11px;
        margin-top: 4px;
        letter-spacing: .02em;
    }

    .sidebar-driver {
        border: 1px solid rgba(255,255,255,.09);
        background: rgba(255,255,255,.045);
        border-radius: 13px;
        padding: 14px;
        margin: 8px 0 14px;
    }

    .sidebar-driver-label {
        color: #9eab8f !important;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: .12em;
        font-weight: 800;
    }

    .sidebar-driver-value {
        color: #ffffff !important;
        font-size: 16px;
        font-weight: 750;
        margin-top: 5px;
        word-break: break-word;
    }

    .sidebar-status {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #c6cfb8 !important;
        font-size: 12px;
        margin-top: 7px;
    }

    .dot-green { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.12); }
    .dot-blue { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 0 4px rgba(56,189,248,.12); }
    .dot-gray { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }

    .sidebar-cloud {
        border: 1px solid rgba(34,197,94,.18);
        background: rgba(34,197,94,.06);
        border-radius: 11px;
        padding: 11px 12px;
        margin-top: 8px;
    }

    .sidebar-cloud-title {
        color: #aab69a !important;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: .1em;
        font-weight: 800;
    }

    .sidebar-cloud-value {
        color: #86efac !important;
        font-size: 13px;
        font-weight: 750;
        margin-top: 4px;
    }

    /* ---------- PAGE HEADER ---------- */
    .page-kicker {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 6px 10px;
        border: 1px solid #d9dfd0;
        background: #ece7d0;
        color: #596b32 !important;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 850;
        letter-spacing: .12em;
        text-transform: uppercase;
        margin-bottom: 12px;
    }

    .hero-title {
        color: var(--ink) !important;
        font-size: 38px;
        line-height: 1.05;
        font-weight: 850;
        letter-spacing: -.045em;
        margin-bottom: 8px;
    }

    .hero-subtitle {
        color: var(--muted) !important;
        font-size: 15px;
        line-height: 1.55;
        margin-bottom: 22px;
        max-width: 850px;
    }

    .hero-panel {
        position: relative;
        overflow: hidden;
        padding: 28px 30px;
        border-radius: 20px;
        background: linear-gradient(135deg, #2b3b22 0%, #526638 100%);
        box-shadow: var(--shadow-lg);
        margin-bottom: 24px;
    }

    .hero-panel:after {
        content: "";
        position: absolute;
        width: 260px;
        height: 260px;
        border-radius: 50%;
        right: -80px;
        top: -120px;
        background: radial-gradient(circle, rgba(56,189,248,.22), transparent 68%);
    }

    .hero-panel * { position: relative; z-index: 1; }
    .hero-panel .page-kicker { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.13); color: #bdcc91 !important; }
    .hero-panel .hero-title { color: #ffffff !important; }
    .hero-panel .hero-subtitle { color: #c5cdb7 !important; margin-bottom: 0; }

    /* ---------- SECTION HEADERS ---------- */
    .section-title {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--ink) !important;
        font-size: 20px;
        font-weight: 800;
        letter-spacing: -.02em;
        margin: 5px 0 13px;
    }

    .section-title-bar {
        width: 4px;
        height: 22px;
        border-radius: 999px;
        background: linear-gradient(180deg, #66783c, #a2ad67);
    }

    /* ---------- STATUS CARDS ---------- */
    .status-card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 18px 19px;
        min-height: 112px;
        box-shadow: var(--shadow);
        position: relative;
        overflow: hidden;
    }

    .status-card:before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: #66783c;
    }

    .status-card.green:before { background: #16a34a; }
    .status-card.cyan:before { background: #91a85a; }
    .status-card.amber:before { background: #d97706; }

    .status-label {
        color: #7a8797 !important;
        font-size: 10px;
        font-weight: 850;
        letter-spacing: .1em;
        text-transform: uppercase;
    }

    .status-value {
        color: #1d2719 !important;
        font-size: 20px;
        font-weight: 800;
        letter-spacing: -.025em;
        margin-top: 9px;
    }

    .status-meta {
        color: #78816f !important;
        font-size: 11px;
        margin-top: 6px;
    }

    .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        margin-top: 7px;
    }

    .pill-green { background: #ecfdf3; color: #15803d !important; }
    .pill-blue { background: #ece7d0; color: #596b32 !important; }
    .pill-gray { background: #f0eee2; color: #64748b !important; }

    /* ---------- METRIC CARDS ---------- */
    .metric-card {
        background: #fffdf5;
        border: 1px solid var(--line);
        border-radius: 15px;
        padding: 17px 18px;
        box-shadow: 0 5px 20px rgba(15,23,42,.045);
    }

    .metric-label {
        color: #727b69 !important;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .1em;
    }

    .metric-value {
        color: #1d2719 !important;
        font-size: 26px;
        font-weight: 820;
        margin-top: 7px;
        letter-spacing: -.035em;
    }

    .metric-detail {
        color: #7d866f !important;
        font-size: 11px;
        margin-top: 4px;
    }

    /* ---------- EVIDENCE / WORKFLOW CARDS ---------- */
    .evidence-card {
        background: #fffdf5;
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 22px;
        box-shadow: var(--shadow);
    }

    .evidence-name {
        color: #1d2719 !important;
        font-size: 17px;
        font-weight: 800;
        word-break: break-word;
    }

    .evidence-path {
        color: #727b69 !important;
        font-size: 11px;
        margin-top: 5px;
        word-break: break-all;
    }

    .workflow-card {
        background: #fffdf5;
        border: 1px solid var(--line);
        border-radius: 17px;
        padding: 21px;
        min-height: 180px;
        box-shadow: var(--shadow);
    }

    .workflow-number {
        width: 31px;
        height: 31px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ece7d0;
        color: #71853d !important;
        font-weight: 850;
        font-size: 12px;
    }

    .workflow-title {
        color: #1d2719 !important;
        font-size: 16px;
        font-weight: 800;
        margin-top: 17px;
    }

    .workflow-text {
        color: #6f7867 !important;
        font-size: 12px;
        line-height: 1.6;
        margin-top: 7px;
    }

    /* ---------- DRIVER / SECURITY PANEL ---------- */
    .driver-panel {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 17px 19px;
        background: #fffdf5;
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: var(--shadow);
    }

    .driver-label {
        color: #727b69 !important;
        font-size: 10px;
        font-weight: 850;
        text-transform: uppercase;
        letter-spacing: .1em;
    }

    .driver-value {
        color: #1d2719 !important;
        font-size: 17px;
        font-weight: 800;
        margin-top: 4px;
    }

    .driver-state {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 10px;
        border-radius: 9px;
        background: #ecfdf3;
        color: #15803d !important;
        font-size: 11px;
        font-weight: 800;
    }

    /* ---------- CALLOUTS ---------- */
    .callout {
        border-radius: 13px;
        padding: 12px 14px;
        border: 1px solid #dbe5ef;
        background: #f8f9f5;
        color: #58634e !important;
        font-size: 12px;
        line-height: 1.5;
    }

    .callout.success { background: #f0fdf4; border-color: #bbf7d0; color: #166534 !important; }
    .callout.info { background: #ece7d0; border-color: #cbd7b2; color: #4e5e29 !important; }
    .callout.warning { background: #fffbeb; border-color: #fde68a; color: #92400e !important; }
    .callout.danger { background: #fef2f2; border-color: #fecaca; color: #991b1b !important; }

    /* ---------- STREAMLIT WIDGETS ---------- */
    .stButton > button {
        border-radius: 10px !important;
        border: 1px solid #d8e0e9 !important;
        background: #ffffff !important;
        color: #1d2719 !important;
        font-weight: 750 !important;
        min-height: 42px;
        box-shadow: 0 3px 10px rgba(15,23,42,.04);
        transition: all .15s ease;
    }

    .stButton > button:hover {
        border-color: #bdcc91 !important;
        color: #596b32 !important;
        transform: translateY(-1px);
        box-shadow: 0 7px 18px rgba(37,99,235,.10);
    }

    .stButton > button[kind="primary"] {
        background: linear-gradient(135deg, #71853d, #5f7131) !important;
        color: #ffffff !important;
        border: 0 !important;
    }

    .stTextInput input, .stNumberInput input,
    .stSelectbox div[data-baseweb="select"] > div {
        border-radius: 10px !important;
        border-color: #d9dfd0 !important;
        background: #ffffff !important;
        color: #1d2719 !important;
    }

    .stTextInput input:focus, .stNumberInput input:focus {
        border-color: #60a5fa !important;
        box-shadow: 0 0 0 3px rgba(37,99,235,.10) !important;
    }

    [data-testid="stFileUploaderDropzone"] {
        border: 1px dashed #b8c7d8 !important;
        background: #fafbf8 !important;
        border-radius: 14px !important;
        padding: 18px !important;
        min-height: 112px;
    }

    [data-testid="stFileUploaderDropzone"] button {
        background: linear-gradient(135deg, #71853d, #5f7131) !important;
        color: #ffffff !important;
        border: 0 !important;
        border-radius: 10px !important;
        min-height: 42px !important;
        padding: 0 18px !important;
        font-weight: 800 !important;
        box-shadow: 0 8px 18px rgba(37,99,235,.18) !important;
    }

    [data-testid="stFileUploaderDropzone"] button:hover {
        background: linear-gradient(135deg, #5f7131, #4e5e29) !important;
        color: #ffffff !important;
    }

    [data-testid="stFileUploaderDropzone"] button *,
    [data-testid="stFileUploaderDropzone"] button span,
    [data-testid="stFileUploaderDropzone"] button svg {
        color: #ffffff !important;
        fill: #ffffff !important;
        stroke: #ffffff !important;
    }

    [data-testid="stFileUploaderDropzone"] > div {
        color: #38422f !important;
    }

    [data-testid="stFileUploaderDropzone"] small {
        color: #68725f !important;
    }

    [data-testid="stFileUploaderDropzone"] section {
        color: #38422f !important;
    }

    .upload-panel {
        background: #fffdf5;
        border: 1px solid #dde2d7;
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 8px 25px rgba(15,23,42,.05);
    }

    .upload-heading {
        color: #1d2719 !important;
        font-size: 16px;
        font-weight: 800;
        margin-bottom: 4px;
    }

    .upload-description {
        color: #727b69 !important;
        font-size: 12px;
        margin-bottom: 14px;
    }

    .capture-symbol {
        width: 38px;
        height: 38px;
        border-radius: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ece7d0;
        border: 1px solid #dce4cb;
        margin-bottom: 10px;
    }

    .capture-symbol svg {
        width: 21px;
        height: 21px;
    }

    [data-testid="stMetric"] {
        background: #fffdf5;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
        box-shadow: 0 4px 14px rgba(15,23,42,.04);
    }

    [data-testid="stMetricLabel"] {
        color: #727b69 !important;
        font-size: 11px !important;
    }

    [data-testid="stMetricValue"] {
        color: #1d2719 !important;
        font-weight: 800 !important;
    }

    /* Tabs */
    .stTabs [data-baseweb="tab-list"] {
        gap: 5px;
        border-bottom: 1px solid #dde2d7;
    }

    .stTabs [data-baseweb="tab"] {
        color: #66705c !important;
        font-weight: 750;
        padding: 10px 16px;
    }

    .stTabs [aria-selected="true"] {
        color: #596b32 !important;
    }

    /* Dataframe */
    [data-testid="stDataFrame"] {
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
    }

    /* Footer */
    .footer {
        text-align: center;
        color: #7d866f !important;
        padding: 38px 10px 20px;
        font-size: 11px;
        line-height: 1.7;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


# ============================================================
# SESSION STATE
# ============================================================

# Version the evidence session state so an old selected video
# cannot survive after the application is updated.
APP_STATE_VERSION = 4

if st.session_state.get("evidence_state_version") != APP_STATE_VERSION:
    st.session_state.evidence_state_version = APP_STATE_VERSION
    st.session_state.selected_video_path = ""
    st.session_state.selected_video_name = ""
    st.session_state.verification_result = None
    st.session_state.verification_report = ""
    st.session_state.encoder_result = None
    st.session_state.camera_record_path = ""
    st.session_state.camera_record_ready = False

if "driver_id" not in st.session_state:
    st.session_state.driver_id = "driver-01"

if "selected_video_path" not in st.session_state:
    st.session_state.selected_video_path = ""

if "selected_video_name" not in st.session_state:
    st.session_state.selected_video_name = ""

if "verification_result" not in st.session_state:
    st.session_state.verification_result = None

if "verification_report" not in st.session_state:
    st.session_state.verification_report = ""

if "encoder_result" not in st.session_state:
    st.session_state.encoder_result = None

if "camera_record_path" not in st.session_state:
    st.session_state.camera_record_path = ""

if "camera_record_ready" not in st.session_state:
    st.session_state.camera_record_ready = False


# ============================================================
# HELPER FUNCTIONS
# ============================================================

def hash_frame(frame):

    return hashlib.sha256(
        frame.tobytes()
    ).hexdigest()


def get_video_information(video_path):

    if not video_path:
        return None

    path = Path(video_path)

    if not path.exists():
        return None

    cap = cv2.VideoCapture(str(path))

    if not cap.isOpened():
        return None

    frame_count = int(
        cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )

    fps = cap.get(cv2.CAP_PROP_FPS)

    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )

    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )

    duration = (
        frame_count / fps
        if fps and fps > 0
        else 0
    )

    cap.release()

    return {
        "frames": frame_count,
        "fps": fps,
        "width": width,
        "height": height,
        "duration": duration,
    }


def get_cloud_records(
    driver_id,
    video_name,
):

    if supabase is None:
        return []

    all_records = []

    start = 0
    batch_size = 1000

    while True:

        response = (
            supabase
            .table("fingerprints")
            .select(
                "id,"
                "driver_id,"
                "frame_number,"
                "fingerprint,"
                "timestamp,"
                "video_name,"
                "status,"
                "created_at"
            )
            .eq(
                "driver_id",
                driver_id
            )
            .eq(
                "video_name",
                video_name
            )
            .order(
                "frame_number"
            )
            .range(
                start,
                start + batch_size - 1
            )
            .execute()
        )

        records = response.data or []

        if not records:
            break

        all_records.extend(records)

        if len(records) < batch_size:
            break

        start += batch_size

    return all_records


def create_report(
    driver_id,
    video_name,
    frames_checked,
    verified,
    corrupted,
    missing,
    integrity,
    status,
):

    verification_time = datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    return f"""
INSURANCE INTEGRITY VERIFICATION REPORT
========================================
Verification Time: {verification_time}
Driver ID: {driver_id}
Video Name: {video_name}
Fingerprint Algorithm: SHA-256

Frames Checked: {frames_checked}
Verified Frames: {verified}
Corrupted Frames: {corrupted}
Missing Frames: {missing}
Integrity: {integrity:.2f}%
Status: {status}

Verification completed successfully.
""".strip()


def save_local_fingerprints(
    records,
    video_name,
):

    output_file = (
        DATABASE_DIR /
        f"{Path(video_name).stem}_fingerprints.txt"
    )

    with open(
        output_file,
        "w",
        encoding="utf-8",
    ) as file:

        file.write(
            "DASHCAM ASSURANCE FINGERPRINT DATABASE\n"
        )

        file.write(
            f"Video: {video_name}\n"
        )

        file.write(
            "Algorithm: SHA-256\n"
        )

        file.write(
            "=" * 60 + "\n"
        )

        for record in records:

            file.write(
                f"{record['frame_number']} | "
                f"{record['fingerprint']} | "
                f"{record['timestamp']}\n"
            )

    return output_file


def process_video(
    video_path,
    driver_id,
    video_name,
    progress_bar,
    status_box,
):

    if supabase is None:

        raise RuntimeError(
            "Supabase is not connected."
        )

    video_path = Path(video_path)

    if not video_path.exists():

        raise FileNotFoundError(
            f"Video not found: {video_path}"
        )

    # --------------------------------------------------------
    # Existing cloud evidence
    # --------------------------------------------------------

    existing_records = get_cloud_records(
        driver_id,
        video_name,
    )

    existing_frames = {
        record["frame_number"]
        for record in existing_records
    }

    # --------------------------------------------------------
    # Open video
    # --------------------------------------------------------

    cap = cv2.VideoCapture(
        str(video_path)
    )

    if not cap.isOpened():

        raise RuntimeError(
            "Unable to open video."
        )

    total_frames = int(
        cap.get(
            cv2.CAP_PROP_FRAME_COUNT
        )
    )

    fps = cap.get(
        cv2.CAP_PROP_FPS
    )

    if fps <= 0:
        fps = 20.0

    new_records = []

    frame_number = 0

    # --------------------------------------------------------
    # Generate fingerprints
    # --------------------------------------------------------

    while True:

        success, frame = cap.read()

        if not success:
            break

        frame_number += 1

        fingerprint = hash_frame(
            frame
        )

        timestamp = (
            datetime.now() +
            timedelta(
                seconds=(
                    (frame_number - 1)
                    / fps
                )
            )
        ).isoformat()

        record = {
            "driver_id":
                driver_id,

            "frame_number":
                frame_number,

            "fingerprint":
                fingerprint,

            "timestamp":
                timestamp,

            "video_name":
                video_name,

            "status":
                "sent",
        }

        if frame_number not in existing_frames:

            new_records.append(
                record
            )

        progress = (
            frame_number /
            total_frames
            if total_frames > 0
            else 0
        )

        progress_bar.progress(
            min(progress, 1.0)
        )

        status_box.write(
            f"🔢 Fingerprinting frame "
            f"{frame_number}/{total_frames}"
        )

    cap.release()

    # --------------------------------------------------------
    # Upload in batches
    # --------------------------------------------------------

    uploaded = 0

    batch_size = 500

    for start in range(
        0,
        len(new_records),
        batch_size,
    ):

        batch = new_records[
            start:
            start + batch_size
        ]

        response = (
            supabase
            .table("fingerprints")
            .insert(batch)
            .execute()
        )

        if response.data:

            uploaded += len(
                response.data
            )

    # --------------------------------------------------------
    # Combine local evidence
    # --------------------------------------------------------

    combined_records = (
        existing_records +
        new_records
    )

    combined_records.sort(
        key=lambda x:
        x["frame_number"]
    )

    local_file = save_local_fingerprints(
        combined_records,
        video_name,
    )

    return {
        "frames":
            total_frames,

        "uploaded":
            uploaded,

        "already_existing":
            len(existing_records),

        "total_cloud_records":
            len(combined_records),

        "local_file":
            str(local_file),
    }


# ============================================================
# CAMERA RECORDING
# ============================================================

def make_camera_record_path():

    timestamp = datetime.now().strftime(
        "%Y%m%d_%H%M%S_%f"
    )

    return VIDEO_DIR / f"camera_recording_{timestamp}.mp4"


def create_camera_recorder(record_path):
    # IMPORTANT: this function can run in the WebRTC worker thread.
    # Do not modify st.session_state from here. The path is created
    # in the normal Streamlit thread and passed into the recorder.
    return MediaRecorder(str(record_path))


# ============================================================
# SIDEBAR
# ============================================================

st.sidebar.markdown(
    """
    <div class="brand-block">
        <div class="brand-mark">
            <svg viewBox="0 0 64 64" aria-hidden="true">
                <defs>
                    <linearGradient id="brandGradient" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                        <stop stop-color="#3B82F6"/>
                        <stop offset="1" stop-color="#06B6D4"/>
                    </linearGradient>
                </defs>
                <rect x="3" y="3" width="58" height="58" rx="16" fill="#0D1B2A"/>
                <path d="M17 27.5h5l3.5-5h13l3.5 5H47c2.2 0 4 1.8 4 4v12c0 2.2-1.8 4-4 4H17c-2.2 0-4-1.8-4-4v-12c0-2.2 1.8-4 4-4Z" fill="url(#brandGradient)"/>
                <circle cx="32" cy="37.5" r="8.5" fill="#0D1B2A"/>
                <circle cx="32" cy="37.5" r="4.5" fill="#EAF6FF"/>
                <path d="M45 17.5l3 3-5 5" fill="none" stroke="#93C5FD" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M46 17h5v5" fill="none" stroke="#93C5FD" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <div class="brand-name">Dashcam Assurance</div>
        <div class="brand-sub">Digital Evidence Integrity Platform</div>
    </div>
    """,
    unsafe_allow_html=True,
)

st.sidebar.divider()

page = st.sidebar.radio(
    "APPLICATION",
    [
        "Dashboard",
        "Evidence Capture",
        "Evaluation Lab",
        "Insurance Verification",
        "Administration",
    ],
)

st.sidebar.divider()

st.sidebar.markdown(
    '<div class="sidebar-driver">'
    '<div class="sidebar-driver-label">Active driver</div>',
    unsafe_allow_html=True,
)

st.session_state.driver_id = st.sidebar.text_input(
    "Driver ID",
    value=st.session_state.driver_id,
    label_visibility="collapsed",
)

st.sidebar.markdown(
    '<div class="sidebar-status">'
    '<span class="dot-blue"></span>'
    '<span>Identity session active</span>'
    '</div></div>',
    unsafe_allow_html=True,
)

if supabase:
    st.sidebar.markdown(
        '<div class="sidebar-cloud">'
        '<div class="sidebar-cloud-title">Cloud service</div>'
        '<div class="sidebar-cloud-value">● Connected</div>'
        '</div>',
        unsafe_allow_html=True,
    )
else:
    st.sidebar.markdown(
        '<div class="sidebar-cloud" style="border-color:rgba(248,113,113,.2);">'
        '<div class="sidebar-cloud-title">Cloud service</div>'
        '<div style="color:#fca5a5 !important;font-size:13px;font-weight:750;margin-top:4px;">● Disconnected</div>'
        '</div>',
        unsafe_allow_html=True,
    )

st.sidebar.markdown(
    '<div style="height:12px"></div>'
    '<div style="color:#71849a !important;font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;">Security</div>'
    '<div style="color:#b7c4d2 !important;font-size:11px;margin-top:5px;">SHA-256 · Supabase · Streamlit</div>',
    unsafe_allow_html=True,
)


# ============================================================
# DASHBOARD
# ============================================================

if page == "Dashboard":

    st.markdown(
        '<div class="hero-panel">'
        '<div class="page-kicker">SECURE EVIDENCE PLATFORM</div>'
        '<div class="hero-title">Dashcam Assurance</div>'
        '<div class="hero-subtitle">'
        'A controlled digital evidence workspace for capturing, fingerprinting, certifying and verifying dashcam footage for insurance workflows.'
        '</div></div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="section-title"><span class="section-title-bar"></span>System overview</div>',
        unsafe_allow_html=True,
    )

    current_path = st.session_state.selected_video_path
    current_name = st.session_state.selected_video_name
    has_evidence = bool(current_path and Path(current_path).exists())

    s1, s2, s3, s4 = st.columns(4)

    with s1:
        db_value = "Connected" if supabase else "Offline"
        db_class = "green" if supabase else "amber"
        pill = '<span class="status-pill pill-green">● Operational</span>' if supabase else '<span class="status-pill" style="background:#fff7ed;color:#b45309 !important;">● Attention</span>'
        st.markdown(
            f'<div class="status-card {db_class}">'
            '<div class="status-label">Cloud database</div>'
            f'<div class="status-value">{db_value}</div>'
            f'{pill}</div>',
            unsafe_allow_html=True,
        )

    with s2:
        st.markdown(
            '<div class="status-card cyan">'
            '<div class="status-label">Integrity engine</div>'
            '<div class="status-value">SHA-256</div>'
            '<div class="status-meta">Frame-level fingerprinting</div>'
            '</div>',
            unsafe_allow_html=True,
        )

    with s3:
        verify_ready = has_evidence
        st.markdown(
            '<div class="status-card">'
            '<div class="status-label">Verification</div>'
            f'<div class="status-value">{"Ready" if verify_ready else "Waiting"}</div>'
            f'<div class="status-meta">{"Evidence selected" if verify_ready else "Select evidence to begin"}</div>'
            '</div>',
            unsafe_allow_html=True,
        )

    with s4:
        st.markdown(
            '<div class="status-card green">'
            '<div class="status-label">Evidence state</div>'
            f'<div class="status-value">{"Active" if has_evidence else "Empty"}</div>'
            f'<div class="status-meta">{"Current evidence ready" if has_evidence else "No active video"}</div>'
            '</div>',
            unsafe_allow_html=True,
        )

    st.markdown('<div style="height:8px"></div>', unsafe_allow_html=True)

    # Driver / session status
    st.markdown(
        '<div class="section-title"><span class="section-title-bar"></span>Driver & session</div>',
        unsafe_allow_html=True,
    )
    st.markdown(
        '<div class="driver-panel">'
        '<div><div class="driver-label">Driver identity</div>'
        f'<div class="driver-value">{st.session_state.driver_id}</div></div>'
        '<div style="text-align:right;">'
        '<span class="driver-state"><span class="dot-green"></span>Session active</span>'
        '<div style="color:#7d866f;font-size:11px;margin-top:6px;">Cloud-backed evidence workspace</div>'
        '</div></div>',
        unsafe_allow_html=True,
    )

    st.markdown('<div style="height:8px"></div>', unsafe_allow_html=True)

    # Current evidence
    st.markdown(
        '<div class="section-title"><span class="section-title-bar"></span>Current evidence</div>',
        unsafe_allow_html=True,
    )

    if has_evidence:
        info = get_video_information(current_path)
        if info:
            st.markdown(
                '<div class="evidence-card">'
                f'<div class="evidence-name">{current_name}</div>'
                '<div class="evidence-path">Active evidence file</div>'
                '</div>',
                unsafe_allow_html=True,
            )
            st.markdown('<div style="height:10px"></div>', unsafe_allow_html=True)
            v1, v2, v3, v4 = st.columns(4)
            with v1:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Frames</div><div class="metric-value">{info["frames"]:,}</div><div class="metric-detail">Detected video frames</div></div>', unsafe_allow_html=True)
            with v2:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Frame rate</div><div class="metric-value">{info["fps"]:.2f}</div><div class="metric-detail">Frames per second</div></div>', unsafe_allow_html=True)
            with v3:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Resolution</div><div class="metric-value" style="font-size:20px;">{info["width"]} × {info["height"]}</div><div class="metric-detail">Video dimensions</div></div>', unsafe_allow_html=True)
            with v4:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Duration</div><div class="metric-value">{info["duration"]:.2f}s</div><div class="metric-detail">Playback duration</div></div>', unsafe_allow_html=True)
    else:
        st.markdown(
            '<div class="callout info">No active evidence is selected. Open Evidence Capture to upload or record a new video.</div>',
            unsafe_allow_html=True,
        )

    # Cloud evidence
    st.markdown('<div style="height:8px"></div>', unsafe_allow_html=True)
    st.markdown(
        '<div class="section-title"><span class="section-title-bar"></span>Certified cloud evidence</div>',
        unsafe_allow_html=True,
    )

    if supabase and current_name:
        try:
            records = get_cloud_records(st.session_state.driver_id, current_name)
            total = len(records)
            unique_frames = len(set(r["frame_number"] for r in records))
            pending = sum(1 for r in records if str(r.get("status", "")).lower() == "pending")
            c1, c2, c3, c4 = st.columns(4)
            vals = [
                ("Fingerprints", f"{total:,}", "Stored frame hashes"),
                ("Unique frames", f"{unique_frames:,}", "Distinct frame numbers"),
                ("Pending", f"{pending:,}", "Awaiting certification"),
                ("Evidence state", "CERTIFIED" if total > 0 and pending == 0 else "PENDING", "Cloud certification status"),
            ]
            for col, (label, value, detail) in zip((c1,c2,c3,c4), vals):
                with col:
                    st.markdown(f'<div class="metric-card"><div class="metric-label">{label}</div><div class="metric-value" style="font-size:{20 if label=="Evidence state" else 26}px;">{value}</div><div class="metric-detail">{detail}</div></div>', unsafe_allow_html=True)
        except Exception as e:
            st.markdown(f'<div class="callout danger">Cloud evidence error: {e}</div>', unsafe_allow_html=True)
    else:
        st.markdown('<div class="callout info">Cloud evidence will appear here after a video is selected and certified.</div>', unsafe_allow_html=True)

    # Workflow
    st.markdown('<div style="height:8px"></div>', unsafe_allow_html=True)
    st.markdown(
        '<div class="section-title"><span class="section-title-bar"></span>Evidence lifecycle</div>',
        unsafe_allow_html=True,
    )

    w1, w2, w3, w4 = st.columns(4)
    workflow = [
        ("01", "Capture", "Upload existing footage or record directly from a browser camera."),
        ("02", "Fingerprint", "Generate a SHA-256 digest for every frame in the evidence file."),
        ("03", "Certify", "Store the certified fingerprint set in the Supabase evidence database."),
        ("04", "Verify", "Recalculate frame hashes and compare them with the certified record."),
    ]
    for col, (num, title, text_) in zip((w1,w2,w3,w4), workflow):
        with col:
            st.markdown(
                f'<div class="workflow-card"><div class="workflow-number">{num}</div>'
                f'<div class="workflow-title">{title}</div>'
                f'<div class="workflow-text">{text_}</div></div>',
                unsafe_allow_html=True,
            )


# ============================================================
# EVIDENCE CAPTURE
# ============================================================

elif page == "Evidence Capture":

    st.markdown(
        '<div class="page-kicker">EVIDENCE INTAKE</div>'
        '<div class="hero-title">'
        'Evidence Capture'
        '</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="hero-subtitle">'
        'Upload dashcam footage or record directly from your camera'
        '</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="driver-panel">'
        '<div><div class="driver-label">Evidence owner</div>'
        f'<div class="driver-value">{st.session_state.driver_id}</div></div>'
        '<div style="text-align:right;">'
        '<span class="driver-state"><span class="dot-green"></span>Capture session active</span>'
        '<div style="color:#7d866f;font-size:11px;margin-top:6px;">New uploads replace the active evidence</div>'
        '</div></div>',
        unsafe_allow_html=True,
    )

    st.markdown('<div style="height:12px"></div>', unsafe_allow_html=True)

    # --------------------------------------------------------
    # TABS
    # --------------------------------------------------------

    upload_tab, camera_tab = st.tabs(
        [
            "UPLOAD VIDEO",
            "RECORD FROM CAMERA",
        ]
    )

    # ========================================================
    # UPLOAD VIDEO
    # ========================================================

    with upload_tab:

        st.markdown(
            '<div class="upload-panel">'
            '<div class="capture-symbol">'
            '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
            '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H9l1.4-2h3.2L15 5h2.5A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" stroke="#2563EB" stroke-width="1.8"/>'
            '<circle cx="12" cy="12" r="3.7" stroke="#0EA5E9" stroke-width="1.8"/>'
            '</svg>'
            '</div>'
            '<div class="upload-heading">Upload existing dashcam footage</div>'
            '<div class="upload-description">Select a video to make it the active evidence item.</div>',
            unsafe_allow_html=True,
        )

        uploaded_file = st.file_uploader(
            "Choose a video file",
            type=[
                "mp4",
                "avi",
                "mov",
                "mkv",
                "webm",
            ],
        )

        st.markdown('</div>', unsafe_allow_html=True)

        if uploaded_file:

            # Give every upload a unique stored filename.
            # This prevents a new video from being confused with
            # an older certified video that had the same filename.
            original_name = Path(uploaded_file.name).name
            original_stem = Path(original_name).stem
            original_suffix = Path(original_name).suffix.lower()

            upload_timestamp = datetime.now().strftime(
                "%Y%m%d_%H%M%S_%f"
            )

            upload_name = (
                f"upload_{upload_timestamp}_"
                f"{original_stem}{original_suffix}"
            )

            upload_path = VIDEO_DIR / upload_name

            with open(
                upload_path,
                "wb",
            ) as file:

                file.write(
                    uploaded_file.getbuffer()
                )

            # The newly uploaded video immediately becomes active.
            st.session_state.selected_video_path = str(upload_path)
            st.session_state.selected_video_name = upload_name

            # Clear results belonging to the previous evidence.
            st.session_state.verification_result = None
            st.session_state.verification_report = ""
            st.session_state.encoder_result = None

            st.success(
                f"✅ New video uploaded and selected: {upload_name}"
            )

            info = get_video_information(
                upload_path
            )

            if info:

                u1, u2, u3, u4 = st.columns(4)

                with u1:
                    st.metric(
                        "Frames",
                        info["frames"]
                    )

                with u2:
                    st.metric(
                        "FPS",
                        f"{info['fps']:.2f}"
                    )

                with u3:
                    st.metric(
                        "Resolution",
                        f"{info['width']} × "
                        f"{info['height']}"
                    )

                with u4:
                    st.metric(
                        "Duration",
                        f"{info['duration']:.2f}s"
                    )

                st.video(
                    str(upload_path)
                )

                st.success(
                    "This video is now the active "
                    "evidence file."
                )

    # ========================================================
    # CAMERA RECORDING
    # ========================================================

    with camera_tab:

        st.subheader(
            "Record Dashcam Evidence"
        )

        st.write(
            "Allow camera access when your browser asks. "
            "Click START to begin recording and STOP "
            "when you want to finish."
        )

        st.warning(
            "For a local demonstration, Chrome or Edge "
            "should be allowed to access your camera."
        )

        # ----------------------------------------------------
        # Prepare a unique output file BEFORE WebRTC starts.
        # The recorder thread never writes to st.session_state.
        # ----------------------------------------------------

        if not st.session_state.camera_record_path:
            st.session_state.camera_record_path = str(
                make_camera_record_path()
            )

        camera_path = Path(
            st.session_state.camera_record_path
        )

        try:

            ctx = webrtc_streamer(
                key="dashcam-camera-recorder",
                mode=WebRtcMode.SENDRECV,
                media_stream_constraints={
                    "video": True,
                    "audio": False,
                },
                in_recorder_factory=lambda: create_camera_recorder(
                    camera_path
                ),
            )

            if ctx.state.playing:

                st.success(
                    "🔴 Camera recording is ACTIVE"
                )

            else:

                st.info(
                    "Camera is stopped. "
                    "Click START to record."
                )

        except Exception as e:

            st.error(
                f"Camera initialization failed: {e}"
            )

        # ----------------------------------------------------
        # Check recorded file
        # ----------------------------------------------------

        camera_path = Path(
            st.session_state.camera_record_path
        ) if st.session_state.camera_record_path else None

        if (
            camera_path is not None and
            camera_path.exists()
        ):

            file_size = (
                Path(camera_path).stat().st_size
            )

            if file_size > 1000:

                st.success(
                    "✅ Camera recording saved."
                )

                st.write(
                    f"**Recording:** "
                    f"`{Path(camera_path).name}`"
                )

                st.write(
                    f"**Size:** "
                    f"{file_size / 1024:.1f} KB"
                )

                st.video(
                    camera_path
                )

                # Only activate the file after recording has stopped.
                # While recording, the MP4 may still be incomplete.
                if (
                    not ctx.state.playing
                    and st.session_state.selected_video_path != str(camera_path)
                ):
                    st.session_state.selected_video_path = str(camera_path)
                    st.session_state.selected_video_name = camera_path.name
                    st.session_state.verification_result = None
                    st.session_state.verification_report = ""
                    st.session_state.encoder_result = None

                if st.button(
                    "📌 Use This Recording as Evidence",
                    type="primary",
                    use_container_width=True,
                ):

                    st.session_state.selected_video_path = str(camera_path)
                    st.session_state.selected_video_name = camera_path.name
                    st.session_state.verification_result = None
                    st.session_state.verification_report = ""
                    st.session_state.encoder_result = None

                    st.success(
                        "New camera recording is now the "
                        "active evidence."
                    )

                    st.rerun()

        # ----------------------------------------------------
        # Start a completely new local evidence session
        # ----------------------------------------------------

        if st.button(
            "🧹 Clear Active Evidence / Start New",
            use_container_width=True,
        ):
            st.session_state.selected_video_path = ""
            st.session_state.selected_video_name = ""
            st.session_state.camera_record_path = ""
            st.session_state.camera_record_ready = False
            st.session_state.verification_result = None
            st.session_state.verification_report = ""
            st.session_state.encoder_result = None

            st.success(
                "✅ Active evidence cleared. "
                "Upload or record a new video."
            )
            st.rerun()

        # ----------------------------------------------------
        # Active video
        # ----------------------------------------------------

        if (
            st.session_state.selected_video_path and
            Path(
                st.session_state.selected_video_path
            ).exists()
        ):

            st.divider()

            st.subheader(
                "📌 Active Evidence"
            )

            st.write(
                f"`{st.session_state.selected_video_name}`"
            )

    # ========================================================
    # FINGERPRINT / CLOUD TRANSMISSION
    # ========================================================

    st.divider()

    st.subheader(
        "🔢 Generate Certified Fingerprints"
    )

    active_path = (
        st.session_state.selected_video_path
    )

    active_name = (
        st.session_state.selected_video_name
    )

    if (
        active_path and
        Path(active_path).exists()
    ):

        active_info = get_video_information(active_path)

        st.success(
            f"Active video: `{active_name}`"
        )

        if active_info:
            st.info(
                f"🎞️ Current active video contains "
                f"**{active_info['frames']} frames** "
                f"({active_info['duration']:.2f}s)."
            )

        st.write(
            f"Driver ID: `{st.session_state.driver_id}`"
        )

        process_button = st.button(
            "🚀 Fingerprint & Certify Evidence",
            type="primary",
            use_container_width=True,
        )

        if process_button:

            progress_bar = st.progress(
                0
            )

            status_box = st.empty()

            try:

                result = process_video(
                    active_path,
                    st.session_state.driver_id,
                    active_name,
                    progress_bar,
                    status_box,
                )

                st.session_state.encoder_result = (
                    result
                )

                st.session_state.verification_result = None
                st.session_state.verification_report = ""

                progress_bar.progress(
                    1.0
                )

                status_box.success(
                    "✅ Evidence certification completed."
                )

                r1, r2, r3, r4 = st.columns(4)

                with r1:
                    st.metric(
                        "Frames",
                        result["frames"]
                    )

                with r2:
                    st.metric(
                        "Uploaded",
                        result["uploaded"]
                    )

                with r3:
                    st.metric(
                        "Existing",
                        result["already_existing"]
                    )

                with r4:
                    st.metric(
                        "Cloud Total",
                        result["total_cloud_records"]
                    )

                st.success(
                    "☁️ Fingerprints successfully "
                    "stored in Supabase."
                )

                st.info(
                    f"Local evidence file: "
                    f"{result['local_file']}"
                )

            except Exception as e:

                st.error(
                    f"❌ Certification failed: {e}"
                )

    else:

        st.info(
            "Upload a video or record one from the "
            "camera before fingerprinting."
        )


# ============================================================
# INSURANCE VERIFICATION
# ============================================================

elif page == "Insurance Verification":

    st.markdown(
        '<div class="page-kicker">INTEGRITY CHECK</div>'
        '<div class="hero-title">'
        'Insurance Verification'
        '</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="hero-subtitle">'
        'Certified Dashcam Evidence Integrity Verification'
        '</div>',
        unsafe_allow_html=True,
    )

    driver_id = (
        st.session_state.driver_id
    )

    video_path = (
        st.session_state.selected_video_path
    )

    video_name = (
        st.session_state.selected_video_name
    )

    if (
        not video_path or
        not Path(video_path).exists()
    ):

        st.warning(
            "No active video selected."
        )

        st.info(
            "Go to Evidence Capture and upload or "
            "record a video first."
        )

        st.stop()

    # --------------------------------------------------------
    # EVIDENCE DETAILS
    # --------------------------------------------------------

    st.subheader(
        "🎥 Evidence Details"
    )

    d1, d2, d3 = st.columns(3)

    details = [
        ("Driver identity", driver_id, "Session owner"),
        ("Evidence file", video_name, "Active video"),
        ("Fingerprint engine", "SHA-256", "Frame-level integrity")
    ]
    for col, (label, value, detail) in zip((d1, d2, d3), details):
        with col:
            st.markdown(
                f'<div class="metric-card"><div class="metric-label">{label}</div>'
                f'<div class="metric-value" style="font-size:17px;word-break:break-word;">{value}</div>'
                f'<div class="metric-detail">{detail}</div></div>',
                unsafe_allow_html=True,
            )

    # --------------------------------------------------------
    # VIDEO
    # --------------------------------------------------------

    st.divider()

    st.subheader(
        "🎥 Evidence Video"
    )

    st.video(
        video_path
    )

    # --------------------------------------------------------
    # CLOUD CHECK
    # --------------------------------------------------------

    try:

        cloud_records = get_cloud_records(
            driver_id,
            video_name,
        )

    except Exception as e:

        st.error(
            f"Cloud database error: {e}"
        )

        cloud_records = []

    if not cloud_records:

        st.warning(
            "⚠️ No certified cloud fingerprints "
            "were found for this video."
        )

        st.info(
            "Go to Evidence Capture and click "
            "'Fingerprint & Certify Evidence'."
        )

    else:

        st.success(
            f"☁️ {len(cloud_records)} certified "
            "cloud fingerprints available."
        )

    # --------------------------------------------------------
    # VERIFY
    # --------------------------------------------------------

    verify_button = st.button(
        "🔎 Verify Video Integrity",
        type="primary",
        use_container_width=True,
    )

    if verify_button:

        if not cloud_records:

            st.error(
                "Cannot verify because certified "
                "cloud fingerprints are unavailable."
            )

            st.stop()

        cloud_fingerprints = {
            record["frame_number"]:
                record["fingerprint"]
            for record in cloud_records
        }

        cap = cv2.VideoCapture(
            str(video_path)
        )

        if not cap.isOpened():

            st.error(
                "Unable to open video."
            )

            st.stop()

        total_frames = int(
            cap.get(
                cv2.CAP_PROP_FRAME_COUNT
            )
        )

        progress = st.progress(
            0
        )

        checked = 0
        verified = 0
        corrupted = 0
        missing = 0

        while True:

            success, frame = cap.read()

            if not success:
                break

            checked += 1

            current_hash = hash_frame(
                frame
            )

            certified_hash = (
                cloud_fingerprints.get(
                    checked
                )
            )

            if certified_hash is None:

                missing += 1

            elif (
                current_hash ==
                certified_hash
            ):

                verified += 1

            else:

                corrupted += 1

            progress.progress(
                min(
                    checked /
                    total_frames,
                    1.0
                )
            )

        cap.release()

        integrity = (
            (
                verified /
                checked
            ) * 100
            if checked > 0
            else 0
        )

        if (
            checked > 0 and
            corrupted == 0 and
            missing == 0 and
            verified == checked
        ):

            status = "VERIFIED"

        else:

            status = "INTEGRITY FAILURE"

        st.session_state.verification_result = {
            "checked": checked,
            "verified": verified,
            "corrupted": corrupted,
            "missing": missing,
            "integrity": integrity,
            "status": status,
        }

        st.session_state.verification_report = (
            create_report(
                driver_id,
                video_name,
                checked,
                verified,
                corrupted,
                missing,
                integrity,
                status,
            )
        )

    # --------------------------------------------------------
    # RESULTS
    # --------------------------------------------------------

    if st.session_state.verification_result:

        result = (
            st.session_state.verification_result
        )

        st.divider()

        st.subheader(
            "📊 Verification Results"
        )

        r1, r2, r3, r4 = st.columns(4)

        with r1:

            st.metric(
                "Frames Checked",
                result["checked"]
            )

        with r2:

            st.metric(
                "Verified Frames",
                result["verified"]
            )

        with r3:

            st.metric(
                "Corrupted Frames",
                result["corrupted"]
            )

        with r4:

            st.metric(
                "Missing Frames",
                result["missing"]
            )

        st.divider()

        if result["status"] == "VERIFIED":

            st.markdown(
                f'<div class="callout success"><strong>VIDEO VERIFIED</strong><br>'
                f'Integrity score: <strong>{result["integrity"]:.2f}%</strong><br>'
                f'All checked frames match the certified fingerprint set.</div>',
                unsafe_allow_html=True,
            )

        else:

            st.markdown(
                f'<div class="callout danger"><strong>INTEGRITY FAILURE</strong><br>'
                f'Integrity score: <strong>{result["integrity"]:.2f}%</strong><br>'
                f'One or more frames differ from the certified fingerprint set.</div>',
                unsafe_allow_html=True,
            )

        # ----------------------------------------------------
        # REPORT
        # ----------------------------------------------------

        st.divider()

        st.subheader(
            "📄 Insurance Verification Report"
        )

        st.code(
            st.session_state.verification_report,
            language="text",
        )

        st.download_button(
            label="⬇️ Download Verification Report",
            data=st.session_state.verification_report,
            file_name=(
                "insurance_integrity_"
                "verification_report.txt"
            ),
            mime="text/plain",
            use_container_width=True,
        )


# ============================================================
# ADMINISTRATION
# ============================================================

elif page == "Administration":

    st.markdown(
        '<div class="page-kicker">CONTROL CENTER</div>'
        '<div class="hero-title">'
        'Administration'
        '</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="hero-subtitle">'
        'Cloud Evidence Management & Retention'
        '</div>',
        unsafe_allow_html=True,
    )

    driver_id = (
        st.session_state.driver_id
    )

    video_name = (
        st.session_state.selected_video_name
    )

    if not video_name:

        st.warning(
            "No active evidence selected."
        )

        st.stop()

    try:

        records = get_cloud_records(
            driver_id,
            video_name,
        )

    except Exception as e:

        st.error(
            f"Unable to retrieve evidence: {e}"
        )

        records = []

# ============================================================
# EVALUATION LAB
# ============================================================

elif page == "Evaluation Lab":

    st.markdown(
        '<div class="page-kicker">VIDEO EVALUATION</div>'
        '<div class="hero-title">Evaluation Lab</div>',
        unsafe_allow_html=True,
    )

    st.markdown(
        '<div class="hero-subtitle">'
        'Perceptual Fingerprint & Video Matching'
        '</div>',
        unsafe_allow_html=True,
    )

    st.write(
        "Evaluate captured or uploaded evidence using "
        "multiple perceptual fingerprinting methods."
    )

    st.divider()

    # ========================================================
    # ACTIVE EVIDENCE
    # ========================================================

    active_path = st.session_state.selected_video_path
    active_name = st.session_state.selected_video_name

    if not active_path or not Path(active_path).exists():

        st.warning("No active evidence is selected.")

        st.info(
            "Go to Evidence Capture and upload or record "
            "a video first."
        )

        st.stop()

    st.subheader("Active Evidence")

    st.success(f"Active video: {active_name}")

    active_info = get_video_information(active_path)

    if active_info:

        c1, c2, c3, c4 = st.columns(4)

        with c1:
            st.metric("Frames", active_info["frames"])

        with c2:
            st.metric("FPS", f"{active_info['fps']:.2f}")

        with c3:
            st.metric(
                "Resolution",
                f"{active_info['width']} × {active_info['height']}"
            )

        with c4:
            st.metric(
                "Duration",
                f"{active_info['duration']:.2f}s"
            )

    st.divider()

    # ========================================================
    # REFERENCE VIDEO
    # ========================================================

    st.subheader("Reference Evidence")

    reference_upload = st.file_uploader(
        "Upload the original/reference video",
        type=["mp4", "avi", "mov", "mkv", "webm"],
        key="evaluation_reference_video",
    )

    if reference_upload:

        reference_path = (
            Path("videos")
            / f"evaluation_reference_{reference_upload.name}"
        )

        with open(reference_path, "wb") as f:
            f.write(reference_upload.getbuffer())

        st.success(
            f"Reference video loaded: {reference_upload.name}"
        )

    else:

        reference_path = None

    st.divider()

    # ========================================================
    # TRANSFORMATION TESTS
    # ========================================================

    st.subheader("Transformation Tests")

    st.write(
        "Create a modified test video from the reference "
        "video to evaluate temporal robustness."
    )

    trim_seconds = st.number_input(
        "Trim beginning (seconds)",
        min_value=1,
        max_value=30,
        value=2,
        step=1,
        key="trim_test_seconds",
    )

    create_trim_test = st.button(
        "Create Trimmed Test Video",
        use_container_width=True,
    )

    if create_trim_test:

        if not reference_path:

            st.warning("Upload a reference video first.")

        else:

            try:

                trimmed_test_path = (
                    Path("videos")
                    / "evaluation_trimmed_test.mp4"
                )

                trim_result = create_trimmed_video(
                    str(reference_path),
                    str(trimmed_test_path),
                    start_seconds=int(trim_seconds),
                )

                st.session_state.evaluation_test_path = (
                    str(trimmed_test_path)
                )

                st.session_state.trim_test_result = trim_result

                st.success(
                    "Trimmed test video created successfully."
                )

                st.write(
                    f"Removed beginning: **{trim_seconds} seconds**"
                )

                st.write(
                    f"Frames written: "
                    f"**{trim_result['frames_written']:,}**"
                )

            except Exception as e:

                st.error(
                    f"Could not create trimmed video: {e}"
                )

    if (
        "evaluation_test_path" in st.session_state
        and Path(st.session_state.evaluation_test_path).exists()
    ):

        st.info(
            "Current evaluation test: "
            f"{Path(st.session_state.evaluation_test_path).name}"
        )

    st.divider()

    # ========================================================
    # EVALUATION SETTINGS
    # ========================================================

    st.subheader("Evaluation Settings")

    st.write(
        "All four perceptual fingerprint methods "
        "will be evaluated automatically."
    )

    hash_methods = {
        "pHash": "phash",
        "aHash": "ahash",
        "dHash": "dhash",
        "wHash": "whash",
    }

    sample_interval = st.number_input(
        "Compare every Nth frame",
        min_value=1,
        max_value=300,
        value=30,
        step=1,
        key="evaluation_sample_interval",
    )

    st.caption(
        "A value of 30 means approximately one frame "
        "is evaluated for every 30 frames."
    )

    st.divider()

    # ========================================================
    # MATCHING MODE
    # ========================================================

    st.subheader("Matching Mode")

    matching_mode = st.radio(
        "Choose how the videos should be compared:",
        [
            "Same Frame Position",
            "Temporal Alignment",
        ],
        key="evaluation_matching_mode",
    )

    if matching_mode == "Same Frame Position":

        st.caption(
            "Compares corresponding frame positions directly. "
            "Best for videos with the same timing."
        )

    else:

        st.caption(
            "Searches for a temporal offset between the "
            "reference and test videos. Useful for trimmed "
            "or shifted videos."
        )

    max_shift = 300

    if matching_mode == "Temporal Alignment":

        max_shift = st.number_input(
            "Maximum temporal shift (frames)",
            min_value=30,
            max_value=3000,
            value=300,
            step=30,
            key="evaluation_max_shift",
        )

        st.caption(
            f"The system will search up to ±{max_shift} "
            "frames for the best temporal alignment."
        )

    st.divider()

    # ========================================================
    # RUN EVALUATION
    # ========================================================

    if reference_path:

        run_evaluation = st.button(
            "Run All Fingerprint Evaluations",
            type="primary",
            use_container_width=True,
        )

        if run_evaluation:

            with st.spinner(
                "Running all four fingerprint methods..."
            ):

                try:

                    test_path = st.session_state.get(
                        "evaluation_test_path",
                        str(active_path)
                    )

                    all_results = {}

                    for method_name, method_function in hash_methods.items():

                        method_start_time = time.perf_counter()

                        if matching_mode == "Same Frame Position":

                            result = match_video_frames(
                                str(reference_path),
                                str(test_path),
                                hash_method=method_function,
                                sample_interval=int(sample_interval),
                            )

                            similarity = result["average_similarity"]

                            result["matching_mode"] = (
                                "Same Frame Position"
                            )

                        else:

                            result = find_best_temporal_match(
                                str(reference_path),
                                str(test_path),
                                hash_method=method_function,
                                sample_interval=int(sample_interval),
                                max_shift=int(max_shift),
                            )

                            similarity = result["best_similarity"]

                            result["matching_mode"] = (
                                "Temporal Alignment"
                            )

                        result["method_name"] = method_name

                        result["processing_time_seconds"] = (
                            time.perf_counter()
                            - method_start_time
                        )

                        result["classification"] = (
                            classify_similarity(similarity)
                        )

                        all_results[method_name] = result

                    st.session_state.evaluation_results = all_results

                    st.success(
                        "All four fingerprint methods "
                        "evaluated successfully."
                    )

                except Exception as e:

                    st.error(f"Evaluation failed: {e}")

    # ========================================================
    # RESULTS
    # ========================================================

    if "evaluation_results" in st.session_state:

        all_results = st.session_state.evaluation_results

        st.divider()

        st.subheader("Fingerprint Comparison")

        comparison_rows = []

        for method_name, result in all_results.items():

            if result.get("matching_mode") == "Temporal Alignment":

                similarity = float(
                    result.get("best_similarity", 0)
                )

                distance = 100.0 - similarity

                shift = result.get("best_shift", 0)

            else:

                similarity = float(
                    result.get("average_similarity", 0)
                )

                distance = float(
                    result.get("average_distance", 0)
                )

                shift = 0

            comparison_rows.append({
                "Fingerprint": method_name,
                "Similarity (%)": round(similarity, 2),
                "Normalized Distance (%)": round(distance, 2),
                "Classification": result.get(
                    "classification",
                    "Unknown"
                ),
                "Temporal Shift": shift,
                "Processing Time (s)": round(
                    float(
                        result.get(
                            "processing_time_seconds",
                            0
                        )
                    ),
                    3,
                ),
            })

        if comparison_rows:

            comparison_df = pd.DataFrame(comparison_rows)

            st.dataframe(
                comparison_df,
                use_container_width=True,
                height=240,
                hide_index=True,
            )

        else:

            st.warning(
                "No fingerprint comparison results "
                "are available. Run the evaluation again."
            )

        st.divider()

        st.subheader("Individual Results")

        for method_name, result in all_results.items():

            with st.expander(
                f"{method_name} — "
                f"{result.get('classification', 'Unknown')}"
            ):

                if (
                    result.get("matching_mode")
                    == "Temporal Alignment"
                ):

                    c1, c2, c3, c4, c5 = st.columns(5)

                    with c1:
                        st.metric(
                            "Best Shift",
                            f"{result.get('best_shift', 0)} frames"
                        )

                    with c2:
                        st.metric(
                            "Best Similarity",
                            f"{result.get('best_similarity', 0):.2f}%"
                        )

                    with c3:
                        st.metric(
                            "Reference Frames",
                            f"{result.get('reference_frames', 0):,}"
                        )

                    with c4:
                        st.metric(
                            "Test Frames",
                            f"{result.get('test_frames', 0):,}"
                        )

                    with c5:
                        st.metric(
                            "Processing Time",
                            f"{result.get('processing_time_seconds', 0):.3f}s"
                        )

                else:

                    c1, c2, c3, c4, c5 = st.columns(5)

                    with c1:
                        st.metric(
                            "Frames Compared",
                            result.get("frames_compared", 0)
                        )

                    with c2:
                        st.metric(
                            "Average Similarity",
                            f"{result.get('average_similarity', 0):.2f}%"
                        )

                    with c3:
                        st.metric(
                            "Average Distance",
                            f"{result.get('average_distance', 0):.2f}"
                        )

                    with c4:
                        st.metric(
                            "Minimum Similarity",
                            f"{result.get('minimum_similarity', 0):.2f}%"
                        )

                    with c5:
                        st.metric(
                            "Processing Time",
                            f"{result.get('processing_time_seconds', 0):.3f}s"
                        )

                st.write(
                    f"**Classification:** "
                    f"{result.get('classification', 'Unknown')}"
                )

    else:

        if not reference_path:

            st.info(
                "Upload a reference video to begin "
                "the evaluation."
            )

    # ========================================================
    # CLOUD DATABASE
    # ========================================================

    st.subheader("☁️ Cloud Database")

    try:

        records = get_cloud_records(
            st.session_state.driver_id,
            active_name,
        )

    except Exception:

        records = []

    if records:

        total_records = len(records)

        unique_frames = len(
            set(
                r["frame_number"]
                for r in records
            )
        )

        pending = sum(
            1
            for r in records
            if str(r.get("status", "")).lower() == "pending"
        )

        duplicates = total_records - unique_frames

        a1, a2, a3, a4 = st.columns(4)

        with a1:
            st.metric("Fingerprints", total_records)

        with a2:
            st.metric("Unique Frames", unique_frames)

        with a3:
            st.metric("Pending", pending)

        with a4:
            st.metric("Duplicates", duplicates)

        st.divider()

        st.subheader("📋 Recent Evidence")

        recent = sorted(
            records,
            key=lambda x: x.get("frame_number", 0),
            reverse=True,
        )[:20]

        table = []

        for record in recent:

            fingerprint = record.get("fingerprint", "")

            table.append({
                "Frame": record.get("frame_number"),
                "SHA-256": fingerprint[:16] + "...",
                "Timestamp": record.get("timestamp"),
                "Status": record.get("status"),
            })

        if table:

            st.dataframe(
                pd.DataFrame(table),
                use_container_width=True,
                hide_index=True,
            )

        st.divider()

        st.subheader("🗓️ Evidence Retention")

        retention_days = st.number_input(
            "Retention Period",
            min_value=1,
            value=30,
            step=1,
        )

        timestamps = [
            r["timestamp"]
            for r in records
            if r.get("timestamp")
        ]

        if timestamps:

            try:

                latest_timestamp = max(timestamps)

                latest = datetime.fromisoformat(
                    latest_timestamp.replace(
                        "Z",
                        "+00:00",
                    )
                )

                if latest.tzinfo:
                    latest = latest.replace(tzinfo=None)

                age = (
                    datetime.now() - latest
                ).total_seconds() / 86400

                remaining = retention_days - age

                st.write(
                    f"**Evidence Age:** {age:.1f} days"
                )

                if remaining > 7:

                    st.success(
                        f"🟢 Active — {remaining:.1f} days remaining"
                    )

                elif remaining > 0:

                    st.warning(
                        f"🟡 Expiring Soon — {remaining:.1f} days remaining"
                    )

                else:

                    st.error("🔴 Evidence Expired")

            except Exception:

                st.warning(
                    "Unable to calculate retention status."
                )

        st.divider()

        st.subheader("🗑️ Secure Evidence Deletion")

        st.warning(
            "Deletion is permanent. Only evidence older "
            "than the configured retention period can "
            "be deleted."
        )

        cutoff = (
            datetime.now()
            - timedelta(days=retention_days)
        )

        expired_records = []

        for record in records:

            timestamp = record.get("timestamp")

            if not timestamp:
                continue

            try:

                record_date = datetime.fromisoformat(
                    timestamp.replace(
                        "Z",
                        "+00:00",
                    )
                )

                if record_date.tzinfo:
                    record_date = record_date.replace(
                        tzinfo=None
                    )

                if record_date < cutoff:
                    expired_records.append(record)

            except Exception:
                continue

        st.write(
            f"**Records eligible for deletion:** "
            f"{len(expired_records)}"
        )

        if not expired_records:

            st.success(
                "✅ No expired evidence is currently "
                "eligible for deletion."
            )

        else:

            st.error(
                f"🔴 {len(expired_records)} records "
                "are eligible for permanent deletion."
            )

            confirmation = st.text_input(
                'Type "DELETE EXPIRED EVIDENCE" '
                "to enable deletion"
            )

            delete_button = st.button(
                "🗑️ Permanently Delete Expired Evidence",
                type="primary",
                disabled=(
                    confirmation !=
                    "DELETE EXPIRED EVIDENCE"
                ),
                use_container_width=True,
            )

            if delete_button:

                deleted = 0

                try:

                    for record in expired_records:

                        record_id = record.get("id")

                        if record_id is not None:

                            (
                                supabase
                                .table("fingerprints")
                                .delete()
                                .eq("id", record_id)
                                .execute()
                            )

                            deleted += 1

                    st.success(
                        f"✅ Deleted {deleted} "
                        "expired evidence records."
                    )

                    st.rerun()

                except Exception as e:

                    st.error(
                        f"❌ Deletion failed: {e}"
                    )

    else:

        st.warning(
            "No cloud evidence found for the "
            "selected driver and video."
        )


# ============================================================
# FOOTER
# ============================================================

st.markdown(
    """
    <div class="footer">
        <strong style="color:#526174;">DASHCAM ASSURANCE</strong><br>
        Certified Digital Evidence Integrity System · SHA-256 · Supabase · Streamlit
    </div>
    """,
    unsafe_allow_html=True,
)
