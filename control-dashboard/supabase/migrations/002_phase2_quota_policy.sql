-- Lead Finder Control Dashboard — Phase 2 quota-policy correction
-- Local/test preparation only until Gate S1 is explicitly approved.
-- The monthly target remains 1,000. AMBER and RED are owner-configured per tenant.
begin;

alter table public.customer_configurations
  alter column amber_threshold_percent drop default,
  alter column red_threshold_percent drop default;

comment on column public.customer_configurations.amber_threshold_percent is
  'Required owner-configured threshold. No system AMBER default is approved.';
comment on column public.customer_configurations.red_threshold_percent is
  'Required owner-configured threshold. No system RED default is approved.';

commit;
