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

const FP = 'A'.repeat(64);
const APP_PASS = 'accesscode123456';
const RAW_KEY = 'AIzaSyA_TEST_KEY_0000000000000000000000';

const WIF = {
  pool: 'lf-vercel-wif',
  provider: 'vercel-oidc',
  centralProjectNumber: '123456789012',
  vercelTeamSlug: 'lawrencew7729-4682s',
  vercelTeamId: 'team_lawrencew7729',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    placesKeyFingerprint: FP,
    goldenRelease: GOLDEN,
    executionGate: true,
    centralStore: true,
    websiteRestrictionConfirmed: true,
    realPortalSmokeConfirmed: true,
    centralStoreUrl: 'https://central.example.com',
    billingAccountId: '01B61E-759031-B494E4',
    wif: WIF,
    ...overrides,
  };
}

function transient() {
  return { placesApiKey: RAW_KEY, deviceLockSecrets: { appPass: APP_PASS } };
}

describe('R1 security — raw Places key never enters persistence', () => {
  it('executor refuses a raw AIza… key at the tenant stage', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input({ placesKeyFingerprint: RAW_KEY }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toContain('raw key refused');
  });

  it('raw key never appears in any stage detail or audit detail', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const allText = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(allText).not.toContain('AIza');
  });

  it('persisted config path only ever carries the FULL 64-hex fingerprint', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient());
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.ok).toBe(true);
    expect(readback.config?.keyFingerprint).toBe(FP);
    expect(readback.config?.keyFingerprint.length).toBe(64);
    expect(JSON.stringify(readback.config)).not.toContain('AIza');
  });

  it('provisioning rejects raw-key-shaped inputs even with a fingerprint prefix', async () => {
    // fingerprint must be EXACTLY 64 hex chars — raw/truncated values are refused
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input({ placesKeyFingerprint: RAW_KEY.slice(0, 10) }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
  });

  it('transient raw key is consumed at the places_key stage and never serialized', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const serialized = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(serialized).not.toContain('AIza');
    expect(serialized).not.toContain(APP_PASS);
    expect(serialized).not.toContain('rest_tok_');
  });
});
