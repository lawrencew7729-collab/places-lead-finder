import { describe, expect, it } from 'vitest';
import { runProvisioning } from './executor';
import { createFakeProviders, lastHandedOffDeviceLockSecrets } from './provisioningProviders';
import { kvStoreFingerprint } from './deviceLockContract';
import type { GoldenReleaseIdentity } from './releaseRegistry';
import type { DeviceLockSecretsInput } from './deviceLockContract';

const FP = 'A'.repeat(64);

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.1',
  tag: 'customer-app-v1.0.1',
  commitSha: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

const STORE_A = 'https://store-a.upstash.io';
const STORE_B = 'https://store-b.upstash.io';

function deviceSecrets(kvRestApiUrl = STORE_A): DeviceLockSecretsInput {
  return {
    kvRestApiUrl,
    kvRestApiToken: 'tok_abcdefghijkl',
    appPass: 'accesscode123456', // 16-char customer access code
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    placesKeyFingerprint: FP,
    goldenRelease: GOLDEN,
    centralMonitoringSa: 'leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com',
    executionGate: true,
    ...overrides,
  };
}

describe('R1 TWO-DEVICE CONTRACT — provisioning integration', () => {
  it('CUSTOMER_READY requires a locked device-lock probe (full contract)', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets() });
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(result.failedStageId).toBeNull();
    const deviceStage = result.stages.find((s) => s.id === 'device_lock');
    expect(deviceStage?.status).toBe('PASS');
    // persisted policy is tenant-scoped, not hostname-scoped
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.devicePolicy.kvNamespace).toBe(`lf_dev:${result.tenantId}`);
    expect(readback.config?.devicePolicy.storeFingerprint).toBe(kvStoreFingerprint(STORE_A));
    expect(readback.config?.devicePolicy.maxDevices).toBe(2);
  });

  it('provisioning CANNOT reach CUSTOMER READY when the deployment is open (KV not active)', async () => {
    const providers = createFakeProviders();
    providers.setDeviceLockOpen('abc.leadfinder.business');
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets() });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('device_lock');
    expect(result.stages.find((s) => s.id === 'device_lock')?.detail).toContain('device lock not active');
  });

  it('provisioning CANNOT reach CUSTOMER READY without a device-lock provider (fail-closed)', async () => {
    const providers = createFakeProviders();
    const { deviceLock, ...withoutDeviceLock } = providers;
    void deviceLock;
    const result = await runProvisioning(withoutDeviceLock as typeof providers, input(), { deviceLockSecrets: deviceSecrets() });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('device_lock');
  });

  it('provisioning CANNOT reach CUSTOMER READY with invalid handoff secrets', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), {
      deviceLockSecrets: { ...deviceSecrets(), appPass: 'tooshort' },
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('device_lock');
    expect(result.stages.find((s) => s.id === 'device_lock')?.detail).toContain('secrets invalid');
  });

  it('first-run handoff requires secrets: open probe without them fails closed', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input()); // no deviceLockSecrets
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('device_lock');
  });

  it('resume path (already configured deployment) passes WITHOUT re-entering secrets', async () => {
    const providers = createFakeProviders();
    const first = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets() });
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input()); // no secrets — already configured
    expect(second.outcome).toBe('CUSTOMER_READY');
    // deterministic tenant identity: same slug → same tenantId → same registry namespace
    expect(second.tenantId).toBe(first.tenantId);
  });
});

describe('R1 TWO-DEVICE CONTRACT — dedicated-store uniqueness guard', () => {
  it('second customer with the SAME store → FAILED at device_lock', async () => {
    const providers = createFakeProviders();
    const first = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input({ slug: 'xyz' }), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(second.outcome).toBe('FAILED');
    expect(second.failedStageId).toBe('device_lock');
    expect(second.stages.find((s) => s.id === 'device_lock')?.detail).toContain('already owned by another tenant');
  });

  it('different customers with DIFFERENT stores → both CUSTOMER_READY, registries isolated', async () => {
    const providers = createFakeProviders();
    const first = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    const second = await runProvisioning(providers, input({ slug: 'xyz' }), { deviceLockSecrets: deviceSecrets(STORE_B) });
    expect(first.outcome).toBe('CUSTOMER_READY');
    expect(second.outcome).toBe('CUSTOMER_READY');
    const a = await providers.controlPlane.findConfigByTenant(first.tenantId);
    const b = await providers.controlPlane.findConfigByTenant(second.tenantId);
    expect(a.config?.devicePolicy.kvNamespace).not.toBe(b.config?.devicePolicy.kvNamespace);
    expect(a.config?.devicePolicy.storeFingerprint).not.toBe(b.config?.devicePolicy.storeFingerprint);
  });

  it('same customer re-provision with the SAME store → allowed (idempotent, one owner)', async () => {
    const providers = createFakeProviders();
    const first = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(second.tenantId).toBe(first.tenantId);
  });

  it('same customer with a DIFFERENT store → FAILED (device policy drift, no silent takeover)', async () => {
    const providers = createFakeProviders();
    const first = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_B) });
    expect(second.outcome).toBe('FAILED');
    expect(second.failedStageId).toBe('finalize');
    expect(second.stages.find((s) => s.id === 'finalize')?.detail).toContain('drift');
  });
});

describe('R1 TWO-DEVICE CONTRACT — immutable tenant identity', () => {
  it('tenantId is the authoritative Control Plane UUID — stable across retries, independent of slug', async () => {
    const providers = createFakeProviders();
    const a = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    // real UUID v4, generated ONCE at the customer identity boundary
    expect(a.tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // retry of the SAME customer reuses the persisted tenant id (registry identity never drifts)
    const b = await runProvisioning(providers, input(), { deviceLockSecrets: deviceSecrets(STORE_A) });
    expect(b.tenantId).toBe(a.tenantId);
    // a different customer is a different tenant
    const c = await runProvisioning(createFakeProviders(), input({ slug: 'xyz' }), { deviceLockSecrets: deviceSecrets(STORE_B) });
    expect(c.tenantId).not.toBe(a.tenantId);
  });
});

describe('R1 TWO-DEVICE CONTRACT — secret boundary (executor)', () => {
  it('handoff secrets are consumed transiently and NEVER enter serializable state', async () => {
    const providers = createFakeProviders();
    const secrets = deviceSecrets();
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: secrets });
    expect(result.outcome).toBe('CUSTOMER_READY');
    // the fake recorded the handoff (proves the handoff path ran)
    expect(lastHandedOffDeviceLockSecrets()).toEqual(secrets);
    // raw values never in stages / rollback / audit / persisted config
    const serialized = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(serialized).not.toContain(secrets.kvRestApiToken);
    expect(serialized).not.toContain(secrets.appPass);
    expect(serialized).not.toContain(secrets.kvRestApiUrl);
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(JSON.stringify(readback.config)).not.toContain(secrets.kvRestApiToken);
    expect(JSON.stringify(readback.config)).not.toContain(secrets.appPass);
    expect(JSON.stringify(readback.config)).not.toContain('upstash');
    expect(JSON.stringify(readback.config)).not.toContain('tok_');
  });

  it('stage failure reasons never leak secret values', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), {
      deviceLockSecrets: { ...deviceSecrets(), appPass: 'short' },
    });
    expect(result.outcome).toBe('FAILED');
    const allText = JSON.stringify(result.stages);
    expect(allText).not.toContain('short');
    expect(allText).not.toContain('upstash');
  });
});
