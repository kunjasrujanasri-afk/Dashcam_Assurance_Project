from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from database.evidence_store import (
    enqueue_records, load_fingerprint_txt, mark_sent, pending_records,
    queue_size, retry_pending, save_fingerprint_txt,
)
from evaluation import evaluation_engine as engine
from evaluation.metrics import binary_metrics, evaluate_thresholds, recommend_threshold
from evaluation.evaluation_engine import vector_distances, optional_fuzzy_metrics
from decoder.integrity import verify_hash_sequence
from evaluation.run_evaluation import run


def sample_records(count=3):
    return [{"driver_id": "test", "video_name": "sample.mp4", "frame_number": i,
             "fingerprint": f"{i:064x}", "timestamp": f"2026-01-01T00:00:{i:02d}Z", "status": "sent"}
            for i in range(1, count + 1)]


def patterned_frame(index: int) -> np.ndarray:
    rng = np.random.default_rng(index + 300)
    frame = rng.integers(0, 256, (72, 96, 3), dtype=np.uint8)
    cv2.putText(frame, str(index), (4, 45), cv2.FONT_HERSHEY_SIMPLEX, .8, (255, 255, 255), 2)
    return frame


class FakeCapture:
    def __init__(self, frames): self.frames, self.index = frames, 0
    def isOpened(self): return True
    def get(self, prop):
        if prop == cv2.CAP_PROP_FRAME_COUNT: return len(self.frames)
        if prop == cv2.CAP_PROP_FPS: return 8
        return 96 if prop == cv2.CAP_PROP_FRAME_WIDTH else 72
    def read(self):
        if self.index >= len(self.frames): return False, None
        frame = self.frames[self.index]; self.index += 1
        return True, frame.copy()
    def release(self): pass


class CoreTests(unittest.TestCase):
    def test_sha256_exact_and_changed(self):
        frame = patterned_frame(1)
        self.assertEqual(engine.sha256_frame(frame), engine.sha256_frame(frame.copy()))
        changed = frame.copy(); changed[0, 0, 0] ^= 255
        self.assertNotEqual(engine.sha256_frame(frame), engine.sha256_frame(changed))

    def test_hamming_and_similarity(self):
        a, b = "0" * 64, "1" + "0" * 63
        self.assertEqual(engine.hamming_distance(a, b), 1)
        self.assertEqual(engine.normalized_hamming_distance(a, b), 1 / 64)
        self.assertAlmostEqual(engine.similarity_score(a, b), 100 * 63 / 64)
        self.assertEqual(engine.hamming_distance(a, a), 0)

    def test_perceptual_hash_stable_and_metrics_exist(self):
        frame = patterned_frame(4)
        for method in (engine.ahash, engine.dhash, engine.phash, engine.whash):
            self.assertEqual(method(frame), method(frame.copy()))
            self.assertEqual(len(method(frame)), 64 if method is not engine.phash else 63)

    def test_temporal_match_respects_max_shift_and_reports_seconds(self):
        frames = [patterned_frame(i) for i in range(14)]
        caps = [FakeCapture(frames), FakeCapture(frames[4:])]
        with patch.object(engine.cv2, "VideoCapture", side_effect=caps):
            result = engine.find_best_temporal_match("ref", "test", hash_method="phash", sample_interval=1, search_step=1, max_shift=5)
        self.assertEqual(result["shift_frames"], 4)
        self.assertAlmostEqual(result["shift_seconds"], .5)
        self.assertIsNotNone(result["matched_start_frame"])
        caps = [FakeCapture(frames), FakeCapture(frames[4:])]
        with patch.object(engine.cv2, "VideoCapture", side_effect=caps):
            limited = engine.find_best_temporal_match("ref", "test", hash_method="phash", sample_interval=1, search_step=1, max_shift=1)
        self.assertLessEqual(abs(limited["shift_frames"]), 1)

    def test_threshold_confusion_metrics_and_selection(self):
        result = binary_metrics([(99, True), (80, True), (20, False), (70, False)], 75)
        self.assertEqual((result["TP"], result["TN"], result["FP"], result["FN"]), (2, 2, 0, 0))
        curves = evaluate_thresholds([(99, True), (20, False)])
        self.assertIsNotNone(recommend_threshold(curves))
        self.assertIsNone(recommend_threshold(evaluate_thresholds([(80, True), (80, False)])))

    def test_vector_and_optional_metrics(self):
        values = vector_distances([1, 2, 3], [1, 2, 3])
        self.assertEqual(values["euclidean_l2"], 0)
        self.assertEqual(values["manhattan_l1"], 0)
        self.assertAlmostEqual(values["cosine_similarity"], 1)
        optional = optional_fuzzy_metrics(b"frame a", b"frame b")
        self.assertIn("ssdeep", optional)
        self.assertIn("tlsh", optional)

    def test_exact_decoder_reports_modified_reordered_missing_and_trim(self):
        a, b, c, d = (f"{n:064x}" for n in range(1, 5))
        result = verify_hash_sequence({1: a, 2: b, 3: c, 4: d}, [a, c, b, "f" * 64])
        self.assertEqual(result["verified"], 1)
        self.assertEqual(result["reordered_or_shifted"], 2)
        repeated = verify_hash_sequence({1: a, 2: b, 3: c, 4: d}, [a, b, b, d])
        self.assertEqual(repeated["duplicates"], 1)
        self.assertEqual(result["modified_or_corrupt"], 1)
        trimmed = verify_hash_sequence({1: a, 2: b, 3: c, 4: d}, [b, c])
        self.assertEqual(trimmed["leading_trim_frames"], 1)
        self.assertEqual(trimmed["trailing_trim_frames"], 2)

    def test_txt_save_load_and_legacy_support(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fingerprints.txt"
            save_fingerprint_txt(path, sample_records())
            self.assertEqual(load_fingerprint_txt(path), [r["fingerprint"] for r in sample_records()])
            path.write_text("metadata\n1 | " + "a" * 64 + " | time\n", encoding="utf-8")
            self.assertEqual(load_fingerprint_txt(path), ["a" * 64])

    def test_sqlite_queue_duplicate_prevention_persistence_and_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "queue.sqlite3"
            rows = sample_records()
            self.assertEqual(enqueue_records(db, rows), 3)
            self.assertEqual(enqueue_records(db, rows), 0)
            self.assertEqual(queue_size(db), 3)
            self.assertEqual(len(pending_records(db)), 3)
            self.assertEqual(retry_pending(db, lambda batch: (_ for _ in ()).throw(ConnectionError("offline"))), 0)
            self.assertEqual(queue_size(db), 3)
            self.assertEqual(retry_pending(db, lambda batch: None), 3)
            self.assertEqual(queue_size(db), 0)

    def test_dataset_scenario_generation(self):
        from evaluation import generate_test_dataset as generator
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "source.avi"
            writer = cv2.VideoWriter(str(src), cv2.VideoWriter_fourcc(*"MJPG"), 8, (96, 72))
            for i in range(32): writer.write(patterned_frame(i))
            writer.release()
            old_source = generator.SOURCE
            try:
                generator.SOURCE = str(src)
                other = Path(tmp) / "other.mp4"
                generator.create_synthetic_other_trip(str(other), seconds=1, fps=4)
                partial = Path(tmp) / "partial.mp4"
                generator.create_partially_modified_video(str(partial), str(other))
                end = Path(tmp) / "end.mp4"
                generator.create_end_trimmed_video(str(end), trim_seconds=1)
            finally:
                generator.SOURCE = old_source
            self.assertTrue(other.exists() and partial.exists() and end.exists())
            end_cap, src_cap = cv2.VideoCapture(str(end)), cv2.VideoCapture(str(src))
            self.assertLess(end_cap.get(cv2.CAP_PROP_FRAME_COUNT), src_cap.get(cv2.CAP_PROP_FRAME_COUNT))
            end_cap.release(); src_cap.release()

    def test_evaluation_writes_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); dataset = base / "dataset"
            for folder in ("authentic", "transformed", "other"):
                (dataset / folder).mkdir(parents=True)
            def write(path, frames):
                writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 8, (96, 72))
                for frame in frames: writer.write(frame)
                writer.release()
            frames = [patterned_frame(i) for i in range(8)]
            write(dataset / "authentic" / "authentic.avi", frames)
            write(dataset / "transformed" / "brightness.avi", [cv2.convertScaleAbs(f, alpha=1, beta=10) for f in frames])
            write(dataset / "other" / "other_trip_synthetic.avi", [patterned_frame(i + 30) for i in range(8)])
            result_dir = base / "results"
            summary = run(dataset, result_dir, sample_interval=1, max_shift=3)
            self.assertEqual(summary["scenario_count"], 2)
            for name in ("scenario_results.csv", "threshold_results.csv", "summary.csv", "confusion_matrix.csv"):
                self.assertTrue((result_dir / name).exists())


if __name__ == "__main__":
    unittest.main()
