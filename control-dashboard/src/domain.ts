export type Signal = 'green' | 'amber' | 'red' | 'unknown';
export type TenantStatus = 'draft' | 'setup_pending' | 'verification_pending' | 'active' | 'suspended' | 'archived';
export type MonitoringMode = 'shared_access' | 'dedicated_credential' | 'not_configured';
export type VerificationStatus = 'not_checked' | 'pending' | 'pass' | 'warning' | 'fail';

export interface QuotaPolicy {
  monthlyTarget: number;
  amberPercent: number;
  redPercent: number;
  telemetryIsDelayed: true;
  enforcementMode: 'warn_only' | 'disable_new_search';
}
export interface QuotaPolicyInput {
  monthlyTarget?: number;
  amberPercent: number;
  redPercent: number;
  enforcementMode: QuotaPolicy['enforcementMode'];
}
export interface CommercialModel { annualRevenueMyr: number; monthlyEquivalentMyr: number; currency: 'MYR' }
export interface ServerFingerprintMetadata {
  algorithm: 'sha256';
  value: string;
  computedBy: 'mock_provider_adapter' | 'server_provider_adapter';
  computedAt: string;
}
export interface Tenant {
  id: string; companyName: string; slug: string; exactSubdomain: string; status: TenantStatus;
  monitoringMode: MonitoringMode; monitoringStatus: VerificationStatus; placesKeyFingerprint: string | null;
  googleProjectId: string | null; websiteRestrictionStatus: VerificationStatus; billingStatus: VerificationStatus;
  placesApiStatus: VerificationStatus; customerLiveStatus: VerificationStatus; monthlyTarget: number;
  annualRevenueMyr: number; releaseVersion: string | null; vercelProjectId: string | null;
  lastHealthStatus: Signal; createdAt: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOMER_HOST = /^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.leadfinder\.business$/;

export function createQuotaPolicy(input: QuotaPolicyInput): QuotaPolicy {
  const monthlyTarget = input.monthlyTarget ?? 1000;
  const validPercentage = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
  if (!Number.isFinite(monthlyTarget) || monthlyTarget <= 0) throw new Error('Monthly target must be greater than zero');
  if (!validPercentage(input.amberPercent) || !validPercentage(input.redPercent)) throw new Error('Quota thresholds must be between 0 and 100');
  if (input.amberPercent > input.redPercent) throw new Error('AMBER threshold must not exceed RED threshold');
  return Object.freeze({ monthlyTarget, amberPercent: input.amberPercent, redPercent: input.redPercent, telemetryIsDelayed: true, enforcementMode: input.enforcementMode });
}

export const DEFAULT_COMMERCIAL_MODEL: CommercialModel = Object.freeze({ annualRevenueMyr: 1500, monthlyEquivalentMyr: 125, currency: 'MYR' });

export function normalizeCustomerHostname(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!CUSTOMER_HOST.test(normalized)) throw new Error('Approved exact customer hostname required');
  return normalized;
}

export function exactRestrictionFor(host: string): string {
  return `https://${normalizeCustomerHostname(host)}/*`;
}

export function validateTenantId(value: string): boolean { return UUID_V4.test(value); }
export const isTenantId = validateTenantId;

export function generateTenantId(randomSource: () => Uint8Array | string = () => crypto.randomUUID()): string {
  const generated = randomSource();
  if (typeof generated === 'string') {
    if (!validateTenantId(generated)) throw new Error('RFC 4122 UUID v4 Tenant ID required');
    return generated.toLowerCase();
  }
  if (generated.length !== 16) throw new Error('UUID source must provide 16 bytes');
  const bytes = Uint8Array.from(generated);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateServerFingerprintMetadata(metadata: ServerFingerprintMetadata): ServerFingerprintMetadata {
  if (!['mock_provider_adapter', 'server_provider_adapter'].includes(metadata.computedBy)) throw new Error('Fingerprint provenance must be a provider/server adapter');
  if (metadata.algorithm !== 'sha256' || !/^[A-F0-9]{64}$/.test(metadata.value)) throw new Error('Full SHA-256 fingerprint metadata required');
  if (!metadata.computedAt || Number.isNaN(Date.parse(metadata.computedAt))) throw new Error('Valid fingerprint evidence timestamp required');
  return Object.freeze({ ...metadata, computedAt: new Date(metadata.computedAt).toISOString() });
}

export function createKeyFingerprintMetadata(input: { value: string; computedBy: ServerFingerprintMetadata['computedBy']; computedAt: string }): ServerFingerprintMetadata {
  return validateServerFingerprintMetadata({ ...input, algorithm: 'sha256' });
}

export function quotaStatus(used: number, policy: QuotaPolicy): Signal {
  if (!Number.isFinite(used) || used < 0 || policy.monthlyTarget <= 0) return 'unknown';
  const percentage = (used / policy.monthlyTarget) * 100;
  if (percentage >= policy.redPercent) return 'red';
  if (percentage >= policy.amberPercent) return 'amber';
  return 'green';
}

export function selectInfrastructureStatus(signals: Signal[]): Signal {
  if (signals.includes('red')) return 'red';
  if (signals.includes('unknown') || signals.length === 0) return 'unknown';
  if (signals.includes('amber')) return 'amber';
  return 'green';
}

export function releaseIsImmutable(currentVersion: string, currentChecksum: string, proposedVersion: string, proposedChecksum: string): boolean {
  return currentVersion !== proposedVersion || currentChecksum === proposedChecksum;
}
