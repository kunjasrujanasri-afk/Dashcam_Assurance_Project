import cv2
import numpy as np
from pathlib import Path
import hashlib
import time



# ============================================================
# SHA-256 CRYPTOGRAPHIC FINGERPRINT
# ============================================================

def sha256_frame(frame):
    """
    Generate an exact SHA-256 fingerprint for a video frame.
    """
    return hashlib.sha256(frame.tobytes()).hexdigest()


# ============================================================
# FRAME PREPROCESSING
# ============================================================

def prepare_frame(frame, size=(32, 32)):
    """
    Convert frame to grayscale and resize it.
    Used by perceptual hashing methods.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, size)
    return gray


# ============================================================
# aHASH
# ============================================================

def ahash(frame):
    """
    Average Hash (aHash).
    Returns a 64-bit binary string.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (8, 8))

    average = resized.mean()
    hash_bits = resized >= average

    return ''.join('1' if bit else '0' for bit in hash_bits.flatten())


# ============================================================
# dHASH
# ============================================================

def dhash(frame):
    """
    Difference Hash (dHash).

    Compares horizontal pixel differences.
    Returns a 64-bit binary string.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # 9x8 because we compare each pixel with the pixel to its right
    resized = cv2.resize(gray, (9, 8))

    difference = resized[:, 1:] >= resized[:, :-1]

    return ''.join('1' if bit else '0' for bit in difference.flatten())


# ============================================================
# pHASH
# ============================================================

def phash(frame):
    """
    Perceptual Hash (pHash).

    Uses DCT coefficients to create a 64-bit
    perceptual fingerprint.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Resize to 32x32 for DCT
    resized = cv2.resize(gray, (32, 32))

    # Convert to float
    pixels = np.float32(resized)

    # Apply 2D Discrete Cosine Transform
    dct = cv2.dct(pixels)

    # Take the top-left 8x8 low-frequency coefficients
    dct_low = dct[:8, :8]

    # Ignore the DC coefficient at [0,0]
    values = dct_low.flatten()[1:]

    median = np.median(values)

    hash_bits = values >= median

    return ''.join('1' if bit else '0' for bit in hash_bits)


# ============================================================
# wHASH
# ============================================================

def whash(frame):
    """
    Wavelet-style Hash (wHash).

    Uses a simple Haar-like approximation to generate
    a 64-bit perceptual fingerprint.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Resize to 16x16
    resized = cv2.resize(gray, (16, 16)).astype(np.float32)

    # Simple 2x2 Haar-like averaging
    low = (
        resized[0::2, 0::2]
        + resized[0::2, 1::2]
        + resized[1::2, 0::2]
        + resized[1::2, 1::2]
    ) / 4.0

    # 8x8 = 64 values
    median = np.median(low)

    hash_bits = low >= median

    return ''.join('1' if bit else '0' for bit in hash_bits.flatten())
# ============================================================
# HAMMING DISTANCE
# ============================================================

def hamming_distance(hash1, hash2):
    """
    Calculate the number of different bits
    between two binary perceptual hashes.
    """

    if len(hash1) != len(hash2):
        raise ValueError(
            f"Hash lengths must be equal: "
            f"{len(hash1)} != {len(hash2)}"
        )

    return sum(bit1 != bit2 for bit1, bit2 in zip(hash1, hash2))

# ============================================================
# NORMALIZED HAMMING DISTANCE
# ============================================================

def normalized_hamming_distance(hash1, hash2):
    """
    Calculate normalized Hamming distance.

    Returns a value between 0 and 1.
    0.0 = identical
    1.0 = completely different
    """

    distance = hamming_distance(hash1, hash2)

    return distance / len(hash1)


# ============================================================
# SIMILARITY SCORE
# ============================================================

def similarity_score(hash1, hash2):
    """
    Calculate perceptual similarity percentage.

    100% = identical
    0% = completely different
    """

    normalized_distance = normalized_hamming_distance(hash1, hash2)

    return (1.0 - normalized_distance) * 100.0


def vector_distances(vector_a, vector_b):
    """Return L2, L1 and cosine metrics for numeric frame descriptors."""
    a = np.asarray(vector_a, dtype=np.float64).ravel()
    b = np.asarray(vector_b, dtype=np.float64).ravel()
    if a.shape != b.shape:
        raise ValueError("Feature vectors must have the same shape.")
    delta = a - b
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    cosine = float(np.dot(a, b) / denominator) if denominator else (1.0 if not np.any(a) and not np.any(b) else 0.0)
    return {"euclidean_l2": float(np.linalg.norm(delta)),
            "manhattan_l1": float(np.abs(delta).sum()),
            "cosine_similarity": cosine,
            "cosine_distance": 1.0 - cosine}


def optional_fuzzy_metrics(data_a: bytes, data_b: bytes) -> dict:
    """Report ssdeep/TLSH comparisons only when their optional Windows wheels exist."""
    metrics = {}
    try:
        import ssdeep
        metrics["ssdeep"] = {"available": True, "similarity": ssdeep.compare(ssdeep.hash(data_a), ssdeep.hash(data_b))}
    except Exception as exc:
        metrics["ssdeep"] = {"available": False, "reason": str(exc)}
    try:
        import tlsh
        hash_a, hash_b = tlsh.hash(data_a), tlsh.hash(data_b)
        metrics["tlsh"] = {"available": bool(hash_a and hash_b), "distance": tlsh.diff(hash_a, hash_b) if hash_a and hash_b else None}
    except Exception as exc:
        metrics["tlsh"] = {"available": False, "reason": str(exc)}
    return metrics

# ============================================================
# FRAME INFORMATION
# ============================================================

def get_video_info(video_path):

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    duration = frame_count / fps if fps > 0 else 0

    cap.release()

    return {
        "frames": frame_count,
        "fps": fps,
        "width": width,
        "height": height,
        "duration": duration
    }


# ============================================================
# TEST ONE FRAME
# ============================================================

def compare_frame(frame_a, frame_b):

    results = {}

    hashes = {
        "aHash": (ahash(frame_a), ahash(frame_b)),
        "dHash": (dhash(frame_a), dhash(frame_b)),
        "pHash": (phash(frame_a), phash(frame_b)),
        "wHash": (whash(frame_a), whash(frame_b)),
    }

    for name, (hash_a, hash_b) in hashes.items():

        distance = hamming_distance(hash_a, hash_b)

        normalized = normalized_hamming_distance(
            hash_a,
            hash_b
        )

        similarity = similarity_score(
            hash_a,
            hash_b
        )

        results[name] = {
            "hamming_distance": distance,
            "normalized_distance": normalized,
            "similarity_percent": similarity
        }

    return results


# ============================================================
# TEST FIRST FRAME OF TWO VIDEOS
# ============================================================

def compare_first_frames(video_a, video_b):

    cap_a = cv2.VideoCapture(video_a)
    cap_b = cv2.VideoCapture(video_b)

    if not cap_a.isOpened():
        raise ValueError(f"Could not open: {video_a}")

    if not cap_b.isOpened():
        raise ValueError(f"Could not open: {video_b}")

    success_a, frame_a = cap_a.read()
    success_b, frame_b = cap_b.read()

    cap_a.release()
    cap_b.release()

    if not success_a:
        raise ValueError("Could not read first frame from video A.")

    if not success_b:
        raise ValueError("Could not read first frame from video B.")

    start = time.perf_counter()

    results = compare_frame(frame_a, frame_b)

    processing_time = time.perf_counter() - start

    return results, processing_time


# ============================================================

# ============================================================
# FRAME MATCHING ENGINE
# ============================================================

def match_video_frames(
    reference_video,
    test_video,
    hash_method="phash",
    sample_interval=30,
    match_threshold=70.0
):
    """
    Compare frames from two videos using perceptual hashing.

    match_threshold is the minimum similarity percentage
    required for an individual frame to be classified as MATCH.
    """

    hash_functions = {
        "ahash": ahash,
        "dhash": dhash,
        "phash": phash,
        "whash": whash,
    }

    if hash_method not in hash_functions:
        raise ValueError(
            "Unknown hash method. "
            "Use: ahash, dhash, phash, or whash."
        )

    if not 0 <= match_threshold <= 100:
        raise ValueError(
            "match_threshold must be between 0 and 100."
        )

    hash_function = hash_functions[hash_method]

    reference_cap = cv2.VideoCapture(reference_video)
    test_cap = cv2.VideoCapture(test_video)

    if not reference_cap.isOpened():
        raise ValueError(
            f"Could not open reference video: {reference_video}"
        )

    if not test_cap.isOpened():
        raise ValueError(
            f"Could not open test video: {test_video}"
        )

    reference_frames = int(
        reference_cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )
    test_frames = int(
        test_cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )

    frame_results = []
    processed = 0
    matched_count = 0

    while True:
        reference_ok, reference_frame = reference_cap.read()
        test_ok, test_frame = test_cap.read()

        if not reference_ok or not test_ok:
            break

        current_frame = processed

        if current_frame % sample_interval == 0:
            reference_hash = hash_function(reference_frame)
            test_hash = hash_function(test_frame)

            distance = hamming_distance(
                reference_hash,
                test_hash
            )

            normalized = normalized_hamming_distance(
                reference_hash,
                test_hash
            )

            similarity = similarity_score(
                reference_hash,
                test_hash
            )

            is_match = similarity >= match_threshold

            if is_match:
                matched_count += 1

            frame_results.append({
                "frame": current_frame,
                "distance": distance,
                "normalized_distance": normalized,
                "similarity": similarity,
                "match": "MATCH" if is_match else "NO MATCH"
            })

        processed += 1

    reference_cap.release()
    test_cap.release()

    frames_compared = len(frame_results)

    if frames_compared > 0:
        average_similarity = (
            sum(item["similarity"] for item in frame_results)
            / frames_compared
        )
        average_distance = (
            sum(item["distance"] for item in frame_results)
            / frames_compared
        )
        maximum_distance = max(
            item["distance"] for item in frame_results
        )
        minimum_similarity = min(
            item["similarity"] for item in frame_results
        )
        matched_frames_percentage = (
            matched_count / frames_compared
        ) * 100.0
    else:
        average_similarity = 0.0
        average_distance = 0.0
        maximum_distance = 0.0
        minimum_similarity = 0.0
        matched_frames_percentage = 0.0

    unmatched_count = frames_compared - matched_count

    return {
        "reference_frames": reference_frames,
        "test_frames": test_frames,
        "frames_processed": processed,
        "frames_compared": frames_compared,
        "average_similarity": average_similarity,
        "average_distance": average_distance,
        "maximum_distance": maximum_distance,
        "minimum_similarity": minimum_similarity,
        "match_threshold": match_threshold,
        "matched_frames": matched_count,
        "unmatched_frames": unmatched_count,
        "matched_frames_percentage": matched_frames_percentage,
        "frame_results": frame_results,
    }


# ============================================================
# TEMPORAL ALIGNMENT
# ============================================================

def find_best_temporal_match(
    reference_video,
    test_video,
    hash_method="phash",
    sample_interval=5,
    search_step=5,
    match_threshold=70.0,
    max_shift=None
):
    """
    Find the best temporal alignment between two videos.

    Optimized implementation:
    - Reads each video sequentially only once.
    - Stores sampled perceptual hashes.
    - Avoids repeated cv2 frame seeking, which can be extremely slow.
    - Searches temporal offsets using the stored hashes.

    Returns the offset that produces the highest average similarity.
    """

    hash_functions = {
        "ahash": ahash,
        "dhash": dhash,
        "phash": phash,
        "whash": whash,
    }

    if hash_method not in hash_functions:
        raise ValueError(
            f"Unknown hash method: {hash_method}. "
            f"Use ahash, dhash, phash, or whash."
        )

    if sample_interval < 1:
        raise ValueError("sample_interval must be >= 1.")

    if search_step < 1:
        raise ValueError("search_step must be >= 1.")

    if not 0 <= match_threshold <= 100:
        raise ValueError(
            "match_threshold must be between 0 and 100."
        )

    hash_function = hash_functions[hash_method]

    ref_cap = cv2.VideoCapture(reference_video)
    test_cap = cv2.VideoCapture(test_video)

    if not ref_cap.isOpened():
        raise ValueError(
            f"Could not open reference video: {reference_video}"
        )

    if not test_cap.isOpened():
        ref_cap.release()
        raise ValueError(
            f"Could not open test video: {test_video}"
        )

    reference_total = int(
        ref_cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )

    test_total = int(
        test_cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )
    ref_fps = ref_cap.get(cv2.CAP_PROP_FPS)
    test_fps = test_cap.get(cv2.CAP_PROP_FPS)

    # --------------------------------------------------------
    # Read reference video sequentially
    # --------------------------------------------------------

    reference_hashes = {}

    frame_index = 0

    while True:
        success, frame = ref_cap.read()

        if not success:
            break

        if frame_index % sample_interval == 0:
            reference_hashes[frame_index] = (
                hash_function(frame)
            )

        frame_index += 1

    ref_cap.release()

    # --------------------------------------------------------
    # Read test video sequentially
    # --------------------------------------------------------

    test_hashes = {}

    frame_index = 0

    while True:
        success, frame = test_cap.read()

        if not success:
            break

        if frame_index % sample_interval == 0:
            test_hashes[frame_index] = (
                hash_function(frame)
            )

        frame_index += 1

    test_cap.release()

    if not reference_hashes:
        raise ValueError(
            "No reference frames were available for matching."
        )

    if not test_hashes:
        raise ValueError(
            "No test frames were available for matching."
        )

    # --------------------------------------------------------
    # Determine search range
    # --------------------------------------------------------

    max_possible_shift = max(
        reference_total,
        test_total
    ) if max_shift is None else min(int(max_shift), max(reference_total, test_total))
    if max_possible_shift < 0:
        raise ValueError("max_shift must be >= 0.")


    best_shift = 0
    best_similarity = -1.0
    best_matches = 0
    best_comparisons = 0

    shift_results = []

    # --------------------------------------------------------
    # Compare stored hashes for each temporal offset
    # --------------------------------------------------------

    for shift in range(
        -max_possible_shift,
        max_possible_shift + 1,
        search_step
    ):

        similarities = []
        matched_count = 0

        for test_index, test_hash in test_hashes.items():

            reference_index = test_index + shift

            if reference_index not in reference_hashes:
                continue

            reference_hash = reference_hashes[
                reference_index
            ]

            similarity = similarity_score(
                reference_hash,
                test_hash
            )

            similarities.append(similarity)

            if similarity >= match_threshold:
                matched_count += 1

        if not similarities:
            continue

        average_similarity = (
            sum(similarities)
            / len(similarities)
        )

        matched_percentage = (
            matched_count
            / len(similarities)
            * 100.0
        )

        result = {
            "shift": shift,
            "average_similarity": average_similarity,
            "frames_compared": len(similarities),
            "matched_frames": matched_count,
            "matched_frames_percentage": matched_percentage,
        }

        shift_results.append(result)

        if (average_similarity, len(similarities)) > (best_similarity, best_comparisons):

            best_similarity = average_similarity
            best_shift = shift
            best_matches = matched_count
            best_comparisons = len(similarities)

    if best_comparisons > 0:
        best_matched_percentage = (
            best_matches
            / best_comparisons
            * 100.0
        )
    else:
        best_matched_percentage = 0.0

    matched_test_positions = [
        test_index for test_index in test_hashes
        if test_index + best_shift in reference_hashes
    ]
    start_position = min(matched_test_positions) if matched_test_positions else None
    end_position = max(matched_test_positions) if matched_test_positions else None
    fps = test_fps or ref_fps or 0

    return {
        "best_shift": best_shift,
        "best_temporal_offset": best_shift,
        "shift_frames": best_shift,
        "shift_seconds": best_shift / fps if fps > 0 else None,
        "matched_start_frame": start_position,
        "matched_end_frame": end_position,
        "matched_start_seconds": start_position / fps if start_position is not None and fps > 0 else None,
        "matched_end_seconds": end_position / fps if end_position is not None and fps > 0 else None,
        "best_similarity": best_similarity,
        "average_similarity": best_similarity,
        "reference_frames": reference_total,
        "test_frames": test_total,
        "frames_compared": best_comparisons,
        "matched_frames": best_matches,
        "matched_frames_percentage": best_matched_percentage,
        "match_threshold": match_threshold,
        "sample_interval": sample_interval,
        "search_step": search_step,
        "hash_method": hash_method,
        "max_shift": max_possible_shift,
        "shift_results": shift_results,
    }



# ============================================================
# CLASSIFICATION
# ============================================================

def classify_similarity(similarity, threshold=70.0):
    """Classify using the selected/evaluated threshold, not hard-coded bands."""
    if not 0 <= float(threshold) <= 100:
        raise ValueError("threshold must be between 0 and 100.")
    return "MATCH" if float(similarity) >= float(threshold) else "NO MATCH"


# ============================================================
# CREATE TRIMMED VIDEO
# ============================================================

def create_trimmed_video(
    input_video,
    output_video,
    start_seconds=0,
    end_seconds=None
):
    """
    Create a trimmed copy of a video.
    """

    cap = cv2.VideoCapture(input_video)

    if not cap.isOpened():
        raise ValueError(
            f"Could not open video: {input_video}"
        )

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(
        cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    )
    height = int(
        cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )
    total_frames = int(
        cap.get(cv2.CAP_PROP_FRAME_COUNT)
    )

    if fps <= 0:
        cap.release()
        raise ValueError(
            "Could not determine video FPS."
        )

    start_frame = int(
        start_seconds * fps
    )

    if end_seconds is None:
        end_frame = total_frames
    else:
        end_frame = int(
            end_seconds * fps
        )

    if start_frame >= total_frames:
        cap.release()
        raise ValueError(
            "Start time is beyond the end of the video."
        )

    end_frame = min(
        end_frame,
        total_frames
    )

    if end_frame <= start_frame:
        cap.release()
        raise ValueError(
            "Invalid trim range."
        )

    fourcc = cv2.VideoWriter_fourcc(
        *"mp4v"
    )

    writer = cv2.VideoWriter(
        output_video,
        fourcc,
        fps,
        (width, height)
    )

    cap.set(
        cv2.CAP_PROP_POS_FRAMES,
        start_frame
    )

    current_frame = start_frame

    while current_frame < end_frame:
        ret, frame = cap.read()

        if not ret:
            break

        writer.write(frame)
        current_frame += 1

    cap.release()
    writer.release()

    if not Path(output_video).exists():
        raise RuntimeError(
            "Trimmed video was not created."
        )

    return {
        "input_video": str(input_video),
        "output_video": str(output_video),
        "start_seconds": start_seconds,
        "end_seconds": (
            end_seconds
            if end_seconds is not None
            else total_frames / fps
        ),
        "frames_written": current_frame - start_frame,
        "fps": fps,
    }


# ============================================================
# MAIN TEST
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("DASHCAM ASSURANCE - FINGERPRINT EVALUATION")
    print("=" * 60)
    print()
    print("Evaluation engine loaded successfully.")
    print()
    print("Available fingerprint methods:")
    print("1. SHA-256")
    print("2. aHash")
    print("3. dHash")
    print("4. pHash")
    print("5. wHash")
    print()
    print("Available metrics:")
    print("1. Hamming distance")
    print("2. Normalized Hamming distance")
    print("3. Similarity percentage")
    print("4. Matched frames percentage")
    print()
    print("Frame matching engine is ready.")
def compare_video_all_hashes(
    reference_video,
    test_video,
    sample_interval=5,
    match_threshold=70.0,
    temporal_alignment=True,
    search_step=5
):
    """
    Compare two videos using all perceptual hash methods:
    aHash, dHash, pHash and wHash.

    Returns results for every hash method.
    """

    methods = {}

    hash_methods = ["ahash", "dhash", "phash", "whash"]

    for method in hash_methods:

        print(f"Testing {method}...")

        if temporal_alignment:
            result = find_best_temporal_match(
                reference_video,
                test_video,
                hash_method=method,
                sample_interval=sample_interval,
                search_step=search_step,
                match_threshold=match_threshold
            )

            methods[method] = result

        else:
            result = match_video_frames(
                reference_video,
                test_video,
                hash_method=method,
                sample_interval=sample_interval,
                match_threshold=match_threshold
            )

            methods[method] = result

    return {
        "reference_video": reference_video,
        "test_video": test_video,
        "sample_interval": sample_interval,
        "match_threshold": match_threshold,
        "temporal_alignment": temporal_alignment,
        "search_step": search_step,
        "methods": methods
    }
