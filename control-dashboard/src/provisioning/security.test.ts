import { describe, expect, it } from 'vitest';
import { runProvisioning } from './executor';
import { createFakeProviders } from './provisioningProviders';
import type { GoldenReleaseIdentity } from './releaseRegistry';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.1',
  tag: 'customer-app-v1.0.1',
  commitSha: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

// R1 TWO-DEVICE CONTRACT — per-customer handoff secrets (transient, first run)
const DEVICE_LOCK_SECRETS = {
  kvRestApiUrl: 'https://store-a.upstash.io',
  kvRestApiToken: 'tok_abcdefghijkl',
  appPass: 'accesscode123456',
};

const RAW_KEY = 'AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg';

function input(overrides: Record<string, unknown> = {}) {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    placesKeyFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    goldenRelease: GOLDEN,
    centralMonitoringSa: 'leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com',
    executionGate: true,
    ...overrides,
  };
}

describe('R1 security — raw Places key never enters persistence', () => {
  it('executor refuses a raw AIza… key at the tenant stage', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input({ placesKeyFingerprint: RAW_KEY }), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toContain('raw key refused');
  });

  it('raw key never appears in any stage detail or audit detail', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('CUSTOMER_READY');
    const allText = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(allText).not.toContain('AIza');
  });

  it('persisted config path only ever carries the 8-hex fingerprint', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.ok).toBe(true);
    expect(readback.config?.keyFingerprint).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(readback.config?.keyFingerprint.length).toBe(64);
    expect(JSON.stringify(readback.config)).not.toContain('AIza');
  });

  it('provisioning rejects raw-key-shaped inputs even with a valid fingerprint prefix', async () => {
    // fingerprint must be EXACTLY 8 hex chars — longer/raw values are refused
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input({ placesKeyFingerprint: RAW_KEY.slice(0, 10) }), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('FAILED');
  });
});
