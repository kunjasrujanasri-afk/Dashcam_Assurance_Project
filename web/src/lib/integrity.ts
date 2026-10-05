/**
 * src/lib/integrity.ts
 *
 * The integrity protocol shared by the Encoder and the Decoder.
 * Only standard Web Crypto primitives are used (SHA-256, ECDSA P-256), so the
 * same code runs in the phone browser, the insurer browser and Node ≥ 20.
 *
 *  segment_hash    = SHA-256(bytes of the video segment file)
 *  prev_chain_hash = chain_hash of segment seq-1   (seq 0: SHA-256("GENESIS|"+session))
 *  chain_hash      = SHA-256(canonical record)      (see canonicalRecord)
 *  signature       = ECDSA-P256-SHA256(device private key, chain_hash)
 *
 * Because chain_hash covers the metadata, the segment hash AND the previous
 * chain hash, any change to a file, to a stored record, or to the order /
 * completeness of the sequence is detectable.
 */

import { PROTOCOL_VERSION } from "./config";

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error(
      "Web Crypto is unavailable. The page must be served over HTTPS (or http://localhost)."
    );
  }
  return c.subtle;
};

// ── Encoding helpers ─────────────────────────────────────────────────────────

export function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
export const isSha256Hex = (s: unknown): s is string =>
  typeof s === "string" && SHA256_RE.test(s);

// ── Hashing ──────────────────────────────────────────────────────────────────

export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bufToHex(await subtle().digest("SHA-256", bytes));
}

/** SHA-256 of a Blob / File (the recorded segment). */
export async function hashBlob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}

export function genesisHash(sessionId: string): Promise<string> {
  return sha256Hex(`GENESIS|${sessionId}`);
}

// ── Canonical record ─────────────────────────────────────────────────────────

/** Fields of a segment record that are covered by the chain hash. */
export interface SegmentCore {
  device_id: string;
  session_id: string;
  seq: number;
  started_at: number;
  ended_at: number;
  frame_count: number;
  byte_size: number;
  mime_type: string;
  width: number | null;
  height: number | null;
  latitude: number | null;
  longitude: number | null;
  segment_hash: string;
  prev_chain_hash: string;
}

/** Full record as transmitted to / stored on the server. */
export interface SegmentRecord extends SegmentCore {
  chain_hash: string;
  signature: string;
}

const num = (v: number | null | undefined, digits?: number) =>
  v === null || v === undefined || Number.isNaN(v)
    ? ""
    : digits !== undefined
    ? Number(v).toFixed(digits)
    : String(Math.trunc(Number(v)));

/**
 * Deterministic serialisation of a record. Every field is listed explicitly
 * in a fixed order, so the encoder and decoder always hash the same string.
 */
export function canonicalRecord(r: SegmentCore): string {
  return [
    PROTOCOL_VERSION,
    r.device_id,
    r.session_id,
    num(r.seq),
    num(r.started_at),
    num(r.ended_at),
    num(r.frame_count),
    num(r.byte_size),
    r.mime_type,
    num(r.width),
    num(r.height),
    num(r.latitude, 6),
    num(r.longitude, 6),
    r.segment_hash,
    r.prev_chain_hash,
  ].join("|");
}

export function computeChainHash(r: SegmentCore): Promise<string> {
  return sha256Hex(canonicalRecord(r));
}

// ── Signatures (ECDSA P-256) ─────────────────────────────────────────────────

const ECDSA_KEY = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** Generates the device key pair. The private key is NOT extractable. */
export function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(ECDSA_KEY, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey("jwk", key);
}

export function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const clean: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
  return subtle().importKey("jwk", clean, ECDSA_KEY, true, ["verify"]);
}

/** Short, human-comparable fingerprint of a public key. */
export async function publicKeyFingerprint(jwk: JsonWebKey): Promise<string> {
  const h = await sha256Hex(`${jwk.crv}|${jwk.x}|${jwk.y}`);
  return h.slice(0, 16).match(/.{4}/g)!.join(":");
}

export async function signChainHash(privateKey: CryptoKey, chainHash: string): Promise<string> {
  const sig = await subtle().sign(ECDSA_SIGN, privateKey, new TextEncoder().encode(chainHash));
  return bufToBase64(sig);
}

export async function verifyChainSignature(
  publicKey: CryptoKey,
  chainHash: string,
  signatureB64: string
): Promise<boolean> {
  try {
    return await subtle().verify(
      ECDSA_SIGN,
      publicKey,
      base64ToBuf(signatureB64),
      new TextEncoder().encode(chainHash)
    );
  } catch {
    return false;
  }
}

// ── Build a full record (Encoder side) ───────────────────────────────────────

export async function buildSignedRecord(
  core: SegmentCore,
  privateKey: CryptoKey
): Promise<SegmentRecord> {
  const chain_hash = await computeChainHash(core);
  const signature = await signChainHash(privateKey, chain_hash);
  return { ...core, chain_hash, signature };
}

// ── File naming ──────────────────────────────────────────────────────────────

export function extensionForMime(mime: string): string {
  return mime.includes("mp4") ? "mp4" : "webm";
}

/** dashcam_<session uuid>_<seq 5 digits>.<ext> */
export function segmentFileName(sessionId: string, seq: number, mime: string): string {
  return `dashcam_${sessionId}_${String(seq).padStart(5, "0")}.${extensionForMime(mime)}`;
}

const NAME_RE =
  /dashcam_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)\./i;

/** Filename is only a hint (it can be renamed); the hash is the authority. */
export function parseSegmentFileName(name: string): { session_id: string; seq: number } | null {
  const m = NAME_RE.exec(name);
  return m ? { session_id: m[1].toLowerCase(), seq: parseInt(m[2], 10) } : null;
}
