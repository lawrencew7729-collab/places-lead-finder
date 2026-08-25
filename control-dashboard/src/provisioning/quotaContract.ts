/**
 * R1 readiness — ONE authoritative new-customer quota contract.
 *
 * Approved contract (owner): monthly 1000 · Amber 900 (90%) · Red 1000 (100%)
 * · enforcement disable_new_search.
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
  redPercent: 100,
  enforcementMode: 'disable_new_search' as const,
  amberRequests: 900,
  redRequests: 1000,
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

/** Signal for display: red at 1000, amber at 900. */
export function quotaSignal(used: number): Signal {
  if (!Number.isFinite(used) || used < 0) return 'unknown';
  if (used >= QUOTA_CONTRACT.redRequests) return 'red';
  if (used >= QUOTA_CONTRACT.amberRequests) return 'amber';
  return 'green';
}
