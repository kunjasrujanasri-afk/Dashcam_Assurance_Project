export type PerceptualFrame = { time: number; information: number; ahash: string; dhash: string; phash: string; whash: string };
export type PerceptualEvidence = { schema: "dashcam-perceptual-v1"; interval: number; duration: number; frames: PerceptualFrame[] };
export type SignedFingerprint = {
  version: 3; workspaceId: string; deviceId: string; sessionId: string; segmentId: string;
  sequence: number; capturedAt: string; bytes: number; sha256: string; previousHash: string | null;
  chainHash: string; signature: string; signatureAlgorithm: "ECDSA_P256_SHA256";
  perceptual: PerceptualEvidence; perceptualHash: string; source: string; metadata: Record<string, unknown>;
};

const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");

export async function sha256(value: ArrayBuffer | Uint8Array | Blob | string) {
  const source = typeof value === "string" ? utf8.encode(value)
    : value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : value instanceof Uint8Array ? value : new Uint8Array(value);
  const input = Uint8Array.from(source).buffer as ArrayBuffer;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function iso(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Capture timestamp is invalid.");
  return date.toISOString();
}

export function canonicalChainPayload(record: Partial<SignedFingerprint>) {
  return JSON.stringify({
    version: Number(record.version ?? 3), workspaceId: record.workspaceId, deviceId: record.deviceId,
    sessionId: record.sessionId, segmentId: record.segmentId, perceptualHash: record.perceptualHash,
    sequence: Number(record.sequence), capturedAt: iso(String(record.capturedAt)), bytes: Number(record.bytes),
    sha256: record.sha256, previousHash: record.previousHash ?? null,
  });
}

export function canonicalSignedPayload(record: Partial<SignedFingerprint>) {
  return JSON.stringify({ ...JSON.parse(canonicalChainPayload(record)), chainHash: record.chainHash });
}

function fingerprintBits(bits: boolean[]) {
  let high = 0, low = 0;
  for (let i = 0; i < 64; i++) {
    const value = bits[i] ? 1 : 0;
    if (i < 32) high = (high * 2 + value) >>> 0;
    else low = (low * 2 + value) >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

function blockMeans(gray: Uint8Array, width: number, height: number, blocks: number) {
  const result: number[] = [];
  for (let by = 0; by < blocks; by++) for (let bx = 0; bx < blocks; bx++) {
    let sum = 0, count = 0;
    const x0 = Math.floor(bx * width / blocks), x1 = Math.floor((bx + 1) * width / blocks);
    const y0 = Math.floor(by * height / blocks), y1 = Math.floor((by + 1) * height / blocks);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += gray[y * width + x]; count++; }
    result.push(count ? sum / count : 0);
  }
  return result;
}

function dctLow(gray: Uint8Array, size: number) {
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let total = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      total += gray[y * size + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * size)) * Math.cos((2 * y + 1) * v * Math.PI / (2 * size));
    }
    coefficients.push(total);
  }
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return coefficients.map((value, index) => index !== 0 && value >= median);
}

function analyzeFrame(image: ImageData, time: number): PerceptualFrame {
  const width = 32, height = 32, gray = new Uint8Array(width * height), histogram = new Uint8Array(16);

  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    const value = Math.round(image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114);
    gray[p] = value; histogram[value >> 4]++;
  }
  const means = blockMeans(gray, width, height, 8), average = means.reduce((a, b) => a + b, 0) / means.length;
  const ahash = fingerprintBits(means.map(value => value >= average));
  const difference: boolean[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) difference.push(means[y * 8 + x] > means[y * 8 + x + 1]);
  const dHash = fingerprintBits(difference);
  const dct = fingerprintBits(dctLow(gray, width));
  const wavelet = fingerprintBits(means.map((value, index) => value >= (means[index ^ 1] + means[index ^ 8]) / 2));
  let information = 0;
  for (const count of histogram) if (count) { const p = count / (width * height); information -= p * Math.log2(p); }
  return { time, information, ahash, dhash: dHash, phash: dct, whash: wavelet };
}

export async function extractPerceptual(blob: Blob, interval = 0.5, maxFrames = 600) {
  if (typeof document === "undefined") throw new Error("Video analysis requires a browser.");
  const video = document.createElement("video"), url = URL.createObjectURL(blob);
  video.preload = "metadata"; video.muted = true; video.playsInline = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("The recorded segment could not be decoded for perceptual analysis.")); });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!(duration > 0)) throw new Error("The recorded segment has no readable duration.");
    const canvas = document.createElement("canvas"), size = 32; canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not initialize frame analysis.");
    const count = Math.max(1, Math.min(maxFrames, Math.ceil(duration / interval))), frames: PerceptualFrame[] = [];
    for (let index = 0; index < count; index++) {
      const time = Math.min(index * interval + 0.001, Math.max(0, duration - 0.01));
      await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Could not seek through the evidence segment.")); video.currentTime = time; });
      ctx.drawImage(video, 0, 0, size, size);
      frames.push(analyzeFrame(ctx.getImageData(0, 0, size, size), time));
    }
    return { schema: "dashcam-perceptual-v1" as const, interval, duration, frames };
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

export async function createSignedFingerprint(input: {
  workspaceId: string; deviceId: string; sessionId: string; segmentId: string; sequence: number;
  capturedAt: string; blob: Blob; previousHash: string | null; perceptual: PerceptualEvidence;
  privateKey: CryptoKey; locked: boolean; incidentId?: string | null;
}): Promise<SignedFingerprint> {
  const base = {
    version: 3 as const, workspaceId: input.workspaceId, deviceId: input.deviceId, sessionId: input.sessionId,
    segmentId: input.segmentId, sequence: input.sequence, capturedAt: iso(input.capturedAt), bytes: input.blob.size,
    sha256: await sha256(input.blob), previousHash: input.previousHash,
    perceptual: input.perceptual, perceptualHash: await sha256(stableJson(input.perceptual)),
    source: "recorded-video-segment", metadata: { locked: input.locked, incidentId: input.incidentId ?? null },
  };
  const chainHash = await sha256(canonicalChainPayload(base));
  const signed = { ...base, chainHash, signatureAlgorithm: "ECDSA_P256_SHA256" as const };
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, utf8.encode(canonicalSignedPayload(signed))));
  return { ...signed, signature: btoa(String.fromCharCode(...signature)) };
}

export async function verifySignature(record: SignedFingerprint, publicJwk: JsonWebKey) {
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(record.signature), char => char.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, utf8.encode(canonicalSignedPayload(record)));
  } catch { return false; }
}

export async function verifyChain(records: SignedFingerprint[]) {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  if (!ordered.length) return { valid: false, status: "FINGERPRINT_NOT_FOUND" };
  const sessionId = ordered[0].sessionId; let prior: SignedFingerprint | null = null;
  for (const record of ordered) {
    if (record.sessionId !== sessionId) return { valid: false, status: "SESSION_MISMATCH", sequence: record.sequence };
    if (prior && record.sequence !== prior.sequence + 1) return { valid: false, status: record.sequence <= prior.sequence ? "REORDERED_SEQUENCE" : "MISSING_SEQUENCE", sequence: prior.sequence + 1 };
    if ((!prior && record.sequence !== 0) || record.previousHash !== (prior?.chainHash ?? null)) return { valid: false, status: "BROKEN_CHAIN", sequence: record.sequence };
    if (await sha256(canonicalChainPayload(record)) !== record.chainHash) return { valid: false, status: "BROKEN_CHAIN", sequence: record.sequence };
    prior = record;
  }
  return { valid: true, status: "VERIFIED", lastHash: prior?.chainHash };
}

export function createEvidenceManifest(record: SignedFingerprint, devicePublicKey: JsonWebKey) {
  return { manifestVersion: 1, devicePublicKey, evidence: record };
}

export function parseFingerprintFile(text: string) {
  const fingerprints: string[] = [], invalidLines: number[] = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, index) => {
    const value = line.trim(); if (!value) return;
    if (/^[a-f0-9]{64}$/i.test(value)) fingerprints.push(value.toLowerCase());
    else { const candidate = value.split("|")[1]?.trim(); if (candidate && /^[a-f0-9]{64}$/i.test(candidate)) fingerprints.push(candidate.toLowerCase()); else invalidLines.push(index + 1); }
  });
  return { fingerprints, invalidLines };
}
