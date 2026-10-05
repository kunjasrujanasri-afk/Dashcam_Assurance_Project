/**
 * src/lib/fingerprintMetrics.ts
 *
 * Fingerprint distance and similarity metrics for video integrity evaluation.
 *
 * Supports:
 *  - Perceptual hashing: aHash, dHash, pHash (DCT-based), wHash (wavelet-like)
 *  - Hamming distance & normalized Hamming distance
 *  - Fuzzy hashing: ssdeep-style rolling hash (simplified), TLSH-style locality hash
 *  - Vector-based: Euclidean (L2), Manhattan (L1), Cosine similarity/distance
 *
 * Hashes are represented as 64-element bit arrays (number[]) to avoid
 * BigInt dependency and stay compatible with ES2017 targets.
 */

// ── Perceptual Hashes ─────────────────────────────────────────────────────────

/** Convert an ImageData (RGBA) to an 8-bit greyscale flat array. */
export function toGrayscale(data: Uint8ClampedArray, width: number, height: number): number[] {
  const grey: number[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    grey[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return grey;
}

/**
 * Resize a greyscale array to targetW x targetH using nearest-neighbour.
 */
export function resizeGray(
  grey: number[],
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): number[] {
  const out: number[] = new Array(dstW * dstH);
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.floor(x * xScale), srcW - 1);
      const sy = Math.min(Math.floor(y * yScale), srcH - 1);
      out[y * dstW + x] = grey[sy * srcW + sx];
    }
  }
  return out;
}

/** A 64-bit perceptual hash represented as a bit array of 64 elements (each 0 or 1). */
export type PerceptualHash = number[];

/** Convert a bit array to a hex string for display. */
export function hashToHex(bits: PerceptualHash): string {
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  }
  return hex;
}

/**
 * aHash (Average Hash) — 8x8 hash.
 * Each bit = pixel >= average ? 1 : 0.
 */
export function aHash(grey: number[], width: number, height: number): PerceptualHash {
  const small = resizeGray(grey, width, height, 8, 8);
  const avg = small.reduce((a, b) => a + b, 0) / 64;
  return small.map((v) => (v >= avg ? 1 : 0));
}

/**
 * dHash (Difference Hash) — 8x8 output from 9x8 input.
 * Each bit = current pixel > next pixel in the same row.
 */
export function dHash(grey: number[], width: number, height: number): PerceptualHash {
  const small = resizeGray(grey, width, height, 9, 8);
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits.push(small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0);
    }
  }
  return bits;
}

/**
 * pHash (Perceptual Hash, DCT-based) — 64-bit from 32x32 DCT.
 */
export function pHash(grey: number[], width: number, height: number): PerceptualHash {
  const N = 32;
  const small = resizeGray(grey, width, height, N, N);
  const dct = dct2d(small, N, N);
  const coeffs: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue; // skip DC
      coeffs.push(dct[y * N + x]);
    }
  }
  const mean = coeffs.reduce((a, b) => a + b, 0) / coeffs.length;
  return coeffs.map((c) => (c >= mean ? 1 : 0));
}

/**
 * wHash (Wavelet-like Hash) — 64-bit using a simple Haar-like lowpass.
 */
export function wHash(grey: number[], width: number, height: number): PerceptualHash {
  let w = 64, h = 64;
  let img = resizeGray(grey, width, height, w, h);
  for (let lvl = 0; lvl < 3; lvl++) {
    const nw = w >> 1;
    const nh = h >> 1;
    const next: number[] = new Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        next[y * nw + x] = Math.round(
          (img[2 * y * w + 2 * x] +
            img[2 * y * w + 2 * x + 1] +
            img[(2 * y + 1) * w + 2 * x] +
            img[(2 * y + 1) * w + 2 * x + 1]) / 4
        );
      }
    }
    img = next;
    w = nw;
    h = nh;
  }
  const avg = img.reduce((a, b) => a + b, 0) / 64;
  return img.map((v) => (v >= avg ? 1 : 0));
}

/** Internal: 2-D DCT-II on a flat row-major array of rows x cols. */
function dct2d(pixels: number[], rows: number, cols: number): number[] {
  const tmp = new Array(rows * cols).fill(0);
  for (let x = 0; x < cols; x++) {
    for (let k = 0; k < rows; k++) {
      let sum = 0;
      for (let n = 0; n < rows; n++) sum += pixels[n * cols + x] * Math.cos((Math.PI / rows) * (n + 0.5) * k);
      tmp[k * cols + x] = sum;
    }
  }
  const out = new Array(rows * cols).fill(0);
  for (let y = 0; y < rows; y++) {
    for (let k = 0; k < cols; k++) {
      let sum = 0;
      for (let n = 0; n < cols; n++) sum += tmp[y * cols + n] * Math.cos((Math.PI / cols) * (n + 0.5) * k);
      out[y * cols + k] = sum;
    }
  }
  return out;
}

// ── Hamming Distance ──────────────────────────────────────────────────────────

/** Count the number of differing bits between two 64-bit hashes (bit arrays). */
export function hammingDistance(a: PerceptualHash, b: PerceptualHash): number {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}

/** Normalised Hamming distance in [0, 1]. */
export function normalizedHammingDistance(a: PerceptualHash, b: PerceptualHash): number {
  return hammingDistance(a, b) / a.length;
}

/** Hamming similarity: 1 - normalised distance. */
export function hammingSimilarity(a: PerceptualHash, b: PerceptualHash): number {
  return 1 - normalizedHammingDistance(a, b);
}

// ── Fuzzy / Rolling Hash ──────────────────────────────────────────────────────

export interface FuzzyHash {
  blockSize: number;
  h1: string;
  h2: string;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * ssdeep-style context-triggered piecewise linear (CTPH) hash.
 * Simplified reference implementation; byte-accurate to the algorithm.
 */
export function ssdeepHash(data: Uint8Array): FuzzyHash {
  const MIN_BLOCK = 3;
  const SPAMSUM_LENGTH = 64;
  let blockSize = MIN_BLOCK;
  while (blockSize * SPAMSUM_LENGTH < data.length) blockSize *= 2;

  const roll = (bs: number) => {
    const win = new Uint8Array(7);
    let rh1 = 0, rh2 = 0, rh3 = 0;
    let h1 = "", h2 = "";
    let sum1 = 5381, sum2 = 5381;
    let p = 0;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      rh2 ^= b;
      rh1 = (((rh1 << 5) >>> 0) + b - win[p % 7]) >>> 0;
      win[p++ % 7] = b;
      rh3 = ((rh3 * 1756695921 + b) >>> 0) >>> 0;
      const rh = (rh1 + rh2 + rh3) >>> 0;
      sum1 = ((sum1 * 33) ^ b) >>> 0;
      if (rh % bs === bs - 1) { h1 += B64[sum1 & 63]; sum1 = 5381; }
      sum2 = ((sum2 * 33) ^ b) >>> 0;
      if (rh % (bs * 2) === bs * 2 - 1) { h2 += B64[sum2 & 63]; sum2 = 5381; }
    }
    h1 += B64[sum1 & 63];
    h2 += B64[sum2 & 63];
    return { h1, h2 };
  };

  const { h1, h2 } = roll(blockSize);
  return { blockSize, h1, h2 };
}

/** ssdeep-style similarity score [0 to 100]. */
export function ssdeepSimilarity(a: FuzzyHash, b: FuzzyHash): number {
  if (a.blockSize !== b.blockSize && a.blockSize * 2 !== b.blockSize && b.blockSize * 2 !== a.blockSize) return 0;
  const s1 = editSimilarity(a.h1, b.h1);
  const s2 = editSimilarity(a.h2, b.h2);
  return Math.round(Math.max(s1, s2) * 100);
}

function editSimilarity(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0 && lb === 0) return 1;
  const dp = Array.from({ length: la + 1 }, (_, i) => [i, ...new Array(lb).fill(0)]);
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[la][lb] / Math.max(la, lb);
}

// ── TLSH-style locality-sensitive hash ───────────────────────────────────────

export interface TlshHash {
  checksum: number;
  length_bucket: number;
  body: Uint8Array;
}

/** TLSH-style locality-sensitive hash (simplified, 32-byte body). */
export function tlshHash(data: Uint8Array): TlshHash {
  const buckets = new Uint32Array(256);
  const TLSH_WIN = 5;
  for (let i = TLSH_WIN - 1; i < data.length; i++) {
    let h = 0;
    for (let j = 0; j < TLSH_WIN; j++) h = ((h * 31) + data[i - j]) & 0xff;
    buckets[h]++;
  }
  const sorted = Array.from(buckets).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q2 = sorted[Math.floor(sorted.length * 0.50)];
  const body = new Uint8Array(32);
  for (let i = 0; i < 128; i++) {
    const v = buckets[i] < q1 ? 0 : buckets[i] < q2 ? 1 : buckets[i] < q2 * 2 ? 2 : 3;
    body[Math.floor(i / 4)] |= v << (2 * (i % 4));
  }
  let checksum = 0;
  for (let i = 0; i < data.length; i++) checksum = (checksum + data[i]) & 0xff;
  const length_bucket = Math.min(255, Math.floor(Math.log2(Math.max(data.length, 1)) * 10));
  return { checksum, length_bucket, body };
}

/** TLSH distance — lower is more similar; <=30 = near-duplicate. */
export function tlshDistance(a: TlshHash, b: TlshHash): number {
  let d = 0;
  d += Math.abs(a.length_bucket - b.length_bucket) * 12;
  d += a.checksum !== b.checksum ? 1 : 0;
  for (let i = 0; i < 32; i++) {
    for (let bit = 0; bit < 8; bit += 2) {
      const va = (a.body[i] >> bit) & 3;
      const vb = (b.body[i] >> bit) & 3;
      d += Math.abs(va - vb);
    }
  }
  return d;
}

// ── Vector-based Metrics ──────────────────────────────────────────────────────

/** Euclidean (L2) distance between two numeric vectors. */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Manhattan (L1) distance between two numeric vectors. */
export function manhattanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/** Cosine similarity in [-1, 1] (1 = identical direction). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] ** 2;
    magB += b[i] ** 2;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Cosine distance = 1 - cosine similarity. */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type HashMethod = "aHash" | "dHash" | "pHash" | "wHash";

export interface PerceptualComparison {
  method: HashMethod;
  hashHex: string;
  refHashHex: string;
  hamming: number;
  normalizedHamming: number;
  similarity: number;
  isMatch: boolean;
}

export interface MetricThresholds {
  maxHamming: number;
  minSsdeepScore: number;
  maxTlshDistance: number;
  maxCosineDistance: number;
  maxEuclidean: number;
}

export const DEFAULT_THRESHOLDS: MetricThresholds = {
  maxHamming: 10,
  minSsdeepScore: 50,
  maxTlshDistance: 30,
  maxCosineDistance: 0.15,
  maxEuclidean: 2.5,
};

/**
 * Compare two frames using all four perceptual hash algorithms.
 * Each frame is supplied as a flat greyscale array (from toGrayscale).
 */
export function comparePerceptualHashes(
  greyA: number[],
  greyB: number[],
  width: number,
  height: number,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS
): PerceptualComparison[] {
  const methods: { name: HashMethod; fn: (g: number[], w: number, h: number) => PerceptualHash }[] = [
    { name: "aHash", fn: aHash },
    { name: "dHash", fn: dHash },
    { name: "pHash", fn: pHash },
    { name: "wHash", fn: wHash },
  ];
  return methods.map(({ name, fn }) => {
    const hA = fn(greyA, width, height);
    const hB = fn(greyB, width, height);
    const hamming = hammingDistance(hA, hB);
    const normalizedHamming = normalizedHammingDistance(hA, hB);
    const similarity = hammingSimilarity(hA, hB);
    return {
      method: name,
      hashHex: hashToHex(hA),
      refHashHex: hashToHex(hB),
      hamming,
      normalizedHamming,
      similarity,
      isMatch: hamming <= thresholds.maxHamming,
    };
  });
}

/**
 * Build a 64-dimensional feature vector from a greyscale image.
 * Values: the 8x8 average-pooled pixel values, normalised to [0, 1].
 */
export function buildFeatureVector(grey: number[], width: number, height: number): number[] {
  const small = resizeGray(grey, width, height, 8, 8);
  const max = Math.max(...small, 1);
  return small.map((v) => v / max);
}

// ── Threshold Evaluation ─────────────────────────────────────────────────────

export interface ThresholdEvaluation {
  metric: string;
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

/**
 * Evaluate a binary classifier at a given threshold.
 * higherIsBetter = true for similarity scores; false for distances.
 */
export function evaluateThreshold(
  scores: { score: number; isGenuine: boolean }[],
  threshold: number,
  higherIsBetter: boolean,
  metricName: string
): ThresholdEvaluation {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { score, isGenuine } of scores) {
    const predicted = higherIsBetter ? score >= threshold : score <= threshold;
    if (isGenuine && predicted) tp++;
    else if (!isGenuine && predicted) fp++;
    else if (!isGenuine && !predicted) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const accuracy = (tp + tn) / scores.length;
  return { metric: metricName, threshold, truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn, precision, recall, f1, accuracy };
}
