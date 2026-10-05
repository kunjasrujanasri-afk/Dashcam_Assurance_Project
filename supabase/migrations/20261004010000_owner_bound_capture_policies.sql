-- Bind driver writes to the authenticated owner of the registered camera device.
-- The decoder keeps workspace-scoped read access through can_access_device().
create or replace function public.owns_device(requested_workspace uuid, requested_device uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.devices d
    where d.id = requested_device
      and d.workspace_id = requested_workspace
      and d.owner_id = auth.uid()
  );
$$;

revoke all on function public.owns_device(uuid, uuid) from public, anon;
grant execute on function public.owns_device(uuid, uuid) to authenticated;

drop policy if exists "secure evidence session insert" on public.capture_sessions;
create policy "secure evidence session insert" on public.capture_sessions
for insert to authenticated
with check (owner_id = auth.uid() and public.owns_device(workspace_id, device_id));

drop policy if exists "secure evidence fingerprint insert" on public.evidence_fingerprints;
create policy "secure evidence fingerprint insert" on public.evidence_fingerprints
for insert to authenticated
with check (
  public.owns_device(workspace_id, device_id)
  and exists (
    select 1 from public.capture_sessions s
    where s.id = evidence_fingerprints.session_id
      and s.workspace_id = evidence_fingerprints.workspace_id
      and s.device_id = evidence_fingerprints.device_id
      and s.owner_id = auth.uid()
  )
);

drop policy if exists "secure evidence incident insert" on public.incidents;
create policy "secure evidence incident insert" on public.incidents
for insert to authenticated
with check (owner_id = auth.uid() and public.owns_device(workspace_id, device_id));
