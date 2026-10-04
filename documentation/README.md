#### Dashcam Assurance

Certified Digital Evidence Integrity Platform

Dashcam Assurance is a Streamlit-based digital evidence platform for
capturing dashcam footage, generating frame-level SHA-256 fingerprints,
storing evidence fingerprints in Supabase, and verifying video integrity
for insurance-related evidence workflows.

The project supports both uploaded dashcam footage and browser-based
camera recording.

#### 1. Project Overview

The system is designed around four main stages:

Capture --- upload an existing dashcam video or record evidence
from a browser camera.

Fingerprint --- calculate a SHA-256 fingerprint for each video
frame.

Certify --- store frame fingerprints and evidence metadata in
Supabase.

Verify --- compare a selected video against its stored
fingerprints and generate an integrity report.
The application also includes an administration area for viewing cloud
evidence statistics and handling retention-based deletion.

#### 2. Main Features

Evidence Capture

Upload video files.

Record video directly from a browser camera.

Automatically set newly uploaded or recorded footage as the active
evidence.

Display video information such as frame count, FPS, resolution, and
duration.

Support common video formats such as MP4, AVI, MOV, MKV, and WEBM
where supported by the installed video codecs.

Cryptographic Fingerprinting

SHA-256 hashing is applied to each decoded video frame.

Each fingerprint is associated with:

Driver ID

Frame number

Timestamp

Video name

Fingerprint

Evidence status

Cloud Evidence Storage

Supabase PostgreSQL is used for cloud storage.

Fingerprints are stored in the public.fingerprints table.

Uploads can be processed in batches.

Existing records are checked to reduce duplicate fingerprint
insertion.

Insurance Verification

The selected video is decoded frame-by-frame.

Each calculated SHA-256 fingerprint is compared with the
corresponding cloud fingerprint.

The system reports:

Frames checked

Verified frames

Corrupted frames

Missing frames

Integrity percentage

Verification status

A verification report can be downloaded.

Administration

View cloud evidence statistics.

View recent evidence records.

Check pending/duplicate information.

Configure a retention period.

Permanently delete expired cloud fingerprint records after
confirmation.

#### 3. Technology Stack

Technology         Purpose

Python             Application and processing logic
Streamlit          Web interface
OpenCV             Video decoding and frame processing
hashlib            SHA-256 fingerprint generation
Supabase           Cloud PostgreSQL database
python-dotenv      Environment variable management
streamlit-webrtc   Browser camera/WebRTC integration
aiortc             WebRTC media handling and recording

4. Project Structure

Dashcam_Assurance_Project/
│
├── app.py
├── .env
├── requirements.txt
│
├── assets/
│   
│
├── videos/
│   ├── uploaded videos
│   └── camera recordings
│
├── database/
│   └── fingerprints.txt
│
├── encoder/
│   └── encoder.py
    |___store recorded videos
│
└── decoder/
    ├── decoder.py
    └── admin.py


#### 5. Installation

Requirements

Recommended environment:

Windows, macOS, or Linux

Python 3.10+ recommended

Internet connection for Supabase access

A modern browser for camera recording

Create a virtual environment

Windows PowerShell:

cd "C:\Users\sampa\OneDrive\Desktop\Dashcam_Assurance_Project"

python -m venv venv

.\venv\Scripts\Activate.ps1

If PowerShell blocks activation, run the project using the Python
executable inside venv directly or adjust the local PowerShell
execution policy according to your system's policy.

Install dependencies

pip install -r requirements.txt

If requirements.txt does not yet exist:

pip freeze > requirements.txt

For browser camera recording, the project uses:

streamlit-webrtc
aiortc
av

#### 6. Environment Configuration

Create a .env file in the project root.

Example:

SUPABASE_URL=your_supabase_project_url
SUPABASE_SECRET_KEY=your_server_side_supabase_key


A safer Git configuration should include:

.env
venv/

inside .gitignore.

#### 7. Supabase Database

The application uses:

public.fingerprints

A representative table structure is:

create table public.fingerprints (
  id bigserial primary key,
  driver_id text not null,
  frame_number integer not null,
  fingerprint text not null,
  timestamp timestamp without time zone not null,
  video_name text,
  status text default 'pending',
  created_at timestamp without time zone default now()
);

Row Level Security (RLS) should be configured according to the
deployment/security model.

For production use, database permissions should follow the principle of
least privilege.

8. Running the Application

Start Streamlit:

cd "C:\Users\sampa\OneDrive\Desktop\Dashcam_Assurance_Project"

.\venv\Scripts\Activate.ps1

streamlit run app.py

Open the local address displayed by Streamlit, normally:

http://localhost:8501

9. Typical Workflow

Step 1 --- Select Driver

Enter the Driver ID in the application.

Example:

driver-01

Step 2 --- Capture Evidence

Go to:

Evidence Capture

Choose either:

Upload Video

Record From Camera

The newly selected video should become the active evidence.

Step 3 --- Review Evidence

Check:

Video name

Number of frames

FPS

Resolution

Duration

Step 4 --- Generate Fingerprints

Click:

Fingerprint & Certify Evidence

The application calculates SHA-256 fingerprints for the video's frames
and stores the certified fingerprints in Supabase.

Step 5 --- Verify Integrity

Go to:

Insurance Verification

Select the active evidence and run verification.

A successful unchanged video should report matching frames and a
corresponding integrity result.

Step 6 --- Generate Report

Download the generated verification report for documentation or
demonstration purposes.

Step 7 --- Administration

Use:

Administration

to inspect cloud records, statistics, and retention/deletion controls.

#### 10. Integrity Verification Concept

For each frame:

Video Frame
     |
     v
OpenCV Decode
     |
     v
SHA-256(frame bytes)
     |
     v
Calculated Fingerprint
     |
     v
Compare with Supabase fingerprint
     |
     +---- Match ------> Verified
     |
     +---- Different --> Corrupted
     |
     +---- Missing ----> Missing

The core integrity principle is:

Same frame content
      ↓
Same SHA-256 fingerprint

If the frame content changes, its calculated fingerprint is expected to
change.

#### 11. Example Verification Report

A successful verification report can contain:

INSURANCE INTEGRITY VERIFICATION REPORT
========================================
Verification Time: YYYY-MM-DD HH:MM:SS
Driver ID: driver-01
Video Name: example.mp4
Fingerprint Algorithm: SHA-256

Frames Checked: N
Verified Frames: N
Corrupted Frames: 0
Missing Frames: 0
Integrity: 100.00%
Status: VERIFIED

Verification completed successfully.

The exact frame count depends on the selected video.

#### 12. Camera Recording

The browser camera feature uses WebRTC.

For local development:

Open the application using localhost.

Allow camera permission when the browser asks.

Click START.

Record the evidence.

Click STOP.

The application saves the recording under the project's videos
directory.

Camera access can be affected by browser permissions, operating-system
camera permissions, and WebRTC configuration.

#### 13. Important Data Reset Procedure

If you intentionally want to start a completely new fingerprint dataset,
clear the cloud fingerprint table:

TRUNCATE TABLE public.fingerprints RESTART IDENTITY;

Then verify:

SELECT COUNT(*) FROM public.fingerprints;

Expected result:

0

Also remove or replace old local fingerprint files if they are no longer
required.

Do not repeatedly certify the same video unless the application is
intended to keep multiple evidence records for it.

#### 14. Security Considerations

Current security-related mechanisms include:

SHA-256 frame fingerprints.

Supabase cloud storage.

Environment variables for configuration/secrets.

RLS support on the fingerprint table.

Retention-based cloud record deletion.

Verification reports.

Production recommendations

For a production deployment, consider adding:

User authentication.

Role-based access control.

Per-user/organization authorization.

Stronger database policies.

Audit logs.

Encryption at rest and in transit.

Signed evidence manifests.

Immutable/WORM evidence storage.

Secure key management.

Server-side validation of uploaded files.

Malware/content scanning for uploaded files.

Explicit chain-of-custody records.

#### 15. Current Limitations

The system is primarily a project/prototype implementation rather
than a complete production insurance platform.

Browser camera behavior depends on WebRTC and browser permissions.

Video decoding depends on available codecs.

Local video files remain on the machine unless explicitly managed.

Cloud fingerprint deletion does not automatically imply secure
deletion of every local copy.

Authentication and full role-based authorization require additional
implementation.

SHA-256 provides integrity checking but does not by itself prove who
originally created a video.

#### 16. Troubleshooting

Supabase connection error

Check:

SUPABASE_URL
SUPABASE_SECRET_KEY

in .env.

Restart Streamlit after changing .env.

Camera does not start

Check:

Browser camera permission.

Windows camera permission.

Use localhost for local testing.

Check that no other application is exclusively using the camera.

Old evidence appears

Make sure a new video is selected as active evidence and that the
application is not automatically assigning an old default video.

The current design should not automatically select dashcam_test.mp4.

Fingerprint count is unexpectedly high

Check the Supabase table:

SELECT COUNT(*) FROM public.fingerprints;

Repeated certification can create additional records depending on the
current application logic and database constraints.


#### 17. Suggested Demonstration Sequence

For a project presentation:

Dashboard
   ↓
Evidence Capture
   ↓
Upload or Record Video
   ↓
Review Video Metadata
   ↓
Generate Certified Fingerprints
   ↓
Show Supabase Records
   ↓
Insurance Verification
   ↓
Show Integrity Result
   ↓
Download Verification Report
   ↓
Administration

#### 18. Project Goal

The goal of Dashcam Assurance is to demonstrate how cryptographic frame
fingerprinting can be used to detect changes to digital dashcam evidence
and provide a structured verification workflow for insurance-oriented
evidence handling.

#### 19. Author / Academic Project

Project: Dashcam Assurance
Type: Digital Evidence Integrity Platform
Frontend: Streamlit
Database: Supabase PostgreSQL
Integrity Algorithm: SHA-256
Video Processing: OpenCV
Camera/WebRTC: streamlit-webrtc + aiortc