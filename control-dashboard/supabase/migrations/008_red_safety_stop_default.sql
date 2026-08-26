-- 008_red_safety_stop_default.sql
-- R1 REVISED QUOTA SAFETY CONTRACT (owner-approved 2026-08-26):
--   Google monthly allowance = 1000 ALL Places API (New) requests
--   AMBER = 900 (90%) · HARD SAFETY STOP = 950 (95%) · reserved buffer = 50
--   enforcement = disable_new_search at 950.
-- Migration 005 set red_threshold_percent default to 100; the authoritative
-- contract now requires the database DEFAULT to match the safety stop (95).
-- ONLY the default changes. Existing rows are NOT rewritten here — the T1
-- sandbox row (currently 100) is a separate, targeted, audited Phase E data
-- update. Migrations 005/006/007 are untouched (fixed checksums).
alter table public.customer_configurations
  alter column red_threshold_percent set default 95;
