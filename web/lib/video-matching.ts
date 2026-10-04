import type { PerceptualEvidence, PerceptualFrame } from "./signed-evidence";

export type HashMethod = "ahash" | "dhash" | "phash" | "whash";
export type MatchOptions = { method?: HashMethod; maximumDistance?: number; minimumCoverage?: number };
export type MatchSection = { state: "consistent" | "review" | "inconclusive"; start: number; end: number };

function bits(hash: string) { return hash.match(/.{2}/g)?.flatMap(byte => [(parseInt(byte, 16) >> 4) & 15, parseInt(byte, 16) & 15]) ?? []; }
export function hammingDistance(left: string, right: string) {
  if (!/^[a-f0-9]{16}$/i.test(left) || !/^[a-f0-9]{16}$/i.test(right)) throw new Error("Perceptual hashes must be 64-bit hexadecimal values.");
  const a = bits(left), b = bits(right); let distance = 0;
  for (let i = 0; i < 16; i++) { let value = a[i] ^ b[i]; while (value) { distance += value & 1; value >>>= 1; } }
  return distance;
}

export function alignVideos(query: PerceptualEvidence, reference: PerceptualEvidence, options: MatchOptions = {}) {
  const method = options.method ?? "phash", threshold = options.maximumDistance ?? 14, minimumCoverage = options.minimumCoverage ?? 0.6;
  const q = query.frames, r = reference.frames;
  if (!q.length || !r.length || q.length > 1200 || r.length > 2400) throw new Error("Video comparison requires 1–1,200 submitted and 1–2,400 reference samples.");
  const width = r.length + 1, trace = new Uint8Array((q.length + 1) * width);
  let previous = new Float32Array(width), best = 0, endI = 0, endJ = 0;
  for (let i = 1; i <= q.length; i++) {
    const row = new Float32Array(width);
    for (let j = 1; j <= r.length; j++) {
      const difference = hammingDistance(q[i - 1][method], r[j - 1][method]);
      const informative = q[i - 1].information >= 1.2 && r[j - 1].information >= 1.2;
      const diagonal = previous[j - 1] + (informative && difference <= threshold ? 1 - 0.4 * difference / Math.max(threshold, 1) : -0.8);
      const up = previous[j] - 0.35, left = row[j - 1] - 0.35;
      row[j] = Math.max(0, diagonal, up, left);
      trace[i * width + j] = !row[j] ? 0 : row[j] === diagonal ? 1 : row[j] === up ? 2 : 3;
      if (row[j] > best) { best = row[j]; endI = i; endJ = j; }
    }
    previous = row;
  }
  const pairs: Array<{ queryIndex: number; referenceIndex: number; queryTime: number; referenceTime: number; distance: number }> = [];
  let i = endI, j = endJ;
  while (i && j) {
    const direction = trace[i * width + j];
    if (!direction) break;
    if (direction === 1) {
      const distance = hammingDistance(q[i - 1][method], r[j - 1][method]);
      if (distance <= threshold && q[i - 1].information >= 1.2 && r[j - 1].information >= 1.2) pairs.push({ queryIndex: i - 1, referenceIndex: j - 1, queryTime: q[i - 1].time, referenceTime: r[j - 1].time, distance });
      i--; j--;
    } else if (direction === 2) i--; else j--;
  }
  pairs.reverse();
  const matched = new Set(pairs.map(pair => pair.queryIndex)), anomalies: Array<{ type: string; start: number; end?: number; detail?: string }> = [];
  for (let cursor = 0; cursor < q.length;) {
    if (matched.has(cursor)) { cursor++; continue; }
    const start = cursor; while (cursor < q.length && !matched.has(cursor)) cursor++;
    anomalies.push({ type: "UNMATCHED_SECTION", start: q[start].time, end: cursor < q.length ? q[cursor].time : query.duration });
  }
  for (let k = 1; k < pairs.length; k++) {
    const a = pairs[k - 1], b = pairs[k];
    if (b.referenceIndex - a.referenceIndex > b.queryIndex - a.queryIndex + 1) anomalies.push({ type: "REFERENCE_GAP", start: a.referenceTime, end: b.referenceTime });
    if (b.referenceIndex < a.referenceIndex) anomalies.push({ type: "POSSIBLE_REORDER", start: b.queryTime, end: b.queryTime + query.interval });
    if (b.queryIndex - a.queryIndex > 1 && b.referenceIndex - a.referenceIndex <= 1) anomalies.push({ type: "POSSIBLE_DUPLICATE", start: a.queryTime, end: b.queryTime });
  }
  let speedRatio: number | null = null;
  if (pairs.length > 1) {
    const first = pairs[0], last = pairs[pairs.length - 1];
    if (last.queryTime > first.queryTime) { speedRatio = (last.referenceTime - first.referenceTime) / (last.queryTime - first.queryTime); if (Math.abs(speedRatio - 1) > 0.08) anomalies.push({ type: "TIME_SCALE_CHANGE", start: first.queryTime, end: last.queryTime, detail: `${speedRatio.toFixed(2)}x` }); }
  }
  const coverage = pairs.length / q.length, meanDistance = pairs.length ? pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length : null;
  const match = pairs.length >= 3 && coverage >= minimumCoverage;
  const sections: MatchSection[] = [];
  for (let index = 0; index < q.length; index++) {
    const start = q[index].time, end = Math.min(query.duration, q[index + 1]?.time ?? start + query.interval);
    const state = matched.has(index) ? "consistent" : q[index].information >= 1.2 ? "review" : "inconclusive";
    const prior = sections[sections.length - 1];
    if (prior?.state === state && Math.abs(prior.end - start) < 0.01) prior.end = end;
    else sections.push({ state, start, end });
  }
  return {
    match, status: match ? "CONTENT_MATCH" : pairs.length >= 3 ? "PARTIAL_MATCH" : "NO_MATCH",
    matchedFingerprints: pairs.length, totalFingerprints: q.length, matchedPercentage: coverage * 100,
    score: meanDistance === null ? 0 : 100 * coverage * Math.max(0, 1 - meanDistance / 64), meanDistance,
    referenceStart: pairs[0]?.referenceTime ?? null, referenceEnd: pairs.length ? Math.min(reference.duration, pairs[pairs.length - 1].referenceTime + reference.interval) : null,
    queryStart: pairs[0]?.queryTime ?? null, queryDuration: query.duration, speedRatio, anomalies, sections, pairs,
    method, maximumDistance: threshold, minimumCoverage,
  };
}

const labels: Record<string, [string, string]> = {
  UNMATCHED_SECTION: ["Changed or replaced section", "These frames differ from the trusted recording; crop, blur, overlays, edits, or another trip may look similar."],
  REFERENCE_GAP: ["Possible deleted section", "Part of the trusted recording is missing from the submitted video."],
  POSSIBLE_REORDER: ["Possible reordered footage", "A recognizable frame appears out of sequence."],
  POSSIBLE_DUPLICATE: ["Possible repeated footage", "A segment may have been duplicated. A static scene can also look repeated."],
  TIME_SCALE_CHANGE: ["Possible speed change", "The matching points suggest a different playback rate."],
};
export function explainAnomaly(type: string) { return labels[type] ?? ["Needs human review", "The comparison found a difference that cannot identify a specific editing operation."]; }

export function classifyHash(distance: number, threshold: number, expectedMatch: boolean) {
  const predictedMatch = distance <= threshold;
  if (expectedMatch && predictedMatch) return "TRUE_MATCH";
  if (expectedMatch) return "MISSED_MATCH";
  if (predictedMatch) return "FALSE_MATCH";
  return "TRUE_NEGATIVE";
}

export function confusion(samples: Array<{ distance: number; expected: boolean }>, threshold: number) {
  const result = { TP: 0, TN: 0, FP: 0, FN: 0 };
  for (const sample of samples) {
    const match = sample.distance <= threshold;
    if (match && sample.expected) result.TP++;
    else if (match) result.FP++;
    else if (sample.expected) result.FN++;
    else result.TN++;
  }
  const precision = result.TP + result.FP ? result.TP / (result.TP + result.FP) : 0;
  const recall = result.TP + result.FN ? result.TP / (result.TP + result.FN) : 0;
  const specificity = result.TN + result.FP ? result.TN / (result.TN + result.FP) : 0;
  return { threshold, ...result, precision, recall, specificity, F1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, balancedAccuracy: (recall + specificity) / 2 };
}

export function hashMethodScores(query: PerceptualFrame[], reference: PerceptualFrame[]) {
  const methods: HashMethod[] = ["ahash", "dhash", "phash", "whash"];
  return methods.map(method => {
    const pairs = query.flatMap(frame => {
      const nearest = reference.reduce<{ frame: PerceptualFrame; distance: number } | null>((best, candidate) => {
        const distance = hammingDistance(frame[method], candidate[method]);
        return !best || distance < best.distance ? { frame: candidate, distance } : best;
      }, null);
      return nearest ? [{ time: frame.time, distance: nearest.distance }] : [];
    });
    const mean = pairs.length ? pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length : null;
    return { method, samples: pairs.length, meanDistance: mean, similarity: mean === null ? 0 : 100 * (1 - mean / 64) };
  });
}
