import { exactRestrictionFor, validateServerFingerprintMetadata, validateTenantId, type MonitoringMode, type ServerFingerprintMetadata, type VerificationStatus } from './domain';

export type RuntimeArchitecture = 'browser_direct' | 'server_proxied';
export type EvidenceSource = 'mock' | 'provider';
export type Freshness = 'fresh' | 'stale' | 'unknown';
export type ProviderStatus = VerificationStatus | 'unknown';
export type MockFailureMode = 'failure' | 'timeout' | 'permission_denied' | 'unavailable';
export interface TenantProviderContext { tenantId: string; exactDomain: string }
export interface PlacesVerificationInput extends TenantProviderContext { googleProjectId: string }
export interface ProviderEvidenceMeta { authoritative: boolean; diagnosticReason: string; failureCode?: MockFailureMode }
export interface PlacesVerificationResult extends ProviderEvidenceMeta { tenantId: string; status: ProviderStatus; source: EvidenceSource; runtimeArchitecture: RuntimeArchitecture; websiteRestriction: string; googleProjectId: string; keyFingerprint: ServerFingerprintMetadata; checkedAt: string }
export interface MonitoringSnapshot extends ProviderEvidenceMeta { tenantId: string; status: ProviderStatus; source: EvidenceSource; mode: MonitoringMode; usedRequests: number | null; measurementTimestamp: string; collectionTimestamp: string; freshness: Freshness }
export interface VercelCapacitySnapshot extends ProviderEvidenceMeta { tenantId: string; status: ProviderStatus; source: EvidenceSource; projectsUsed: number | null; applicableProjectLimit: number | null; deploymentsHealthy: number | null; deploymentsFailed: number | null; spendAmount: number | null; spendCurrency: string | null; providerReportedLimits: Record<string, unknown>; collectionTimestamp: string }
export interface DeploymentHealthResult extends ProviderEvidenceMeta { tenantId: string; status: ProviderStatus; source: EvidenceSource; exactDomain: string; checkedAt: string }
export interface ProviderGateway {
  verifyPlacesConfiguration(input: PlacesVerificationInput): Promise<PlacesVerificationResult>;
  readMonitoring(context: TenantProviderContext): Promise<MonitoringSnapshot>;
  readVercelCapacity(context: TenantProviderContext): Promise<VercelCapacitySnapshot>;
  verifyDeploymentHealth(context: TenantProviderContext): Promise<DeploymentHealthResult>;
}
export interface MockProviderOptions { monitoringUnavailable?: boolean; failingTenantId?: string; failureMode?: MockFailureMode }

function requireTenantContext(context: TenantProviderContext) {
  if (!validateTenantId(context.tenantId)) throw new Error('UUID Tenant ID is required');
  exactRestrictionFor(context.exactDomain);
}
function evidenceClock() {
  const collection = new Date();
  const measurement = new Date(collection.getTime() - 5 * 60 * 1000);
  return { collectionTimestamp: collection.toISOString(), measurementTimestamp: measurement.toISOString() };
}
function failed(options: MockProviderOptions, tenantId: string) { return options.failingTenantId === tenantId; }
function normalizedMockEvidence(options: MockProviderOptions, tenantId: string): ProviderEvidenceMeta & { status: 'unknown'; source: 'mock' } {
  const failureCode = failed(options, tenantId) ? (options.failureMode ?? 'failure') : undefined;
  return {
    status: 'unknown', source: 'mock', authoritative: false,
    diagnosticReason: failureCode ? `PROVIDER_${failureCode.toUpperCase()}` : 'MOCK_NON_AUTHORITATIVE',
    ...(failureCode ? { failureCode } : {}),
  };
}
function mockFingerprint(tenantId: string): ServerFingerprintMetadata {
  const value = tenantId.replaceAll('-', '').toUpperCase().repeat(2);
  return validateServerFingerprintMetadata({ algorithm: 'sha256', value, computedBy: 'mock_provider_adapter', computedAt: new Date().toISOString() });
}

export function createMockProviderGateway(options: MockProviderOptions = {}): ProviderGateway {
  return {
    async verifyPlacesConfiguration(input) {
      requireTenantContext(input);
      if (!input.googleProjectId.trim()) throw new Error('Google project ID is required');
      const keyFingerprint = mockFingerprint(input.tenantId);
      return { tenantId: input.tenantId, ...normalizedMockEvidence(options, input.tenantId), runtimeArchitecture: 'browser_direct', websiteRestriction: exactRestrictionFor(input.exactDomain), googleProjectId: input.googleProjectId, keyFingerprint, checkedAt: new Date().toISOString() };
    },
    async readMonitoring(context) {
      requireTenantContext(context); const clock = evidenceClock();
      const evidence = options.monitoringUnavailable && !failed(options, context.tenantId)
        ? { status: 'unknown' as const, source: 'mock' as const, authoritative: false, diagnosticReason: 'PROVIDER_UNAVAILABLE', failureCode: 'unavailable' as const }
        : normalizedMockEvidence(options, context.tenantId);
      return { tenantId: context.tenantId, ...evidence, mode: 'shared_access', usedRequests: null, ...clock, freshness: 'unknown' };
    },
    async readVercelCapacity(context) {
      requireTenantContext(context);
      return { tenantId: context.tenantId, ...normalizedMockEvidence(options, context.tenantId), projectsUsed: null, applicableProjectLimit: null, deploymentsHealthy: null, deploymentsFailed: null, spendAmount: null, spendCurrency: null, providerReportedLimits: {}, collectionTimestamp: new Date().toISOString() };
    },
    async verifyDeploymentHealth(context) {
      requireTenantContext(context);
      return { tenantId: context.tenantId, ...normalizedMockEvidence(options, context.tenantId), exactDomain: context.exactDomain, checkedAt: new Date().toISOString() };
    },
  };
}
