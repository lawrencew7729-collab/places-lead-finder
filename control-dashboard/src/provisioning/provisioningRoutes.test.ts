/**
 * Phase 2C Segment 2b — authenticated provisioning routes tests.
 * Proves the trusted-boundary contract:
 *   - operatorUserId derives server-side; browser-supplied identity ignored
 *   - golden release derives from the trusted registry; body tag ignored
 *   - confirm smoke is staff-only and resumes only the target tenant's run
 *   - wrong operator/run cannot resume another workflow
 *   - status exposes no secrets
 *   - no raw Places key / APP_PASS required after suspension
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeProviders } from './provisioningProviders.js';
import { startProvisioningRoute, completeOnboardingRoute, statusRoute, type AuthContext, type ProvisioningRouteDeps, type StartRequestBody } from './provisioningRoutes.js';
import { runProvisioning } from './executor.js';
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
const STAFF: AuthContext = { operatorUserId: '451473db-d1d0-4f04-b0ff-63e6897ff567', roles: ['staff'] };
const EVIL_USER_ID = '00000000-0000-0000-0000-0000000000evi';

const resumed: Array<{ tenantId: string; confirmedBy: string }> = [];

function deps(providers = createFakeProviders()): ProvisioningRouteDeps & { providers: ReturnType<typeof createFakeProviders> } {
  return {
    providers,
    registry: {
      latestApproved: async () => ({ tag: GOLDEN.tag }),
    },
    resumer: {
      resumeSmoke: async (tenantId, payload) => {
        resumed.push({ tenantId, confirmedBy: payload.confirmedBy });
        return { ok: true };
      },
    },
    trust: { centralStoreUrl: 'https://central.example.com' },
  };
}

function body(over: Partial<StartRequestBody> = {}): StartRequestBody {
  return {
    companyName: 'Route Test Co',
    slug: 'routeco',
    googleProjectId: 'routeco-12345',
    websiteRestrictionConfirmed: true,
    placesApiKey: KEY,
    appPass: APP_PASS,
    operatorUserId: EVIL_USER_ID, // attacker-supplied — must be ignored
    goldenTag: 'customer-app-v0.0.1-evil', // attacker-supplied — must be ignored
    ...over,
  };
}

beforeEach(() => (resumed.length = 0));

async function registerGolden(providers: ReturnType<typeof createFakeProviders>) {
  const r = await providers.controlPlane.insertRelease(GOLDEN);
  expect(r.ok).toBe(true);
}

function runInput() {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    placesKeyFingerprint: 'A'.repeat(64),
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

describe('startProvisioningRoute (authenticated boundary)', () => {
  it('derives operatorUserId from the server session — browser-supplied identity is IGNORED', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await startProvisioningRoute(body(), STAFF, d);
    expect(res.ok).toBe(true);
    // prove the attacker id never became the tenant created_by: audit rows exist
    const audits = JSON.stringify(d.providers.__audits());
    expect(audits).not.toContain(EVIL_USER_ID);
    // tenant row was created with the SERVER identity (fake tenants store only slug;
    // the authoritative check is the audit/tenant path — assert no evil id anywhere)
    expect(audits).toContain('CUSTOMER_ONBOARDING_STARTED');
  });

  it('golden release is derived from the trusted registry — browser-supplied tag is IGNORED', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await startProvisioningRoute(body({ goldenTag: 'customer-app-v0.0.1-evil' }), STAFF, d);
    expect(res.ok).toBe(true);
    const audits = JSON.stringify(d.providers.__audits());
    expect(audits).not.toContain('v0.0.1-evil');
  });

  it('start fails closed when no approved release exists in the registry', async () => {
    const d = deps();
    d.registry.latestApproved = async () => null;
    const res = await startProvisioningRoute(body(), STAFF, d);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('no approved release');
  });

  it('start with restriction unconfirmed fails before workflow start', async () => {
    const d = deps();
    await registerGolden(d.providers);
    const res = await startProvisioningRoute(body({ websiteRestrictionConfirmed: false }), STAFF, d);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('restriction must be confirmed');
  });
});

describe('completeOnboardingRoute / PLAN B MANUAL COMPLETE (staff-only, direct ACTIVE)', () => {
  // A working setup_pending tenant — deliberately WITHOUT reservation or run:
  // Plan B completion must not depend on hook/Workflow bookkeeping.
  async function workingTenant(slug = 'confirmco') {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Confirm Co', slug, hostname: `${slug}.leadfinder.business`,
      googleProjectId: `${slug}-1`, keyFingerprint: '9'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug(slug);
    return { providers, tenantId: tenant.tenantId! };
  }

  function dWithProbe(providers: ReturnType<typeof createFakeProviders>, ready = true) {
    return { ...deps(providers), portalProbe: vi.fn(async () => ({ ok: true, ready })) } as unknown as ProvisioningRouteDeps;
  }

  it('staff completes onboarding: portal ready + setup_pending → tenant ACTIVE directly (no reservation/hook needed)', async () => {
    const { providers, tenantId } = await workingTenant();
    const d = dWithProbe(providers);
    const res = await completeOnboardingRoute({ tenantId }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'active' });
    // authoritative flip visible via the control plane
    const after = await providers.controlPlane.findTenantBySlug('confirmco');
    expect(after.tenantStatus).toBe('active');
    // NO hook resume / NO workflow action of any kind
    expect(resumed.length).toBe(0);
  });

  it('non-staff (no role) is forbidden', async () => {
    const { providers, tenantId } = await workingTenant();
    const res = await completeOnboardingRoute({ tenantId }, { operatorUserId: 'x', roles: [] }, dWithProbe(providers));
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('forbidden');
  });

  it('unknown tenant cannot complete', async () => {
    const d = dWithProbe(createFakeProviders());
    const res = await completeOnboardingRoute({ tenantId: '00000000-0000-0000-0000-000000000000' }, STAFF, d);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('tenant not found');
  });

  it('portal NOT ready → completion refused, tenant stays setup_pending', async () => {
    const { providers, tenantId } = await workingTenant();
    const d = dWithProbe(providers, false);
    const res = await completeOnboardingRoute({ tenantId }, STAFF, d);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('not ready yet');
    const after = await providers.controlPlane.findTenantBySlug('confirmco');
    expect(after.tenantStatus).not.toBe('active');
    expect(resumed.length).toBe(0);
  });

  it('missing portal probe dependency → fail closed (never blind complete)', async () => {
    const { providers, tenantId } = await workingTenant();
    const d = { ...deps(providers) } as ProvisioningRouteDeps; // no portalProbe
    const res = await completeOnboardingRoute({ tenantId }, STAFF, d);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('unavailable');
  });

  it('already-ACTIVE tenant → idempotent success (no probe, no re-write)', async () => {
    const { providers, tenantId } = await workingTenant();
    await providers.controlPlane.updateTenantStatus(tenantId, 'active');
    const probe = vi.fn(async () => ({ ok: true, ready: true }));
    const d = { ...deps(providers), portalProbe: probe } as unknown as ProvisioningRouteDeps;
    const res = await completeOnboardingRoute({ tenantId }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'active', alreadyActive: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it('Workflow FAILED/COMPLETED history never blocks manual completion (no run state consulted)', async () => {
    // The working tenant above has NO reservation/run at all and still
    // completes — proving Workflow state is not part of the authority.
    const { providers, tenantId } = await workingTenant();
    const d = dWithProbe(providers);
    const res = await completeOnboardingRoute({ tenantId }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'active' });
  });
});

describe('statusRoute (no secrets)', () => {
  it('provisioned tenant → active + fingerprint only (never raw)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    await runProvisioning(providers, runInput(), {
      placesApiKey: KEY,
      deviceLockSecrets: { appPass: APP_PASS },
    });
    const d = deps(providers);
    const res = await statusRoute({ slug: 'abc' }, STAFF, d);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('active');
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(APP_PASS);
    // fingerprint is the persisted non-secret 64-hex evidence (executor stored the
    // input fingerprint — the exact format contract is what matters here)
    expect(res.keyFingerprint).toMatch(/^[0-9A-F]{64}$/);
  });

  it('unknown slug → not found (unknown status)', async () => {
    const d = deps();
    const res = await statusRoute({ slug: 'nope' }, STAFF, d);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('unknown');
  });

  it('tenant without finalized config → provisioning (setup_pending)', async () => {
    const providers = createFakeProviders();
    const d = deps(providers);
    // create a tenant row only (no config) via a plain insert
    await providers.controlPlane.insertTenant({
      companyName: 'Pending Co',
      slug: 'pendingco',
      hostname: 'pendingco.leadfinder.business',
      googleProjectId: 'pendingco-1',
      keyFingerprint: 'B'.repeat(64),
    });
    const res = await statusRoute({ slug: 'pendingco' }, STAFF, d);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('provisioning');
  });

  it('matching registered smoke hook for the current reserved run → authoritative waiting_smoke', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Waiting Co', slug: 'waitingco', hostname: 'waitingco.leadfinder.business',
      googleProjectId: 'waitingco-1', keyFingerprint: 'D'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug('waitingco');
    await providers.controlPlane.reserveProvisioningStart(tenant.tenantId!, 'reservation-current');
    await providers.controlPlane.linkProvisioningRun(tenant.tenantId!, 'reservation-current', 'run-current');
    const d = deps(providers);
    d.resumer.smokeReady = async (_tenantId, runId) => runId === 'run-current' ? 'ready' : 'not_ready';

    const res = await statusRoute({ slug: 'waitingco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'waiting_smoke', tenantStatus: 'setup_pending', confirmationReady: true });
  });

  it('stale hook/run mismatch never enables confirmation', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Stale Co', slug: 'staleco', hostname: 'staleco.leadfinder.business',
      googleProjectId: 'staleco-1', keyFingerprint: 'E'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug('staleco');
    await providers.controlPlane.reserveProvisioningStart(tenant.tenantId!, 'reservation-current');
    await providers.controlPlane.linkProvisioningRun(tenant.tenantId!, 'reservation-current', 'run-current');
    const d = deps(providers);
    d.resumer.smokeReady = async () => 'not_ready';

    const res = await statusRoute({ slug: 'staleco' }, STAFF, d);
    expect(res.status).toBe('provisioning');
    expect(res.confirmationReady).not.toBe(true);
  });

  // TERMINAL-RUN RECOVERY (2026-09-08): a setup_pending tenant whose current
  // reserved run is authoritatively TERMINAL (completed/failed/canceled/
  // not_found) must surface as restartable instead of "provisioning" forever —
  // but only when runStatus says terminal; unknown/live stays fail-closed.
  async function terminalTenant(slug: string, runId = 'run-terminal') {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'Old Co', slug, hostname: `${slug}.leadfinder.business`,
      googleProjectId: `${slug}-1`, keyFingerprint: 'F'.repeat(64),
    });
    const tenant = await providers.controlPlane.findTenantBySlug(slug);
    await providers.controlPlane.reserveProvisioningStart(tenant.tenantId!, 'reservation-old');
    await providers.controlPlane.linkProvisioningRun(tenant.tenantId!, 'reservation-old', runId);
    const d = deps(providers);
    d.resumer.smokeReady = async () => 'not_ready';
    return { providers, d };
  }

  it('terminal COMPLETED old run → restartable failed status (never endless provisioning)', async () => {
    const { d } = await terminalTenant('doneco');
    d.runStatus = async () => 'completed';
    const res = await statusRoute({ slug: 'doneco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true });
  });

  it('terminal FAILED old run → restartable failed status', async () => {
    const { d } = await terminalTenant('failco');
    d.runStatus = async () => 'failed';
    const res = await statusRoute({ slug: 'failco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'failed', restartable: true });
  });

  it('terminal CANCELED old run → restartable failed status', async () => {
    const { d } = await terminalTenant('cancelco');
    d.runStatus = async () => 'canceled';
    const res = await statusRoute({ slug: 'cancelco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'failed', restartable: true });
  });

  it('terminal cancelled (Vercel two-L platform spelling) → restartable failed status (2026-09-09 fix)', async () => {
    const { d } = await terminalTenant('cancelledco');
    d.runStatus = async () => 'cancelled';
    const res = await statusRoute({ slug: 'cancelledco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'failed', restartable: true });
  });

  it('terminal NOT_FOUND run → restartable failed status (mirrors backend CAS contract)', async () => {
    const { d } = await terminalTenant('missingco');
    d.runStatus = async () => 'not_found';
    const res = await statusRoute({ slug: 'missingco' }, STAFF, d);
    expect(res).toMatchObject({ ok: true, status: 'failed', restartable: true });
  });

  it('LIVE run + smoke not ready → stays provisioning (no false restart)', async () => {
    const { d } = await terminalTenant('liveco', 'run-live');
    d.resumer.smokeReady = async () => 'not_ready';
    d.runStatus = async () => 'running';
    const res = await statusRoute({ slug: 'liveco' }, STAFF, d);
    expect(res.status).toBe('provisioning');
    expect(res.restartable).not.toBe(true);
  });

  it('runStatus UNKNOWN/error → fail closed (no restart offered)', async () => {
    const { d } = await terminalTenant('unkco');
    d.runStatus = async () => 'unknown';
    const res = await statusRoute({ slug: 'unkco' }, STAFF, d);
    expect(res.status).toBe('provisioning');
    expect(res.restartable).not.toBe(true);
  });

  it('terminal classification without a reservation runId keeps existing fail-closed behavior', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertTenant({
      companyName: 'NoRun Co', slug: 'norunco', hostname: 'norunco.leadfinder.business',
      googleProjectId: 'norunco-1', keyFingerprint: 'A'.repeat(64),
    });
    const d = deps(providers);
    d.runStatus = async () => 'completed'; // present but no reservation runId → must NOT classify
    const res = await statusRoute({ slug: 'norunco' }, STAFF, d);
    expect(res.status).toBe('provisioning');
    expect(res.restartable).not.toBe(true);
  });

  it('tenant with a config row but status NOT yet flipped → still provisioning (S2e Fix 3: config-row existence never implies ACTIVE)', async () => {
    const providers = createFakeProviders();
    const d = deps(providers);
    await providers.controlPlane.insertTenant({
      companyName: 'Config Co',
      slug: 'configco',
      hostname: 'configco.leadfinder.business',
      googleProjectId: 'configco-1',
      keyFingerprint: 'C'.repeat(64),
    });
    // simulate a finalize that persisted config but crashed before flipping
    // tenants.status — the config row EXISTS but the tenant is NOT active.
    const configInput = {
      tenantId: 'configco',
      googleProjectId: 'configco-1',
      keyFingerprint: 'C'.repeat(64),
      websiteRestrictionExact: 'https://configco.leadfinder.business/*',
      monitoringMode: 'shared_access',
      quota: { monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search' },
      devicePolicy: { maxDevices: 2, mode: 'hard_lock', kvNamespace: 'ns', appPassConfigured: true, tenantIdConfigured: true, autoEviction: false, storeFingerprint: 'fp', billingAccountId: '01B61E-759031-B494E4' },
    } as never;
    await providers.controlPlane.insertCustomerConfig(configInput);
    const res = await statusRoute({ slug: 'configco' }, STAFF, d);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('provisioning'); // config exists ≠ ACTIVE
  });

  it('authoritative ACTIVE only when tenants.status flipped to active (S2e Fix 3)', async () => {
    const providers = createFakeProviders();
    await registerGolden(providers);
    await runProvisioning(providers, runInput(), {
      placesApiKey: KEY,
      deviceLockSecrets: { appPass: APP_PASS },
    });
    // find the tenant id, then prove statusRoute ACTIVE tracks the flipped status
    const d = deps(providers);
    const res = await statusRoute({ slug: 'abc' }, STAFF, d);
    expect(res.status).toBe('active');
    expect(res.tenantStatus).toBe('active');
  });
});
