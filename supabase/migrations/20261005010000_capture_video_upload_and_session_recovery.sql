-- Allow an authenticated device owner to safely restore its own offline session.
create or replace function public.ensure_owned_capture_session(
  requested_session uuid,
  requested_workspace uuid,
  requested_device uuid,
  requested_started_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare existing public.capture_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.devices d
    where d.id = requested_device
      and d.workspace_id = requested_workspace
      and d.owner_id = auth.uid()
  ) then raise exception 'The signed-in user does not own this camera device'; end if;

  insert into public.capture_sessions(id, workspace_id, device_id, owner_id, started_at)
  values(requested_session, requested_workspace, requested_device, auth.uid(), requested_started_at)
  on conflict(id) do nothing;

  select * into existing from public.capture_sessions s where s.id = requested_session;
  if existing.id is null
    or existing.workspace_id <> requested_workspace
    or existing.device_id <> requested_device
    or existing.owner_id <> auth.uid()
  then raise exception 'The capture session belongs to a different device or account'; end if;
  return existing.id;
end;
$$;
revoke all on function public.ensure_owned_capture_session(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.ensure_owned_capture_session(uuid, uuid, uuid, timestamptz) to authenticated;

-- Every acknowledged video is kept in the existing private evidence bucket.
create table if not exists public.evidence_recordings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  session_id uuid not null references public.capture_sessions(id) on delete restrict,
  segment_id uuid not null unique references public.evidence_fingerprints(segment_id) on delete cascade,
  storage_path text not null unique,
  bytes bigint not null check(bytes >= 0),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz not null default now()
);
create index if not exists evidence_recordings_workspace_time_idx on public.evidence_recordings(workspace_id, uploaded_at desc);
alter table public.evidence_recordings enable row level security;
drop policy if exists "secure evidence recording read" on public.evidence_recordings;
create policy "secure evidence recording read" on public.evidence_recordings
  for select to authenticated using(public.can_access_device(workspace_id, device_id));
drop policy if exists "secure evidence recording insert" on public.evidence_recordings;
create policy "secure evidence recording insert" on public.evidence_recordings
  for insert to authenticated with check(
    public.owns_device(workspace_id, device_id)
    and exists (
      select 1 from public.capture_sessions s
      where s.id = evidence_recordings.session_id
        and s.workspace_id = evidence_recordings.workspace_id
        and s.device_id = evidence_recordings.device_id
        and s.owner_id = auth.uid()
    )
    and exists (
      select 1 from public.evidence_fingerprints f
      where f.segment_id = evidence_recordings.segment_id
        and f.workspace_id = evidence_recordings.workspace_id
        and f.device_id = evidence_recordings.device_id
        and f.session_id = evidence_recordings.session_id
        and f.sha256 = evidence_recordings.sha256
        and f.bytes = evidence_recordings.bytes
    )
  );
grant select, insert on public.evidence_recordings to authenticated;

-- Keep session and incident clips in the same private bucket while validating
-- the third path component against a session or an owned incident.
drop policy if exists "secure evidence storage insert" on storage.objects;
create policy "secure evidence storage insert" on storage.objects
  for insert to authenticated with check(
    bucket_id = 'evidence'
    and public.can_access_device(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid)
    and (
      exists (
        select 1 from public.capture_sessions s
        where s.id = ((storage.foldername(name))[3])::uuid
          and s.workspace_id = ((storage.foldername(name))[1])::uuid
          and s.device_id = ((storage.foldername(name))[2])::uuid
          and s.owner_id = auth.uid()
      )
      or exists (
        select 1 from public.incidents i
        where i.id = ((storage.foldername(name))[3])::uuid
          and i.workspace_id = ((storage.foldername(name))[1])::uuid
          and i.device_id = ((storage.foldername(name))[2])::uuid
          and i.owner_id = auth.uid()
      )
    )
  );
drop policy if exists "secure evidence storage update" on storage.objects;
create policy "secure evidence storage update" on storage.objects
  for update to authenticated using(
    bucket_id = 'evidence'
    and public.owns_device(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid)
    and (
      exists (
        select 1 from public.capture_sessions s
        where s.id = ((storage.foldername(name))[3])::uuid
          and s.workspace_id = ((storage.foldername(name))[1])::uuid
          and s.device_id = ((storage.foldername(name))[2])::uuid
          and s.owner_id = auth.uid()
      )
      or exists (
        select 1 from public.incidents i
        where i.id = ((storage.foldername(name))[3])::uuid
          and i.workspace_id = ((storage.foldername(name))[1])::uuid
          and i.device_id = ((storage.foldername(name))[2])::uuid
          and i.owner_id = auth.uid()
      )
    )
  ) with check(
    bucket_id = 'evidence'
    and public.owns_device(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid)
    and (
      exists (
        select 1 from public.capture_sessions s
        where s.id = ((storage.foldername(name))[3])::uuid
          and s.workspace_id = ((storage.foldername(name))[1])::uuid
          and s.device_id = ((storage.foldername(name))[2])::uuid
          and s.owner_id = auth.uid()
      )
      or exists (
        select 1 from public.incidents i
        where i.id = ((storage.foldername(name))[3])::uuid
          and i.workspace_id = ((storage.foldername(name))[1])::uuid
          and i.device_id = ((storage.foldername(name))[2])::uuid
          and i.owner_id = auth.uid()
      )
    )
  );
