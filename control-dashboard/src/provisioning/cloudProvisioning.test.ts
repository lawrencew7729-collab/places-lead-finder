/**
 * Phase 2C Segment 1 — cloud provisioning foundation tests.
 * Proves the secure start/bootstrap contract:
 *   - raw secrets NEVER enter the workflow payload / audit / errors
 *   - workflow does NOT start when env bootstrap fails
 *   - tenant + Vercel project are created/reused BEFORE env write (idempotent)
 *   - bounded executor run (stopBefore:'deploy') does not execute deploy
 *   - cloud path works when required env already exists (raw absent)
 *   - cloud path FAILS CLOSED when raw AND env are both absent
 *   - CLI/raw-secret executor path still works
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { secureStartProvisioning, fingerprintPlacesKey, type CloudStartInput } from './cloudProvisioning.js';
import { runProvisioning } from './executor.js';
import { createFakeProviders } from './provisioningProviders.js';
import type { GoldenReleaseIdentity } from './releaseRegistry.js';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.10',
  tag: 'customer-app-v1.0.10',
  commitSha: '9f924c9a91eb36ee7f8d0aa7d8571852e0c025bd',
  artifactSha256: 'a9e0a48c4117311f99431adafcb47c57fc5c2307a62db49bc35a58651e11a981',
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

const KEY = 'AIzaSyA_TEST_KEY_0000000000000000000000';
const APP_PASS = 'correct-horse-battery-staple';
const FP = 'A'.repeat(64);
const STARTER_CALLS: Array<Record<string, unknown>> = [];

function fakeStarter() {
  return {
    async start(payload: Record<string, unknown>) {
      STARTER_CALLS.push(payload);
      return { ok: true, runId: 'wf-run-1' };
    },
  };
}

function startInput(over: Partial<CloudStartInput> = {}): CloudStartInput {
  return {
    companyName: 'Cloud Test Co',
    slug: 'cloudco',
    googleProjectId: 'cloudco-507999',
    websiteRestrictionConfirmed: true,
    placesApiKey: KEY,
    appPass: APP_PASS,
    operatorUserId: '451473db-d1d0-4f04-b0ff-63e6897ff567',
    centralStoreUrl: 'https://central.example.upstash.io',
    goldenRelease: GOLDEN,
    ...over,
  };
}

async function registerGolden(providers: ReturnType<typeof createFakeProviders>) {
  const r = await providers.controlPlane.insertRelease(GOLDEN);
  expect(r.ok).toBe(true);
}

function runInput() {
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
    bootstrapMember: 'admin@leadfinder.business',
    wif: { pool: 'lf-vercel-wif', provider: 'vercel-oidc', centralProjectNumber: '123456789012', vercelTeamSlug: 'lawrencew7729-4682s', vercelTeamId: 'team_lawrencew7729' },
  };
}

function runTransient(over: { appPass?: string | null; placesApiKey?: string | null } = {}) {
  // null = explicitly omit that secret (cloud-path simulation)
  const appPass = over.appPass === undefined ? APP_PASS : over.appPass;
  const placesKey = over.placesApiKey === undefined ? KEY : over.placesApiKey;
  return {
    ...(placesKey ? { placesApiKey: placesKey } : {}),
    ...(appPass ? { deviceLockSecrets: { appPass } } : {}),
  };
}

beforeEach(() => (STARTER_CALLS.length = 0));

describe('secureStartProvisioning (Phase 2C Segment 1)', () => {
  it('workflow payload contains NO raw Places key / APP_PASS (identifiers only)', async () => {
    const providers = createFakeProviders();
    const res = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(res.ok).toBe(true);
    expect(res.workflowRunId).toBe('wf-run-1');
    expect(STARTER_CALLS.length).toBe(1);
    const serialized = JSON.stringify(STARTER_CALLS[0]);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(APP_PASS);
    expect(serialized).toContain('tenantId');
    expect(serialized).toContain('projectId');
  });

  it('workflow does NOT start when the Places key env write fails', async () => {
    const providers = createFakeProviders({ failAt: ['secrets.configurePlacesKey'] });
    const res = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).not.toContain(KEY); // raw key never in error text
    expect(STARTER_CALLS.length).toBe(0);
  });

  it('workflow does NOT start when the APP_PASS env write fails', async () => {
    const providers = createFakeProviders({ failAt: ['secrets.configureAppPass'] });
    const res = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(res.ok).toBe(false);
    expect(STARTER_CALLS.length).toBe(0);
  });

  it('tenant + Vercel project created BEFORE env write; duplicate start reuses both (no duplicates)', async () => {
    const providers = createFakeProviders();
    const first = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(first.ok).toBe(true);
    expect(first.tenantId).toBeTruthy();
    const second = await secureStartProvisioning(startInput({ recoveryTenantId: first.tenantId }), providers, fakeStarter() as never);
    expect(second.ok).toBe(true);
    expect(second.tenantId).toBe(first.tenantId); // same tenant reused
    expect(second.projectId).toBe(first.projectId); // same Vercel project reused
    expect(STARTER_CALLS.length).toBe(2);
  });

  it('raw secret is NOT persisted to audit/evidence (fingerprint only)', async () => {
    const providers = createFakeProviders();
    const res = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(res.ok).toBe(true);
    const audits = providers.__audits();
    expect(audits.length).toBeGreaterThan(0);
    const all = JSON.stringify(audits);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(APP_PASS);
    expect(all).toContain(fingerprintPlacesKey(KEY)); // non-secret fingerprint IS recorded
  });

  it('validation: restriction must be confirmed before PROVISION', async () => {
    const providers = createFakeProviders();
    const res = await secureStartProvisioning(startInput({ websiteRestrictionConfirmed: false }), providers, fakeStarter() as never);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('restriction must be confirmed');
    expect(STARTER_CALLS.length).toBe(0);
  });

  it('validation: weak APP_PASS rejected before any external call', async () => {
    const providers = createFakeProviders();
    const res = await secureStartProvisioning(startInput({ appPass: '1234' }), providers, fakeStarter() as never);
    expect(res.ok).toBe(false);
    expect(STARTER_CALLS.length).toBe(0);
  });

  it('setup_pending recovery with matching tenant identity and existing APP_PASS needs no new raw code', async () => {
    const providers = createFakeProviders();
    const first = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(first.ok).toBe(true);
    const retry = await secureStartProvisioning(
      startInput({ appPass: undefined, recoveryTenantId: first.tenantId }),
      providers,
      fakeStarter() as never,
    );
    expect(retry.ok).toBe(true);
    expect(retry.appPassState).toBe('retained');
  });

  it('setup_pending recovery with matching tenant identity but no APP_PASS fails OWNER ACTION REQUIRED', async () => {
    const providers = createFakeProviders();
    const tenant = await providers.controlPlane.insertTenant({
      companyName: 'Cloud Test Co', slug: 'cloudco', hostname: 'cloudco.leadfinder.business',
      googleProjectId: 'cloudco-507999', keyFingerprint: fingerprintPlacesKey(KEY),
    });
    expect(tenant.ok).toBe(true);
    if (!('resourceId' in tenant) || !tenant.resourceId) throw new Error('tenant setup failed');
    const tenantId = tenant.resourceId;
    const res = await secureStartProvisioning(
      startInput({ appPass: undefined, recoveryTenantId: tenantId }),
      providers,
      fakeStarter() as never,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('OWNER ACTION REQUIRED');
    expect(STARTER_CALLS).toHaveLength(0);
  });

  it('successful APP_PASS handoff with missing appPassState fails safe instead of defaulting to created', async () => {
    const providers = createFakeProviders();
    providers.secrets!.configureAppPass = (async () => ({ ok: true, resourceId: 'project-with-unknown-pass-state' })) as never;
    const res = await secureStartProvisioning(startInput(), providers, fakeStarter() as never);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('APP_PASS handoff contract error');
    expect(STARTER_CALLS).toHaveLength(0);
  });

  it('setup_pending slug without matching recovery tenant identity fails closed', async () => {
    const providers = createFakeProviders();
    const tenant = await providers.controlPlane.insertTenant({
      companyName: 'Original Co', slug: 'cloudco', hostname: 'cloudco.leadfinder.business',
      googleProjectId: 'cloudco-507999', keyFingerprint: fingerprintPlacesKey(KEY),
    });
    expect(tenant.ok).toBe(true);
    if (!('resourceId' in tenant) || !tenant.resourceId) throw new Error('tenant setup failed');
    const tenantId = tenant.resourceId;
    const missing = await secureStartProvisioning(startInput({ recoveryTenantId: undefined }), providers, fakeStarter() as never);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('recovery identity required');
    const mismatch = await secureStartProvisioning(startInput({ recoveryTenantId: `${tenantId}-wrong` }), providers, fakeStarter() as never);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain('recovery identity mismatch');
    expect(STARTER_CALLS).toHaveLength(0);
  });

  it('slug collision FAILS CLOSED before secret env mutation: existing provisioned tenant A + incoming google project B', async () => {
    const providers = createFakeProviders();
    // Tenant A fully provisioned (config persisted with google project A).
    await registerGolden(providers);
    const runA = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(runA.outcome).toBe('CUSTOMER_READY');
    // Incoming request: SAME slug 'abc' but a DIFFERENT google project → refuse.
    const res = await secureStartProvisioning(
      startInput({ slug: 'abc', companyName: 'Different Co', googleProjectId: 'OTHER-PROJECT-999' }),
      providers,
      fakeStarter() as never,
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('slug collision');
    expect(STARTER_CALLS.length).toBe(0); // workflow never started
    // no secret env mutation happened for the incoming identity
    const audit = JSON.stringify(providers.__audits());
    expect(audit).not.toContain('OTHER-PROJECT-999');
  });

  it('slug reuse ALLOWED when the google project matches the existing provisioned tenant (retry path)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const runA = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(runA.outcome).toBe('CUSTOMER_READY');
    const res = await secureStartProvisioning(
      startInput({ slug: 'abc', companyName: 'ABC Trading Sdn Bhd', googleProjectId: 'abc-leadfinder-1234' }),
      providers,
      fakeStarter() as never,
    );
    expect(res.ok).toBe(true);
    expect(STARTER_CALLS.length).toBe(1);
  });

  it('operational config-read FAILURE refuses to continue (never silently skips the collision check — S2e Fix 2)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const runA = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(runA.outcome).toBe('CUSTOMER_READY');
    providers.__failNext('cp.findConfigByTenant');
    const res = await secureStartProvisioning(
      startInput({ slug: 'abc', companyName: 'Different Co', googleProjectId: 'OTHER-PROJECT-999' }),
      providers,
      fakeStarter() as never,
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('slug collision check failed');
    expect(STARTER_CALLS.length).toBe(0); // workflow never started
  });
});

describe('bounded executor run (stopBefore) + secret-optional cloud path', () => {
  it('stopBefore:deploy stops after acl and never marks deploy PASS', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, runInput(), runTransient(), { stopBefore: 'deploy' });
    expect(result.outcome).toBe('PAUSED');
    expect(result.stages.find((s) => s.id === 'tenant')?.status).toBe('PASS');
    expect(result.stages.find((s) => s.id === 'acl')?.status).toBe('PASS');
    expect(result.stages.find((s) => s.id === 'deploy')?.status).not.toBe('PASS');
    expect(result.stages.find((s) => s.id === 'finalize')?.status).not.toBe('PASS');
  });

  it('CLI/raw-secret path still works end-to-end (raw appPass + key supplied)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(result.outcome).toBe('CUSTOMER_READY');
  });

  it('cloud path works when required env ALREADY exists and raw APP_PASS is absent', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const first = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, runInput(), runTransient({ appPass: null }), {});
    expect(second.outcome).toBe('CUSTOMER_READY'); // env-exists idempotent resume — raw not required
  });

  it('cloud path FAILS CLOSED when raw is absent AND env is absent', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, runInput(), runTransient({ appPass: null }), {});
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
    expect(result.stages.find((s) => s.id === 'acl')?.detail).toContain('OWNER ACTION REQUIRED');
  });

  it('BOTH raw secrets absent + BOTH required encrypted env values already exist → cloud executor proceeds idempotently', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // First run writes both secrets into the customer env (places_key + acl/APP_PASS).
    const first = await runProvisioning(providers, runInput(), runTransient(), {});
    expect(first.outcome).toBe('CUSTOMER_READY');
    // Second run: NO raw Places key AND NO raw APP_PASS — env-exists resume must
    // reach CUSTOMER_READY (workflow never needs either raw secret).
    const second = await runProvisioning(providers, runInput(), runTransient({ placesApiKey: null, appPass: null }), {});
    expect(second.outcome).toBe('CUSTOMER_READY');
  });

  it('raw Places key absent AND Places env absent → FAIL CLOSED at places_key', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, runInput(), runTransient({ placesApiKey: null, appPass: null }), {});
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('places_key');
    expect(result.stages.find((s) => s.id === 'places_key')?.detail).toContain('OWNER ACTION REQUIRED');
  });
});
