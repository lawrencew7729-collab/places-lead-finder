-- 006_full_fingerprint_contract.sql
-- R1 final closure: places_key_fingerprint must hold the FULL 64-hex SHA-256
-- fingerprint (uppercase canonical). varchar(16) truncation is not accepted
-- for authoritative persistence.
-- Historical migrations 001..005 are NOT rewritten. No live data mutated in
-- this LOCAL task.
--
-- Legacy/T1 handling: any pre-existing shorter fingerprint value cannot be
-- authoritatively reconstructed without re-presenting the original key.
-- Backfill requirement (documented, NOT executed): before R1, each existing
-- record's fingerprint must be re-derived by re-presenting the original key
-- in a controlled server-side operation, or marked legacy_placeholder and
-- re-verified at the customer's next controlled access.
alter table public.customer_configurations
  alter column places_key_fingerprint type varchar(64)
  using (places_key_fingerprint);
