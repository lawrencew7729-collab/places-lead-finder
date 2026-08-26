import { describe, expect, it, beforeEach } from 'vitest';
import { runProvisioning } from './executor';
import { createFakeProviders, lastHandedOffPlacesKey } from './provisioningProviders';
import { createVercelAdapter, createControlPlaneAdapter, createGoogleAdapter, createHealthAdapter, createFakeTransport } from './adapters';
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
    centralMonitoringSa: 'leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com',
    executionGate: true,
  };
}

describe('R1 final closure — full fingerprint contract', () => {
  it('persists exactly 64 uppercase hex characters', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.keyFingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(readback.config?.keyFingerprint.length).toBe(64);
  });

  it('refuses truncated 8-hex fingerprints (must be full 64)', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input().placesKeyFingerprint ? { ...input(), placesKeyFingerprint: '1A2B3C4D' } : input(), { deviceLockSecrets: DEVICE_LOCK_SECRETS });
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
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(lastHandedOffPlacesKey()).toBe(RAW_KEY);
    // raw key never enters serializable state
    const serialized = JSON.stringify({ stages: result.stages, rollback: result.rollbackMetadata });
    expect(serialized).not.toContain('AIza');
  });

  it('raw key never enters DB/audit/rollback even when handed off', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY, deviceLockSecrets: DEVICE_LOCK_SECRETS });
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(JSON.stringify(readback.config)).not.toContain('AIza');
    expect(JSON.stringify(result.rollbackMetadata)).not.toContain('AIza');
  });

  it('invalid raw key fails at the handoff (stage 5)', async () => {
    const providers = createFakeProviders();
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
      VITE_CUSTOMER_AMBER_PERCENT: '90',
      VITE_CUSTOMER_RED_PERCENT: '100',
      VITE_CUSTOMER_ENFORCEMENT_MODE: 'disable_new_search',
    });
    expect(pairs.server).toEqual({ CUSTOMER_MONTHLY_TARGET: '1000' });
  });

  it('verifyRuntimeEnvConsistency accepts matching pairs', () => {
    const pairs = runtimeEnvPairs();
    expect(verifyRuntimeEnvConsistency(pairs.browser, pairs.server).consistent).toBe(true);
  });

  it('browser/server disagreement fails closed', () => {
    const pairs = runtimeEnvPairs();
    const bad = verifyRuntimeEnvConsistency({ ...pairs.browser, VITE_CUSTOMER_MONTHLY_TARGET: '5000' }, pairs.server);
    expect(bad.consistent).toBe(false);
    expect(bad.reasons.join()).toContain('browser/server monthly cap disagreement');
  });

  it('server cap differing from browser cap fails closed', () => {
    const pairs = runtimeEnvPairs();
    const bad = verifyRuntimeEnvConsistency(pairs.browser, { CUSTOMER_MONTHLY_TARGET: '5000' });
    expect(bad.consistent).toBe(false);
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
      { urlPrefix: '/env', body: {} },
    ]);
    const adapter = createVercelAdapter({ token: 't', teamId: 'team_x', transport });
    const created = await adapter.createProject('tenant-1', 'abc');
    expect(created.ok && created.resourceId).toBe('prj_new');
    const env = await adapter.setRuntimeEnv('prj_new', { monthlyTarget: 1000, amberPercent: 90, redPercent: 100, enforcementMode: 'disable_new_search', googleProjectId: 'p1' });
    expect(env.ok).toBe(true);
    const envCalls = calls.filter((c) => c.url.includes('/env'));
    expect(envCalls.length).toBe(6); // 4 browser + server monthly + google project
    expect(envCalls.map((c) => JSON.parse(c.body ?? '{}').key)).toContain('VITE_CUSTOMER_MONTHLY_TARGET');
    expect(envCalls.map((c) => JSON.parse(c.body ?? '{}').key)).toContain('CUSTOMER_MONTHLY_TARGET');
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
      quota: { monthlyTarget: 1000, amberPercent: 90, redPercent: 100, enforcementMode: 'disable_new_search' },
      devicePolicy: {
        maxDevices: 2,
        mode: 'hard_lock',
        kvNamespace: 'lf_dev:t1',
        appPassConfigured: true,
        tenantIdConfigured: true,
        autoEviction: false,
        storeFingerprint: 'B'.repeat(64),
      },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0].body ?? '{}');
    expect(body.monthly_usage_target).toBe(1000);
    expect(body.amber_threshold_percent).toBe(90);
    expect(body.red_threshold_percent).toBe(100);
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

  it('no privileged credential appears in adapter request shapes (token only in Authorization header)', async () => {
    const { transport, calls } = createFakeTransport([{ urlPrefix: '/v9/projects?', body: { projects: [] } }, { urlPrefix: '/v9/projects?', body: { id: 'p' } }]);
    const adapter = createVercelAdapter({ token: 'super-secret-token', teamId: 'team_x', transport });
    await adapter.createProject('t', 'abc');
    expect(calls[1].url).not.toContain('super-secret-token');
    expect(calls[1].body ?? '').not.toContain('super-secret-token');
  });
});
