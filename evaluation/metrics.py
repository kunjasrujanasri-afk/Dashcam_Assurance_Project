"""Deterministic threshold/confusion metrics for similarity scores."""
from __future__ import annotations

from collections.abc import Iterable


def binary_metrics(samples: Iterable[tuple[float, bool]], threshold: float) -> dict:
    tp = fp = tn = fn = 0
    for score, is_positive in samples:
        predicted = float(score) >= float(threshold)
        if predicted and is_positive: tp += 1
        elif predicted: fp += 1
        elif is_positive: fn += 1
        else: tn += 1
    total = tp + fp + tn + fn
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    specificity = tn / (tn + fp) if tn + fp else 0.0
    balanced_accuracy = (recall + specificity) / 2 if (tp + fn) and (tn + fp) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": float(threshold), "TP": tp, "TN": tn, "FP": fp, "FN": fn,
        "accuracy": (tp + tn) / total if total else 0.0,
        "precision": precision, "recall": recall, "F1": f1,
        "specificity": specificity, "balanced_accuracy": balanced_accuracy,
        "false_positive_rate": fp / (fp + tn) if fp + tn else 0.0,
        "false_negative_rate": fn / (fn + tp) if fn + tp else 0.0,
    }


def evaluate_thresholds(samples: Iterable[tuple[float, bool]], thresholds=None) -> list[dict]:
    values = list(samples)
    grid = thresholds if thresholds is not None else range(0, 101, 5)
    return [binary_metrics(values, t) for t in grid]


def recommend_threshold(results: list[dict]) -> dict | None:
    """Maximize balanced accuracy, then F1; ties use the higher threshold."""
    if not results:
        return None
    best = max(results, key=lambda row: (row["balanced_accuracy"], row["F1"], -row["false_positive_rate"], row["threshold"]))
    # A chance-level sweep is evidence that this dataset cannot calibrate a threshold.
    return best if best["balanced_accuracy"] > 0.5 else None
