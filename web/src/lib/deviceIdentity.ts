/**
 * src/lib/deviceIdentity.ts
 *
 * Each phone owns a random device id and an ECDSA P-256 key pair created on
 * first launch. The private key is generated as NON-extractable and kept in
 * IndexedDB: JavaScript can use it to sign but can never read its bytes.
 * The public key is registered once in public.devices so that the insurer
 * can verify every segment signature.
 */

import { exportPublicJwk, generateDeviceKeyPair, publicKeyFingerprint } from "./integrity";
import { kvGet, kvSet } from "./localStore";
import { isTransientFailure, supabase } from "./supabaseClient";

export interface DeviceIdentity {
  deviceId: string;
  label: string;
  keyPair: CryptoKeyPair;
  publicJwk: JsonWebKey;
  fingerprint: string;
  registered: boolean;
}

const KV_KEY = "device-identity";

export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const existing = await kvGet<DeviceIdentity>(KV_KEY);
  if (existing?.keyPair?.privateKey) return existing;

  const keyPair = await generateDeviceKeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = /iphone|ipad/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : "Desktop";
  const identity: DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    label: `${platform} dashcam`,
    keyPair,
    publicJwk,
    fingerprint: await publicKeyFingerprint(publicJwk),
    registered: false,
  };
  await kvSet(KV_KEY, identity);
  return identity;
}

/**
 * Registers the public key on the server (idempotent: ON CONFLICT DO NOTHING).
 * Returns "ok", "retry" (network problem) or an error message.
 */
export async function registerDevice(identity: DeviceIdentity): Promise<"ok" | "retry" | string> {
  if (identity.registered) return "ok";
  const { publicJwk } = identity;
  const { error, status } = await supabase.from("devices").upsert(
    {
      id: identity.deviceId,
      label: identity.label,
      public_key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (error) return isTransientFailure(status) ? "retry" : `${error.message}`;
  identity.registered = true;
  await kvSet(KV_KEY, identity);
  return "ok";
}
