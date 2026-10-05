-- =============================================================================
-- Dashcam Integrity System — Supabase PostgreSQL schema (v2)
-- =============================================================================
-- Run this whole script once in the Supabase SQL Editor (it is idempotent, so
-- running it again is safe). It creates:
--
--   1. public.dashcam_devices         – one row per dashcam (smartphone) + its ECDSA
--                                public key, used to verify signatures.
--   2. public.dashcam_video_segments  – one row per recorded video segment: SHA-256 of
--                                the segment file, hash-chain link, signature,
--                                capture metadata and server arrival time.
--   3. Immutability triggers   – rows can be inserted, never updated.
--   4. Retention               – purge_expired_segments() deletes hashes whose
--                                retention period has passed (pg_cron job).
--   5. Storage bucket          – "dashcam-evidence": clips the driver submits to the
--                                insurer after an incident.
--   6. Realtime publication    – the Decoder receives new rows live.
-- =============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DEVICES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.dashcam_devices (
  owner_id    uuid not null default auth.uid() references auth.users(id),
  id          uuid primary key,                -- generated on the phone
  label       text,
  public_key  jsonb not null,                  -- ECDSA P-256 public key (JWK)
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VIDEO SEGMENTS (the "fingerprints")
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.dashcam_video_segments (
  id               uuid primary key default gen_random_uuid(),
  device_id        uuid   not null references public.dashcam_devices(id),
  session_id       uuid   not null,            -- one recording session
  seq              integer not null check (seq >= 0),

  -- SHA-256 of the exact bytes of the segment file (hex, 64 chars)
  segment_hash     text not null check (segment_hash    ~ '^[0-9a-f]{64}$'),
  -- hash chain: chain_hash = SHA-256(canonical record incl. prev_chain_hash)
  prev_chain_hash  text not null check (prev_chain_hash ~ '^[0-9a-f]{64}$'),
  chain_hash       text not null check (chain_hash      ~ '^[0-9a-f]{64}$'),
  -- ECDSA P-256 / SHA-256 signature of chain_hash by the device (base64)
  signature        text not null,

  -- capture metadata (client clock, epoch ms) – covered by the chain hash
  started_at       bigint  not null,
  ended_at         bigint  not null check (ended_at >= started_at),
  frame_count      integer not null check (frame_count >= 0),
  byte_size        bigint  not null check (byte_size > 0),
  mime_type        text    not null,
  width            integer,
  height           integer,
  latitude         double precision,
  longitude        double precision,

  -- server-side values: forced by trigger, the client cannot choose them
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '30 days',

  unique (session_id, seq)
);

create index if not exists idx_dashcam_segments_hash     on public.dashcam_video_segments (segment_hash);
create index if not exists idx_dashcam_segments_session  on public.dashcam_video_segments (session_id, seq);
create index if not exists idx_dashcam_segments_created  on public.dashcam_video_segments (created_at desc);
create index if not exists idx_dashcam_segments_expires  on public.dashcam_video_segments (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SERVER TIMESTAMPS + IMMUTABILITY
-- ─────────────────────────────────────────────────────────────────────────────
-- Retention period of the hashes on the server (change here if needed).
create or replace function public.dashcam_segment_retention()
returns interval language sql immutable as $$ select interval '30 days' $$;

-- Force created_at / expires_at to server time on insert (anti-backdating).
create or replace function public.dashcam_segments_before_insert()
returns trigger language plpgsql as $$
begin
  new.created_at := now();
  new.expires_at := now() + public.dashcam_segment_retention();
  return new;
end $$;

drop trigger if exists trg_segments_before_insert on public.dashcam_video_segments;
create trigger trg_segments_before_insert
  before insert on public.dashcam_video_segments
  for each row execute function public.dashcam_segments_before_insert();

-- Reject every UPDATE: a fingerprint, once anchored, can never change.
create or replace function public.dashcam_reject_update()
returns trigger language plpgsql as $$
begin
  raise exception 'Records in % are immutable', tg_table_name;
end $$;

drop trigger if exists trg_segments_no_update on public.dashcam_video_segments;
create trigger trg_segments_no_update
  before update on public.dashcam_video_segments
  for each row execute function public.dashcam_reject_update();

drop trigger if exists trg_devices_no_update on public.dashcam_devices;
create trigger trg_devices_no_update
  before update on public.dashcam_devices
  for each row execute function public.dashcam_reject_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- Signed-in accounts may insert and read their own devices and segments:
-- there is deliberately NO update and NO delete policy.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.dashcam_devices        enable row level security;
alter table public.dashcam_video_segments enable row level security;

drop policy if exists dashcam_devices_insert  on public.dashcam_devices;
drop policy if exists dashcam_devices_select  on public.dashcam_devices;
drop policy if exists segments_insert on public.dashcam_video_segments;
drop policy if exists segments_select on public.dashcam_video_segments;

create policy dashcam_devices_insert  on public.dashcam_devices        for insert to authenticated with check (owner_id = auth.uid());
create policy dashcam_devices_select  on public.dashcam_devices        for select to authenticated using (owner_id = auth.uid());
create policy segments_insert on public.dashcam_video_segments for insert to authenticated with check (exists(select 1 from public.dashcam_devices d where d.id = dashcam_video_segments.device_id and d.owner_id = auth.uid()));
create policy segments_select on public.dashcam_video_segments for select to authenticated using (exists(select 1 from public.dashcam_devices d where d.id = dashcam_video_segments.device_id and d.owner_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RETENTION — delete hashes that are no longer valid
-- Segments whose clip was submitted as evidence (storage bucket "evidence",
-- folder = session_id) are kept, because they are part of a claim.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.dashcam_purge_expired_segments()
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  n integer;
begin
  delete from public.dashcam_video_segments s
   where s.expires_at < now() and exists(select 1 from public.dashcam_devices d where d.id=s.device_id and d.owner_id=auth.uid())
     and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'dashcam-evidence'
          and o.name like s.session_id::text || '/%'
     );
  get diagnostics n = row_count;
  return n;
end $$;

-- The Decoder has a "Run retention purge" button (only removes expired rows).
grant execute on function public.dashcam_purge_expired_segments() to authenticated;

-- Manual owner-scoped retention purge.
-- 6. STORAGE BUCKET "evidence" (private; insert + read, no overwrite/delete)
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('dashcam-evidence', 'dashcam-evidence', false)
on conflict (id) do nothing;

drop policy if exists dashcam_evidence_insert on storage.objects;
drop policy if exists dashcam_evidence_select on storage.objects;

create policy dashcam_evidence_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'dashcam-evidence' and exists(select 1 from public.dashcam_video_segments s join public.dashcam_devices d on d.id=s.device_id where s.session_id::text=(storage.foldername(name))[1] and d.owner_id=auth.uid()));
create policy dashcam_evidence_select on storage.objects
  for select to authenticated using (bucket_id = 'dashcam-evidence' and exists(select 1 from public.dashcam_video_segments s join public.dashcam_devices d on d.id=s.device_id where s.session_id::text=(storage.foldername(name))[1] and d.owner_id=auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. REALTIME
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  alter publication supabase_realtime add table public.dashcam_video_segments;
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (Optional) remove the v1 table that stored per-frame JPEG hashes:
-- drop table if exists public.fingerprints;
-- ─────────────────────────────────────────────────────────────────────────────

grant select, insert on public.dashcam_devices, public.dashcam_video_segments to authenticated;
revoke all on function public.dashcam_purge_expired_segments() from public, anon;
grant execute on function public.dashcam_purge_expired_segments() to authenticated;