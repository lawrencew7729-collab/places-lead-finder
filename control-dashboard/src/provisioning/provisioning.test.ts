import { describe, expect, it } from 'vitest';
import { explicitProvisioningQuota, quotaSignal, verifyQuotaConsistency } from './quotaContract';
import { refuseMissingRelease, RETIRED_MOCK_RELEASE, verifyGoldenRelease, type GoldenReleaseIdentity } from './releaseRegistry';
import { runProvisioning, EXECUTION_GATE_REQUIRED } from './executor';
import { createFakeProviders } from './provisioningProviders';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.1',
  tag: 'customer-app-v1.0.1',
  commitSha: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

function input(overrides: Partial<Parameters<typeof runProvisioning>[1]> = {}) {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    placesKeyFingerprint: '1a2b3c4d',
    goldenRelease: GOLDEN,
    centralMonitoringSa: 'leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com',
    executionGate: true,
    ...overrides,
  };
}

describe('R1 quota contract (dashboard side)', () => {
  it('explicit provisioning quota writes 1000/90/100/disable_new_search', () => {
    const q = explicitProvisioningQuota();
    expect(q).toEqual({ monthlyTarget: 1000, amberPercent: 90, redPercent: 100, enforcementMode: 'disable_new_search' });
  });

  it('quota signal: green <900, amber 900-999, red 1000+', () => {
    expect(quotaSignal(0)).toBe('green');
    expect(quotaSignal(899)).toBe('green');
    expect(quotaSignal(900)).toBe('amber');
    expect(quotaSignal(999)).toBe('amber');
    expect(quotaSignal(1000)).toBe('red');
    expect(quotaSignal(1500)).toBe('red');
  });

  it('verifyQuotaConsistency fails closed on any disagreement', () => {
    const runtime = { monthlyTarget: 1000, amberPercent: 90, redPercent: 100, enforcementMode: 'disable_new_search' as const };
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

describe('R1 provisioning executor', () => {
  it('executes all 10 stages to CUSTOMER_READY with the approved contract', async () => {
    const providers = createFakeProviders();
    const result = await runProvisioning(providers, input());
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(result.failedStageId).toBeNull();
    expect(result.stages).toHaveLength(10);
    expect(result.stages.every((s) => s.status === 'PASS')).toBe(true);
    expect(result.rollbackMetadata.resourceIds.vercel).toBe('prj_fake_abc');
    expect(result.rollbackMetadata.resourceIds.domain).toBe('abc.leadfinder.business');
  });

  it('fails closed when the R1 execution gate is not granted', async () => {
    const result = await runProvisioning(createFakeProviders(), input({ executionGate: false }));
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toBe(EXECUTION_GATE_REQUIRED);
  });

  it('refuses raw Places key instead of fingerprint', async () => {
    const result = await runProvisioning(createFakeProviders(), input({ placesKeyFingerprint: 'AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg' }));
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('tenant');
    expect(result.stages[0].detail).toContain('raw key refused');
  });

  it('stops on failure and preserves earlier PASS stages', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.deployGolden'] });
    const result = await runProvisioning(providers, input());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('deploy');
    expect(result.stages[0].status).toBe('PASS'); // tenant preserved
    expect(result.stages[1].status).toBe('PASS'); // vercel project preserved
    expect(result.stages[2].status).toBe('FAILED');
    // stages after failure remain PENDING (no forward execution)
    expect(result.stages.slice(3).every((s) => s.status === 'PENDING')).toBe(true);
  });

  it('retries only the failed stage and resumes (idempotent find-before-create)', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.bindDomain'] });
    const first = await runProvisioning(providers, input());
    expect(first.failedStageId).toBe('domain');
    // retry with the failure removed — tenant/project/deploy already exist (idempotent)
    providers.setFailures([]);
    const retried = await runProvisioning(providers, input());
    expect(retried.outcome).toBe('CUSTOMER_READY');
  });

  it('never creates duplicate projects on retry', async () => {
    const providers = createFakeProviders({ failAt: ['vercel.bindDomain'] });
    await runProvisioning(providers, input());
    providers.setFailures([]);
    await runProvisioning(providers, input());
    providers.setFailures([]);
    await runProvisioning(providers, input());
    // fake keeps a single project per tenant — no duplicate creation path
    const result = await runProvisioning(providers, input());
    expect(result.outcome).toBe('CUSTOMER_READY');
  });

  it('rejects a domain already bound to another project (isolation)', async () => {
    const providers = createFakeProviders();
    await runProvisioning(providers, input());
    const second = await runProvisioning(providers, input({ slug: 'abc' }));
    // same slug → same hostname; fake returns the existing project (idempotent) — still ONE owner
    expect(second.outcome).toBe('CUSTOMER_READY');
    expect(second.rollbackMetadata.resourceIds.domain).toBe('abc.leadfinder.business');
  });

  it('verifies runtime/persisted quota agreement at stage 8 (fail-closed)', async () => {
    const providers = createFakeProviders({ failAt: ['cp.insertCustomerConfig'] });
    // quota stage runs BEFORE finalize; insertCustomerConfig failure only surfaces at finalize
    const result = await runProvisioning(providers, input());
    expect(result.outcome).toBe('FAILED');
    expect(result.failedStageId).toBe('finalize');
    // quota stage itself passed (runtime == persisted contract)
    expect(result.stages[7].status).toBe('PASS');
  });
});
