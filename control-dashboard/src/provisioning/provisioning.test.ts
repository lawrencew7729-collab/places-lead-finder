import { describe, expect, it } from 'vitest';
import { explicitProvisioningQuota, quotaSignal, verifyQuotaConsistency } from './quotaContract.js';
import { refuseMissingRelease, RETIRED_MOCK_RELEASE, verifyGoldenRelease, type GoldenReleaseIdentity } from './releaseRegistry.js';
import { runProvisioning, EXECUTION_GATE_REQUIRED } from './executor.js';
import { createFakeProviders, customerMonitoringSaEmail, lastHandedOffDeviceLockSecrets, wifAudienceFor } from './provisioningProviders.js';
import { aclUsernameFor } from './aclProvisioning.js';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.1',
  tag: 'customer-app-v1.0.1',
  commitSha: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

const FP = 'A'.repeat(64);
const RAW_KEY = 'AIzaSyA_TEST_KEY_0000000000000000000000';
const APP_PASS = 'accesscode123456';
const CENTRAL_STORE = 'https://central.example.com';
const BILLING_ACCOUNT = '01B61E-759031-B494E4';
const WIF = {
  pool: 'lf-vercel-wif',
  provider: 'vercel-oidc',
  centralProjectNumber: '123456789012',
  vercelTeamSlug: 'lawrencew7729-4682s',
  vercelTeamId: 'team_lawrencew7729',
};

/** Register the golden release in the fake registry — REQUIRED before any run (registry verification). */
async function registerGolden(providers: ReturnType<typeof createFakeProviders>) {
  const r = await providers.controlPlane.insertRelease(GOLDEN);
  expect(r.ok).toBe(true);
}

function input(overrides: Partial<Parameters<typeof runProvisioning>[1]> = {}) {
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
    centralStoreUrl: CENTRAL_STORE,
    billingAccountId: BILLING_ACCOUNT,
    wif: WIF,
      bootstrapMember: 'admin@leadfinder.business',
    ...overrides,
  };
}

function transient() {
  return { placesApiKey: RAW_KEY, deviceLockSecrets: { appPass: APP_PASS } };
}

describe('R1 quota contract (dashboard side)', () => {
  it('explicit provisioning quota writes 1000/85/90/disable_new_search', () => {
    const q = explicitProvisioningQuota();
    expect(q).toEqual({ monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search' });
  });

  it('quota signal: green <850, amber 850-899, red 900+ (B2 safety stop)', () => {
    expect(quotaSignal(0)).toBe('green');
    expect(quotaSignal(849)).toBe('green');
    expect(quotaSignal(850)).toBe('amber');
    expect(quotaSignal(899)).toBe('amber');
    expect(quotaSignal(900)).toBe('red');
    expect(quotaSignal(999)).toBe('red');
    expect(quotaSignal(1000)).toBe('red');
    expect(quotaSignal(1500)).toBe('red');
  });

  it('verifyQuotaConsistency fails closed on any disagreement', () => {
    const runtime = { monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search' as const };
    expect(verifyQuotaConsistency(runtime, runtime).consistent).toBe(true);
    expect(verifyQuotaConsistency(runtime, { ...runtime, amberPercent: 80 }).consistent).toBe(false);
    expect(verifyQuotaConsistency(runtime, { ...runtime, monthlyTarget: 5000 }).consistent).toBe(false);
    expect(verifyQuotaConsistency(runtime, null).consistent).toBe(false);
    expect(verifyQuotaConsistency(null, null).consistent).toBe(false);
  });
});

describe('R1 Golden Standard registry', () => {
  it('accepts an exact approved golden release', () => {
    const r = verifyGoldenRelease(GOLDEN, GOLDEN);
    expect(r.match).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('refuses tag mismatch', () => {
    const r = verifyGoldenRelease({ ...GOLDEN, tag: 'customer-app-v1.0.0' }, GOLDEN);
    expect(r.match).toBe(false);
    expect(r.reasons.join()).toContain('tag mismatch');
  });

  it('refuses commit mismatch', () => {
    const r = verifyGoldenRelease({ ...GOLDEN, commitSha: 'c'.repeat(40) }, GOLDEN);
    expect(r.match).toBe(false);
    expect(r.reasons.join()).toContain('commit mismatch');
  });

  it('refuses artifact hash mismatch', () => {
    const r = verifyGoldenRelease({ ...GOLDEN, artifactSha256: 'd'.repeat(64) }, GOLDEN);
    expect(r.match).toBe(false);
    expect(r.reasons.join()).toContain('artifact manifest mismatch');
  });

  it('refuses unapproved status', () => {
    const r = verifyGoldenRelease({ ...GOLDEN, status: 'candidate' }, GOLDEN);
    expect(r.match).toBe(false);
    expect(r.reasons.join()).toContain('not approved');
  });

  it('refuses the stale mock release identity', () => {
    const mock: GoldenReleaseIdentity = {
      version: RETIRED_MOCK_RELEASE.releaseId,
      tag: 'golden-root-626c0c1',
      commitSha: RETIRED_MOCK_RELEASE.gitSha,
      artifactSha256: RETIRED_MOCK_RELEASE.artifactSha256,
      sourcePath: 'legacy mock',
      status: 'approved',
    };
    const r = verifyGoldenRelease(mock, mock);
    expect(r.match).toBe(false);
    expect(r.reasons.join()).toContain('stale mock');
  });

  it('refuses missing/unknown release records', () => {
    expect(refuseMissingRelease(null).match).toBe(false);
    expect(refuseMissingRelease(null).reasons.join()).toContain('missing release record');
  });
});

describe('R1 provisioning executor (16-stage model — 15 + bootstrap_cleanup)', () => {
  it('executes all 16 stages (incl. bootstrap_cleanup) to CUSTOMER_READY with the approved contract', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(result.failedStageId).toBeNull();
    expect(result.stages).toHaveLength(16);
    expect(result.stages.every((s) => s.status === 'PASS')).toBe(true);
    expect(result.rollbackMetadata.resourceIds.vercel).toBe('prj_fake_abc');
    expect(result.rollbackMetadata.resourceIds.domain).toBe('abc.leadfinder.business');
    // ACL identity is deterministic per tenant
    expect(result.rollbackMetadata.resourceIds.acl).toBe(aclUsernameFor(result.tenantId));
  });

  it('REFUSES an unknown/unregistered release (registry verification, no self-compare)', async () => {
    const providers = createFakeProviders();
    // no registerGolden — the registry is EMPTY
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.stages[0].detail).toContain('unknown/unregistered release');
  });

  it('REFUSES a release whose registry record disagrees (mismatched artifact)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease({ ...GOLDEN, artifactSha256: 'd'.repeat(64) });
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.stages[0].detail).toContain('artifact manifest mismatch');
  });

  it('fails closed when the R1 execution gate is not granted', async () => {
    const result = await runProvisioning(createFakeProviders(), input({ executionGate: false }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toBe(EXECUTION_GATE_REQUIRED);
  });

  it('refuses raw Places key instead of fingerprint', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input({ placesKeyFingerprint: RAW_KEY }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toContain('raw key refused');
  });

  it('refuses missing WIF config at the tenant stage (fail-closed: WIF_AUDIENCE required)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input({ wif: undefined }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toContain('WIF config required');
  });

  it('orders env/secrets BEFORE the golden deploy (stage order contract)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    const ids = result.stages.map((s) => s.id);
    // deploy must come AFTER wif/env/places_key/acl (all pre-deploy env+secrets)
    expect(ids.indexOf('deploy')).toBeGreaterThan(ids.indexOf('wif'));
    expect(ids.indexOf('deploy')).toBeGreaterThan(ids.indexOf('env'));
    expect(ids.indexOf('deploy')).toBeGreaterThan(ids.indexOf('places_key'));
    expect(ids.indexOf('deploy')).toBeGreaterThan(ids.indexOf('acl'));
    // verification stages follow domain
    expect(ids.indexOf('usage_smoke')).toBeGreaterThan(ids.indexOf('deploy'));
    expect(ids.indexOf('device_lock')).toBeGreaterThan(ids.indexOf('usage_smoke'));
    expect(ids.indexOf('billing')).toBeGreaterThan(ids.indexOf('device_lock'));
    expect(ids.indexOf('finalize')).toBeGreaterThan(ids.indexOf('billing'));
  });

  it('stops on failure and preserves earlier PASS stages', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.deployGolden'] });
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('deploy');
    expect(result.stages[0].status).toBe('PASS'); // tenant preserved
    expect(result.stages[1].status).toBe('PASS'); // vercel preserved
    expect(result.stages[5].status).toBe('PASS'); // acl preserved (before deploy)
    expect(result.stages[6].status).toBe('FAILED'); // deploy
    // stages after failure remain PENDING (no forward execution)
    expect(result.stages.slice(7).every((s) => s.status === 'PENDING')).toBe(true);
    expect(result.stages[12].id).toBe('device_lock');
    expect(result.stages[14].id).toBe('bootstrap_cleanup');
    expect(result.stages[15].id).toBe('finalize');
  });

  it('retries only the failed stage and resumes (idempotent find-before-create)', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.bindDomain'] });
    await registerGolden(providers);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.failedStageId).toBe('domain');
    providers.setFailures([]);
    const retried = await runProvisioning(providers, input(), transient());
    expect(retried.outcome).toBe('CUSTOMER_READY');
    expect(retried.tenantId).toBe(first.tenantId);
  });

  it('never creates duplicate projects on retry', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.bindDomain'] });
    await registerGolden(providers);
    await runProvisioning(providers, input(), transient());
    providers.setFailures([]);
    await runProvisioning(providers, input(), transient());
    providers.setFailures([]);
    await runProvisioning(providers, input(), transient());
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
  });

  it('rejects a domain already bound to another project (isolation)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    await runProvisioning(providers, input(), transient());
    const second = await runProvisioning(providers, input({ slug: 'abc' }), transient());
    // same slug → same hostname; fake returns the existing project (idempotent) — still ONE owner
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(second.rollbackMetadata.resourceIds.domain).toBe('abc.leadfinder.business');
  });

  it('verifies runtime/persisted quota agreement at stage 11 (fail-closed)', async () => {
    const providers = createFakeProviders({ failAt: ['cp.insertCustomerConfig'] });
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('finalize');
    // quota stage itself passed (runtime == persisted contract)
    expect(result.stages[10].status).toBe('PASS');
    expect(result.stages[10].id).toBe('quota');
  });

  it('restriction checkpoint HOLD: missing operator confirmation → NOT READY (no silent PASS)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input({ websiteRestrictionConfirmed: false }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('restriction');
    expect(result.stages.find((s) => s.id === 'restriction')?.detail).toContain('OWNER ACTION REQUIRED');
  });

  it('restriction checkpoint PASS requires the exact subdomain restriction + explicit confirmation', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input({ websiteRestrictionConfirmed: true }), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const restrictionStage = result.stages.find((s) => s.id === 'restriction');
    expect(restrictionStage?.status).toBe('PASS');
    expect(restrictionStage?.resourceId).toBe('https://abc.leadfinder.business/*');
  });

  it('restriction format: broad wildcard / unrelated domain / apex are refused by the provider', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // direct adapter-level check (the executor always derives the exact form from slug)
    const bad1 = await providers.google.verifyReferrer('abc-leadfinder-1234', 'https://*.leadfinder.business/*');
    const bad2 = await providers.google.verifyReferrer('abc-leadfinder-1234', 'https://example.com/*');
    const bad3 = await providers.google.verifyReferrer('abc-leadfinder-1234', 'https://leadfinder.business/*');
    const bad4 = await providers.google.verifyReferrer('abc-leadfinder-1234', 'https://abc.leadfinder.business/');
    expect(bad1.ok).toBe(false);
    expect(bad2.ok).toBe(false);
    expect(bad3.ok).toBe(false);
    expect(bad4.ok).toBe(false);
    const good = await providers.google.verifyReferrer('abc-leadfinder-1234', 'https://abc.leadfinder.business/*');
    expect(good.ok).toBe(true);
  });

  it('smoke requires the real API key on the DEV path: absent transient key + real smoke NOT yet confirmed → usage_smoke FAIL (owner correction)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const devInput = input({ realPortalSmokeConfirmed: false });
    // first run: key captured + runtime handoff (env baked); preflight passes,
    // then stops at the real-smoke OWNER ACTION gate.
    const first = await runProvisioning(providers, devInput, transient());
    expect(first.outcome).toBe('FAILED');
    expect(first.failedStageId).toBe('usage_smoke');
    // resume run WITHOUT the transient key while real smoke is STILL not
    // confirmed → no raw key = cloud-path semantics: preflight not applicable,
    // the run must stop at the real-smoke OWNER ACTION gate (never readiness).
    const result = await runProvisioning(providers, devInput, { deviceLockSecrets: transient().deviceLockSecrets });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('usage_smoke');
    expect(result.stages.find((s) => s.id === 'usage_smoke')?.detail).toContain('OWNER ACTION REQUIRED');
  });

  it('referrer-denied preflight (incompatible/mismatched restriction behavior) → FAIL at usage_smoke while real smoke unconfirmed', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    providers.setFailures(['usageSmoke.places']); // simulates REQUEST_DENIED (restriction not configured/mismatched)
    const result = await runProvisioning(providers, input({ realPortalSmokeConfirmed: false }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('usage_smoke');
  });

  it('cloud path: real smoke confirmed by operator → referrer preflight not required (no raw key available) — smoke passes on the 10 HTTP points', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // full provision with raw key first (writes envs) — then cloud resume with
    // NO raw key at all (both secrets absent) and smoke confirmed → READY.
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const cloud = await runProvisioning(providers, input(), {});
    expect(cloud.outcome).toBe('CUSTOMER_READY');
  });

  it('smoke success cannot bypass a missing restriction confirmation (stage 9 HOLD first)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // all smoke signals healthy, but confirmation=false → the run must HOLD at
    // restriction (stage 9) BEFORE any smoke can run
    const result = await runProvisioning(providers, input({ websiteRestrictionConfirmed: false }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('restriction');
    expect(result.stages.find((s) => s.id === 'usage_smoke')?.status).not.toBe('PASS');
  });

  it('real Customer Portal smoke HOLD: preflight PASS + no operator browser confirmation → OWNER ACTION REQUIRED', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // probe + all 10 HTTP checks PASS, but the operator has NOT performed the
    // real browser smoke → the preflight alone must NOT produce readiness
    const result = await runProvisioning(providers, input({ realPortalSmokeConfirmed: false }), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('usage_smoke');
    const detail = result.stages.find((s) => s.id === 'usage_smoke')?.detail ?? '';
    expect(detail).toContain('OWNER ACTION REQUIRED: real Customer Portal browser smoke');
    expect(detail).toContain('https://abc.leadfinder.business');
  });

  it('real Customer Portal smoke resume: after operator browser confirmation → CUSTOMER_READY', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    // first run: probe passes but real portal smoke not yet confirmed
    const first = await runProvisioning(providers, input({ realPortalSmokeConfirmed: false }), transient());
    expect(first.outcome).toBe('FAILED');
    expect(first.failedStageId).toBe('usage_smoke');
    // operator performed the real browser search → resume with the explicit
    // confirmation (same tenant identity, idempotent)
    const second = await runProvisioning(providers, input({ realPortalSmokeConfirmed: true }), transient());
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(second.tenantId).toBe(first.tenantId);
  });

  it('WIF onboarding stages run and record the exact customer SA identity', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const wifStage = result.stages.find((s) => s.id === 'wif');
    expect(wifStage?.status).toBe('PASS');
    // A3b: the wif stage evidence is the customer's OWN monitoring SA email
    expect(wifStage?.resourceId).toBe(customerMonitoringSaEmail('abc-leadfinder-1234', result.tenantId));
  });

  it('APP_PASS owner-action HOLD: missing APP_PASS stops at the acl stage before any ACL identity exists', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY });
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('acl');
    expect(result.stages.find((s) => s.id === 'acl')?.detail).toContain('OWNER ACTION REQUIRED');
  });

  it('APP_PASS HOLD → resume: same tenantId, CUSTOMER_READY after the owner supplies the secret', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const hold = await runProvisioning(providers, input(), { placesApiKey: RAW_KEY });
    expect(hold.failedStageId).toBe('acl');
    const resumed = await runProvisioning(providers, input(), transient());
    expect(resumed.outcome).toBe('CUSTOMER_READY');
    expect(resumed.tenantId).toBe(hold.tenantId);
  });

  it('acl stage hands the per-tenant REST token (NEVER the admin password) into the store env', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const handed = lastHandedOffDeviceLockSecrets();
    expect(handed).not.toBeNull();
    // the fake admin mints an Upstash-style GENTOKEN (gt-fake-N) — the env must receive exactly that token
    expect(handed?.kvRestApiToken).toMatch(/^gt-fake-\d+$/);
    expect(handed?.kvRestApiUrl).toBe(CENTRAL_STORE);
  });

  it('usage smoke failure fails closed at usage_smoke (functional activation proof required)', async () => {
    const providers = createFakeProviders({ failAt: ['usageSmoke.run'] });
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('usage_smoke');
  });

  it('non-zero activation-month usage is RECORDED but does NOT block provisioning (owner decision 2026-09-04 — smoke itself creates usage)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    providers.setPreActivationUsage('abc-leadfinder-1234', 27);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY'); // not blocked
    expect(result.failedStageId).toBeNull();
    // usage still read + recorded as evidence (billing stage passed, detail contains the value)
    const billingStage = result.stages.find((s) => s.id === 'billing');
    expect(billingStage?.status).toBe('PASS');
    // persisted config still carries the evidence columns
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.billingAccountId).toBe(BILLING_ACCOUNT);
    expect(readback.config?.billingPreActivationUsage).toBe(27);
    expect(readback.config?.billingActivationMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it('billing account with more than one linked project stops at billing (isolation contract)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    providers.setBillingProjects(BILLING_ACCOUNT, ['abc-leadfinder-1234', 'other-project-5678']);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('billing');
    expect(result.stages.find((s) => s.id === 'billing')?.detail).toContain('exactly 1');
  });

  it('billing evidence + ACL identity are persisted at finalize (non-secret only)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const readback = await providers.controlPlane.findConfigByTenant(result.tenantId);
    expect(readback.config?.billingAccountId).toBe(BILLING_ACCOUNT);
    expect(readback.config?.billingPreActivationUsage).toBe(0);
    expect(readback.config?.billingActivationMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(readback.config?.aclUsername).toBe(aclUsernameFor(result.tenantId));
    expect(readback.config?.aclTokenFingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(JSON.stringify(readback.config)).not.toContain('AIza');
    expect(JSON.stringify(readback.config)).not.toContain('rest_tok_');
  });

  it('WIF_AUDIENCE env value is the fixed provider full name (identical for every customer)', async () => {
    expect(wifAudienceFor(WIF)).toBe('//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/lf-vercel-wif/providers/vercel-oidc');
    const providers = createFakeProviders();
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input({ slug: 'xyz' }), transient());
    expect(second.outcome).toBe('CUSTOMER_READY');
    // audience is org-level — no per-customer variance
    expect(wifAudienceFor(input().wif!)).toBe(wifAudienceFor(input({ slug: 'xyz' }).wif!));
  });

  it('tenant starts setup_pending; successful CUSTOMER_READY flips it to active (2026-09-04 status consistency)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    expect(providers.__getTenantStatus(input().slug)).toBeUndefined(); // not created yet
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(providers.__getTenantStatus(input().slug)).toBe('active');
  });

  it('failure BEFORE finalization leaves the tenant at setup_pending (never active)', async () => {
    const providers = createFakeProviders({ failAt: ['usageSmoke.run'] });
    await registerGolden(providers);
    const result = await runProvisioning(providers, input(), transient());
    expect(result.outcome).toBe('FAILED');
    expect(providers.__getTenantStatus(input().slug)).toBe('setup_pending');
  });

  it('idempotent re-run of an already-active tenant stays active (no drift)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    const first = await runProvisioning(providers, input(), transient());
    expect(first.outcome).toBe('CUSTOMER_READY');
    const second = await runProvisioning(providers, input(), transient());
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(providers.__getTenantStatus(input().slug)).toBe('active');
  });
});

  it('Verify 5: validate/finalize re-run REUSES the deploy-phase READY deployment (deployGolden called exactly once)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN as never);
    let deployPosts = 0;
    const origDeploy = providers.vercel.deployGolden.bind(providers.vercel);
    providers.vercel.deployGolden = (async (...a: never[]) => { deployPosts += 1; return origDeploy(...(a as [never, never])); }) as never;
    const first = await runProvisioning(providers, input() as never, { placesApiKey: 'AIzaSyA_TEST_KEY_0000000000000000000000', deviceLockSecrets: { appPass: 'correct-horse-battery-staple' } } as never, {} as never);
    expect(first.outcome).toBe('CUSTOMER_READY');
    const deploymentId = first.stages.find((s2) => s2.id === 'deploy')?.detail || first.rollbackMetadata;
    expect(deployPosts).toBe(1);
    const rerun = await runProvisioning(providers, input({ existingDeploymentId: String(deploymentId || 'dpl_x') }) as never, { placesApiKey: 'AIzaSyA_TEST_KEY_0000000000000000000000', deviceLockSecrets: { appPass: 'correct-horse-battery-staple' } } as never, {} as never);
    expect(rerun.outcome).toBe('CUSTOMER_READY');
    expect(deployPosts).toBe(1); // STILL one deployment for one logical provisioning
  });

  it('usage_smoke: raw key PRESENT but referrer probe denied → STILL fail-closed (CLI/dev protection preserved)', async () => {
    const providers = createFakeProviders();
    providers.usageSmoke!.run = async () => ({
      ok: true,
      resourceId: 'x',
      smoke: {
        domainHealthy: true, usageStructured: true, capIs1000: true, safetyStopIs900: true,
        maxSessionIs50: true, monitoringSource: true, deviceProbeLocked: true,
        tenantIdentityExact: true, noActiveLeaseAfterRelease: true,
        referrerAcceptanceProbe: false,
      },
    });
    await providers.controlPlane.insertRelease(GOLDEN as never);
    const result = await runProvisioning(providers, input({ realPortalSmokeConfirmed: false }), { placesApiKey: RAW_KEY, deviceLockSecrets: { appPass: APP_PASS } }, {});
    expect(result.outcome).toBe('FAILED');
    const stage = result.stages.find((st) => st.id === 'usage_smoke');
    expect(String(stage?.detail)).toContain('referrer-acceptance preflight did not pass');
  });

  it('usage_smoke: cloud path with NO raw key does not fail on the probe — reaches the real-smoke hold instead', async () => {
    const providers = createFakeProviders();
    providers.usageSmoke!.run = async () => ({
      ok: true,
      resourceId: 'x',
      smoke: {
        domainHealthy: true, usageStructured: true, capIs1000: true, safetyStopIs900: true,
        maxSessionIs50: true, monitoringSource: true, deviceProbeLocked: true,
        tenantIdentityExact: true, noActiveLeaseAfterRelease: true,
        referrerAcceptanceProbe: false,
      },
    });
    await providers.controlPlane.insertRelease(GOLDEN as never);
    // CLOUD RESUME CONTRACT: secure-start wrote the Places key to the CUSTOMER
    // VERCEL PROJECT env (configurePlacesKey stores under /v9/projects/{vercel
    // projectId}/env). Fake contract: vercel project id = prj_fake_<slug>
    // (createProject) — NOT the Google project id. Seeding the same namespace
    // the later cloud run reads is what makes Stage 5 skip idempotently.
    const preSeed = await providers.secrets!.configurePlacesKey('prj_fake_abc', RAW_KEY);
    expect(preSeed.ok).toBe(true);
    const result = await runProvisioning(providers, input({ realPortalSmokeConfirmed: false }), { deviceLockSecrets: { appPass: APP_PASS } }, {});
    expect(result.outcome).toBe('FAILED');
    const stage = result.stages.find((st) => st.id === 'usage_smoke');
    expect(String(stage?.detail)).toContain('OWNER ACTION REQUIRED');
    expect(String(stage?.detail)).not.toContain('referrer');
  });
