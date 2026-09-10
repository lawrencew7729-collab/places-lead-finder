/**
 * Phase 2C Segment 2c — HTTP route/framework boundary tests.
 * Exercises handleStart/Confirm/Status with REAL Request objects through the
 * same logic the api/provisioning/* glue binds — fakes for providers + the
 * platform workflow start/resume.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { exportJWK, generateKeyPair } from 'jose';
import { handleStartRequest, handleConfirmRequest, handleStatusRequest, type HttpDeps } from '../../api/lib/provisioningHttp.js';
import { createFakeProviders } from '../../src/provisioning/provisioningProviders.js';
import type { GoldenReleaseIdentity } from '../../src/provisioning/releaseRegistry.js';
import { runProvisioning } from '../../src/provisioning/executor.js';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.10',
  tag: 'customer-app-v1.0.10',
  commitSha: '9f924c9a91eb36ee7f8d0aa7d8571852e0c025bd',
  artifactSha256: 'a9e0a48c4117311f99431adafcb47c57fc5c2307a62db49bc35a58651e11a981',
  sourcePath: 'repo root (Vite)',
  status: 'approved',
  approvedAt: '2026-09-03T00:00:00Z',
};
const SUPABASE_URL = 'https://x.supabase.co';
const STAFF_SUB = '451473db-d1d0-4f04-b0ff-63e6897ff567';
let ES_KEY: { publicKey: CryptoKey; privateKey: CryptoKey };
const KEY = 'AIzaSyA_TEST_KEY_0000000000000000000000';
const APP_PASS = 'correct-horse-battery-staple';
const ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE: 'sb-test',
  CENTRAL_STORE_URL: 'https://central.example.com',
  WIF_CENTRAL_PROJECT_NUMBER: '123456789012',
  WIF_VERCEL_TEAM_SLUG: 'lawrencew7729-4682s',
  VERCEL_TEAM_ID: 'team_t',
};

async function staffJwt(over: { sub?: string; role?: string; exp?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: over.role ?? 'authenticated', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
    .setSubject(over.sub ?? STAFF_SUB)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setIssuedAt(now)
    .setExpirationTime(over.exp ?? now + 3600)
    .sign(ES_KEY.privateKey);
}

async function jsonRequest(url: string, body: unknown, token?: string | Promise<string>): Promise<Request> {
  const t = token instanceof Promise ? await token : token;
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
}

const workflowCalls: Array<{ kind: string; tenantId?: string; confirmedBy?: string }> = [];

function deps(providers = createFakeProviders()): HttpDeps {
  providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
  return {
    supabaseUrl: SUPABASE_URL,
    providers,
    workflowStart: async (args) => {
      workflowCalls.push({ kind: 'start', tenantId: args.ctx.tenantId });
      return { ok: true, runId: `wf-run-${args.ctx.tenantId.slice(0, 8)}` };
    },
    workflowResumeSmoke: async (tenantId, payload) => {
      workflowCalls.push({ kind: 'confirm', tenantId, confirmedBy: payload.confirmedBy });
      return { ok: true };
    },
    portalProbe: async () => ({ ok: true, ready: true }),
    registry: { latestApproved: async () => ({ tag: GOLDEN.tag }) },
    env: ENV,
  };
}

import type { ProvisioningProviders } from '../../src/provisioning/provisioningProviders.js';
async function registerGolden(providers: ProvisioningProviders) {
  const r = await providers.controlPlane.insertRelease(GOLDEN);
  expect(r.ok).toBe(true);
}
function auditsOf(providers: ProvisioningProviders): Array<{ tenantId: string; action: string; detail: string }> {
  return (providers as unknown as { __audits(): Array<{ tenantId: string; action: string; detail: string }> }).__audits();
}

beforeAll(async () => {
  ES_KEY = await generateKeyPair('ES256');
});

beforeEach(() => {
  workflowCalls.length = 0;
  const jwksUrl = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === jwksUrl) {
      const jwk = await exportJWK(ES_KEY.publicKey);
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-kid', alg: 'ES256', use: 'sig' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
});

describe('provisioning HTTP boundary (Phase 2C Segment 2c)', () => {
  it('unauthenticated START is rejected (401)', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', { slug: 'x' }), d);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.reason)).toContain('unauthenticated');
    expect(workflowCalls.length).toBe(0);
  });

  it('invalid/expired session token rejected (401)', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const bad = staffJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', { slug: 'x' }, bad), d);
    expect(res.status).toBe(401);
  });

  it('authenticated START launches the workflow with server-derived identity (browser spoof ignored)', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await handleStartRequest(
      await jsonRequest(
        'https://dash/api/provisioning/start',
        {
          companyName: 'Http Co',
          slug: 'httpco',
          googleProjectId: 'httpco-7788',
          websiteRestrictionConfirmed: true,
          placesApiKey: KEY,
          appPass: APP_PASS,
          operatorUserId: '00000000-0000-0000-0000-0000000000e1', // browser spoof — ignored
          goldenTag: 'customer-app-v0.0.1-evil', // browser spoof — ignored
        },
        staffJwt(),
      ),
      d,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('running');
    expect(typeof body.runId).toBe('string');
    expect(body.tenantId).toBeTruthy();
    // spoofed identity never appears anywhere
    const audits = JSON.stringify(auditsOf(d.providers));
    expect(audits).not.toContain('00000000-0000-0000-0000-0000000000e1');
    expect(audits).not.toContain('v0.0.1-evil');
    expect(workflowCalls.length).toBe(1);
    expect(workflowCalls[0].kind).toBe('start');
  });

  it('missing restriction confirmation fails before workflow start', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await handleStartRequest(
      await jsonRequest('https://dash/api/provisioning/start', { companyName: 'X', slug: 'x', googleProjectId: 'x-1', placesApiKey: KEY, appPass: APP_PASS }, staffJwt()),
      d,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.reason)).toContain('restriction');
    expect(workflowCalls.length).toBe(0);
  });

  it('CONFIRM requires an authenticated staff session', async () => {
    const d = deps();
    const res = await handleConfirmRequest(await jsonRequest('https://dash/api/provisioning/confirm', { tenantId: '11111111-1111-1111-1111-111111111111' }), d);
    expect(res.status).toBe(401);
    expect(workflowCalls.length).toBe(0);
  });

  it('CONFIRM for an unknown tenant fails closed (no resume)', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await handleConfirmRequest(await jsonRequest('https://dash/api/provisioning/confirm', { tenantId: '11111111-1111-1111-1111-111111111111' }, staffJwt()), d);
    expect(res.status).toBe(403);
    expect(workflowCalls.length).toBe(0);
  });

  it('CONFIRM (COMPLETE ONBOARDING / PLAN B) directly activates the current setup_pending tenant (no Workflow action)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Confirm Co', slug: 'confirmco', hostname: 'confirmco.leadfinder.business',
      googleProjectId: 'confirmco-1', keyFingerprint: '4'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug('confirmco');
    const d = deps(providers);
    const res = await handleConfirmRequest(await jsonRequest('https://dash/api/provisioning/confirm', { tenantId: tenant.tenantId }, staffJwt()), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body).toMatchObject({ ok: true, status: 'active' });
    // authoritative flip visible server-side
    const after = await providers.controlPlane.findTenantBySlug('confirmco');
    expect(after.tenantStatus).toBe('active');
    // NO hook resume — manual completion is the authority
    expect(workflowCalls.length).toBe(0);
  });

  it('production glue semantics: deps WITHOUT env reads raw process.env exactly once (no double-parse of ProvisionServerEnv)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    // raw env on process.env (what the platform injects); deps.env OMITTED —
    // exactly like the production glue after the double-parse correction.
    const prev = { ...process.env };
    Object.assign(process.env, ENV);
    try {
      const d: HttpDeps = {
        supabaseUrl: SUPABASE_URL,
        providers,
        workflowStart: async () => ({ ok: true, runId: 'wf-raw-env' }),
        workflowResumeSmoke: async () => ({ ok: true }),
        registry: { latestApproved: async () => ({ tag: GOLDEN.tag }) },
        // NOTE: env deliberately absent — handler falls back to process.env
      };
      const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', { companyName: 'Raw Env Co', slug: 'rawenv', googleProjectId: 'rawenv-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS }, await staffJwt()), d);
      // must NOT throw 'missing required server env' and must reach the workflow start
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; runId?: string; reason?: string };
      expect(body.ok).toBe(true);
      expect(body.runId).toBe('wf-raw-env');
    } finally {
      for (const k of Object.keys(ENV)) delete process.env[k];
      Object.assign(process.env, prev);
    }
  });

  it('STATUS requires auth; returns safe business state with no secrets', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    await runProvisioning(providers, {
      companyName: 'ABC Trading Sdn Bhd', slug: 'abc', googleProjectId: 'abc-leadfinder-1234',
      placesKeyFingerprint: 'A'.repeat(64), goldenRelease: GOLDEN, executionGate: true, centralStore: true,
      websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: true, centralStoreUrl: 'https://central.example.com',
      bootstrapMember: 'admin@leadfinder.business',
      wif: { pool: 'lf-vercel-wif', provider: 'vercel-oidc', centralProjectNumber: '123456789012', vercelTeamSlug: 'lawrencew7729-4682s', vercelTeamId: 'team_lawrencew7729' },
    }, { placesApiKey: KEY, deviceLockSecrets: { appPass: APP_PASS } });

    const d = deps(providers);
    const anon = await handleStatusRequest(new Request('https://dash/api/provisioning/status?slug=abc'), d);
    expect(anon.status).toBe(401);
    const token = await staffJwt();
    const res = await handleStatusRequest(new Request('https://dash/api/provisioning/status?slug=abc', { headers: { authorization: `Bearer ${token}` } }), d);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(APP_PASS);
    expect(serialized).not.toContain('supabase-jwt-secret');
  });

  it('terminal COMPLETED reserved run → status failed/restartable (HttpDeps workflowRunStatus wiring)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Term Co', slug: 'termco', hostname: 'termco.leadfinder.business',
      googleProjectId: 'termco-1', keyFingerprint: 'F'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug('termco');
    await providers.controlPlane.reserveProvisioningStart(tenant.tenantId!, 'reservation-term');
    await providers.controlPlane.linkProvisioningRun(tenant.tenantId!, 'reservation-term', 'run-term');
    const d = deps(providers);
    d.workflowSmokeReady = async () => 'not_ready';
    d.workflowRunStatus = async () => 'completed';
    const token = await staffJwt();
    const res = await handleStatusRequest(new Request('https://dash/api/provisioning/status?slug=termco', { headers: { authorization: `Bearer ${token}` } }), d);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true });
  });

  it('run status UNKNOWN → fail closed (provisioning, never restartable)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Unk Co', slug: 'unkco', hostname: 'unkco.leadfinder.business',
      googleProjectId: 'unkco-1', keyFingerprint: '1'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug('unkco');
    await providers.controlPlane.reserveProvisioningStart(tenant.tenantId!, 'reservation-unk');
    await providers.controlPlane.linkProvisioningRun(tenant.tenantId!, 'reservation-unk', 'run-unk');
    const d = deps(providers);
    d.workflowSmokeReady = async () => 'not_ready';
    d.workflowRunStatus = async () => 'unknown';
    const token = await staffJwt();
    const res = await handleStatusRequest(new Request('https://dash/api/provisioning/status?slug=unkco', { headers: { authorization: `Bearer ${token}` } }), d);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'provisioning' });
    expect(body.restartable).not.toBe(true);
  });

  it('spoofed browser goldenTag can never reach the workflow args (registry is authoritative)', async () => {
    const d = deps();
    await registerGolden(d.providers);
    // Registry holds only v1.0.10 — a spoofed tag in the body must not matter;
    // the start result still references the workflow run (registry release used).
    const res = await handleStartRequest(
      await jsonRequest('https://dash/api/provisioning/start', {
        companyName: 'Spoof Co', slug: 'spoofco', googleProjectId: 'spoofco-1',
        websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
        goldenTag: 'customer-app-v9.9.9', operatorUserId: 'evil-user-id',
      }, staffJwt()),
      d,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(workflowCalls.length).toBe(1);
  });
});

describe('duplicate workflow run protection (S2e pre-E2E)', () => {
  async function startOnce(d: HttpDeps, recoveryTenantId?: string): Promise<Response> {
    return handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'Dup Co', slug: 'dupco', googleProjectId: 'dupco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS, recoveryTenantId,
    }, await staffJwt()), d);
  }

  it('live/in-progress previous run → second PROVISION refused (no Workflow B)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    d.workflowRunStatus = async () => 'pending';
    const first = await startOnce(d);
    expect(first.status).toBe(200);
    const firstBody = (await first.clone().json()) as { tenantId?: string };
    expect(firstBody.tenantId).toBeTruthy();
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(1);
    const second = await startOnce(d, firstBody.tenantId);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { ok?: boolean; duplicatePrevented?: boolean };
    expect(body.ok).toBe(false);
    expect(body.duplicatePrevented).toBe(true);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(1); // STILL one
  });

  it('previous run provably dead (failed) → retry allowed (Workflow starts again)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    d.workflowRunStatus = async () => 'failed';
    const first = await startOnce(d);
    const firstBody = (await first.json()) as { tenantId?: string };
    await startOnce(d, firstBody.tenantId);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(2);
  });

  it('previous run cancelled (Vercel two-L spelling) → retry allowed (2026-09-09 fix)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    d.workflowRunStatus = async () => 'cancelled';
    const first = await startOnce(d);
    const firstBody = (await first.json()) as { tenantId?: string };
    const retry = await startOnce(d, firstBody.tenantId);
    expect(retry.status).toBe(200);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(2);
  });

  it('workflow start records the run linkage in the audit (WORKFLOW_STARTED:<runId>)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    await startOnce(d);
    const audits = providers.__audits();
    expect(audits.some((a) => a.action.startsWith('WORKFLOW_STARTED:'))).toBe(true);
  });
});

  it('reservation read/DB failure → FAIL CLOSED (503, no workflow start)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    providers.__failNext('cp.reserveProvisioningStart');
    const d = deps(providers);
    d.workflowRunStatus = async () => 'unknown';
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'FailCo', slug: 'failco', googleProjectId: 'failco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(res.status).toBe(503);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(0);
  });

  it('prior run status UNKNOWN (platform/network error) → refused (never Workflow B)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    d.workflowRunStatus = async () => 'unknown';
    const first = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'UnkCo', slug: 'unkco', googleProjectId: 'unkco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    const firstBody = (await first.json()) as { tenantId?: string };
    // second identical request — previous run is recorded but status unknown
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'UnkCo', slug: 'unkco', googleProjectId: 'unkco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS, recoveryTenantId: firstBody.tenantId,
    }, await staffJwt()), d);
    expect(res.status).toBe(409);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(1);
  });

  it('Verify 4: createProviders factory receives the AUTHENTICATED session operator (attribution)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    const seen: string[] = [];
    d.createProviders = async (operatorUserId) => {
      seen.push(operatorUserId);
      const p2 = createFakeProviders();
      p2.__seedOperatorProfile(STAFF_SUB, 'admin', true);
      await p2.controlPlane.insertRelease(GOLDEN);
      return p2;
    };
    await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'AttrCo', slug: 'attrco', googleProjectId: 'attrco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(seen).toEqual([STAFF_SUB]); // authenticated operator — never a static env id
  });

  it('CONCURRENT identical START requests → workflowStart called EXACTLY once (atomic reservation)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    d.workflowRunStatus = async () => 'unknown';
    const mkReq = () =>
      jsonRequest('https://dash/api/provisioning/start', {
        companyName: 'RaceCo', slug: 'raceco', googleProjectId: 'raceco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
      }, staffJwt());
    const [a, b] = await Promise.all([handleStartRequest(await mkReq(), d), handleStartRequest(await mkReq(), d)]);
    const statuses = [a.status, b.status].sort();
    const starts = workflowCalls.filter((c) => c.kind === 'start').length;
    expect(starts).toBe(1); // exactly ONE workflow — the loser refused without calling start()
    expect(statuses).toEqual([200, 400]); // one winner + one fail-closed request without recovery identity
  });

describe('S2e ACTIVE-guard ordering (guard precedes ANY provisioning mutation)', () => {
  async function makeActiveTenant(providers: ReturnType<typeof createFakeProviders>, slug: string, projectId: string) {
    const created = await providers.controlPlane.insertTenant({
      companyName: 'ActiveCo', slug, hostname: slug + '.leadfinder.business', googleProjectId: projectId, keyFingerprint: 'A'.repeat(64),
    } as never);
    const tenantId = created.resourceId!;
    await providers.controlPlane.updateTenantStatus(tenantId, 'active');
    await providers.controlPlane.insertCustomerConfig({
      tenantId, googleProjectId: projectId, keyFingerprint: 'A'.repeat(64), websiteRestrictionExact: 'https://' + slug + '.leadfinder.business/*',
      monitoringMode: 'usage', quota: { monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'shared' },
      devicePolicy: { maxDevices: 2, mode: 'hard_lock', kvNamespace: 'ns', storeFingerprint: 'F'.repeat(64), appPassConfigured: true, autoEviction: false },
      billingAccountId: null, billingActivationMonth: null, billingPreActivationUsage: 0,
    } as never);
    return tenantId;
  }

  it('ACTIVE same-project tenant returns alreadyActive with NO mutation behind it', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    await makeActiveTenant(providers, 'activeco', 'activeco-1');
    const audits = providers as never as { __audits(): Array<{ action: string }> };
    const auditsBefore = audits.__audits().filter((a) => a.action === 'CUSTOMER_ONBOARDING_STARTED').length;
    let reserveCalls = 0;
    const origReserve = providers.controlPlane.reserveProvisioningStart.bind(providers.controlPlane);
    providers.controlPlane.reserveProvisioningStart = (async (tid: string, tok: string) => { reserveCalls += 1; return origReserve(tid, tok); }) as never;
    const d = deps(providers);
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'ActiveCo', slug: 'activeco', googleProjectId: 'activeco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyActive?: boolean; status?: string };
    expect(body.alreadyActive).toBe(true);
    expect(body.status).toBe('active');
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(0);
    expect(reserveCalls).toBe(0);
    const auditsAfter = audits.__audits().filter((a) => a.action === 'CUSTOMER_ONBOARDING_STARTED').length;
    expect(auditsAfter).toBe(auditsBefore);
  });

  it('ACTIVE slug with CONFLICTING google project FAILS CLOSED (409, never misleading alreadyActive)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    await makeActiveTenant(providers, 'activeco', 'activeco-1');
    const d = deps(providers);
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'ActiveCo', slug: 'activeco', googleProjectId: 'OTHER-PROJECT-9', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(res.status).toBe(409);
    expect(workflowCalls.filter((c) => c.kind === 'start').length).toBe(0);
  });
});

describe('Access Code appPassState contract (retry/recovery)', () => {
  it('first provisioning returns appPassState created (code adopted)', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    const res = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'First Co', slug: 'firstco', googleProjectId: 'firstco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appPassState?: string };
    expect(body.appPassState).toBe('created');
  });

  it('retry with APP_PASS already in the customer env needs no new raw code and returns retained', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    const d = deps(providers);
    // first start adopts the code
    const first = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'Retry Co', slug: 'retryco', googleProjectId: 'retryco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { tenantId: string };
    // second start (retry) — prior run provably dead → retry allowed without
    // generating or submitting a replacement-looking code.
    d.workflowRunStatus = async () => 'failed';
    const retry = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'Retry Co', slug: 'retryco', googleProjectId: 'retryco-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, recoveryTenantId: firstBody.tenantId,
    }, await staffJwt()), d);
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { appPassState?: string };
    expect(body.appPassState).toBe('retained');
    // fake configureAppPass is idempotent (never overwrites) — 'retained' is
    // only returned when the ORIGINAL APP_PASS is still in the customer env.
  });

  it('setup_pending retry without matching authoritative recovery tenant id fails closed', async () => {
    const providers = createFakeProviders();
    providers.__seedOperatorProfile(STAFF_SUB, 'admin', true);
    await providers.controlPlane.insertRelease(GOLDEN);
    await providers.controlPlane.insertTenant({
      companyName: 'Original Co', slug: 'pendingco', hostname: 'pendingco.leadfinder.business',
      googleProjectId: 'pendingco-1', keyFingerprint: 'A'.repeat(64),
    });
    const d = deps(providers);
    const missing = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'Other Co', slug: 'pendingco', googleProjectId: 'other-project-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS,
    }, await staffJwt()), d);
    expect(missing.status).toBe(400);
    expect(String((await missing.json()).reason)).toContain('recovery identity required');
    const mismatch = await handleStartRequest(await jsonRequest('https://dash/api/provisioning/start', {
      companyName: 'Other Co', slug: 'pendingco', googleProjectId: 'other-project-1', websiteRestrictionConfirmed: true, placesApiKey: KEY, appPass: APP_PASS, recoveryTenantId: 'wrong-tenant-id',
    }, await staffJwt()), d);
    expect(mismatch.status).toBe(400);
    expect(String((await mismatch.json()).reason)).toContain('recovery identity mismatch');
    expect(workflowCalls).toHaveLength(0);
  });
});
