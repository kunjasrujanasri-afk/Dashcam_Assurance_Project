"use client";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getBrowserSupabase } from "./supabase-browser";
import { loadKeyPair, saveKeyPair, type LocalSegment } from "./local-vault";
import { sha256, type SignedFingerprint } from "./signed-evidence";

export type DeviceIdentity = { workspaceId: string; deviceId: string; keys: NonNullable<Awaited<ReturnType<typeof loadKeyPair>>>; user: User };
const dbError = (error: { message: string; code?: string } | null, action: string) => {
  if (!error) return;
  const wrapped = new Error(`${action}: ${error.message}`) as Error & { code?: string };
  wrapped.code = error.code; throw wrapped;
};

export async function getAuthedClient() {
  const client = await getBrowserSupabase();
  if (!client) throw new Error("Supabase is not configured. Set its project URL and publishable/anon key in the deployment environment.");
  const { data, error } = await client.auth.getUser(); dbError(error, "Could not read the signed-in session");
  if (!data.user) throw new Error("Sign in to access secure capture and verification.");
  return { client, user: data.user };
}

export async function bootstrapWorkspace(client: SupabaseClient) {
  const { data, error } = await client.rpc("bootstrap_workspace", { workspace_name: "Forensics Lab" });
  dbError(error, "Could not open your secure workspace");
  if (typeof data !== "string") throw new Error("Workspace setup returned no workspace ID.");
  return data;
}

async function assertDeviceOwnership(client: SupabaseClient, workspaceId: string, deviceId: string, expectedUserId: string) {
  const { data: authData, error: authError } = await client.auth.getUser();
  dbError(authError, "Could not confirm the signed-in account");
  if (!authData.user || authData.user.id !== expectedUserId) throw new Error("Your sign-in changed. Reload the workspace before recording or sending evidence.");
  const { data: device, error } = await client.from("devices").select("id,workspace_id,owner_id").eq("id", deviceId).maybeSingle();
  dbError(error, "Could not validate the registered camera device");
  if (!device) throw new Error("This camera device is not registered to the signed-in account. Refresh the workspace to register a new signing device.");
  if (device.workspace_id !== workspaceId || device.owner_id !== authData.user.id) throw new Error("The registered camera device belongs to a different workspace or account. Refresh the workspace before recording.");
  return authData.user;
}

async function ensureOwnedSession(client: SupabaseClient, workspaceId: string, deviceId: string, sessionId: string, startedAt: string, ownerId: string, action: string) {
  const { error: rpcError } = await client.rpc("ensure_owned_capture_session", { requested_session: sessionId, requested_workspace: workspaceId, requested_device: deviceId, requested_started_at: startedAt });
  if (!rpcError) return;
  if (rpcError.code !== "PGRST202" && rpcError.code !== "42883") dbError(rpcError, action);

  // Compatibility during rollout: use the same owner-bound table policy if the
  // recovery RPC migration has not reached this Supabase project yet.
  const { data: existing, error: lookupError } = await client.from("capture_sessions").select("id,workspace_id,device_id,owner_id").eq("id", sessionId).maybeSingle();
  dbError(lookupError, "Could not check the capture session");
  if (existing) {
    if (existing.workspace_id !== workspaceId || existing.device_id !== deviceId || existing.owner_id !== ownerId) throw new Error("This capture session belongs to a different device or account.");
    return;
  }
  const { error: insertError } = await client.from("capture_sessions").insert({ id: sessionId, workspace_id: workspaceId, device_id: deviceId, owner_id: ownerId, started_at: startedAt });
  dbError(insertError, action);
}

export async function prepareIdentity(client: SupabaseClient, user: User): Promise<DeviceIdentity> {
  const localKey = `driveproof-device:${user.id}`, workspaceKey = `driveproof-workspace:${user.id}`;
  const cachedDevice = localStorage.getItem(localKey), cachedWorkspace = localStorage.getItem(workspaceKey);
  const cachedKeys = cachedDevice ? await loadKeyPair(cachedDevice) : null;
  if (!navigator.onLine && cachedDevice && cachedWorkspace && cachedKeys) return { workspaceId: cachedWorkspace, deviceId: cachedDevice, keys: cachedKeys, user };
  try {
    const workspaceId = await bootstrapWorkspace(client);
    let deviceId = cachedDevice || crypto.randomUUID();
    let keys = await loadKeyPair(deviceId);
    const { data: initialDevice, error } = await client.from("devices").select("id,public_key,workspace_id,owner_id").eq("id", deviceId).maybeSingle();
    let existing = initialDevice;
    dbError(error, "Could not check the registered signing device");
    if (existing && (!keys || JSON.stringify(existing.public_key) !== JSON.stringify(keys.publicJwk) || existing.workspace_id !== workspaceId || existing.owner_id !== user.id)) {
      deviceId = crypto.randomUUID(); keys = undefined; existing = null;
    }
    if (!keys) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const privateBytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
      const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      await saveKeyPair(deviceId, privateKey, pair.publicKey, publicJwk);
      keys = { id: deviceId, privateKey, publicKey: pair.publicKey, publicJwk };
    }
    if (!existing) {
      const { error: insertError } = await client.from("devices").insert({ id: deviceId, workspace_id: workspaceId, owner_id: user.id, label: "Browser dashcam", public_key: keys.publicJwk, last_seen_at: new Date().toISOString() });
      dbError(insertError, "Could not register this device signing key");
    }
    localStorage.setItem(localKey, deviceId); localStorage.setItem(workspaceKey, workspaceId);
    const { error: touchError } = await client.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", deviceId);
    dbError(touchError, "Could not update the device status");
    return { workspaceId, deviceId, keys, user };
  } catch (error) {
    if (!navigator.onLine && cachedDevice && cachedWorkspace && cachedKeys) return { workspaceId: cachedWorkspace, deviceId: cachedDevice, keys: cachedKeys, user };
    throw error;
  }
}

export async function startCaptureSession(client: SupabaseClient, identity: DeviceIdentity, id = crypto.randomUUID(), startedAt = new Date().toISOString()) {
  const owner = await assertDeviceOwnership(client, identity.workspaceId, identity.deviceId, identity.user.id);
  await ensureOwnedSession(client, identity.workspaceId, identity.deviceId, id, startedAt, owner.id, "Could not start a trusted capture session");
  return { id, startedAt };
}

export async function endCaptureSession(client: SupabaseClient, id: string) {
  const { error } = await client.from("capture_sessions").update({ ended_at: new Date().toISOString() }).eq("id", id);
  dbError(error, "Could not close the capture session");
}

export async function ensureCaptureSession(client: SupabaseClient, fingerprint: SignedFingerprint, ownerId: string) {
  const owner = await assertDeviceOwnership(client, fingerprint.workspaceId, fingerprint.deviceId, ownerId);
  await ensureOwnedSession(client, fingerprint.workspaceId, fingerprint.deviceId, fingerprint.sessionId, fingerprint.capturedAt, owner.id, "Could not restore the queued capture session");
}

function fingerprintRow(item: SignedFingerprint) {
  return {
    version: item.version, workspace_id: item.workspaceId, device_id: item.deviceId, session_id: item.sessionId,
    segment_id: item.segmentId, sequence: item.sequence, captured_at: item.capturedAt, bytes: item.bytes,
    sha256: item.sha256, previous_hash: item.previousHash, chain_hash: item.chainHash, signature: item.signature,
    signature_algorithm: item.signatureAlgorithm, perceptual: item.perceptual, perceptual_hash: item.perceptualHash,
    source: item.source, metadata: item.metadata,
  };
}

export async function transmitFingerprint(client: SupabaseClient, fingerprint: SignedFingerprint) {
  const { data: old, error: lookupError } = await client.from("evidence_fingerprints").select("id,chain_hash,sha256").eq("segment_id", fingerprint.segmentId).maybeSingle();
  dbError(lookupError, "Could not check for an existing segment");
  if (old) {
    if (old.sha256 !== fingerprint.sha256 || old.chain_hash !== fingerprint.chainHash) throw new Error("Evidence ID conflict: the server already has different bytes for this segment.");
    return old.id as string;
  }
  const { data, error } = await client.from("evidence_fingerprints").insert(fingerprintRow(fingerprint)).select("id").single();
  dbError(error, "Could not transmit the signed fingerprint");
  if (!data) throw new Error("The evidence insert returned no server record.");
  return data.id as string;
}

export async function uploadRecordedSegment(client: SupabaseClient, segment: LocalSegment) {
  if (!segment.fingerprintId) throw new Error("The signed fingerprint must be acknowledged before the video upload.");
  if (segment.blob.size !== segment.fingerprint.bytes || await sha256(segment.blob) !== segment.fingerprint.sha256) throw new Error("The local video no longer matches its signed fingerprint; upload stopped.");
  const path = `${segment.workspaceId}/${segment.deviceId}/${segment.sessionId}/${segment.sequence}-${segment.id}.webm`;
  const { data: existing, error: lookupError } = await client.from("evidence_recordings").select("storage_path,sha256,bytes").eq("segment_id", segment.id).maybeSingle();
  dbError(lookupError, "Could not check the cloud video record");
  if (existing) {
    if (existing.sha256 !== segment.fingerprint.sha256 || Number(existing.bytes) !== segment.blob.size) throw new Error("Cloud video ID conflict: the saved record has different bytes.");
    return { storage_path: String(existing.storage_path) };
  }
  const { error: uploadError } = await client.storage.from("evidence").upload(path, segment.blob, { contentType: segment.mimeType || "video/webm", upsert: true });
  dbError(uploadError, "Could not upload the camera video to private Supabase storage");
  const { error } = await client.from("evidence_recordings").insert({ workspace_id: segment.workspaceId, device_id: segment.deviceId, session_id: segment.sessionId, segment_id: segment.id, storage_path: path, bytes: segment.blob.size, sha256: segment.fingerprint.sha256 });
  if (error && error.code !== "23505") dbError(error, "Could not register the uploaded camera video");
  const { data: saved, error: savedError } = await client.from("evidence_recordings").select("storage_path,sha256,bytes").eq("segment_id", segment.id).maybeSingle();
  dbError(savedError, "Could not confirm the uploaded camera video");
  if (!saved || saved.sha256 !== segment.fingerprint.sha256 || Number(saved.bytes) !== segment.blob.size) throw new Error("Supabase did not confirm the signed camera video upload.");
  return { storage_path: String(saved.storage_path) };
}

export async function fetchWorkspaceFingerprints(client: SupabaseClient, workspaceId: string, deviceId?: string, sessionId?: string) {
  let query = client.from("evidence_fingerprints").select("*,devices!inner(public_key,label)").eq("workspace_id", workspaceId).order("captured_at", { ascending: true }).limit(10000);
  if (deviceId) query = query.eq("device_id", deviceId);
  if (sessionId) query = query.eq("session_id", sessionId);
  const { data, error } = await query; dbError(error, "Could not read trusted fingerprints");
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function findFingerprintsByHashes(client: SupabaseClient, workspaceId: string, hashes: string[], bytes?: number) {
  const found: Array<Record<string, unknown>> = [], unique = [...new Set(hashes.map(hash => hash.toLowerCase()))];
  for (let offset = 0; offset < unique.length; offset += 100) {
    let query = client.from("evidence_fingerprints").select("*,devices!inner(public_key,label)").eq("workspace_id", workspaceId).in("sha256", unique.slice(offset, offset + 100)).limit(10000);
    if (bytes !== undefined) query = query.eq("bytes", bytes);
    const { data, error } = await query;
    dbError(error, "Could not compare hashes with Supabase fingerprints");
    found.push(...(data ?? []) as Array<Record<string, unknown>>);
  }
  return found;
}

export async function fetchSessionFingerprints(client: SupabaseClient, workspaceId: string, sessionId: string) {
  const { data, error } = await client.from("evidence_fingerprints").select("*,devices!inner(public_key,label)").eq("workspace_id", workspaceId).eq("session_id", sessionId).order("sequence", { ascending: true }).limit(10000);
  dbError(error, "Could not load the complete Supabase session chain");
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function fetchWorkspaceRecordings(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.from("evidence_recordings").select("*,devices(label)").eq("workspace_id", workspaceId).order("uploaded_at", { ascending: false }).limit(10000);
  dbError(error, "Could not load cloud video recordings");
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function getDeviceFingerprintSummary(client: SupabaseClient, workspaceId: string, deviceId: string) {
  const { count, error } = await client.from("evidence_fingerprints").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("device_id", deviceId);
  dbError(error, "Could not count the cloud fingerprints");
  const { data, error: latestError } = await client.from("evidence_fingerprints").select("*").eq("workspace_id", workspaceId).eq("device_id", deviceId).order("captured_at", { ascending: false }).limit(1).maybeSingle();
  dbError(latestError, "Could not load the most recent fingerprint");
  return { count: count ?? 0, latest: data };
}

export async function openIncident(client: SupabaseClient, identity: DeviceIdentity, title = "Protected dashcam incident") {
  const owner = await assertDeviceOwnership(client, identity.workspaceId, identity.deviceId, identity.user.id);
  const { data, error } = await client.from("incidents").insert({ workspace_id: identity.workspaceId, device_id: identity.deviceId, owner_id: owner.id, title, severity: "high", status: "open" }).select("id").single();
  dbError(error, "Could not create the incident record");
  if (!data) throw new Error("The incident insert returned no server record.");
  return data.id as string;
}

export async function uploadProtectedSegment(client: SupabaseClient, segment: LocalSegment, incidentId: string) {
  if (!segment.fingerprintId) throw new Error("The fingerprint must be acknowledged before protected video upload.");
  const path = segment.recordingPath || `${segment.workspaceId}/${segment.deviceId}/${incidentId}/${segment.sequence}-${segment.id}.webm`;
  if (!segment.recordingPath) {
    const { error: uploadError } = await client.storage.from("evidence").upload(path, segment.blob, { contentType: segment.mimeType || "video/webm", upsert: true });
    dbError(uploadError, "Could not upload the protected incident clip");
  }
  const { data, error } = await client.from("incident_videos").insert({
    workspace_id: segment.workspaceId, device_id: segment.deviceId, incident_id: incidentId,
    fingerprint_id: segment.fingerprintId, session_id: segment.sessionId, segment_id: segment.id,
    sequence: segment.sequence, storage_path: path, bytes: segment.blob.size,
    mime_type: segment.mimeType || "video/webm", sha256: segment.fingerprint.sha256,
  }).select("id,storage_path").single();
  if (error) { if (!segment.recordingPath) await client.storage.from("evidence").remove([path]); dbError(error, "Could not link the protected incident clip"); }
  if (!data) throw new Error("The incident video link returned no server record.");
  return data;
}

export async function listIncidents(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.from("incidents").select("*,devices(label),incident_videos(id,segment_id,sequence,storage_path,bytes,mime_type,sha256)").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(200);
  dbError(error, "Could not load workspace incidents"); return data ?? [];
}

export async function downloadProtectedSegment(client: SupabaseClient, storagePath: string) {
  const { data, error } = await client.storage.from("evidence").download(storagePath);
  dbError(error, "Could not retrieve the protected incident clip"); return data;
}

export async function logVerification(client: SupabaseClient, workspaceId: string, actorId: string, kind: string, status: string, name: string, details: Record<string, unknown>) {
  const { error } = await client.from("verification_attempts").insert({ id: String(details.attemptId ?? crypto.randomUUID()), workspace_id: workspaceId, actor_id: actorId, kind, status, name, details });
  dbError(error, "Could not save verification history");
}

export async function loadVerificationHistory(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.from("verification_attempts").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(500);
  dbError(error, "Could not load verification history"); return data ?? [];
}

export async function logAuditEvent(client: SupabaseClient, workspaceId: string, actorId: string, action: string, target: string, payload: Record<string, unknown> = {}) {
  const { error } = await client.from("audit_events").insert({ workspace_id: workspaceId, actor_id: actorId, action, target, payload });
  dbError(error, "Could not save the audit event");
}

export async function loadAuditEvents(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.from("audit_events").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(500);
  dbError(error, "Could not load audit events"); return data ?? [];
}

export async function subscribeWorkspace(client: SupabaseClient, workspaceId: string, changed: () => void) {
  return client.channel(`evidence:${workspaceId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "evidence_fingerprints", filter: `workspace_id=eq.${workspaceId}` }, changed)
    .on("postgres_changes", { event: "*", schema: "public", table: "incidents", filter: `workspace_id=eq.${workspaceId}` }, changed)
    .on("postgres_changes", { event: "*", schema: "public", table: "verification_attempts", filter: `workspace_id=eq.${workspaceId}` }, changed)
    .on("postgres_changes", { event: "*", schema: "public", table: "audit_events", filter: `workspace_id=eq.${workspaceId}` }, changed)
    .subscribe();
}
