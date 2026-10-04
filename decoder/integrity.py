"""Exact SHA-256 sequence verification and temporal anomaly reporting."""
from __future__ import annotations

from collections import defaultdict


def verify_hash_sequence(reference: dict[int, str], observed: list[str]) -> dict:
    """Compare exact frame digests and report mismatches, repeats, reorder and trims.

    Frame indices are one-based. Similarity is intentionally not used to grant
    VERIFIED status; callers can use the perceptual matcher for investigation.
    """
    positions: dict[str, list[int]] = defaultdict(list)
    for frame_no, digest in reference.items():
        positions[str(digest)].append(int(frame_no))
    seen: dict[str, int] = {}
    verified = modified = reordered = duplicates = missing_refs = 0
    anomalies = []
    matched_positions = []
    total_ref = max(reference, default=0)
    for index, digest in enumerate(observed, start=1):
        expected = reference.get(index)
        if expected == digest:
            verified += 1
            matched_positions.append((index, index))
        elif digest in seen:
            duplicates += 1
            anomalies.append({"candidate_frame": index, "type": "duplicate", "reference_frame": seen[digest]})
        elif digest in positions:
            target = min(positions[digest], key=lambda frame: abs(frame - index))
            reordered += 1
            matched_positions.append((index, target))
            anomalies.append({"candidate_frame": index, "type": "reordered_or_shifted", "reference_frame": target})
        elif expected is None:
            missing_refs += 1
            anomalies.append({"candidate_frame": index, "type": "no_reference_fingerprint"})
        else:
            modified += 1
            anomalies.append({"candidate_frame": index, "type": "modified_or_corrupt"})
        seen.setdefault(digest, index)
    expected_frames = set(range(1, total_ref + 1))
    represented = {ref_no for _, ref_no in matched_positions}
    missing_video_frames = sorted(expected_frames - represented)
    # If test material stops before the reference does, label the tail as trimmed.
    trailing_trim = max(0, total_ref - len(observed))
    first_offset = (matched_positions[0][1] - matched_positions[0][0]) if matched_positions else 0
    last_pair = matched_positions[-1] if matched_positions else None
    end_ref = last_pair[1] if last_pair else None
    leading_trim = max(0, first_offset)
    status = "VERIFIED" if (
        observed and len(observed) == total_ref and verified == total_ref
        and not modified and not reordered and not duplicates and not missing_refs
    ) else "INTEGRITY FAILURE"
    return {
        "status": status,
        "checked": len(observed),
        "reference_frames": total_ref,
        "verified": verified,
        "modified_or_corrupt": modified,
        "reordered_or_shifted": reordered,
        "duplicates": duplicates,
        "missing_reference_frames": len(missing_video_frames),
        "missing_candidate_fingerprints": missing_refs,
        "leading_trim_frames": leading_trim,
        "trailing_trim_frames": trailing_trim,
        "integrity": verified / len(observed) * 100 if observed else 0.0,
        "anomalies": anomalies,
        "missing_reference_positions": missing_video_frames,
        "matched_start_reference_frame": matched_positions[0][1] if matched_positions else None,
        "matched_end_reference_frame": end_ref,
    }
