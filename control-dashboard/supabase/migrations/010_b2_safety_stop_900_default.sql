-- 010_b2_safety_stop_900_default.sql
-- B2 OWNER DECISION (2026-08-27) — PRE-R1 BILLING SAFETY HARDENING:
--   Google monthly allowance = 1000 ALL Places API (New) requests
--   AMBER = 850 (85%) · HARD SAFETY STOP = 900 (90%) · reserved buffer = 100
--   enforcement = disable_new_search at 900.
-- Rationale (owner): the field mask triggers Text Search (New) ENTERPRISE
-- (free cap 1,000/month/billing account); the old 950 stop left a margin of
-- exactly 1 (949+50 claims -> 999). 900 restores a 51-request operational
-- margin (899 + 50 = 949 < 1000).
-- Migration 008 set red_threshold_percent default to 95; the authoritative
-- contract now requires the database DEFAULT to match the new safety stop
-- (90) and amber to stay strictly below red (85).
-- ONLY the defaults change. Existing rows are NOT rewritten here — the T1
-- sandbox row (currently 95) is a separate, targeted, audited data update
-- (B2 t1_data_update, same pattern as E1). Migrations 005/006/007/008/009
-- are untouched (fixed checksums).
alter table public.customer_configurations
  alter column amber_threshold_percent set default 85,
  alter column red_threshold_percent set default 90;
