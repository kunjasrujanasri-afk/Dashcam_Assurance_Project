"""Run reproducible dataset discovery, temporal matching and CSV reporting."""
from __future__ import annotations

import csv
import time
from pathlib import Path

import cv2

from evaluation.evaluation_engine import ahash, dhash, phash, whash, similarity_score
from evaluation.metrics import evaluate_thresholds, recommend_threshold

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "evaluation" / "dataset"
RESULTS = ROOT / "evaluation" / "results"
METHODS = {"ahash": ahash, "dhash": dhash, "phash": phash, "whash": whash}


def scenario_category(path: Path) -> str:
    name = path.stem.lower()
    if "partially_modified" in name: return "partially_modified"
    if "modified" in name or "watermark" in name or "noise" in name or "salt_pepper" in name: return "modified"
    if "other_trip" in name or path.parent.name == "other": return "another_trip"
    if "trimmed_end" in name: return "end_trimmed"
    if "trimmed_beginning" in name: return "beginning_trimmed"
    if "extracted_segment" in name: return "extracted_segment"
    if "missing" in name: return "missing_frames"
    if "duplicated" in name: return "duplicated_frames"
    if "reordered" in name: return "reordered_frames"
    if "shifted" in name: return "temporal_shift"
    if "slower" in name: return "slower_playback"
    if "faster" in name: return "faster_playback"
    if "fps" in name: return "different_fps"
    if "authentic" in name: return "authentic"
    return "transformed"


def expected_detection(category: str) -> str:
    if category in {"modified", "partially_modified", "another_trip"}: return "NO_MATCH_OR_MODIFICATION"
    if category in {"missing_frames", "duplicated_frames", "reordered_frames", "beginning_trimmed", "end_trimmed", "extracted_segment", "temporal_shift", "slower_playback", "faster_playback", "different_fps"}: return "MATCH_WITH_TEMPORAL_ANOMALY"
    return "MATCH"


def _extract_video_hashes(path: Path, stride: int) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        cap.release()
        raise RuntimeError(f"Could not open video {path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    hashes = {name: {} for name in METHODS}
    frame_number = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok: break
            if frame_number % stride == 0:
                for name, method in METHODS.items():
                    hashes[name][frame_number] = method(frame)
            frame_number += 1
    finally:
        cap.release()
    return {"hashes": hashes, "frames": total or frame_number, "fps": fps}


def _match_hashes(reference: dict, test: dict, method: str, stride: int, max_shift: int, threshold: float) -> dict:
    ref_hashes = reference["hashes"][method]
    test_hashes = test["hashes"][method]
    if not ref_hashes or not test_hashes:
        raise RuntimeError("No sampled frame fingerprints were decoded.")
    bound = min(int(max_shift), max(reference["frames"], test["frames"]))
    best_shift, best_average, best_count, best_total = 0, -1.0, 0, 0
    for shift in range(-bound, bound + 1, max(1, stride)):
        values = [similarity_score(ref_hashes[index + shift], digest)
                  for index, digest in test_hashes.items() if index + shift in ref_hashes]
        if not values: continue
        average = sum(values) / len(values)
        if (average, len(values)) > (best_average, best_total):
            best_shift, best_average, best_total = shift, average, len(values)
            best_count = sum(value >= threshold for value in values)
    matched_positions = [index for index in test_hashes if index + best_shift in ref_hashes]
    fps = test["fps"] or reference["fps"]
    return {"best_similarity": best_average, "best_shift": best_shift,
            "shift_frames": best_shift, "shift_seconds": best_shift / fps if fps > 0 else None,
            "matched_start_frame": min(matched_positions) if matched_positions else None,
            "matched_end_frame": max(matched_positions) if matched_positions else None,
            "matched_frames": best_count, "frames_compared": best_total,
            "matched_frames_percentage": best_count / best_total * 100 if best_total else 0,
            "reference_frames": reference["frames"], "test_frames": test["frames"]}


def _write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)


def run(dataset: Path = DATASET, results_dir: Path = RESULTS, sample_interval: int = 60, max_shift: int = 300) -> dict:
    video_suffixes = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
    references = sorted(path for path in (dataset / "authentic").iterdir() if path.suffix.lower() in video_suffixes)
    if not references:
        raise FileNotFoundError(f"No authentic reference video found under {dataset / 'authentic'}")
    reference = references[0]
    scenarios = sorted(path for path in dataset.rglob("*") if path.suffix.lower() in video_suffixes and path != reference)
    if not scenarios:
        raise FileNotFoundError(f"No evaluation scenarios found under {dataset}")

    print(f"Sampling authentic reference: {reference.name}", flush=True)
    decoded_cache = {reference: _extract_video_hashes(reference, sample_interval)}
    for path in scenarios:
        print(f"Sampling scenario: {path.name}", flush=True)
        try:
            decoded_cache[path] = _extract_video_hashes(path, sample_interval)
        except Exception:
            # Preserve the error as a scenario row below rather than stopping the entire sweep.
            decoded_cache[path] = None

    threshold_samples: dict[str, list[tuple[float, bool]]] = {name: [] for name in METHODS}
    # Use independently labeled dataset scenarios, then deterministically balance
    # class counts so the majority class cannot dominate the threshold choice.
    for path in scenarios:
        category = scenario_category(path)
        positive = category in {"transformed"} or path.name.lower().startswith(("reencoded", "low_bitrate", "high_compression", "resolution", "brightness", "contrast", "cropped"))
        negative = category in {"modified", "partially_modified", "another_trip"}
        if positive or negative:
            ref_sample, scenario_sample = decoded_cache[reference], decoded_cache[path]
            if ref_sample is None or scenario_sample is None: continue
            for method_name in METHODS:
                paired = [(similarity_score(digest, scenario_sample["hashes"][method_name][index]), positive)
                          for index, digest in ref_sample["hashes"][method_name].items()
                          if index in scenario_sample["hashes"][method_name]]
                threshold_samples[method_name].extend(paired)

    balanced_samples: dict[str, list[tuple[float, bool]]] = {}
    for method, samples in threshold_samples.items():
        positive_samples = [(score, label) for score, label in samples if label]
        negative_samples = [(score, label) for score, label in samples if not label]
        count = min(len(positive_samples), len(negative_samples))
        def evenly_spaced(values, limit):
            if len(values) <= limit: return values
            return [values[round(i * (len(values) - 1) / max(limit - 1, 1))] for i in range(limit)]
        balanced_samples[method] = evenly_spaced(positive_samples, count) + evenly_spaced(negative_samples, count)

    threshold_rows = []
    recommended = {}
    for method, samples in threshold_samples.items():
        samples = balanced_samples[method]
        metrics = evaluate_thresholds(samples)
        best = recommend_threshold(metrics) if samples else None
        recommended[method] = best["threshold"] if best else 70.0
        for row in metrics:
            threshold_rows.append({"metric": method, "sample_count": len(samples), **row, "recommended": bool(best and row["threshold"] == best["threshold"])})

    scenario_rows = []
    for path in scenarios:
        category = scenario_category(path)
        started = time.perf_counter()
        expected = expected_detection(category)
        try:
            if decoded_cache[path] is None: raise RuntimeError("Video decode failed; details are unavailable.")
            result = _match_hashes(decoded_cache[reference], decoded_cache[path], "phash", sample_interval,
                                   max_shift, recommended.get("phash", 70.0))
        except Exception as exc:
            scenario_rows.append({
                "scenario": path.name, "category": category, "expected_result": expected,
                "detected_result": "PROCESSING_ERROR", "matching_score": None,
                "temporal_shift_frames": None, "temporal_shift_seconds": None,
                "matched_start_frame": None, "matched_end_frame": None,
                "matched_fingerprints": 0, "total_fingerprints_checked": 0,
                "missing_or_unmatched_frames": None,
                "processing_time_seconds": round(time.perf_counter() - started, 6),
                "confidence": 0.0, "pass": False, "error": str(exc)[:300],
            })
            continue
        elapsed = time.perf_counter() - started
        if category in {"modified", "partially_modified", "another_trip"}:
            detected = "NO_MATCH_OR_MODIFICATION" if result["matched_frames_percentage"] < 90 else "MATCH_REQUIRES_REVIEW"
        elif category in {"authentic", "transformed"}:
            detected = "MATCH" if result["matched_frames_percentage"] >= 90 else "MODIFICATION_DETECTED"
        else:
            detected = "MATCH_WITH_TEMPORAL_ANOMALY" if result["matched_frames"] else "NO_MATCH"
        scenario_rows.append({
            "scenario": path.name, "category": category, "expected_result": expected,
            "detected_result": detected, "matching_score": round(result["best_similarity"], 4),
            "temporal_shift_frames": result["shift_frames"], "temporal_shift_seconds": result["shift_seconds"],
            "matched_start_frame": result["matched_start_frame"], "matched_end_frame": result["matched_end_frame"],
            "matched_fingerprints": result["matched_frames"], "total_fingerprints_checked": result["frames_compared"],
            "missing_or_unmatched_frames": max(0, result["test_frames"] // sample_interval - result["matched_frames"]),
            "processing_time_seconds": round(elapsed, 6), "confidence": round(result["matched_frames_percentage"] / 100, 4),
            "pass": detected == expected, "error": "",
        })

    counts = {"scenario_count": len(scenario_rows), "passed": sum(bool(r["pass"]) for r in scenario_rows),
              "failed": sum(not bool(r["pass"]) for r in scenario_rows), "reference": str(reference),
              "sample_interval_frames": sample_interval, "max_shift_frames": max_shift}
    summary_rows = [{"metric": key, "value": value} for key, value in counts.items()]
    summary_rows.extend({"metric": f"recommended_threshold_{name}", "value": value} for name, value in recommended.items())
    _write_csv(results_dir / "scenario_results.csv", scenario_rows)
    _write_csv(results_dir / "threshold_results.csv", threshold_rows)
    _write_csv(results_dir / "summary.csv", summary_rows)
    _write_csv(results_dir / "confusion_matrix.csv", _confusion(scenario_rows))
    return {**counts, "recommended_thresholds": recommended}


def _confusion(rows: list[dict]) -> list[dict]:
    matrix = {"TP": 0, "TN": 0, "FP": 0, "FN": 0}
    for row in rows:
        expected_positive = row["expected_result"] in {"MATCH", "MATCH_WITH_TEMPORAL_ANOMALY"}
        detected_positive = row["detected_result"] in {"MATCH", "MATCH_WITH_TEMPORAL_ANOMALY"}
        if expected_positive and detected_positive: matrix["TP"] += 1
        elif expected_positive: matrix["FN"] += 1
        elif detected_positive: matrix["FP"] += 1
        else: matrix["TN"] += 1
    return [{"actual": "positive", "predicted_positive": matrix["TP"], "predicted_negative": matrix["FN"]},
            {"actual": "negative", "predicted_positive": matrix["FP"], "predicted_negative": matrix["TN"]}]


if __name__ == "__main__":
    print(run())
