-- 007_device_lock_contract.sql
-- R1 TWO-DEVICE CONTRACT: customer-specific device access policy metadata on
-- the Control Plane customer_configurations row.
--
-- Reuse, not duplicate: customer_configurations.device_limit (created in
-- migration 001, default 2, check > 0) IS the two-device limit. 007 tightens
-- its check to the EXACT contract (device_limit = 2) instead of adding a
-- parallel column/constraint.
--
-- Owner policy (approved): MAX_DEVICES = 2 per customer; the IMMUTABLE tenant
-- id (tenants.id / customer_configurations.tenant_id — the authoritative
-- Control Plane identity, created once at the customer identity boundary) is
-- the device registry identity (lf_dev:<tenant_id>). Slug/subdomain are
-- ATTRIBUTES of the tenant and never the identity. Each customer uses ONE
-- dedicated KV store; no automatic eviction; no TTL; owner-controlled
-- release only. DEVICE_ADMIN_SECRET is NOT part of the R1 Golden Standard
-- contract (release = direct maintenance of that customer's dedicated store).
--
-- Secret boundary: this migration stores NON-SECRET policy metadata ONLY
-- (booleans, limits, namespace, and the full 64-hex SHA-256 fingerprint of
-- the normalized dedicated store URL). Raw KV URL/token, the customer access
-- code and any admin secret NEVER touch the Control Plane DB.
--
-- The UNIQUE constraint on device_store_fingerprint is the DB-level
-- dedicated-store guard: no second tenant may own the same store.
--
-- Historical migrations 001..006 are NOT rewritten. No live data mutated in
-- this LOCAL task (same standing as 005/006 — applied at R1 sandbox time).
alter table public.customer_configurations
  add column device_lock_mode text not null default 'hard_lock',
  add column device_kv_namespace text,
  add column device_store_fingerprint text,
  add column device_app_pass_configured boolean not null default false;

-- Tighten the migration-001 device_limit check from "> 0" to the EXACT
-- two-device contract. The auto-generated name from 001 is reused.
alter table public.customer_configurations
  drop constraint customer_configurations_device_limit_check;
alter table public.customer_configurations
  add constraint customer_configurations_device_limit_check
    check (device_limit = 2);

-- Dedicated-store exclusivity: one store fingerprint → one tenant.
-- (NULLs allowed — legacy/pre-device-lock rows are unaffected.)
alter table public.customer_configurations
  add constraint customer_configurations_store_fingerprint_unique
    unique (device_store_fingerprint);
