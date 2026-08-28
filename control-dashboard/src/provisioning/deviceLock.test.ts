import { describe, expect, it } from 'vitest';
import { runProvisioning } from './executor';
import { createFakeProviders, lastHandedOffDeviceLockSecrets } from './provisioningProviders';
import { kvStoreFingerprint } from './deviceLockContract';
import { aclUsernameFor } from './aclProvisioning';
import type { GoldenReleaseIdentity } from './releaseRegistry';

const FP = 'A'.repeat(64);
const APP_PASS = 'accesscode123456';
const RAW_KEY = 'AIzaSyA_TEST_KEY_0000000000000000000000';

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
    centralStoreUrl: STORE_A,
    billingAccountId: '01B61E-759031-B494E4',
    wif: WIF,
    ...overrides,
  };
}

function transient(overrides: Record<string, unknown> = {}) {
  return { placesApiKey: RAW_KEY, deviceLockSecrets: { appPass: APP_PASS }, ...overrides };
}

describe('R1 TWO-DEVICE CONTRACT — provisioning integration (CENTRAL model)', () => {
  it('CUSTOMER_READY requires a locked device-lock probe (full contract)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(result.failedStageId).toBeNull();
    const deviceStage = result.stages.find((s) => s.id === 'device_lock');
    expect(deviceStage?.status).toBe('PASS');
    // persisted policy is tenant-scoped, not hostname-scoped
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.devicePolicy.kvNamespace).toBe(`tenant:${result.tenantId}`);
    expect(readback.config?.devicePolicy.storeFingerprint).toBe(kvStoreFingerprint(STORE_A));
    expect(readback.config?.devicePolicy.maxDevices).toBe(2);
  });

  it('CENTRAL model: two tenants share the same central store (isolation by namespace + ACL, not by store)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input({ slug: 'xyz' }), transient());
    expect(second.outcome).toBe('CUSTOMER_READY');
    const cfgA = await providers.controlPlane.findConfigByTenant(first.tenantId);
    const cfgB = await providers.controlPlane.findConfigByTenant(second.tenantId);
    expect(cfgA.config?.devicePolicy.kvNamespace).toBe(`tenant:${first.tenantId}`);
    expect(cfgB.config?.devicePolicy.kvNamespace).toBe(`tenant:${second.tenantId}`);
    expect(cfgA.config?.devicePolicy.storeFingerprint).toBe(kvStoreFingerprint(STORE_A));
    expect(cfgB.config?.devicePolicy.storeFingerprint).toBe(kvStoreFingerprint(STORE_A));
    // per-tenant ACL identities are distinct
    expect(cfgA.config?.aclUsername).toBe(aclUsernameFor(first.tenantId));
    expect(cfgB.config?.aclUsername).toBe(aclUsernameFor(second.tenantId));
    expect(cfgA.config?.aclUsername).not.toBe(cfgB.config?.aclUsername);
  });

  it('provisioning CANNOT reach CUSTOMER READY when the deployment is open (KV not active)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    providers.setDeviceLockOpen('abc.leadfinder.business');
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('device_lock');
    expect(result.stages.find((s) => s.id === 'device_lock')?.detail).toContain('device lock not active');
  });

  it('provisioning CANNOT reach CUSTOMER READY without a device-lock provider (fail-closed at acl)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const { deviceLock, ...withoutDeviceLock } = providers;
    void deviceLock;
    const result = await runProvisioning(withoutDeviceLock as typeof providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
  });

  it('provisioning CANNOT reach CUSTOMER READY without an ACL admin provider (fail-closed at acl)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const { redisAcl, ...withoutAcl } = providers;
    void redisAcl;
    const result = await runProvisioning(withoutAcl as typeof providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
  });

  it('missing/short APP_PASS stops at the acl stage (owner-action boundary, no ACL identity created)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient({ deviceLockSecrets: { appPass: 'tooshort' } }));
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
    expect(result.stages.find((s) => s.id === 'acl')?.detail).toContain('OWNER ACTION REQUIRED');
  });

  it('first-run requires the APP_PASS owner action: no secrets → HOLD at acl', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
  });

  it('resume path (already configured deployment) passes WITHOUT re-entering secrets', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input()); // no secrets — already configured
    expect(second.outcome).toBe('CUSTOMER_READY');
    // deterministic tenant identity: same slug → same tenantId → same registry namespace
    expect(second.tenantId).toBe(first.tenantId);
  });
});

describe('R1 TWO-DEVICE CONTRACT — central-store consistency', () => {
  it('same customer re-provision with the SAME central store → allowed (idempotent, one owner)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input(), transient());
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(second.tenantId).toBe(first.tenantId);
  });

  it('same customer with a DIFFERENT central store → FAILED (device policy drift, no silent takeover)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input({ centralStoreUrl: STORE_B }), transient());
    expect(second.outcome).toBe('FAILED');
    expect(second.failedStageId).toBe('finalize');
    expect(second.stages.find((s) => s.id === 'finalize')?.detail).toContain('drift');
  });
});

describe('R1 TWO-DEVICE CONTRACT — immutable tenant identity', () => {
  it('tenantId is the authoritative Control Plane UUID — stable across retries, independent of slug', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const a = await runProvisioning(providers, input(), transient());
    // real UUID v4, generated ONCE at the customer identity boundary
    expect(a.tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // retry of the SAME customer reuses the persisted tenant id (registry identity never drifts)
    const b = await runProvisioning(providers, input(), transient());
    expect(b.tenantId).toBe(a.tenantId);
    // a different customer is a different tenant
    const c = await runProvisioning(createFakeProviders(), input({ slug: 'xyz' }), transient());
    expect(c.tenantId).not.toBe(a.tenantId);
  });
});

describe('R1 TWO-DEVICE CONTRACT — secret boundary (executor)', () => {
  it('handoff secrets are consumed transiently and NEVER enter serializable state', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    // the fake recorded the handoff (proves the handoff path ran): appPass and
    // central store URL round-trip; the token is the ACL-minted REST token
    const handed = lastHandedOffDeviceLockSecrets();
    expect(handed?.appPass).toBe(APP_PASS);
    expect(handed?.kvRestApiUrl).toBe(STORE_A);
    expect(handed?.kvRestApiToken).toBe(`rest_tok_${aclUsernameFor(result.tenantId)}`);
    // raw values never in stages / rollback / audit / persisted config
    const serialized = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(serialized).not.toContain(APP_PASS);
    expect(serialized).not.toContain(handed!.kvRestApiToken);
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(JSON.stringify(readback.config)).not.toContain(APP_PASS);
    expect(JSON.stringify(readback.config)).not.toContain('rest_tok_');
    expect(JSON.stringify(readback.config)).not.toContain('tok_');
  });

  it('stage failure reasons never leak secret values', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), transient({ deviceLockSecrets: { appPass: 'short' } }));
    expect(result.outcome).toBe('FAILED');
    const allText = JSON.stringify(result.stages);
    expect(allText).not.toContain('short');
    expect(allText).not.toContain('upstash');
    expect(allText).not.toContain(APP_PASS);
  });
});
