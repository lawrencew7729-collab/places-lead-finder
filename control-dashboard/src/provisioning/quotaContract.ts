/**
 * R1 readiness — ONE authoritative new-customer quota contract.
 *
 * REVISED owner safety contract (2026-08-26):
 *   Google monthly allowance 1000 ALL Places API (New) requests
 *   AMBER 900 (90%) · HARD SAFETY STOP 950 (95%) · reserved buffer 50
 *   · enforcement disable_new_search at 950.
 * The 950–1000 range is a permanent safety reserve, NOT customer-usable.
 *
 * Source of truth: Control Plane `customer_configurations` row (explicit
 * values, never schema defaults). Propagation: per-customer deployment ENV
 * (VITE_CUSTOMER_* build-time) — the customer runtime never depends on the
 * Control Dashboard being available.
 */
import { createQuotaPolicy, type Signal } from '../domain';

export const QUOTA_CONTRACT = Object.freeze({
  monthlyTarget: 1000,
  amberPercent: 90,
  redPercent: 95,
  enforcementMode: 'disable_new_search' as const,
  amberRequests: 900,
  redRequests: 950,
});

export interface RuntimeQuotaConfig {
  monthlyTarget: number;
  amberPercent: number;
  redPercent: number;
  enforcementMode: 'warn_only' | 'disable_new_search';
}

export interface QuotaVerificationResult {
  consistent: boolean;
  reasons: string[];
}

/**
 * Fail-closed verification: runtime and persisted configuration must BOTH
 * match the approved contract (or each other exactly for a non-default
 * customer policy). Any disagreement blocks provisioning.
 */
export function verifyQuotaConsistency(runtime: RuntimeQuotaConfig | null, persisted: RuntimeQuotaConfig | null): QuotaVerificationResult {
  const reasons: string[] = [];
  if (!runtime) reasons.push('runtime quota configuration missing');
  if (!persisted) reasons.push('persisted quota configuration missing');
  if (runtime && persisted) {
    if (runtime.monthlyTarget !== persisted.monthlyTarget) reasons.push('monthly target mismatch');
    if (runtime.amberPercent !== persisted.amberPercent) reasons.push('amber percent mismatch');
    if (runtime.redPercent !== persisted.redPercent) reasons.push('red percent mismatch');
    if (runtime.enforcementMode !== persisted.enforcementMode) reasons.push('enforcement mode mismatch');
  }
  return { consistent: reasons.length === 0, reasons };
}

/** Explicit provisioning write values — NEVER rely on schema defaults. */
export function explicitProvisioningQuota() {
  const policy = createQuotaPolicy({
    monthlyTarget: QUOTA_CONTRACT.monthlyTarget,
    amberPercent: QUOTA_CONTRACT.amberPercent,
    redPercent: QUOTA_CONTRACT.redPercent,
    enforcementMode: QUOTA_CONTRACT.enforcementMode,
  });
  return {
    monthlyTarget: policy.monthlyTarget,
    amberPercent: policy.amberPercent,
    redPercent: policy.redPercent,
    enforcementMode: policy.enforcementMode,
  };
}

/** Signal for display: red (safety stop) at 950, amber at 900. */
export function quotaSignal(used: number): Signal {
  if (!Number.isFinite(used) || used < 0) return 'unknown';
  if (used >= QUOTA_CONTRACT.redRequests) return 'red';
  if (used >= QUOTA_CONTRACT.amberRequests) return 'amber';
  return 'green';
}

/**
 * Runtime ENV pairs — ONE contract propagated to BOTH runtimes:
 *  - browser Vite runtime reads VITE_CUSTOMER_* (build-time)
 *  - serverless api/usage reads CUSTOMER_MONTHLY_TARGET
 * The same constants feed both; provisioning writes both sets and verifies
 * they agree (mismatch fails closed).
 */
export function runtimeEnvPairs() {
  return {
    browser: {
      VITE_CUSTOMER_MONTHLY_TARGET: String(QUOTA_CONTRACT.monthlyTarget),
      VITE_CUSTOMER_AMBER_PERCENT: String(QUOTA_CONTRACT.amberPercent),
      VITE_CUSTOMER_RED_PERCENT: String(QUOTA_CONTRACT.redPercent),
      VITE_CUSTOMER_ENFORCEMENT_MODE: QUOTA_CONTRACT.enforcementMode,
    },
    server: {
      CUSTOMER_MONTHLY_TARGET: String(QUOTA_CONTRACT.monthlyTarget),
    },
  };
}

/** Fail-closed: browser and server env values must agree with each other AND the contract. */
export function verifyRuntimeEnvConsistency(browserEnv: Record<string, string>, serverEnv: Record<string, string>): { consistent: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const pairs = runtimeEnvPairs();
  const check = (expected: string, actual: string | undefined, label: string) => {
    if (actual !== expected) reasons.push(`${label} mismatch (${actual ?? 'missing'} ≠ ${expected})`);
  };
  check(pairs.browser.VITE_CUSTOMER_MONTHLY_TARGET, browserEnv.VITE_CUSTOMER_MONTHLY_TARGET, 'browser monthly');
  check(pairs.browser.VITE_CUSTOMER_AMBER_PERCENT, browserEnv.VITE_CUSTOMER_AMBER_PERCENT, 'browser amber');
  check(pairs.browser.VITE_CUSTOMER_RED_PERCENT, browserEnv.VITE_CUSTOMER_RED_PERCENT, 'browser red');
  check(pairs.browser.VITE_CUSTOMER_ENFORCEMENT_MODE, browserEnv.VITE_CUSTOMER_ENFORCEMENT_MODE, 'browser enforcement');
  check(pairs.server.CUSTOMER_MONTHLY_TARGET, serverEnv.CUSTOMER_MONTHLY_TARGET, 'server monthly');
  if (browserEnv.VITE_CUSTOMER_MONTHLY_TARGET !== serverEnv.CUSTOMER_MONTHLY_TARGET) {
    reasons.push('browser/server monthly cap disagreement');
  }
  return { consistent: reasons.length === 0, reasons };
}
