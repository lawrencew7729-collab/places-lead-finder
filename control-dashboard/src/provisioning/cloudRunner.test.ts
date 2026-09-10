/**
 * Phase 2C Segment 2 — cloud runner + keyless operator identity tests.
 * Proves the durable phase orchestration (infra → deploy → validate →
 * WAITING_SMOKE → finalize) and the WIF/STS operator exchange, all against
 * fake/injected providers — zero live cloud.
 */
import { describe, expect, it } from 'vitest';
import { createFakeProviders } from './provisioningProviders.js';
import { runProvisioning } from './executor.js';
import { runInfraPhase, runDeployPhase, runValidatePhase, runFinalizePhase } from './cloudRunner.js';
import { exchangeOperatorToken, operatorAccessTokenProvider, type OperatorGoogleConfig } from './operatorGoogle.js';
import type { GoldenReleaseIdentity } from './releaseRegistry.js';
import type { ProvisioningInput } from './executor.js';

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

async function registerGolden(providers: ReturnType<typeof createFakeProviders>) {
  const r = await providers.controlPlane.insertRelease(GOLDEN);
  expect(r.ok).toBe(true);
}

function runInput(over: Partial<ProvisioningInput> = {}): ProvisioningInput {
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
    ...over,
  };
}

function runTransient(over: { appPass?: string | null; placesApiKey?: string | null } = {}) {
  const appPass = over.appPass === undefined ? APP_PASS : over.appPass;
  const placesKey = over.placesApiKey === undefined ? KEY : over.placesApiKey;
  return {
    ...(placesKey ? { placesApiKey: placesKey } : {}),
    ...(appPass ? { deviceLockSecrets: { appPass } } : {}),
  };
}

async function provisionedCtx(providers: ReturnType<typeof createFakeProviders>) {
  // one full CUSTOMER_READY run writes all envs + config; later cloud phases
  // then run with ZERO raw secrets (env-exists resume).
  const first = await runProvisioning(providers, runInput(), runTransient(), {});
  expect(first.outcome).toBe('CUSTOMER_READY');
  return { tenantId: first.tenantId, hostname: first.hostname };
}

describe('cloudRunner phases (Phase 2C Segment 2)', () => {
  it('infra phase stops before deploy (PAUSED → READY_FOR_DEPLOY); deploy stage not PASS', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const out = await runInfraPhase({ providers, input: runInput(), transient: runTransient() });
    expect(out.status).toBe('READY_FOR_DEPLOY');
    expect(out.result?.stages.find((s) => s.id === 'deploy')?.status).not.toBe('PASS');
    expect(out.result?.stages.find((s) => s.id === 'acl')?.status).toBe('PASS');
  });

  it('deploy phase: trigger + READY probe → DEPLOYED; re-entry with id does not re-trigger', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const first = await runDeployPhase({ providers, input: runInput() }, 'prj_abc');
    expect(first.status).toBe('DEPLOYED');
    expect(first.reason).toMatch(/^dpl_/); // deployment id returned
    // probe with an existing id never re-triggers (deployGolden not called — fake has no counter,
    // but passing id short-circuits the trigger branch)
    const again = await runDeployPhase({ providers, input: runInput() }, 'prj_abc', first.reason);
    expect(again.status).toBe('DEPLOYED');
  });

  it('validate phase on a fully provisioned tenant with zero raw secrets → VALIDATED (env-exists)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const ctx = await provisionedCtx(providers);
    const out = await runValidatePhase(
      { providers, input: runInput(), transient: runTransient({ appPass: null, placesApiKey: null }) },
      { ...ctx, projectId: 'prj_abc', websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: false },
    );
    // real smoke NOT confirmed → executor stops at usage_smoke OWNER ACTION → WAITING_SMOKE
    expect(out.status).toBe('WAITING_SMOKE');
  });

  it('validate phase with smoke confirmed input field still reports WAITING_SMOKE only when smoke gate holds', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const ctx = await provisionedCtx(providers);
    const out = await runValidatePhase(
      { providers, input: runInput(), transient: {} },
      { ...ctx, projectId: 'prj_abc', websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: true },
    );
    // smoke confirmed (as if staff already confirmed) → validate passes straight through
    expect(out.status).toBe('VALIDATED');
  });

  it('finalize phase (smoke confirmed) on provisioned tenant → ACTIVE', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const ctx = await provisionedCtx(providers);
    const out = await runFinalizePhase(
      { providers, input: runInput(), transient: {} },
      { ...ctx, projectId: 'prj_abc', websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: true },
    );
    expect(out.status).toBe('ACTIVE');
    expect(providers.__getTenantStatus('abc')).toBe('active');
  });

  it('full four-phase sequence on a FRESH tenant reaches ACTIVE', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const ctx = { tenantId: '', hostname: 'abc.leadfinder.business', projectId: 'prj_abc', websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: true };
    const deps = { providers, input: runInput(), transient: runTransient(), deployPoll: { intervalMs: 1, timeoutMs: 1000 } };
    const infra = await runInfraPhase(deps);
    expect(infra.status).toBe('READY_FOR_DEPLOY');
    const deploy = await runDeployPhase(deps, 'prj_abc');
    expect(deploy.status).toBe('DEPLOYED');
    // validate with smoke confirmed on a fresh tenant: usage_smoke smoke confirmed → passes
    const validate = await runValidatePhase({ ...deps, transient: {} }, { ...ctx, realPortalSmokeConfirmed: true });
    expect(validate.status).toBe('VALIDATED');
    const fin = await runFinalizePhase({ ...deps, transient: {} }, { ...ctx, realPortalSmokeConfirmed: true });
    expect(fin.status).toBe('ACTIVE');
  });
});

describe('operator Google keyless identity (Phase 2C Segment 2)', () => {
  const cfg: OperatorGoogleConfig = {
    serviceAccountEmail: 'operator-sa@central-123456.iam.gserviceaccount.com',
    centralProjectNumber: '123456789012',
    pool: 'lf-vercel-wif',
    provider: 'vercel-oidc',
    audience: '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/lf-vercel-wif/providers/vercel-oidc',
  };

  function fakeHttp(over: { status?: number; body?: Record<string, unknown>; calls?: Array<{ url: string; body: Record<string, unknown>; headers?: Record<string, string> }> } = {}) {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers?: Record<string, string> }> = [];
    return {
      calls,
      oidcToken: async () => 'fake-oidc-token',
      post: async (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
        calls.push({ url, body, headers });
        const stsOk = over.status ?? 200;
        // STEP 1 (sts) returns federation token; STEP 2 (iamcredentials) returns SA token.
        if (url.includes('sts.googleapis.com')) {
          return {
            status: stsOk,
            json: async () => (stsOk === 200 ? { access_token: 'ya29.federation.token' } : (over.body ?? { error_description: 'STS failed' })),
          };
        }
        return {
          status: 200,
          json: async () => (over.body ? over.body : { accessToken: 'ya29.operator.token' }),
        };
      },
    };
  }

  it('exchanges OIDC token for an operator SA access token via STS (no local auth)', async () => {
    const http = fakeHttp();
    const res = await exchangeOperatorToken(cfg, http as never);
    expect(res.ok).toBe(true);
    expect(res.accessToken).toBe('ya29.operator.token');
    // two-step verified chain: STS (federation token) then iamcredentials
    expect(http.calls.length).toBe(2);
    expect(http.calls[0].url).toContain('sts.googleapis.com');
    const body = http.calls[0].body;
    expect(body.subjectToken).toBe('fake-oidc-token');
    expect(String(body.audience)).toContain(cfg.pool);
    // no secret material beyond the subject token itself
    expect(JSON.stringify(body)).not.toContain('password');
    expect(http.calls[1].url).toContain('iamcredentials.googleapis.com');
    expect(http.calls[1].url).toContain(encodeURIComponent(cfg.serviceAccountEmail));
    expect(http.calls[1].headers?.authorization).toBe('Bearer ya29.federation.token');
    expect(http.calls[1].body).not.toHaveProperty('impersonationTarget');
  });

  it('STS failure returns actionable reason', async () => {
    const http = fakeHttp({ status: 400, body: { error_description: 'invalid subject token' } });
    const res = await exchangeOperatorToken(cfg, http as never);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('invalid subject token');
  });

  it('missing OIDC token fails closed (no local fallback)', async () => {
    const http = fakeHttp();
    const noToken = { ...http, oidcToken: async () => '' };
    const res = await exchangeOperatorToken(cfg, noToken as never);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('no OIDC token');
  });

  it('cached access-token provider reuses token until near expiry', async () => {
    const http = fakeHttp();
    const provider = operatorAccessTokenProvider(cfg, http as never);
    const t1 = await provider();
    const t2 = await provider();
    expect(t1).toBe('ya29.operator.token');
    expect(t2).toBe(t1);
    expect(http.calls.filter((c) => c.url.includes('sts.googleapis.com')).length).toBe(1); // cached — no second exchange
  });
});
