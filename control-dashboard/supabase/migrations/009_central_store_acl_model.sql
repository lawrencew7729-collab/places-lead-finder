-- 009_central_store_acl_model.sql
-- R1 CENTRALIZED UPSTASH architecture (owner-approved 2026-08-26):
--   ONE central Redis database shared by ALL tenants. Isolation is enforced
--   by the immutable tenant UUID namespace (tenant:<TENANT_ID>:*) plus a
--   per-tenant restricted ACL credential — NOT by a dedicated store per
--   tenant.
-- Migration 007 added UNIQUE(device_store_fingerprint) for the superseded
-- dedicated-store semantics; the central model intentionally shares ONE
-- store fingerprint across tenants, so the uniqueness constraint is dropped.
-- device_store_fingerprint remains as central-store identity metadata
-- (non-unique). Existing rows are NOT rewritten. Migrations 005/006/007/008
-- are untouched (fixed checksums).
alter table public.customer_configurations
  drop constraint customer_configurations_store_fingerprint_unique;
