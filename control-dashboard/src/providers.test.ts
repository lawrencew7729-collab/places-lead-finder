import { describe, expect, it } from 'vitest';
import { createMockProviderGateway, type MockFailureMode, type ProviderGateway } from './providers';


const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const context = { tenantId: tenantA, exactDomain: 'test.leadfinder.business' };


describe('Phase 2 tenant-scoped provider contracts', () => {
  it('models browser-direct architecture using server fingerprint metadata only', async () => {
    const result = await createMockProviderGateway().verifyPlacesConfiguration({ ...context, googleProjectId: 'sandbox-google-project' });
    expect(result.runtimeArchitecture).toBe('browser_direct');
    expect(result.websiteRestriction).toBe('https://test.leadfinder.business/*');
    expect(result.status).toBe('unknown');
    expect(result.authoritative).toBe(false);
    expect(result.diagnosticReason).toBe('MOCK_NON_AUTHORITATIVE');
    expect(result.keyFingerprint.value).toHaveLength(64);
    expect(result.keyFingerprint.computedBy).toBe('mock_provider_adapter');
    expect(JSON.stringify(result)).not.toContain('AIza');
  });

  it('uses Shared Monitoring Access by default and returns evidence timestamps', async () => {
    const result = await createMockProviderGateway().readMonitoring(context);
    expect(result.mode).toBe('shared_access');
    expect(result.source).toBe('mock');
    expect(result.measurementTimestamp).toMatch(/Z$/);
    expect(result.collectionTimestamp).toMatch(/Z$/);
    expect(result.freshness).toBe('unknown');
    expect(result.status).toBe('unknown');
    expect(result.authoritative).toBe(false);
  });

  const methods: Array<{ name: string; invoke: (gateway: ProviderGateway) => Promise<{ status: string; authoritative: boolean; diagnosticReason: string; failureCode?: MockFailureMode }> }> = [
    { name: 'verifyPlacesConfiguration', invoke: (gateway) => gateway.verifyPlacesConfiguration({ ...context, googleProjectId: 'sandbox-google-project' }) },
    { name: 'readMonitoring', invoke: (gateway) => gateway.readMonitoring(context) },
    { name: 'readVercelCapacity', invoke: (gateway) => gateway.readVercelCapacity(context) },
    { name: 'verifyDeploymentHealth', invoke: (gateway) => gateway.verifyDeploymentHealth(context) },
  ];
  for (const method of methods) {
    it.each(['timeout', 'permission_denied', 'unavailable', 'failure'] as const)(`${method.name} normalizes %s to redacted UNKNOWN`, async (failureMode) => {
      const result = await method.invoke(createMockProviderGateway({ failingTenantId: tenantA, failureMode }));
      expect(result.status).toBe('unknown');
      expect(result.authoritative).toBe(false);
      expect(result.failureCode).toBe(failureMode);
      expect(result.diagnosticReason).toBe(`PROVIDER_${failureMode.toUpperCase()}`);
      expect(result.diagnosticReason).not.toMatch(/token|key|credential|secret/i);
    });
  }

  it('does not invent a fixed Vercel project maximum', async () => {
    const result = await createMockProviderGateway().readVercelCapacity(context);
    expect(result.applicableProjectLimit).toBeNull();
    expect(result.providerReportedLimits).toEqual({});
    expect(result.projectsUsed).toBeNull();
  });

  it('keeps provider failure tenant-scoped', async () => {
    const gateway = createMockProviderGateway({ failingTenantId: tenantA, failureMode: 'failure' });
    const failed = await gateway.verifyDeploymentHealth(context);
    const other = await gateway.verifyDeploymentHealth({ tenantId: tenantB, exactDomain: 'other.leadfinder.business' });
    expect(failed.status).toBe('unknown');
    expect(failed.failureCode).toBe('failure');
    expect(other.status).toBe('unknown');
    expect(other.failureCode).toBeUndefined();
    expect(other.diagnosticReason).toBe('MOCK_NON_AUTHORITATIVE');
  });

  it('rejects fictional or mismatched tenant identity before provider access', async () => {
    await expect(createMockProviderGateway().readMonitoring({ tenantId: 'tnt_fake', exactDomain: 'test.leadfinder.business' })).rejects.toThrow(/uuid/i);
  });
});
