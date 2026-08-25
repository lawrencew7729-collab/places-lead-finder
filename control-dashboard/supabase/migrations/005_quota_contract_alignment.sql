-- 005_quota_contract_alignment.sql
-- R1 readiness: align NEW customer_configurations defaults with the
-- owner-approved quota contract:
--   monthly_usage_target  = 1000
--   amber_threshold_percent = 90  (900 requests)
--   red_threshold_percent   = 100 (1000 requests)
--   quota_enforcement_mode  = 'disable_new_search'
-- Historical migrations 001..004 are NOT rewritten. Existing rows are NOT
-- mutated (T1 sandbox already stores the approved 90/100 explicitly).
-- Future provisioning inserts must still write all four values explicitly;
-- this migration only removes the latent 80/95 trap for new records.
alter table public.customer_configurations
  alter column amber_threshold_percent set default 90,
  alter column red_threshold_percent set default 100,
  alter column quota_enforcement_mode set default 'disable_new_search';
