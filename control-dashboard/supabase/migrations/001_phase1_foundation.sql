-- Lead Finder Control Dashboard — Phase 1 foundation
-- Control plane only. This migration does not read, modify, or depend on customer runtime deployments.
create extension if not exists pgcrypto;

do $$ begin
  create type public.operator_role as enum ('admin','operator','viewer','release_manager');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tenant_status as enum ('draft','setup_pending','verification_pending','active','suspended','archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.monitoring_mode as enum ('shared_access','dedicated_credential','not_configured');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.verification_status as enum ('not_checked','pending','pass','warning','fail');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.signal_status as enum ('green','amber','red','unknown');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.release_status as enum ('draft','candidate','approved','deprecated','withdrawn');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.alert_status as enum ('open','acknowledged','resolved','suppressed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.infrastructure_gate as enum ('green','amber','red','unknown');
exception when duplicate_object then null; end $$;

create table public.operator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role public.operator_role not null default 'viewer',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  exact_subdomain text not null unique check (exact_subdomain !~ '[*/:]'),
  status public.tenant_status not null default 'draft',
  annual_revenue_myr numeric(12,2) not null default 1500 check (annual_revenue_myr >= 0),
  monthly_revenue_equivalent_myr numeric(12,2) generated always as (annual_revenue_myr / 12) stored,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.customer_configurations (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  google_project_id text,
  places_key_fingerprint varchar(16) unique,
  places_key_status public.verification_status not null default 'not_checked',
  billing_status public.verification_status not null default 'not_checked',
  places_api_status public.verification_status not null default 'not_checked',
  website_restriction_exact text,
  website_restriction_status public.verification_status not null default 'not_checked',
  monitoring_mode public.monitoring_mode not null default 'not_configured',
  monitoring_status public.verification_status not null default 'not_checked',
  monitoring_credential_secret_ref text,
  monthly_usage_target integer not null default 1000 check (monthly_usage_target > 0),
  amber_threshold_percent numeric(5,2) not null default 80 check (amber_threshold_percent between 0 and 100),
  red_threshold_percent numeric(5,2) not null default 95 check (red_threshold_percent between 0 and 100),
  quota_enforcement_mode text not null default 'warn_only' check (quota_enforcement_mode in ('warn_only','disable_new_search')),
  telemetry_is_delayed boolean not null default true check (telemetry_is_delayed = true),
  device_limit integer not null default 2 check (device_limit > 0),
  login_status public.verification_status not null default 'not_checked',
  device_status public.verification_status not null default 'not_checked',
  customer_live_status public.verification_status not null default 'not_checked',
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  check (red_threshold_percent >= amber_threshold_percent),
  check ((monitoring_mode = 'dedicated_credential' and monitoring_credential_secret_ref is not null) or monitoring_mode <> 'dedicated_credential')
);
comment on column public.customer_configurations.monitoring_credential_secret_ref is 'Opaque server-side secret-manager reference only. Never store dedicated JSON credential content here.';
comment on column public.customer_configurations.places_key_fingerprint is 'Masked fingerprint only; never the raw customer Places API key.';

create table public.releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status public.release_status not null default 'draft',
  git_sha varchar(64) not null,
  artifact_sha256 varchar(64) not null unique,
  artifact_uri text not null,
  release_notes text not null default '',
  test_summary jsonb not null default '{}'::jsonb,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check ((status = 'approved' and approved_by is not null and approved_at is not null) or status <> 'approved')
);

create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  release_id uuid not null references public.releases(id) on delete restrict,
  provider text not null default 'vercel',
  provider_project_id text not null,
  provider_deployment_id text not null,
  exact_domain text not null,
  status public.verification_status not null default 'pending',
  is_current boolean not null default false,
  rollback_deployment_id text,
  deployed_by uuid references auth.users(id),
  deployed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, provider_deployment_id)
);
create unique index deployments_one_current_per_tenant on public.deployments(tenant_id) where is_current;

create table public.health_records (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete restrict,
  deployment_id uuid references public.deployments(id) on delete set null,
  category text not null check (category in ('api_key','places_api','website_restriction','billing','monitoring','quota','deployment','domain_https','login_device','app_version','export_xlsx','external_provider','control_plane')),
  signal public.signal_status not null,
  code text not null,
  message text not null,
  probable_cause text,
  provider_payload_redacted jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  health_record_id bigint references public.health_records(id) on delete set null,
  infrastructure_pool_id uuid,
  severity public.signal_status not null,
  category text not null,
  status public.alert_status not null default 'open',
  title text not null,
  detail text not null,
  probable_action text,
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.infrastructure_pools (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  account_or_team_ref text not null,
  display_name text not null,
  gate public.infrastructure_gate not null default 'unknown',
  allow_new_provisioning boolean not null default false,
  keep_healthy_deployments_running boolean not null default true check (keep_healthy_deployments_running = true),
  threshold_policy jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, account_or_team_ref)
);
alter table public.alerts add constraint alerts_infrastructure_pool_fk foreign key (infrastructure_pool_id) references public.infrastructure_pools(id) on delete set null;

create table public.infrastructure_snapshots (
  id bigint generated always as identity primary key,
  infrastructure_pool_id uuid not null references public.infrastructure_pools(id) on delete cascade,
  gate public.infrastructure_gate not null,
  projects_used bigint,
  applicable_project_limit bigint,
  deployments_healthy bigint,
  deployments_failed bigint,
  spend_amount numeric(14,2),
  spend_currency text,
  provider_usage jsonb not null default '{}'::jsonb,
  provider_limits jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);
comment on column public.infrastructure_snapshots.applicable_project_limit is 'Nullable: never fabricate a provider maximum when no authoritative limit is exposed.';

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id),
  actor_label text not null,
  tenant_id uuid references public.tenants(id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  previous_state_redacted jsonb,
  new_state_redacted jsonb,
  request_id uuid not null default gen_random_uuid(),
  ip_hash text,
  created_at timestamptz not null default now()
);
comment on table public.audit_logs is 'Audit logs are append-only. Client roles receive SELECT and INSERT policies only; no UPDATE or DELETE policy.';

create table public.commercial_settings (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  currency char(3) not null default 'MYR',
  annual_revenue_per_customer numeric(12,2) not null default 1500,
  effective_from date not null default current_date,
  active boolean not null default true,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create or replace function public.is_control_operator(required_roles public.operator_role[] default array['admin','operator','viewer','release_manager']::public.operator_role[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.operator_profiles p where p.user_id = auth.uid() and p.active and p.role = any(required_roles));
$$;
revoke all on function public.is_control_operator(public.operator_role[]) from public;
grant execute on function public.is_control_operator(public.operator_role[]) to authenticated;

create or replace function public.prevent_tenant_identity_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id <> old.id or new.slug <> old.slug or new.exact_subdomain <> old.exact_subdomain then
    raise exception 'Tenant identity, slug and exact subdomain are immutable; create a controlled migration instead';
  end if;
  return new;
end; $$;
create trigger tenants_identity_immutable before update on public.tenants for each row execute function public.prevent_tenant_identity_change();

create or replace function public.prevent_approved_release_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'approved' and (new.version, new.git_sha, new.artifact_sha256, new.artifact_uri) is distinct from (old.version, old.git_sha, old.artifact_sha256, old.artifact_uri) then
    raise exception 'Approved release identity and artifact are immutable; create a new release';
  end if;
  return new;
end; $$;
create trigger releases_approved_immutable before update on public.releases for each row execute function public.prevent_approved_release_mutation();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$ begin new.updated_at = now(); return new; end; $$;
create trigger operator_profiles_touch before update on public.operator_profiles for each row execute function public.touch_updated_at();
create trigger tenants_touch before update on public.tenants for each row execute function public.touch_updated_at();
create trigger customer_configurations_touch before update on public.customer_configurations for each row execute function public.touch_updated_at();
create trigger infrastructure_pools_touch before update on public.infrastructure_pools for each row execute function public.touch_updated_at();
create trigger commercial_settings_touch before update on public.commercial_settings for each row execute function public.touch_updated_at();

alter table public.operator_profiles enable row level security;
alter table public.tenants enable row level security;
alter table public.customer_configurations enable row level security;
alter table public.deployments enable row level security;
alter table public.releases enable row level security;
alter table public.health_records enable row level security;
alter table public.alerts enable row level security;
alter table public.infrastructure_pools enable row level security;
alter table public.infrastructure_snapshots enable row level security;
alter table public.audit_logs enable row level security;
alter table public.commercial_settings enable row level security;

create policy "Operators read profiles" on public.operator_profiles for select to authenticated using (public.is_control_operator());
create policy "Admins manage profiles" on public.operator_profiles for all to authenticated using (public.is_control_operator(array['admin']::public.operator_role[])) with check (public.is_control_operator(array['admin']::public.operator_role[]));
create policy "Operators read tenants" on public.tenants for select to authenticated using (public.is_control_operator());
create policy "Operators manage tenants" on public.tenants for all to authenticated using (public.is_control_operator(array['admin','operator']::public.operator_role[])) with check (public.is_control_operator(array['admin','operator']::public.operator_role[]));
create policy "Operators read customer configurations" on public.customer_configurations for select to authenticated using (public.is_control_operator());
create policy "Operators manage customer configurations" on public.customer_configurations for all to authenticated using (public.is_control_operator(array['admin','operator']::public.operator_role[])) with check (public.is_control_operator(array['admin','operator']::public.operator_role[]));
create policy "Operators read deployments" on public.deployments for select to authenticated using (public.is_control_operator());
create policy "Operators manage deployments" on public.deployments for all to authenticated using (public.is_control_operator(array['admin','operator','release_manager']::public.operator_role[])) with check (public.is_control_operator(array['admin','operator','release_manager']::public.operator_role[]));
create policy "Operators read releases" on public.releases for select to authenticated using (public.is_control_operator());
create policy "Release managers manage releases" on public.releases for all to authenticated using (public.is_control_operator(array['admin','release_manager']::public.operator_role[])) with check (public.is_control_operator(array['admin','release_manager']::public.operator_role[]));
create policy "Operators read health" on public.health_records for select to authenticated using (public.is_control_operator());
create policy "Operators insert health" on public.health_records for insert to authenticated with check (public.is_control_operator(array['admin','operator']::public.operator_role[]));
create policy "Operators read alerts" on public.alerts for select to authenticated using (public.is_control_operator());
create policy "Operators manage alerts" on public.alerts for all to authenticated using (public.is_control_operator(array['admin','operator']::public.operator_role[])) with check (public.is_control_operator(array['admin','operator']::public.operator_role[]));
create policy "Operators read infrastructure pools" on public.infrastructure_pools for select to authenticated using (public.is_control_operator());
create policy "Admins manage infrastructure pools" on public.infrastructure_pools for all to authenticated using (public.is_control_operator(array['admin']::public.operator_role[])) with check (public.is_control_operator(array['admin']::public.operator_role[]));
create policy "Operators read infrastructure snapshots" on public.infrastructure_snapshots for select to authenticated using (public.is_control_operator());
create policy "Operators insert infrastructure snapshots" on public.infrastructure_snapshots for insert to authenticated with check (public.is_control_operator(array['admin','operator']::public.operator_role[]));
create policy "Operators read audit logs" on public.audit_logs for select to authenticated using (public.is_control_operator());
create policy "Operators insert audit logs" on public.audit_logs for insert to authenticated with check (public.is_control_operator());
create policy "Operators read commercial settings" on public.commercial_settings for select to authenticated using (public.is_control_operator());
create policy "Admins manage commercial settings" on public.commercial_settings for all to authenticated using (public.is_control_operator(array['admin']::public.operator_role[])) with check (public.is_control_operator(array['admin']::public.operator_role[]));

create index health_records_tenant_checked_idx on public.health_records(tenant_id, checked_at desc);
create index alerts_status_created_idx on public.alerts(status, created_at desc);
create index audit_logs_tenant_created_idx on public.audit_logs(tenant_id, created_at desc);
create index deployments_tenant_created_idx on public.deployments(tenant_id, created_at desc);

-- No seed customer data. Production records must be imported only through a separately approved process.
