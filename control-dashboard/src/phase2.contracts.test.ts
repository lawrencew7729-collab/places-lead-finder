import { describe, expect, it } from 'vitest';
import {
  exactRestrictionFor,
  generateTenantId,
  normalizeCustomerHostname,
  validateServerFingerprintMetadata,
  validateTenantId,
} from './domain';
import { authorizeOperator, type MockOperator } from './authorization';
import { InMemoryOnboardingRepository, type LocalProviderEvidenceRecord, type OnboardingCheckpointInput } from './onboardingRepository';
import {
  createWizardState,
  recordProviderEvidence,
  transitionWizard,
  WIZARD_STEPS,
} from './wizardWorkflow';


const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const admin: MockOperator = { id: 'op-admin', role: 'admin', active: true };

function completeCheckpoint(tenantId: string, companyName: string, hostname: string): OnboardingCheckpointInput {
  const collectedAt = '2026-08-24T00:05:00.000Z';
  const googleProjectId = `google-${tenantId.slice(0, 8)}`;
  return {
    tenantId, companyName, slug: companyName.toLowerCase().replaceAll(' ', '-'), hostname, googleProjectId,
    keyFingerprint: { algorithm: 'sha256', value: 'A'.repeat(64), computedBy: 'mock_provider_adapter', computedAt: collectedAt },
    runtimeArchitecture: 'browser_direct', monitoringMode: 'shared_access',
    monitoringBinding: { projectId: googleProjectId, resourceId: 'shared_access' },
    providerEvidence: (['google_places', 'monitoring', 'vercel_capacity', 'deployment_health'] satisfies LocalProviderEvidenceRecord['kind'][]).map((kind) => ({
      kind, tenantId, status: 'unknown' as const, source: 'mock' as const,
      resourceId: kind === 'google_places' ? googleProjectId : kind === 'monitoring' ? 'shared_access' : kind === 'vercel_capacity' ? 'vercel-project-a' : 'deployment-a',
      diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt,
    })),
    quotaPolicy: { monthlyTarget: 1000, amberPercent: 70, redPercent: 90, status: 'owner_configured' },
    releaseIdentity: { releaseId: 'golden-test', gitSha: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
    vercelBinding: { projectId: 'vercel-project-a', deploymentId: 'deployment-a' },
    infrastructureBinding: { status: 'unknown', evidenceVersion: 'p0-local-unknown-v1' },
    wizardState: { ...createWizardState(tenantId), currentStep: 7 },
    readinessState: { ready: false, reasons: ['MOCK_NON_AUTHORITATIVE', 'BLOCKED_BY_P0_GATE'] },
  };
}

describe('P0 safety contracts', () => {

  it('normalizes and permits only one exact customer hostname under leadfinder.business', () => {
    expect(normalizeCustomerHostname('ACME.LeadFinder.Business')).toBe('acme.leadfinder.business');
    expect(exactRestrictionFor('ACME.LeadFinder.Business')).toBe('https://acme.leadfinder.business/*');
    for (const invalid of [
      '*.leadfinder.business', 'leadfinder.business', 'a.b.leadfinder.business',
      'https://acme.leadfinder.business', 'acme.leadfinder.business/path',
      'acme.example.com', 'acme.leadfinder.business:443',
    ]) expect(() => exactRestrictionFor(invalid)).toThrow();
  });

  it('uses immutable UUID Tenant IDs with deterministic generation for tests', () => {
    const bytes = new Uint8Array(16).fill(0);
    expect(generateTenantId(() => bytes)).toBe('00000000-0000-4000-8000-000000000000');
    expect(validateTenantId(tenantA)).toBe(true);
    expect(validateTenantId('tnt_fictional')).toBe(false);
  });

  it('accepts adapter-produced fingerprint evidence and rejects UI/server claims outside the adapter contract', () => {
    const metadata = { algorithm: 'sha256' as const, value: 'A'.repeat(64), computedBy: 'server_provider_adapter' as const, computedAt: '2026-08-24T00:00:00.000Z' };
    expect(validateServerFingerprintMetadata(metadata)).toEqual(metadata);
    expect(() => validateServerFingerprintMetadata({ ...metadata, value: 'A1B2C3D4' })).toThrow();
    expect(() => validateServerFingerprintMetadata({ ...metadata, computedBy: 'server' as never })).toThrow(/adapter/i);
    expect(JSON.stringify(metadata)).not.toContain('AIza');
  });
});

describe('mock operator authorization', () => {
  it('allows active admin/operator onboarding actions and denies inactive/viewer users', () => {
    expect(authorizeOperator(admin, 'manage_onboarding')).toBe(true);
    expect(authorizeOperator({ id: 'op', role: 'operator', active: true }, 'manage_onboarding')).toBe(true);
    expect(authorizeOperator({ id: 'view', role: 'viewer', active: true }, 'manage_onboarding')).toBe(false);
    expect(authorizeOperator({ id: 'off', role: 'admin', active: false }, 'manage_onboarding')).toBe(false);
  });
});

describe('22-step resumable workflow', () => {
  it('represents exact plan steps 0 through 21 and prevents invalid skips', () => {
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([...Array(22)].map((_, index) => index));
    const state = createWizardState(tenantA);
    expect(() => transitionWizard(state, 2, { outcome: 'pass', at: '2026-08-24T00:00:00.000Z' })).toThrow(/skip/i);
  });

  it('stops on UNKNOWN/RED, records provider timestamps and keeps P0 LIVE fixed blocked', () => {
    let state = createWizardState(tenantA);
    state = transitionWizard(state, 0, { outcome: 'pass', at: '2026-08-24T00:00:00.000Z' });
    state = transitionWizard(state, 1, { outcome: 'pass', at: '2026-08-24T00:01:00.000Z' });
    state = transitionWizard(state, 2, { outcome: 'pass', at: '2026-08-24T00:02:00.000Z' });
    const blocked = transitionWizard(state, 3, { outcome: 'unknown', at: '2026-08-24T00:03:00.000Z' });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockReason).toMatch(/BLOCKED/);

    const evidence = recordProviderEvidence(tenantA, 'billing', 'green', '2026-08-24T00:04:00.000Z', '2026-08-24T00:05:00.000Z');
    expect(evidence.measurementTimestamp).toMatch(/Z$/);
    expect(evidence.collectionTimestamp).toMatch(/Z$/);

    const atFinal = { ...state, currentStep: 21, completedSteps: [...Array(21)].map((_, i) => i), status: 'in_progress' as const, ownerThresholds: { amberPercent: 70, redPercent: 90 } };
    const blockedLive = transitionWizard(atFinal, 21, { outcome: 'pass', at: '2026-08-24T00:06:00.000Z', liveConfirmedBy: admin.id });
    expect(blockedLive.status).toBe('blocked');
    expect(blockedLive.blockReason).toBe('BLOCKED_BY_P0_GATE');
  });
});

describe('local repository checkpoints and atomic isolation', () => {
  it('atomically saves the complete configuration, supports derived-id retry and resume', async () => {
    const repo = new InMemoryOnboardingRepository();
    const input = completeCheckpoint(tenantA, 'Tenant A', 'a.leadfinder.business');
    const first = await repo.saveOnboardingCheckpointAtomic(input);
    const retry = await repo.saveOnboardingCheckpointAtomic({ ...input, providerEvidence: input.providerEvidence.map((e) => ({ ...e, collectedAt: '2026-08-24T00:06:00.000Z' })) });
    expect(retry).toEqual(first);
    expect(repo.resume(tenantA)?.wizardState.currentStep).toBe(7);
    expect(repo.resume(tenantA)?.providerEvidence).toHaveLength(4);
  });

  it('rolls back all checkpoint rows when audit fails and leaves another tenant unchanged', async () => {
    const repo = new InMemoryOnboardingRepository();
    await repo.saveOnboardingCheckpointAtomic(completeCheckpoint(tenantB, 'Tenant B', 'b.leadfinder.business'));
    await expect(repo.saveOnboardingCheckpointAtomic(completeCheckpoint(tenantA, 'Tenant A', 'a.leadfinder.business'), { failAudit: true })).rejects.toThrow(/audit/i);
    expect(repo.readTenant(tenantA)).toBeNull();
    expect(repo.readTenant(tenantB)?.companyName).toBe('Tenant B');
  });

  it('rejects wrong tenant/resource access and stores no raw secret-shaped values', async () => {
    const repo = new InMemoryOnboardingRepository();
    await repo.saveOnboardingCheckpointAtomic(completeCheckpoint(tenantA, 'Tenant A', 'a.leadfinder.business'));
    expect(() => repo.assertResourceOwnership(tenantB, { tenantId: tenantA, resourceId: 'resource-a' })).toThrow(/tenant/i);
    expect(JSON.stringify(repo.exportRedacted())).not.toMatch(/AIza|service_role|private_key|rawSecret/i);
  });
});
