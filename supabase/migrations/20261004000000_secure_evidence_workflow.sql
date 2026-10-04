-- Authenticated, workspace-scoped evidence workflow. The original public
-- fingerprints table remains available for the legacy Streamlit workflow.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New user',
  created_at timestamptz not null default now()
);
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'driver' check (role in ('admin','analyst','viewer','driver')),
  primary key (workspace_id,user_id)
);
create table if not exists public.devices (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  public_key jsonb not null,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, owner_id, id)
);
create table if not exists public.capture_sessions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.evidence_fingerprints (
  id uuid primary key default gen_random_uuid(),
  version integer not null check(version = 3),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  session_id uuid not null references public.capture_sessions(id) on delete restrict,
  segment_id uuid not null unique,
  sequence integer not null check(sequence >= 0),
  captured_at timestamptz not null,
  bytes bigint not null check(bytes >= 0),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  previous_hash text check(previous_hash is null or previous_hash ~ '^[0-9a-f]{64}$'),
  chain_hash text not null check(chain_hash ~ '^[0-9a-f]{64}$'),
  signature text not null,
  signature_algorithm text not null check(signature_algorithm = 'ECDSA_P256_SHA256'),
  perceptual jsonb not null,
  perceptual_hash text not null check(perceptual_hash ~ '^[0-9a-f]{64}$'),
  source text not null default 'recorded-video-segment',
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique(session_id, sequence)
);
create index if not exists evidence_fingerprints_workspace_time_idx on public.evidence_fingerprints(workspace_id,captured_at desc);
create index if not exists evidence_fingerprints_device_session_idx on public.evidence_fingerprints(device_id,session_id,sequence);
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  title text not null,
  severity text not null default 'medium' check(severity in ('low','medium','high','critical')),
  status text not null default 'open' check(status in ('open','reviewing','resolved')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.incident_videos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  incident_id uuid not null references public.incidents(id) on delete restrict,
  fingerprint_id uuid not null references public.evidence_fingerprints(id) on delete restrict,
  session_id uuid not null references public.capture_sessions(id) on delete restrict,
  segment_id uuid not null unique,
  sequence integer not null check(sequence >= 0),
  storage_path text not null unique,
  bytes bigint not null check(bytes >= 0),
  mime_type text not null,
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.verification_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  status text not null,
  name text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_workspace_member(requested_workspace uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and exists(select 1 from public.workspace_members where workspace_id=requested_workspace and user_id=auth.uid());
$$;
create or replace function public.has_workspace_role(requested_workspace uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and exists(select 1 from public.workspace_members where workspace_id=requested_workspace and user_id=auth.uid() and role=any(allowed_roles));
$$;
create or replace function public.can_access_device(requested_workspace uuid, requested_device uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_workspace_role(requested_workspace,array['admin','analyst']) or exists(select 1 from public.devices where id=requested_device and workspace_id=requested_workspace and owner_id=auth.uid());
$$;
create or replace function public.bootstrap_workspace(workspace_name text default 'Forensics Lab')
returns uuid language plpgsql security definer set search_path=public as $$
declare wid uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select wm.workspace_id into wid from public.workspace_members wm where wm.user_id=auth.uid() order by wm.workspace_id limit 1;
  if wid is not null then return wid; end if;
  insert into public.workspaces(name) values(coalesce(nullif(trim(workspace_name),''),'Forensics Lab')) returning id into wid;
  insert into public.workspace_members(workspace_id,user_id,role) values(wid,auth.uid(),'admin');
  return wid;
end;
$$;
create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name',split_part(coalesce(new.email,''),'@',1),'New user')) on conflict(id) do nothing;
  return new;
end;
$$;
drop trigger if exists secure_evidence_profile_insert on auth.users;
create trigger secure_evidence_profile_insert after insert on auth.users for each row execute function public.create_profile_for_auth_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.devices enable row level security;
alter table public.capture_sessions enable row level security;
alter table public.evidence_fingerprints enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_videos enable row level security;
alter table public.verification_attempts enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists "secure evidence profile read" on public.profiles;
create policy "secure evidence profile read" on public.profiles for select to authenticated using(id=auth.uid() or exists(select 1 from public.workspace_members a join public.workspace_members b using(workspace_id) where a.user_id=auth.uid() and b.user_id=profiles.id));
drop policy if exists "secure evidence profile update" on public.profiles;
create policy "secure evidence profile update" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists "secure evidence workspace read" on public.workspaces;
create policy "secure evidence workspace read" on public.workspaces for select to authenticated using(public.is_workspace_member(id));
drop policy if exists "secure evidence membership read" on public.workspace_members;
create policy "secure evidence membership read" on public.workspace_members for select to authenticated using(public.is_workspace_member(workspace_id));
drop policy if exists "secure evidence membership manage" on public.workspace_members;
create policy "secure evidence membership manage" on public.workspace_members for all to authenticated using(public.has_workspace_role(workspace_id,array['admin'])) with check(public.has_workspace_role(workspace_id,array['admin']));
drop policy if exists "secure evidence device read" on public.devices;
create policy "secure evidence device read" on public.devices for select to authenticated using(public.can_access_device(workspace_id,id));
drop policy if exists "secure evidence device insert" on public.devices;
create policy "secure evidence device insert" on public.devices for insert to authenticated with check(owner_id=auth.uid() and public.is_workspace_member(workspace_id));
drop policy if exists "secure evidence device update" on public.devices;
create policy "secure evidence device update" on public.devices for update to authenticated using(owner_id=auth.uid() or public.has_workspace_role(workspace_id,array['admin','analyst'])) with check(owner_id=auth.uid() or public.has_workspace_role(workspace_id,array['admin','analyst']));
drop policy if exists "secure evidence session read" on public.capture_sessions;
create policy "secure evidence session read" on public.capture_sessions for select to authenticated using(public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence session insert" on public.capture_sessions;
create policy "secure evidence session insert" on public.capture_sessions for insert to authenticated with check(owner_id=auth.uid() and public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence session close" on public.capture_sessions;
create policy "secure evidence session close" on public.capture_sessions for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
drop policy if exists "secure evidence fingerprint read" on public.evidence_fingerprints;
create policy "secure evidence fingerprint read" on public.evidence_fingerprints for select to authenticated using(public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence fingerprint insert" on public.evidence_fingerprints;
create policy "secure evidence fingerprint insert" on public.evidence_fingerprints for insert to authenticated with check(
  public.can_access_device(workspace_id,device_id) and exists(
    select 1 from public.capture_sessions s
    where s.id=evidence_fingerprints.session_id and s.workspace_id=evidence_fingerprints.workspace_id and s.device_id=evidence_fingerprints.device_id and s.owner_id=auth.uid()
  )
);
drop policy if exists "secure evidence incident read" on public.incidents;
create policy "secure evidence incident read" on public.incidents for select to authenticated using(public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence incident insert" on public.incidents;
create policy "secure evidence incident insert" on public.incidents for insert to authenticated with check(owner_id=auth.uid() and public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence incident update" on public.incidents;
create policy "secure evidence incident update" on public.incidents for update to authenticated using(public.has_workspace_role(workspace_id,array['admin','analyst'])) with check(public.has_workspace_role(workspace_id,array['admin','analyst']));
drop policy if exists "secure evidence incident video read" on public.incident_videos;
create policy "secure evidence incident video read" on public.incident_videos for select to authenticated using(public.can_access_device(workspace_id,device_id));
drop policy if exists "secure evidence incident video insert" on public.incident_videos;
create policy "secure evidence incident video insert" on public.incident_videos for insert to authenticated with check(
  public.can_access_device(workspace_id,device_id) and exists(
    select 1 from public.incidents i join public.evidence_fingerprints f on f.id=incident_videos.fingerprint_id
    where i.id=incident_videos.incident_id and i.workspace_id=incident_videos.workspace_id and i.device_id=incident_videos.device_id
      and f.workspace_id=incident_videos.workspace_id and f.device_id=incident_videos.device_id and f.session_id=incident_videos.session_id and f.segment_id=incident_videos.segment_id
  )
);
drop policy if exists "secure evidence check read" on public.verification_attempts;
create policy "secure evidence check read" on public.verification_attempts for select to authenticated using(public.is_workspace_member(workspace_id));
drop policy if exists "secure evidence check insert" on public.verification_attempts;
create policy "secure evidence check insert" on public.verification_attempts for insert to authenticated with check(actor_id=auth.uid() and public.is_workspace_member(workspace_id));
drop policy if exists "secure evidence audit read" on public.audit_events;
create policy "secure evidence audit read" on public.audit_events for select to authenticated using(public.is_workspace_member(workspace_id));
drop policy if exists "secure evidence audit insert" on public.audit_events;
create policy "secure evidence audit insert" on public.audit_events for insert to authenticated with check((actor_id is null or actor_id=auth.uid()) and public.has_workspace_role(workspace_id,array['admin','analyst','driver']));

revoke all on function public.bootstrap_workspace(text) from public,anon;
revoke all on function public.is_workspace_member(uuid) from public,anon;
revoke all on function public.has_workspace_role(uuid,text[]) from public,anon;
revoke all on function public.can_access_device(uuid,uuid) from public,anon;
grant execute on function public.bootstrap_workspace(text) to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid,text[]) to authenticated;
grant execute on function public.can_access_device(uuid,uuid) to authenticated;
grant select,update on public.profiles to authenticated;
grant select on public.workspaces,public.workspace_members,public.devices,public.capture_sessions,public.evidence_fingerprints,public.incidents,public.incident_videos,public.verification_attempts,public.audit_events to authenticated;
grant insert on public.devices,public.capture_sessions,public.evidence_fingerprints,public.incidents,public.incident_videos,public.verification_attempts,public.audit_events to authenticated;
grant insert,update,delete on public.workspace_members to authenticated;
grant update(ended_at) on public.capture_sessions to authenticated;
grant update(status,assigned_to) on public.incidents to authenticated;

-- The legacy driver_id table has no user identity column, so it must not remain
-- anonymously readable/writable once authenticated workspaces are enabled.
do $$ declare p record; anon_id oid; begin
  if to_regclass('public.fingerprints') is not null then
    select oid into anon_id from pg_roles where rolname='anon';
    for p in select polname from pg_policy where polrelid='public.fingerprints'::regclass
      and (polroles @> array[0::oid] or (anon_id is not null and polroles @> array[anon_id]))
    loop execute format('drop policy %I on public.fingerprints',p.polname); end loop;
    revoke all on public.fingerprints from anon;
  end if;
end $$;

insert into storage.buckets(id,name,public) values('evidence','evidence',false) on conflict(id) do update set public=false;
drop policy if exists "secure evidence storage read" on storage.objects;
create policy "secure evidence storage read" on storage.objects for select to authenticated using(
  bucket_id='evidence' and public.can_access_device(((storage.foldername(name))[1])::uuid,((storage.foldername(name))[2])::uuid)
);
drop policy if exists "secure evidence storage insert" on storage.objects;
create policy "secure evidence storage insert" on storage.objects for insert to authenticated with check(
  bucket_id='evidence' and public.can_access_device(((storage.foldername(name))[1])::uuid,((storage.foldername(name))[2])::uuid)
  and exists(select 1 from public.incidents i where i.id=((storage.foldername(name))[3])::uuid and i.workspace_id=((storage.foldername(name))[1])::uuid and i.device_id=((storage.foldername(name))[2])::uuid)
);
drop policy if exists "secure evidence storage delete" on storage.objects;
create policy "secure evidence storage delete" on storage.objects for delete to authenticated using(
  bucket_id='evidence' and public.has_workspace_role(((storage.foldername(name))[1])::uuid,array['admin'])
);

do $$ begin
  alter publication supabase_realtime add table public.evidence_fingerprints,public.incidents,public.verification_attempts,public.audit_events;
exception when duplicate_object then null;
end $$;
notify pgrst,'reload schema';
