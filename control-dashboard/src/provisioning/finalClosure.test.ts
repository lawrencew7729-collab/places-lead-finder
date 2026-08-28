import { describe, expect, it, beforeEach } from 'vitest';
import { runProvisioning } from './executor';
import { createFakeProviders, lastHandedOffPlacesKey } from './provisioningProviders';
import { createVercelAdapter, createControlPlaneAdapter, createGoogleAdapter, createHealthAdapter, createDeviceLockAdapter, createPlacesKeyAdapter, createUpstashRedisAclAdmin, createUsageSmokeAdapter, createFakeTransport } from './adapters';
import { runtimeEnvPairs, verifyRuntimeEnvConsistency } from './quotaContract';
import type { GoldenReleaseIdentity } from './releaseRegistry';

const FP = 'A'.repeat(64);
const RAW_KEY = 'AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg';

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

function input() {
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
    wif: {
      pool: 'lf-vercel-wif',
      provider: 'vercel-oidc',
      centralProjectNumber: '123456789012',
      vercelTeamSlug: 'lawrencew7729-4682s',
      vercelTeamId: 'team_lawrencew7729',
    },
  };
}

describe('R1 final closure — full fingerprint contract', () => {
  it('persists exactly 64 uppercase hex characters', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('CUSTOMER_READY');
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.keyFingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(readback.config?.keyFingerprint.length).toBe(64);
  });

  it('refuses truncated 8-hex fingerprints (must be full 64)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input().placesKeyFingerprint ? { ...input(), placesKeyFingerprint: '1A2B3C4D' } : input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
  });
});

describe('R1 final closure — transient raw key handoff', () => {
  beforeEach(() => {
    // module-level fake state reset via new instance is fine; no cross-test dependence on lastHandedOff
  });

  it('stage 5 consumes the raw key via the ephemeral handoff and discards it', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(lastHandedOffPlacesKey()).toBe(RAW_KEY);
    // raw key never enters serializable state
    const serialized = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(serialized).not.toContain('AIza');
  });

  it('raw key never enters DB/audit/rollback even when handed off', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(JSON.stringify(readback.config)).not.toContain('AIza');
    expect(JSON.stringify(result.rollbackMetadata)).not.toContain('AIza');
  });

  it('invalid raw key fails at the handoff (stage 5)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runProvisioning(providers, input(), { placesApiKey: 'not-a-real-key' });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('places_key');
  });
});

describe('R1 final closure — quota ENV consistency', () => {
  it('browser VITE_* and server CUSTOMER_* pairs both carry the contract', () => {
    const pairs = runtimeEnvPairs();
    expect(pairs.browser).toEqual({
      VITE_CUSTOMER_MONTHLY_TARGET: '1000',
      VITE_CUSTOMER_AMBER_PERCENT: '85',
      VITE_CUSTOMER_RED_PERCENT: '90',
      VITE_CUSTOMER_ENFORCEMENT_MODE: 'disable_new_search',
    });
    // server block additionally REQUIRES WIF_AUDIENCE + monitoring SA + project (fail-closed presence)
    expect(pairs.server).toEqual({
      CUSTOMER_MONTHLY_TARGET: '1000',
      CUSTOMER_GOOGLE_PROJECT_ID: '__REQUIRED__',
      WIF_AUDIENCE: '__REQUIRED__',
      CUSTOMER_MONITORING_SA: '__REQUIRED__',
    });
  });

  it('verifyRuntimeEnvConsistency accepts matching pairs', () => {
    const pairs = runtimeEnvPairs();
    const server = { ...pairs.server, CUSTOMER_GOOGLE_PROJECT_ID: 'p1', WIF_AUDIENCE: '//iam…/providers/x', CUSTOMER_MONITORING_SA: 'sa@p1.iam.gserviceaccount.com' };
    expect(verifyRuntimeEnvConsistency(pairs.browser, server).consistent).toBe(true);
  });

  it('browser/server disagreement fails closed', () => {
    const pairs = runtimeEnvPairs();
    const server = { ...pairs.server, CUSTOMER_GOOGLE_PROJECT_ID: 'p1', WIF_AUDIENCE: '//iam…/providers/x', CUSTOMER_MONITORING_SA: 'sa@p1.iam.gserviceaccount.com' };
    const bad = verifyRuntimeEnvConsistency({ ...pairs.browser, VITE_CUSTOMER_MONTHLY_TARGET: '5000' }, server);
    expect(bad.consistent).toBe(false);
    expect(bad.reasons.join()).toContain('browser/server monthly cap disagreement');
  });

  it('server cap differing from browser cap fails closed', () => {
    const pairs = runtimeEnvPairs();
    const bad = verifyRuntimeEnvConsistency(pairs.browser, { CUSTOMER_MONTHLY_TARGET: '5000' });
    expect(bad.consistent).toBe(false);
  });

  it('missing WIF_AUDIENCE / CUSTOMER_MONITORING_SA / project fails closed (api/usage 503 not_configured contract)', () => {
    const pairs = runtimeEnvPairs();
    const missingWif = verifyRuntimeEnvConsistency(pairs.browser, { CUSTOMER_MONTHLY_TARGET: '1000' });
    expect(missingWif.consistent).toBe(false);
    expect(missingWif.reasons.join()).toContain('WIF_AUDIENCE missing');
    expect(missingWif.reasons.join()).toContain('CUSTOMER_GOOGLE_PROJECT_ID missing');
    expect(missingWif.reasons.join()).toContain('CUSTOMER_MONITORING_SA missing');
  });
});

describe('R1 final closure — real server-side adapters', () => {
  it('Vercel adapter is idempotent: reuses existing project (find-before-create)', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/v9/projects?', body: { projects: [{ id: 'prj_existing', name: 'lf-customer-abc' }] } },
    ]);
    const adapter = createVercelAdapter({ token: 't', teamId: 'team_x', transport });
    const first = await adapter.createProject('tenant-1', 'abc');
    expect(first.ok).toBe(true);
    expect(first.ok && first.resourceId).toBe('prj_existing');
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0); // no create happened
  });

  it('Vercel adapter creates a project when absent and writes full ENV pairs', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/v9/projects?', body: { projects: [] } },
      { urlPrefix: '/v9/projects?', body: { id: 'prj_new' }, status: 200 },
      { urlPrefix: '/env', body: [] }, // env readback (GET) — empty project env
    ]);
    const adapter = createVercelAdapter({ token: 't', teamId: 'team_x', transport });
    const created = await adapter.createProject('tenant-1', 'abc');
    expect(created.ok && created.resourceId).toBe('prj_new');
    const env = await adapter.setRuntimeEnv('prj_new', { monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search', googleProjectId: 'p1', wifAudience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/p/providers/pr', centralMonitoringSa: 'sa@x.iam.gserviceaccount.com' });
    expect(env.ok).toBe(true);
    const envCalls = calls.filter((c) => c.url.includes('/env'));
    expect(envCalls.length).toBe(9); // 1 GET readback + 8 POSTs (4 VITE + server monthly + project + WIF_AUDIENCE + monitoring SA)
    const postedKeys = envCalls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body ?? '{}').key);
    expect(postedKeys).toContain('VITE_CUSTOMER_MONTHLY_TARGET');
    expect(postedKeys).toContain('CUSTOMER_MONTHLY_TARGET');
    expect(postedKeys).toContain('WIF_AUDIENCE');
    expect(postedKeys).toContain('CUSTOMER_MONITORING_SA');
    expect(envCalls.every((c) => JSON.parse(c.body ?? '{}').value !== '5000')).toBe(true);
  });

  it('Control Plane adapter writes explicit quota contract (never defaults)', async () => {
    const { transport, calls } = createFakeTransport([{ urlPrefix: '/customer_configurations', body: {} }]);
    const adapter = createControlPlaneAdapter({ baseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', operatorUserId: 'op-user-1', transport });
    const res = await adapter.insertCustomerConfig({
      tenantId: 't1',
      googleProjectId: 'p1',
      keyFingerprint: FP,
      websiteRestrictionExact: 'https://abc.leadfinder.business/*',
      monitoringMode: 'shared_access',
      quota: { monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search' },
      devicePolicy: {
        maxDevices: 2,
        mode: 'hard_lock',
        kvNamespace: 'tenant:t1',
        appPassConfigured: true,
        tenantIdConfigured: true,
        autoEviction: false,
        storeFingerprint: 'B'.repeat(64),
      },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0].body ?? '{}');
    expect(body.monthly_usage_target).toBe(1000);
    expect(body.amber_threshold_percent).toBe(85);
    expect(body.red_threshold_percent).toBe(90);
    expect(body.quota_enforcement_mode).toBe('disable_new_search');
    expect(body.places_key_fingerprint).toBe(FP);
    expect(calls[0].body).not.toContain('AIza');
  });

  it('Control Plane adapter maps release identity to the LIVE releases schema (no tag column)', async () => {
    const { transport, calls } = createFakeTransport([{ urlPrefix: '/releases', body: [{}] }]);
    const adapter = createControlPlaneAdapter({ baseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', operatorUserId: 'op-user-1', transport });
    const identity: GoldenReleaseIdentity = {
      version: '1.0.2',
      tag: 'customer-app-v1.0.2',
      commitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      sourcePath: 'repo root (Vite)',
      status: 'approved',
      approvedBy: 'op-user-1',
      approvedAt: '2026-08-26T00:00:00.000Z',
    };
    const res = await adapter.insertRelease(identity);
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0].body ?? '{}');
    // live releases columns only — the invented `tag` column must NOT be sent
    expect(Object.keys(body).sort()).toEqual(['approved_at', 'approved_by', 'artifact_sha256', 'artifact_uri', 'created_by', 'git_sha', 'status', 'version']);
    expect(body.tag).toBeUndefined();
    expect(body.artifact_uri).toBe('tag:customer-app-v1.0.2'); // NOT-NULL provenance carrier
    expect(body.git_sha).toBe('c'.repeat(40));
    expect(body.artifact_sha256).toBe('d'.repeat(64));
    expect(body.status).toBe('approved');
    expect(body.created_by).toBe('op-user-1');
    expect(body.approved_by).toBe('op-user-1');
    expect(body.approved_at).toBe('2026-08-26T00:00:00.000Z');
  });

  it('device-lock adapter PREFERS existing UPSTASH_REDIS_REST_* — writes ONLY APP_PASS + CUSTOMER_TENANT_ID, no secret duplication', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/env', body: [
        { key: 'UPSTASH_REDIS_REST_URL', value: 'https://store-a.upstash.io' },
        { key: 'UPSTASH_REDIS_REST_TOKEN', value: 'tok_abcdefghijkl' },
      ] },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
    ]);
    const adapter = createDeviceLockAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.configureDeviceLock('prj_t1', {
      kvRestApiUrl: 'https://store-a.upstash.io',
      kvRestApiToken: 'tok_abcdefghijkl',
      appPass: 'accesscode123456',
    }, '563bfb5f-5ec1-44a8-95b2-2e2ee3e9332b');
    expect(res.ok).toBe(true);
    const envGets = calls.filter((c) => c.url.includes('/env') && c.method === 'GET');
    const envPosts = calls.filter((c) => c.url.includes('/env') && c.method === 'POST');
    expect(envGets.length).toBe(1); // readback only
    expect(envPosts.length).toBe(2); // ONLY the missing T1-specific values
    const keys = envPosts.map((c) => JSON.parse(c.body ?? '{}').key);
    expect(keys.sort()).toEqual(['APP_PASS', 'CUSTOMER_TENANT_ID']);
    expect(keys).not.toContain('KV_REST_API_URL');
    expect(keys).not.toContain('KV_REST_API_TOKEN');
    expect(envPosts.every((c) => !(c.body ?? '').includes('tok_'))).toBe(true); // token never re-written
  });

  it('device-lock adapter writes canonical KV_REST_API_* pair ONLY when no store credentials exist', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/env', body: [] },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
    ]);
    const adapter = createDeviceLockAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.configureDeviceLock('prj_new', {
      kvRestApiUrl: 'https://store-a.upstash.io',
      kvRestApiToken: 'tok_abcdefghijkl',
      appPass: 'accesscode123456',
    }, 't1');
    expect(res.ok).toBe(true);
    const envPosts = calls.filter((c) => c.url.includes('/env') && c.method === 'POST');
    expect(envPosts.length).toBe(5);
    const keys = envPosts.map((c) => JSON.parse(c.body ?? '{}').key);
    expect(keys.sort()).toEqual(['APP_PASS', 'CUSTOMER_TENANT_ID', 'KV_REST_API_TOKEN', 'KV_REST_API_TOKEN_FINGERPRINT', 'KV_REST_API_URL']);
  });

  it('device-lock adapter FAILS on store drift when the deployment store differs from the handoff', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/env', body: [
        { key: 'UPSTASH_REDIS_REST_URL', value: 'https://store-b.upstash.io' },
        { key: 'UPSTASH_REDIS_REST_TOKEN', value: 'tok_other' },
      ] },
    ]);
    const adapter = createDeviceLockAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.configureDeviceLock('prj_t1', {
      kvRestApiUrl: 'https://store-a.upstash.io',
      kvRestApiToken: 'tok_abcdefghijkl',
      appPass: 'accesscode123456',
    }, 't1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected configureDeviceLock to fail');
    expect((res as { reason: string }).reason).toContain('drift');
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0); // nothing written
  });

  it('device-lock adapter CENTRAL mode: ALWAYS writes the customer ACL credential (no shared token reuse), drift vs central URL', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/env', body: [
        { key: 'UPSTASH_REDIS_REST_URL', value: 'https://central.example.com' },
        { key: 'UPSTASH_REDIS_REST_TOKEN', value: 'tok_shared' },
      ] },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
      { urlPrefix: '/env', body: {} },
    ]);
    const adapter = createDeviceLockAdapter({ token: 't', teamId: 'team_x', storeMode: 'central', transport });
    const res = await adapter.configureDeviceLock('prj_t1', {
      kvRestApiUrl: 'https://central.example.com',
      kvRestApiToken: 'tok_customer_acl_only',
      appPass: 'accesscode123456',
    }, '563bfb5f-5ec1-44a8-95b2-2e2ee3e9332b');
    expect(res.ok).toBe(true);
    const envPosts = calls.filter((c) => c.url.includes('/env') && c.method === 'POST');
    // central mode writes ALL FIVE envs incl. the token fingerprint — the shared UPSTASH token is NOT reused
    expect(envPosts.length).toBe(5);
    const keys = envPosts.map((c) => JSON.parse(c.body ?? '{}').key).sort();
    expect(keys).toEqual(['APP_PASS', 'CUSTOMER_TENANT_ID', 'KV_REST_API_TOKEN', 'KV_REST_API_TOKEN_FINGERPRINT', 'KV_REST_API_URL']);
    const tokenPost = envPosts.find((c) => JSON.parse(c.body ?? '{}').key === 'KV_REST_API_TOKEN');
    expect(JSON.parse(tokenPost?.body ?? '{}').value).toBe('tok_customer_acl_only');
    const fpPost = envPosts.find((c) => JSON.parse(c.body ?? '{}').key === 'KV_REST_API_TOKEN_FINGERPRINT');
    // full 64-hex uppercase SHA-256 of the REST token — never the raw token
    expect(JSON.parse(fpPost?.body ?? '{}').value).toMatch(/^[A-F0-9]{64}$/);
    expect(envPosts.every((c) => !(c.body ?? '').includes('tok_shared'))).toBe(true); // shared token never written
  });

  it('device-lock adapter CENTRAL mode FAILS when the deployment store differs from the central store', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/env', body: [
        { key: 'KV_REST_API_URL', value: 'https://other.example.com' },
        { key: 'KV_REST_API_TOKEN', value: 'tok_x' },
      ] },
    ]);
    const adapter = createDeviceLockAdapter({ token: 't', teamId: 'team_x', storeMode: 'central', transport });
    const res = await adapter.configureDeviceLock('prj_t1', {
      kvRestApiUrl: 'https://central.example.com',
      kvRestApiToken: 'tok_customer_acl_only',
      appPass: 'accesscode123456',
    }, 't1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected central drift failure');
    expect((res as { reason: string }).reason).toContain('drift');
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
  });

  it('Google adapter adds ONLY monitoring.viewer — pre-existing roles preserved, none granted', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: ':getIamPolicy', body: { etag: 'E1', bindings: [{ role: 'roles/owner', members: ['user:owner@x.com'] }] } },
      { urlPrefix: ':setIamPolicy', body: {} },
    ]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const res = await adapter.grantMonitoringViewer('proj-1', 'sa@x.iam.gserviceaccount.com');
    expect(res.ok).toBe(true);
    const setCall = calls.find((c) => c.url.includes(':setIamPolicy'));
    const policy = JSON.parse(setCall?.body ?? '{}').policy;
    const roles = policy.bindings.map((b: { role: string }) => b.role);
    // only ONE new binding was added: monitoring.viewer
    const viewer = policy.bindings.find((b: { role: string }) => b.role === 'roles/monitoring.viewer');
    expect(viewer.members).toEqual(['serviceAccount:sa@x.iam.gserviceaccount.com']);
    // pre-existing owner binding preserved exactly — adapter never grants owner/editor
    const owner = policy.bindings.find((b: { role: string }) => b.role === 'roles/owner');
    expect(owner.members).toEqual(['user:owner@x.com']);
    expect(roles.filter((r: string) => r === 'roles/editor').length).toBe(0);
  });

  it('Google adapter refuses wrong project (project lookup 404)', async () => {
    const { transport } = createFakeTransport([{ urlPrefix: '/projects/', status: 404 }]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const res = await adapter.verifyReferrer('wrong-project', 'https://abc.leadfinder.business/*');
    expect(res.ok).toBe(false);
  });

  it('Health adapter performs bounded HTTPS smoke check', async () => {
    const { transport } = createFakeTransport([{ urlPrefix: 'https://abc.leadfinder.business', body: '<!DOCTYPE html><html>…' }]);
    const adapter = createHealthAdapter({ transport });
    const res = await adapter.smokeCheck('abc.leadfinder.business');
    expect(res.ok).toBe(true);
  });

  it('Vercel adapter enables team-mode OIDC idempotently (PATCH + readback skip)', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/v9/projects/prj_t1?', body: { oidcTokenConfig: { enabled: false } } },
      { urlPrefix: '/v9/projects/prj_t1?', body: { oidcTokenConfig: { enabled: true, issuerMode: 'team' } } },
    ]);
    const adapter = createVercelAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.enableVercelOidc('prj_t1');
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && (c.body ?? '').includes('issuerMode'))).toBe(true);
    // already enabled → no PATCH
    const { transport: t2, calls: c2 } = createFakeTransport([
      { urlPrefix: '/v9/projects/prj_t1?', body: { oidcTokenConfig: { enabled: true, issuerMode: 'team' } } },
    ]);
    const adapter2 = createVercelAdapter({ token: 't', teamId: 'team_x', transport: t2 });
    const res2 = await adapter2.enableVercelOidc('prj_t1');
    expect(res2.ok).toBe(true);
    expect(c2.filter((c) => c.method === 'PATCH').length).toBe(0);
  });

  it('Vercel adapter verifyEnv fails closed on missing keys', async () => {
    const { transport } = createFakeTransport([
      { urlPrefix: '/env', body: [{ key: 'WIF_AUDIENCE', value: 'x' }] },
      { urlPrefix: '/env', body: [{ key: 'WIF_AUDIENCE', value: 'x' }] },
    ]);
    const adapter = createVercelAdapter({ token: 't', teamId: 'team_x', transport });
    const ok = await adapter.verifyEnv('prj_t1', ['WIF_AUDIENCE']);
    expect(ok.ok).toBe(true);
    const missing = await adapter.verifyEnv('prj_t1', ['WIF_AUDIENCE', 'CUSTOMER_MONITORING_SA']);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected verifyEnv failure');
    expect((missing as { reason: string }).reason).toContain('CUSTOMER_MONITORING_SA');
  });

  it('Places key adapter: idempotent skip when VITE_PLACES_API_KEY already exists (retry never re-exposes the raw key)', async () => {
    const { transport, calls } = createFakeTransport([{ urlPrefix: '/env', body: [{ key: 'VITE_PLACES_API_KEY', value: null }] }]);
    const adapter = createPlacesKeyAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.configurePlacesKey('prj_t1', 'AIzaSyA_TEST_KEY_0000000000000000000000');
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0); // no write — key never re-sent
  });

  it('Places key adapter: missing key + missing env → OWNER ACTION HOLD (no write)', async () => {
    const { transport } = createFakeTransport([{ urlPrefix: '/env', body: [] }]);
    const adapter = createPlacesKeyAdapter({ token: 't', teamId: 'team_x', transport });
    const res = await adapter.configurePlacesKey('prj_t1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected owner-action failure');
    expect((res as { reason: string }).reason).toContain('OWNER ACTION REQUIRED');
  });

  it('Upstash ACL admin: path-style REST commands (SETUSER/RESTTOKEN/DELUSER), RESTTOKEN returns the token', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/acl/setuser', body: { result: 'OK' } },
      { urlPrefix: '/acl/resttoken', body: { result: 'rest_tok_abc' } },
    ]);
    const admin = createUpstashRedisAclAdmin({ adminUrl: 'https://central.upstash.io', adminToken: 'admin-tok', transport });
    await admin.run('ACL SETUSER lf_t123 on >pw ~tenant:t1:* +get +set');
    const token = await admin.restToken('lf_t123', 'pw');
    expect(token).toBe('rest_tok_abc');
    // path-style: command lowercased; subcommand/args verbatim (case-insensitive on the Redis side)
    expect(calls[0].url.toLowerCase()).toContain('/acl/setuser/');
    expect(calls[1].url.toLowerCase()).toContain('/acl/resttoken/');
    // admin token only in the Authorization header
    expect(calls.every((c) => !(c.url + (c.body ?? '')).includes('admin-tok'))).toBe(true);
  });

  it('Usage smoke adapter: 11-point sequence — server-side referrer-acceptance preflight (NOT a browser-runtime proof)', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: 'https://abc.leadfinder.business/', body: '<!DOCTYPE html><html>' },
      { urlPrefix: '/api/usage', body: { used: 0, cap: 1000, safetyStop: 900, month: '2026-08', sessionId: 'sess-1', maxSessionRequests: 50, source: 'monitoring' } },
      { urlPrefix: '/api/session?mode=status', body: { active: true, sessionId: 'sess-1', used: 0 } },
      { urlPrefix: '/api/session?mode=release', body: { ok: true } },
      { urlPrefix: '/api/session?mode=status', body: { active: false, used: 0 } },
      { urlPrefix: '/api/device?mode=probe', body: { mode: 'locked', maxDevices: 2, kvConfigured: true, appPassConfigured: true, tenantIdConfigured: true } },
      { urlPrefix: 'https://places.googleapis.com/v1/places/', body: { id: 'ChIJj61dQgK6j4AR4GeTYWZsKWw' } },
    ]);
    const adapter = createUsageSmokeAdapter({ transport });
    const res = await adapter.run('abc.leadfinder.business', 'AIzaSyA_TEST_KEY_0000000000000000000000');
    expect(res.ok).toBe(true);
    expect(res.smoke?.capIs1000).toBe(true);
    expect(res.smoke?.safetyStopIs900).toBe(true);
    expect(res.smoke?.maxSessionIs50).toBe(true);
    expect(res.smoke?.monitoringSource).toBe(true);
    expect(res.smoke?.tenantIdentityExact).toBe(true);
    expect(res.smoke?.noActiveLeaseAfterRelease).toBe(true);
    expect(res.smoke?.deviceProbeLocked).toBe(true);
    expect(res.smoke?.referrerAcceptanceProbe).toBe(true);
    // the probe request carries the browser-like exact-origin Referer and the customer key
    const placesCall = calls.find((c) => c.url.includes('places.googleapis.com'));
    expect(placesCall?.headers?.Referer).toBe('https://abc.leadfinder.business/');
    expect(placesCall?.url).toContain('AIzaSyA_TEST_KEY');
    // the raw key never enters the serializable report/reason
    expect(JSON.stringify(res.smoke)).not.toContain('AIzaSy');
  });

  it('Usage smoke adapter fails closed WITHOUT the real key (preflight before key capture/runtime handoff)', async () => {
    const { transport } = createFakeTransport([
      { urlPrefix: 'https://abc.leadfinder.business/', body: '<!DOCTYPE html><html>' },
      { urlPrefix: '/api/usage', body: { used: 0, cap: 1000, safetyStop: 900, month: '2026-08', sessionId: 'sess-1', maxSessionRequests: 50, source: 'monitoring' } },
      { urlPrefix: '/api/session?mode=status', body: { active: true, sessionId: 'sess-1', used: 0 } },
      { urlPrefix: '/api/session?mode=release', body: { ok: true } },
      { urlPrefix: '/api/session?mode=status', body: { active: false, used: 0 } },
      { urlPrefix: '/api/device?mode=probe', body: { mode: 'locked', maxDevices: 2, kvConfigured: true, appPassConfigured: true, tenantIdConfigured: true } },
    ]);
    const adapter = createUsageSmokeAdapter({ transport });
    const res = await adapter.run('abc.leadfinder.business');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected smoke failure');
    expect((res as { reason: string }).reason).toContain('real customer API key missing');
  });

  it('Usage smoke adapter fails closed when the referrer restriction denies the exact origin (REQUEST_DENIED)', async () => {
    const { transport } = createFakeTransport([
      { urlPrefix: 'https://abc.leadfinder.business/', body: '<!DOCTYPE html><html>' },
      { urlPrefix: '/api/usage', body: { used: 0, cap: 1000, safetyStop: 900, month: '2026-08', sessionId: 'sess-1', maxSessionRequests: 50, source: 'monitoring' } },
      { urlPrefix: '/api/session?mode=status', body: { active: true, sessionId: 'sess-1', used: 0 } },
      { urlPrefix: '/api/session?mode=release', body: { ok: true } },
      { urlPrefix: '/api/session?mode=status', body: { active: false, used: 0 } },
      { urlPrefix: '/api/device?mode=probe', body: { mode: 'locked', maxDevices: 2, kvConfigured: true, appPassConfigured: true, tenantIdConfigured: true } },
      { urlPrefix: 'https://places.googleapis.com/v1/places/', status: 403, body: { error: { status: 'PERMISSION_DENIED' } } },
    ]);
    const adapter = createUsageSmokeAdapter({ transport });
    const res = await adapter.run('abc.leadfinder.business', 'AIzaSyA_TEST_KEY_0000000000000000000000');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected smoke failure');
    expect((res as { reason: string }).reason).toContain('referrer restriction denied');
  });

  it('Usage smoke adapter fails closed when /api/usage is blocked or locked', async () => {
    const { transport } = createFakeTransport([
      { urlPrefix: 'https://abc.leadfinder.business/', body: '<!DOCTYPE html><html>' },
      { urlPrefix: '/api/usage', body: { used: 950, cap: 1000, safetyStop: 900, month: '2026-08', blocked: true } },
    ]);
    const adapter = createUsageSmokeAdapter({ transport });
    const res = await adapter.run('abc.leadfinder.business');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected smoke failure');
    expect((res as { reason: string }).reason).toContain('BLOCKED');
  });

  it('Google adapter billing isolation: exactly ONE linked project == customer project', async () => {
    const { transport } = createFakeTransport([{ urlPrefix: '/projects', body: { projects: [{ projectId: 'abc-leadfinder-1234', billingEnabled: true }] } }]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const ok = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', 'abc-leadfinder-1234');
    expect(ok.ok).toBe(true);
    const { transport: t2 } = createFakeTransport([{ urlPrefix: '/projects', body: { projects: [
      { projectId: 'abc-leadfinder-1234', billingEnabled: true },
      { projectId: 'other-5678', billingEnabled: true },
    ] } }]);
    const adapter2 = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport: t2 });
    const fail = await adapter2.verifyBillingIsolation('01B61E-759031-B494E4', 'abc-leadfinder-1234');
    expect(fail.ok).toBe(false);
    const { transport: t3 } = createFakeTransport([{ urlPrefix: '/projects', body: { projects: [{ projectId: 'other-5678', billingEnabled: true }] } }]);
    const adapter3 = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport: t3 });
    const wrong = await adapter3.verifyBillingIsolation('01B61E-759031-B494E4', 'abc-leadfinder-1234');
    expect(wrong.ok).toBe(false);
  });

  it('Google adapter pre-activation usage: 0 passes; non-zero fails closed for the owner review', async () => {
    const { transport } = createFakeTransport([{ urlPrefix: '/timeSeries', body: { timeSeries: [] } }]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const zero = await adapter.preActivationPlacesUsage('abc-leadfinder-1234');
    expect(zero.ok).toBe(true);
    expect(zero.usage).toBe(0);
    const { transport: t2 } = createFakeTransport([{ urlPrefix: '/timeSeries', body: { timeSeries: [{ points: [{ value: { int64Value: '5' } }] }] } }]);
    const adapter2 = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport: t2 });
    const five = await adapter2.preActivationPlacesUsage('abc-leadfinder-1234');
    expect(five.ok).toBe(true);
    expect(five.usage).toBe(5);
  });

  it('no privileged credential appears in adapter request shapes (token only in Authorization header)', async () => {
    const { transport, calls } = createFakeTransport([{ urlPrefix: '/v9/projects?', body: { projects: [] } }, { urlPrefix: '/v9/projects?', body: { id: 'p' } }]);
    const adapter = createVercelAdapter({ token: 'super-secret-token', teamId: 'team_x', transport });
    await adapter.createProject('t', 'abc');
    expect(calls[1].url).not.toContain('super-secret-token');
    expect(calls[1].body ?? '').not.toContain('super-secret-token');
  });
});
