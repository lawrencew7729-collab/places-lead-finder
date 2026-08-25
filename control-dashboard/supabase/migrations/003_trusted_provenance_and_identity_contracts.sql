begin;

-- Audit provenance is explicit and actor fields are derived inside trusted database paths.
alter table public.audit_logs add column actor_type text;
update public.audit_logs
set actor_type = case when actor_user_id is null then 'system' else 'user' end
where actor_type is null;
alter table public.audit_logs alter column actor_type set not null;
alter table public.audit_logs add constraint audit_logs_actor_type_check
  check (actor_type in ('user', 'system'));
alter table public.audit_logs add constraint audit_logs_actor_identity_check
  check ((actor_type = 'user' and actor_user_id is not null) or (actor_type = 'system' and actor_user_id is null));

comment on column public.audit_logs.actor_type is 'USER actors are derived from auth.uid() and operator_profiles; SYSTEM actors are written only through the trusted server RPC.';
comment on table public.audit_logs is 'Append-only audit log. Authenticated callers cannot INSERT directly; trusted RPCs derive USER/SYSTEM actor provenance. No UPDATE or DELETE policy.';

drop policy if exists "Operators insert audit logs" on public.audit_logs;

create or replace function public.write_user_audit_event(
  p_tenant_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_previous_state_redacted jsonb default null,
  p_new_state_redacted jsonb default null,
  p_request_id uuid default gen_random_uuid(),
  p_ip_hash text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_label text;
  v_audit_id bigint;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated USER actor required';
  end if;

  select p.display_name
  into v_actor_label
  from public.operator_profiles p
  where p.user_id = v_actor_user_id
    and p.active
    and p.role in ('admin'::public.operator_role, 'operator'::public.operator_role);

  if v_actor_label is null then
    raise exception 'Active admin/operator profile required for USER audit event';
  end if;

  insert into public.audit_logs (
    actor_type, actor_user_id, actor_label, tenant_id, action, entity_type,
    entity_id, previous_state_redacted, new_state_redacted, request_id, ip_hash
  ) values (
    'user', v_actor_user_id, v_actor_label, p_tenant_id, p_action, p_entity_type,
    p_entity_id, p_previous_state_redacted, p_new_state_redacted, p_request_id, p_ip_hash
  ) returning id into v_audit_id;

  return v_audit_id;
end;
$$;

revoke all on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) from public;
grant execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) to authenticated;

create or replace function public.write_system_audit_event(
  p_system_actor text,
  p_tenant_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_previous_state_redacted jsonb default null,
  p_new_state_redacted jsonb default null,
  p_request_id uuid default gen_random_uuid()
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audit_id bigint;
begin
  if p_system_actor not in ('control_plane', 'provider_gateway', 'release_registry', 'scheduler') then
    raise exception 'Unrecognized trusted SYSTEM actor';
  end if;

  insert into public.audit_logs (
    actor_type, actor_user_id, actor_label, tenant_id, action, entity_type,
    entity_id, previous_state_redacted, new_state_redacted, request_id
  ) values (
    'system', null, p_system_actor, p_tenant_id, p_action, p_entity_type,
    p_entity_id, p_previous_state_redacted, p_new_state_redacted, p_request_id
  ) returning id into v_audit_id;

  return v_audit_id;
end;
$$;

-- No client grant: function owner / trusted backend role only.
revoke all on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from public;
revoke all on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from authenticated;

-- One lowercase DNS label (1..63 chars), exactly under leadfinder.business.
alter table public.tenants drop constraint if exists tenants_exact_subdomain_check;
alter table public.tenants add constraint tenants_exact_subdomain_check
  check (exact_subdomain ~ '^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])\.leadfinder\.business$');
comment on column public.tenants.exact_subdomain is 'Exactly one lowercase DNS label under leadfinder.business; immutable and globally UNIQUE.';

-- Full server-computed SHA-256 metadata only. Raw API keys are never valid fingerprints.
alter table public.customer_configurations
  alter column places_key_fingerprint type varchar(64);
alter table public.customer_configurations
  add constraint customer_configurations_places_key_fingerprint_sha256_check
  check (places_key_fingerprint is null or places_key_fingerprint ~ '^[A-F0-9]{64}$');
comment on column public.customer_configurations.places_key_fingerprint is 'Full uppercase SHA-256 fingerprint computed by a trusted server/provider adapter; never the raw customer Places API key.';

commit;
