/**
 * Central configuration shared by the Encoder (driver phone) and the Decoder
 * (insurer). Values can be tuned here without touching the logic.
 */

/** Frames per second drawn onto the composition canvas. */
export const CAPTURE_FPS = 15;

/** Target resolution requested from the camera (the phone may give less). */
export const CAPTURE_WIDTH = 1280;
export const CAPTURE_HEIGHT = 720;

/** Video bitrate for MediaRecorder (bits/s). */
export const VIDEO_BITS_PER_SECOND = 1_500_000;

/** Length of one video segment. Each segment = one file = one hash. */
export const SEGMENT_OPTIONS_MS = [5_000, 10_000, 30_000] as const;
export const DEFAULT_SEGMENT_MS = 5_000;

/**
 * Loop-recording retention on the phone: segments older than this are
 * considered no longer valid and are deleted, unless locked by an incident.
 */
export const RETENTION_OPTIONS_MS = [60_000, 3 * 60_000, 10 * 60_000, 60 * 60_000] as const;
export const DEFAULT_RETENTION_MS = 3 * 60_000;

/** Hard cap on the number of segments kept on the phone (storage guard). */
export const MAX_LOCAL_SEGMENTS = 400;

/** An incident locks this much video before and after the button press. */
export const INCIDENT_LOCK_BEFORE_MS = 30_000;
export const INCIDENT_LOCK_AFTER_MS = 30_000;

/** Outbox (hash transmission) tuning. */
export const OUTBOX_BATCH_SIZE = 25;
export const OUTBOX_POLL_MS = 3_000;
export const OUTBOX_BACKOFF_MAX_MS = 30_000;

/**
 * Decoder: a hash that reached the server more than this after the end of
 * its segment is flagged "delayed" (it was buffered while offline). It is
 * still valid, but the insurer sees the anchoring was not immediate.
 */
export const ANCHOR_DELAY_WARN_MS = 60_000;

/** Supabase Storage bucket where drivers submit incident clips. */
export const EVIDENCE_BUCKET = "evidence";

/** Protocol version prefix included in every chain-hash computation. */
export const PROTOCOL_VERSION = "dashcam-v1";
