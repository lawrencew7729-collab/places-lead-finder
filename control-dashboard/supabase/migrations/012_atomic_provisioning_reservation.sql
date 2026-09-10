-- 012_atomic_provisioning_reservation.sql
-- S2e FINAL ATOMIC DUPLICATE-START PROTECTION — REVISED (2026-09-05, LOCAL
-- candidate — NOT applied live).
--
--   The reservation token is a SERVER-GENERATED non-secret identity created
--   BEFORE Vercel Workflow start(). The atomic RPC guarantees that under two
--   concurrent identical START requests exactly ONE request wins the right to
--   call start() — no application-level "SELECT then UPDATE" race.
--
--   State machine per tenant:
--     token = NULL                      → no reservation (may acquire)
--     token set + run_id = NULL         → reserved / start pending
--     token set + run_id set            → linked / running (or terminal)
--     token = NULL + run_id retained    → retryable only AFTER an
--                                         authoritatively terminal run
--
--   REVISION NOTES vs the first local candidate (owner review 2026-09-05):
--   (a) All three RPCs return explicit BOOLEAN success (no ambiguous
--       "NULL means success" TEXT contract — PostgREST-safe).
--   (b) reserve_provisioning_start atomically CLEARS provisioning_run_id in
--       the SAME UPDATE that acquires the token: a fresh reservation can
--       never be mistaken for a stale/terminal run by a concurrent request
--       (closes the retry race that could otherwise produce Workflow B + C).
--   (c) Column-level REVOKE so authenticated browser sessions cannot
--       directly mutate the reservation columns (existing "Operators manage
--       tenants" FOR ALL policy would otherwise cover the new columns too).

begin;

-- 1. tenants: reservation columns (non-secret identifiers only — never raw keys).
alter table public.tenants
  add column provisioning_reservation_token text,
  add column provisioning_run_id text;

-- 2. Atomic reservation acquire (SECURITY DEFINER — server-side infra only).
--    Fixed search_path; PUBLIC/anon/authenticated get NO execute.
--    Returns TRUE only when exactly one row was acquired. Acquiring a NEW
--    token atomically clears any prior run_id (historical run ids survive
--    only while the token is NULL after an explicit release).
create or replace function public.reserve_provisioning_start(
  p_tenant_id uuid,
  p_reservation_token text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tenants
     set provisioning_reservation_token = p_reservation_token,
         provisioning_run_id = null,
         updated_at = now()
   where id = p_tenant_id
     and provisioning_reservation_token is null
     and status <> 'active';
  return found;
end;
$$;

-- 3. Link the real Workflow runId to the reservation (idempotent — CAS on the
--    exact reservation token; workflow self-link uses the same function).
--    Returns TRUE only when the exact token matched and the run was linked.
create or replace function public.link_provisioning_run(
  p_tenant_id uuid,
  p_reservation_token text,
  p_run_id text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tenants
     set provisioning_run_id = p_run_id,
         updated_at = now()
   where id = p_tenant_id
     and provisioning_reservation_token = p_reservation_token;
  return found;
end;
$$;

-- 4. Release a reservation (CAS on the exact token — retry after an
--    authoritatively terminal run; token mismatch touches nothing).
--    Returns TRUE only when the exact token matched and was released.
--    The old run_id is deliberately RETAINED here (historical evidence while
--    the token is NULL) — the next successful reserve clears it atomically.
create or replace function public.release_provisioning_reservation(
  p_tenant_id uuid,
  p_reservation_token text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tenants
     set provisioning_reservation_token = null,
         updated_at = now()
   where id = p_tenant_id
     and provisioning_reservation_token = p_reservation_token;
  return found;
end;
$$;

-- 5. Security: server-side provisioning infrastructure ONLY.
--    The Control Plane service-role path executes the RPCs; the browser-facing
--    roles (anon/authenticated) are revoked so customers/staff UI sessions can
--    never claim or replace workflow reservations.
revoke all on function public.reserve_provisioning_start(uuid, text) from public, anon, authenticated;
revoke all on function public.link_provisioning_run(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_provisioning_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_provisioning_start(uuid, text) to service_role;
grant execute on function public.link_provisioning_run(uuid, text, text) to service_role;
grant execute on function public.release_provisioning_reservation(uuid, text) to service_role;

-- 6. Reservation-column hardening: the existing "Operators manage tenants"
--    FOR ALL policy (migration 001) lets authenticated admin/operator
--    sessions manage tenants rows — that must NOT extend to claiming or
--    forging Workflow reservation state, on EITHER direct UPDATE or direct
--    INSERT of the reservation columns.
--    The guard trigger below is the AUTHORITATIVE direct-write enforcement:
--      - BEFORE UPDATE OF the two columns: non-owner direct UPDATE rejected
--      - BEFORE INSERT (fired when either column is supplied non-NULL):
--        non-owner direct INSERT rejected; ordinary INSERTs that omit the
--        columns (both NULL) keep working — the normal tenant-creation path
--        is untouched.
--    The column-level REVOKEs below are defense-in-depth / future hardening
--    ONLY. PostgreSQL privileges are ADDITIVE: a table-level UPDATE grant is
--    not cancelled by a column REVOKE, so the REVOKEs must not be described
--    as an independent deny layer — the trigger is what enforces.
revoke update (provisioning_reservation_token) on public.tenants from authenticated;
revoke update (provisioning_run_id) on public.tenants from authenticated;

create or replace function public.guard_reservation_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  table_owner name;
begin
  -- SECURITY INVOKER (no SECURITY DEFINER): current_user is the statement
  -- executor. Inside the reserve/link/release RPCs (SECURITY DEFINER = table
  -- owner) current_user is the table owner → allowed. Any DIRECT write
  -- (authenticated browser session, or service_role connecting directly)
  -- executes as that role → refused.
  select tableowner into table_owner
    from pg_tables where schemaname = 'public' and tablename = 'tenants';
  if current_user = table_owner then
    return new; -- SECURITY DEFINER RPC path (runs as table owner)
  end if;

  if tg_op = 'INSERT' then
    -- Direct INSERT that tries to forge reservation state is rejected;
    -- ordinary inserts (both columns NULL/omitted) pass through.
    if new.provisioning_reservation_token is not null or new.provisioning_run_id is not null then
      raise exception 'direct insert with provisioning reservation columns is not allowed (use reserve/link/release RPCs)';
    end if;
    return new;
  end if;

  -- UPDATE: refuse only when a reservation column actually changed value
  -- (the trigger fires for every UPDATE; column-set conditions are not used
  -- for portability). Ordinary updates of other columns pass through.
  if new.provisioning_reservation_token is distinct from old.provisioning_reservation_token
     or new.provisioning_run_id is distinct from old.provisioning_run_id then
    raise exception 'direct mutation of provisioning reservation columns is not allowed (use reserve/link/release RPCs)';
  end if;
  return new;
end;
$$;

drop trigger if exists tenants_reservation_columns_guard on public.tenants;
create trigger tenants_reservation_columns_guard
  before update on public.tenants
  for each row execute function public.guard_reservation_columns();

drop trigger if exists tenants_reservation_insert_guard on public.tenants;
create trigger tenants_reservation_insert_guard
  before insert on public.tenants
  for each row execute function public.guard_reservation_columns();

revoke all on function public.guard_reservation_columns() from public, anon, authenticated, service_role;

commit;
