/**
 * R1 TWO-DEVICE CONTRACT — device access policy (dashboard side).
 *
 * Owner policy (hard requirement, approved): every NEW Lead Finder customer
 * deployment enforces MAX_DEVICES = 2 on an INDEPENDENT dedicated KV store.
 * The first two authorized devices claim the slots automatically; a third
 * unknown device is DENIED; existing authorized devices keep working; NO
 * automatic eviction; NO oldest-device replacement; owner-controlled release
 * only.
 *
 * Isolation (approved architecture):
 *  - Registry identity = IMMUTABLE tenant id (UUID v4) → `lf_dev:<tenantId>`.
 *    hostname is NEVER the authoritative identity for new customers.
 *  - Each customer gets ONE dedicated KV store (operator-provided for R1).
 *    Provisioning persists ONLY a non-secret store fingerprint
 *    (SHA-256 of the normalized KV store URL) and refuses to provision a
 *    second tenant on the same store (uniqueness guard, fail-closed).
 *
 * Auth (approved): CUSTOMER ACCESS CODE ONLY — a cryptographically random
 * 16-char code generated in the Create Customer workflow, handed to
 * provisioning as a transient secret, injected ONLY as the customer's
 * server-side APP_PASS env, then discarded. No username concept. No
 * DEVICE_ADMIN_SECRET in the Golden Standard contract (owner-controlled
 * release = direct maintenance of that customer's dedicated store).
 *
 * Secret boundary: privileged values (KV REST credentials, access code) are
 * consumed via the ephemeral provisioning handoff and remain server-side
 * ONLY — never in Control Plane DB, audit logs, Run Sheet, review packages,
 * browser-readable config, or Git.
 */
import { createHash } from 'node:crypto';

export const DEVICE_LOCK_CONTRACT = Object.freeze({
  maxDevices: 2,
  kvKeyNamespace: 'lf_dev',
  mode: 'hard_lock',
  autoEviction: false,
  /** Customer access code length (cryptographically random, generated per customer). */
  accessCodeLength: 16,
});

/**
 * Server-only env keys of the customer deployment relevant to device lock.
 * The store credentials may exist under EITHER naming scheme (api/device.js
 * reads KV_REST_API_* first, UPSTASH_REDIS_REST_* as fallback — same
 * precedence here). Provisioning writes the canonical KV_REST_API_* pair
 * ONLY when no store credentials exist yet, and ALWAYS writes APP_PASS +
 * CUSTOMER_TENANT_ID. No DEVICE_ADMIN_SECRET in the contract.
 */
export const DEVICE_LOCK_ENV_KEYS = Object.freeze([
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'APP_PASS',
  'CUSTOMER_TENANT_ID',
] as const);

/** Privileged device-lock secrets — transient provisioning input ONLY. */
export interface DeviceLockSecretsInput {
  kvRestApiUrl: string;   // dedicated store REST URL (per customer)
  kvRestApiToken: string; // dedicated store REST token (per customer)
  appPass: string;        // 16-char customer access code
}

/** Readiness probe returned by the deployed customer app (/api/device?mode=probe). */
export interface DeviceLockProbe {
  mode: 'locked' | 'open' | 'unconfigured';
  maxDevices: number;
  kvConfigured: boolean;
  appPassConfigured: boolean;
  tenantIdConfigured: boolean;
}

/** Non-secret device policy metadata persisted to the Control Plane. */
export interface DevicePolicy {
  maxDevices: number;
  mode: 'hard_lock';
  kvNamespace: string;
  appPassConfigured: boolean;
  tenantIdConfigured: boolean;
  autoEviction: boolean;
  /** FULL 64-hex SHA-256 of the normalized dedicated KV store URL — never the raw URL. */
  storeFingerprint: string;
}

export interface DeviceLockVerificationResult {
  consistent: boolean;
  reasons: string[];
}

/** Per-customer registry namespace — derived from the IMMUTABLE tenant id. */
export function deviceLockNamespaceFor(tenantId: string): string {
  return `${DEVICE_LOCK_CONTRACT.kvKeyNamespace}:${tenantId}`;
}

/** Non-secret device policy record for a deployment (persisted metadata only). */
export function devicePolicyFor(tenantId: string, storeFingerprint: string): DevicePolicy {
  return {
    maxDevices: DEVICE_LOCK_CONTRACT.maxDevices,
    mode: DEVICE_LOCK_CONTRACT.mode,
    kvNamespace: deviceLockNamespaceFor(tenantId),
    appPassConfigured: true,
    tenantIdConfigured: true,
    autoEviction: DEVICE_LOCK_CONTRACT.autoEviction,
    storeFingerprint,
  };
}

/**
 * Canonical KV store URL form for fingerprinting: lowercase, protocol-less,
 * no trailing slashes (https://ABC.example.com// → abc.example.com).
 * Host is the store identity; path/credentials are not part of the key.
 */
export function normalizeKvStoreUrl(rawUrl: string): string {
  return rawUrl.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** FULL 64-hex uppercase SHA-256 of the normalized dedicated store URL. */
export function kvStoreFingerprint(kvRestApiUrl: string): string {
  return createHash('sha256').update(normalizeKvStoreUrl(kvRestApiUrl)).digest('hex').toUpperCase();
}

/** Fail-closed: persisted policy must match the contract EXACTLY (max === 2). */
export function verifyDeviceLockPolicy(policy: DevicePolicy | null): DeviceLockVerificationResult {
  const reasons: string[] = [];
  if (!policy) {
    reasons.push('device policy missing');
  } else {
    if (policy.maxDevices !== DEVICE_LOCK_CONTRACT.maxDevices) {
      reasons.push(`maxDevices must be exactly ${DEVICE_LOCK_CONTRACT.maxDevices} (got ${policy.maxDevices})`);
    }
    if (policy.mode !== DEVICE_LOCK_CONTRACT.mode) reasons.push('device lock mode must be hard_lock');
    if (!policy.kvNamespace.startsWith(`${DEVICE_LOCK_CONTRACT.kvKeyNamespace}:`)) {
      reasons.push('tenant-scoped KV namespace required');
    }
    if (policy.autoEviction) reasons.push('automatic device eviction forbidden');
    if (!/^[A-F0-9]{64}$/.test(policy.storeFingerprint)) reasons.push('full 64-hex store fingerprint required');
  }
  return { consistent: reasons.length === 0, reasons };
}

/** Fail-closed readiness probe: locked + every component configured + max === 2. */
export function verifyDeviceLockProbe(probe: DeviceLockProbe | null): DeviceLockVerificationResult {
  const reasons: string[] = [];
  if (!probe) {
    reasons.push('device-lock probe missing');
  } else {
    if (probe.mode !== 'locked') reasons.push(`device lock not active (mode=${probe.mode ?? 'unknown'})`);
    if (probe.maxDevices !== DEVICE_LOCK_CONTRACT.maxDevices) {
      reasons.push(`maxDevices must be exactly ${DEVICE_LOCK_CONTRACT.maxDevices} (got ${probe.maxDevices})`);
    }
    if (!probe.kvConfigured) reasons.push('dedicated KV store not configured');
    if (!probe.appPassConfigured) reasons.push('customer access code (APP_PASS) not configured');
    if (!probe.tenantIdConfigured) reasons.push('CUSTOMER_TENANT_ID not configured');
  }
  return { consistent: reasons.length === 0, reasons };
}

/** Fail-closed: privileged handoff input must be complete and well-formed. */
export function verifyDeviceLockSecrets(secrets: DeviceLockSecretsInput | null | undefined): DeviceLockVerificationResult {
  const reasons: string[] = [];
  if (!secrets) {
    reasons.push('device-lock secrets missing');
  } else {
    if (!secrets.kvRestApiUrl || !secrets.kvRestApiUrl.startsWith('https://')) reasons.push('dedicated KV REST URL required (https)');
    if (!secrets.kvRestApiToken || secrets.kvRestApiToken.length < 8) reasons.push('KV REST token required');
    if (!secrets.appPass || secrets.appPass.length < DEVICE_LOCK_CONTRACT.accessCodeLength) {
      reasons.push(`customer access code required (≥ ${DEVICE_LOCK_CONTRACT.accessCodeLength} chars)`);
    }
  }
  return { consistent: reasons.length === 0, reasons };
}
