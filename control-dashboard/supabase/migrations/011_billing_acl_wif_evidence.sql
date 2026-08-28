-- 011_billing_acl_wif_evidence.sql
-- PRE-R1 PROVISIONING AUTOMATION REMEDIATION (2026-08-27, LOCAL batch):
--   Non-secret activation EVIDENCE columns on customer_configurations:
--     billing_account_id            — customer Cloud Billing account id (6-6-6 alnum),
--                                     contract item 10 (previously a GAP: never captured)
--     billing_activation_month      — Pacific (America/Los_Angeles) activation month
--                                     (YYYY-MM) used for the pre-activation usage check
--     billing_pre_activation_usage  — observed Places request_count at activation
--                                     (>= 0; conservative proxy, NOT SKU-exact —
--                                     Monitoring has no SKU dimension)
--     acl_username                  — per-tenant Upstash ACL username (deterministic
--                                     from the immutable tenant UUID)
--     acl_token_fingerprint         — FULL 64-hex SHA-256 of the tenant REST token
--                                     (the raw token/password NEVER touch the DB)
--     monitoring_sa_email           — A3b (owner correction 2026-08-27): the customer's
--                                     OWN dedicated monitoring service account email;
--                                     ownership/scope MUST be the customer's own Google
--                                     project (enforced by provisioning readback).
--   Secret boundary: NO raw credential values anywhere in this migration.
--   No live rows rewritten. Historical migrations 001..010 untouched (fixed checksums).
alter table public.customer_configurations
  add column billing_account_id text,
  add column billing_activation_month text,
  add column billing_pre_activation_usage integer not null default 0,
  add column acl_username text,
  add column acl_token_fingerprint text,
  add column monitoring_sa_email text;

-- Billing account id format: 3 groups of 6 uppercase-alnum chars (e.g. 01B61E-759031-B494E4).
-- Explicitly NAMED constraints — never rely on auto-generated inline-check names
-- (a later migration adding the same name would collide).
alter table public.customer_configurations
  add constraint customer_configurations_billing_account_id_format_check
    check (billing_account_id is null or billing_account_id ~ '^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$');

alter table public.customer_configurations
  add constraint customer_configurations_billing_month_format_check
    check (billing_activation_month is null or billing_activation_month ~ '^\d{4}-(0[1-9]|1[0-2])$');

alter table public.customer_configurations
  add constraint customer_configurations_billing_pre_activation_usage_nonneg_check
    check (billing_pre_activation_usage >= 0);

-- ACL identity metadata: full 64-hex uppercase fingerprint or NULL (legacy rows).
alter table public.customer_configurations
  add constraint customer_configurations_acl_token_fingerprint_format_check
    check (acl_token_fingerprint is null or acl_token_fingerprint ~ '^[A-F0-9]{64}$');
