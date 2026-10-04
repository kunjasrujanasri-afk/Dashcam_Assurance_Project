import os
from pathlib import Path
from datetime import datetime

import streamlit as st
from dotenv import load_dotenv
from supabase import create_client


# ============================================================
# CONFIGURATION
# ============================================================

st.set_page_config(
    page_title="Evidence Administration",
    page_icon="🛠️",
    layout="wide"
)

BASE_DIR = Path(__file__).resolve().parent.parent

# Load .env
load_dotenv(BASE_DIR / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SECRET_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("❌ Supabase configuration is missing.")
    st.stop()

try:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as e:
    st.error(f"❌ Could not connect to Supabase: {e}")
    st.stop()


# ============================================================
# HEADER
# ============================================================

st.title("🛠️ Evidence Administration")
st.caption("Dashcam Assurance — Cloud Evidence Management")

st.divider()


# ============================================================
# SIDEBAR
# ============================================================

st.sidebar.header("🔧 Evidence Selection")

driver_id = st.sidebar.text_input(
    "Driver ID",
    value="driver-01"
)

video_name = st.sidebar.text_input(
    "Video Name",
    value="dashcam_test.mp4"
)

refresh_button = st.sidebar.button(
    "🔄 Refresh Evidence",
    use_container_width=True
)


# ============================================================
# FETCH CLOUD EVIDENCE
# ============================================================

@st.cache_data(ttl=30)
def get_evidence(driver_id, video_name):

    all_records = []

    start = 0
    batch_size = 1000

    while True:

        response = (
            supabase
            .table("fingerprints")
            .select(
                "id,driver_id,frame_number,fingerprint,"
                "timestamp,video_name,status,created_at"
            )
            .eq("driver_id", driver_id)
            .eq("video_name", video_name)
            .order("frame_number")
            .range(start, start + batch_size - 1)
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


if refresh_button:
    get_evidence.clear()


# ============================================================
# LOAD DATA
# ============================================================

try:
    records = get_evidence(driver_id, video_name)

except Exception as e:
    st.error(f"❌ Error retrieving cloud evidence: {e}")
    st.stop()


# ============================================================
# DATABASE STATUS
# ============================================================

st.subheader("☁️ Cloud Database")

if records:

    total_records = len(records)

    unique_frames = len(
        set(record["frame_number"] for record in records)
    )

    duplicate_frames = total_records - unique_frames

    pending_records = sum(
        1
        for record in records
        if str(record.get("status", "")).lower() == "pending"
    )

    sent_records = total_records - pending_records

    timestamps = [
        record["timestamp"]
        for record in records
        if record.get("timestamp")
    ]

    latest_timestamp = max(timestamps) if timestamps else "N/A"

    col1, col2, col3, col4 = st.columns(4)

    with col1:
        st.metric(
            "Total Fingerprints",
            total_records
        )

    with col2:
        st.metric(
            "Unique Frames",
            unique_frames
        )

    with col3:
        st.metric(
            "Successfully Stored",
            sent_records
        )

    with col4:
        st.metric(
            "Pending",
            pending_records
        )

else:

    st.warning(
        "⚠️ No cloud evidence found for the selected driver and video."
    )

    st.stop()


# ============================================================
# EVIDENCE INFORMATION
# ============================================================

st.divider()

st.subheader("🎥 Evidence Information")

info1, info2, info3, info4 = st.columns(4)

with info1:
    st.write("**Driver ID**")
    st.write(driver_id)

with info2:
    st.write("**Video Name**")
    st.write(video_name)

with info3:
    st.write("**Fingerprint Algorithm**")
    st.write("SHA-256")

with info4:
    st.write("**Evidence Status**")

    if pending_records == 0:
        st.success("CERTIFIED")
    else:
        st.warning("PENDING")


# ============================================================
# DUPLICATE CHECK
# ============================================================

if duplicate_frames > 0:

    st.warning(
        f"⚠️ {duplicate_frames} duplicate frame record(s) detected "
        "in the cloud database."
    )

else:

    st.success(
        "✅ No duplicate frame records detected."
    )


# ============================================================
# RECENT CLOUD EVIDENCE
# ============================================================

st.divider()

st.subheader("📋 Recent Cloud Evidence")

# Show the latest 20 frames
recent_records = sorted(
    records,
    key=lambda x: x["frame_number"],
    reverse=True
)[:20]


display_records = []

for record in recent_records:

    fingerprint = record.get("fingerprint", "")

    # Show shortened fingerprint for readability
    short_fingerprint = (
        fingerprint[:16] + "..."
        if len(fingerprint) > 16
        else fingerprint
    )

    display_records.append(
        {
            "Frame": record.get("frame_number"),
            "Fingerprint": short_fingerprint,
            "Timestamp": record.get("timestamp"),
            "Status": record.get("status"),
            "Created At": record.get("created_at")
        }
    )


st.dataframe(
    display_records,
    use_container_width=True,
    hide_index=True
)


# ============================================================
# DATABASE SUMMARY
# ============================================================

st.divider()

st.subheader("📊 Database Summary")

summary_col1, summary_col2 = st.columns(2)

with summary_col1:

    st.write("**Frames Stored:**", total_records)

    st.write("**Unique Frames:**", unique_frames)

    st.write("**Duplicate Records:**", duplicate_frames)

with summary_col2:

    st.write("**Successfully Stored:**", sent_records)

    st.write("**Pending Records:**", pending_records)

    st.write("**Latest Evidence Timestamp:**", latest_timestamp)


# ============================================================
# ADMINISTRATION NOTE
# ============================================================

st.divider()

st.info(
    "🔐 Administration Mode is currently read-only. "
    "No cloud evidence is modified or deleted from this page."
)
# ============================================================
# EVIDENCE RETENTION MANAGEMENT
# ============================================================

st.divider()

st.subheader("🗓️ Evidence Retention")

retention_days = st.number_input(
    "Retention Period (days)",
    min_value=1,
    value=30,
    step=1
)

if timestamps:

    try:
        latest_evidence = datetime.fromisoformat(
            latest_timestamp.replace("Z", "+00:00")
        )

        # Remove timezone if present
        if latest_evidence.tzinfo is not None:
            latest_evidence = latest_evidence.replace(tzinfo=None)

        current_time = datetime.now()

        age_days = (
            current_time - latest_evidence
        ).total_seconds() / 86400

        remaining_days = retention_days - age_days

        st.write(
            f"**Evidence Age:** {age_days:.1f} days"
        )

        st.write(
            f"**Retention Period:** {retention_days} days"
        )

        if remaining_days > 7:

            st.success(
                f"🟢 Evidence Active — "
                f"{remaining_days:.1f} days remaining"
            )

        elif remaining_days > 0:

            st.warning(
                f"🟡 Evidence Expiring Soon — "
                f"{remaining_days:.1f} days remaining"
            )

        else:

            st.error(
                f"🔴 Evidence Expired — "
                f"{abs(remaining_days):.1f} days past retention period"
            )

    except Exception:

        st.warning(
            "⚠️ Unable to calculate evidence age."
        )

else:

    st.info(
        "No evidence timestamp available."
    )


# ============================================================
# RETENTION POLICY
# ============================================================

st.subheader("🔐 Retention Policy")

st.info(
    "Evidence is retained for the configured period before it "
    "becomes eligible for secure deletion. "
    "Deletion is intentionally disabled in this version."
)
# ============================================================
# SECURE EVIDENCE DELETION
# ============================================================

st.divider()

st.subheader("🗑️ Secure Evidence Deletion")

st.warning(
    "⚠️ Deletion is permanent. Only evidence older than the "
    "configured retention period can be deleted."
)

# Calculate deletion cutoff
try:
    current_time = datetime.now()

    cutoff_time = current_time.timestamp() - (
        retention_days * 86400
    )

    expired_records = []

    for record in records:

        record_timestamp = record.get("timestamp")

        if not record_timestamp:
            continue

        try:
            record_date = datetime.fromisoformat(
                record_timestamp.replace("Z", "+00:00")
            )

            if record_date.tzinfo is not None:
                record_date = record_date.replace(tzinfo=None)

            if record_date.timestamp() < cutoff_time:
                expired_records.append(record)

        except Exception:
            continue

    expired_count = len(expired_records)

    st.write(
        f"**Records eligible for deletion:** {expired_count}"
    )

    if expired_count == 0:

        st.success(
            "✅ No expired evidence is currently eligible for deletion."
        )

    else:

        st.error(
            f"🔴 {expired_count} expired fingerprint record(s) "
            "are eligible for permanent deletion."
        )

        confirmation = st.text_input(
            'Type "DELETE EXPIRED EVIDENCE" to enable deletion'
        )

        delete_button = st.button(
            "🗑️ Permanently Delete Expired Evidence",
            type="primary",
            disabled=(
                confirmation != "DELETE EXPIRED EVIDENCE"
            ),
            use_container_width=True
        )

        if delete_button:

            try:

                deleted_count = 0

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

                        deleted_count += 1

                st.success(
                    f"✅ Successfully deleted "
                    f"{deleted_count} expired evidence record(s)."
                )

                st.cache_data.clear()

                st.rerun()

            except Exception as e:

                st.error(
                    f"❌ Secure deletion failed: {e}"
                )

except Exception as e:

    st.error(
        f"❌ Could not evaluate expired evidence: {e}"
    )