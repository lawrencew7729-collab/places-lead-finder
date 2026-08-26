/**
 * Customer-app runtime quota configuration (non-secret, build-time injected).
 *
 * ONE authoritative new-customer quota contract (REVISED owner safety
 * contract, 2026-08-26):
 *   Google monthly allowance 1000 ALL Places API (New) requests
 *   AMBER 900 (90%) · HARD SAFETY STOP 950 (95%) · reserved buffer 50
 *   · enforcement disable_new_search at 950
 * The 950–1000 range is a permanent safety reserve, NOT customer-usable.
 * The counter is ALL Places API (New) requests (operational safety basis) —
 * NEVER claimed as Enterprise SKU usage.
 *
 * Propagation model (documented source of truth):
 *   Control Plane customer_configurations (per-customer row) is the source of
 *   truth. At R1 provisioning time the values are propagated to each isolated
 *   customer deployment as build-time VITE_ env (Vercel project ENV), so the
 *   runtime NEVER depends on the Control Dashboard being available.
 *
 * Raw privileged secrets are NEVER part of this config — only non-secret
 * quota/metadata values.
 */

export const DEFAULT_QUOTA = Object.freeze({
  monthlyTarget: 1000,
  amberPercent: 90,
  redPercent: 95,
  enforcementMode: 'disable_new_search',
});

/** Reads VITE_CUSTOMER_* env with validated fallback to the approved contract. */
export function customerQuota() {
  const monthly = readPositiveInt(import.meta.env?.VITE_CUSTOMER_MONTHLY_TARGET, DEFAULT_QUOTA.monthlyTarget);
  const amber = readPercent(import.meta.env?.VITE_CUSTOMER_AMBER_PERCENT, DEFAULT_QUOTA.amberPercent);
  const red = readPercent(import.meta.env?.VITE_CUSTOMER_RED_PERCENT, DEFAULT_QUOTA.redPercent);
  const enforcement = import.meta.env?.VITE_CUSTOMER_ENFORCEMENT_MODE === 'warn_only' ? 'warn_only' : 'disable_new_search';
  // fail-closed: invalid config must never silently lower the contract
  const amberRequests = Math.round((monthly * amber) / 100);
  const redRequests = Math.round((monthly * red) / 100);
  return Object.freeze({
    monthlyTarget: monthly,
    amberPercent: amber,
    redPercent: red,
    enforcementMode: enforcement,
    amberRequests,
    redRequests,
  });
}

function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readPercent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

/** Pure helper for tests: derive request thresholds from monthly+percent. */
export function quotaThresholds(monthlyTarget, amberPercent, redPercent) {
  return {
    amberRequests: Math.round((monthlyTarget * amberPercent) / 100),
    redRequests: Math.round((monthlyTarget * redPercent) / 100),
  };
}
