import { describe, expect, it } from 'vitest';
import { InMemoryOnboardingRepository, type OnboardingCheckpointInput } from './onboardingRepository';
import { configureOwnerThresholds, createWizardState } from './wizardWorkflow';

const tenantId = '11111111-1111-4111-8111-111111111111';
const at = '2026-08-24T10:00:00.000Z';

function input(): OnboardingCheckpointInput {
  return {
    tenantId,
    companyName: 'Audit Tenant',
    slug: 'audit-tenant',
    hostname: 'audit-tenant.leadfinder.business',
    googleProjectId: 'google-project-audit',
    keyFingerprint: { algorithm: 'sha256', value: 'A'.repeat(64), computedBy: 'mock_provider_adapter', computedAt: at },
    runtimeArchitecture: 'browser_direct',
    monitoringMode: 'shared_access',
    monitoringBinding: { projectId: 'monitoring-project-audit', resourceId: 'monitoring-resource-audit' },
    providerEvidence: [
      { kind: 'google_places', tenantId, status: 'unknown', source: 'mock', resourceId: 'google-project-audit', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'monitoring', tenantId, status: 'unknown', source: 'mock', resourceId: 'monitoring-resource-audit', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'vercel_capacity', tenantId, status: 'unknown', source: 'mock', resourceId: 'vercel-project-audit', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'deployment_health', tenantId, status: 'unknown', source: 'mock', resourceId: 'deployment-audit', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
    ],
    quotaPolicy: { monthlyTarget: 1000, amberPercent: 72, redPercent: 91, status: 'owner_configured' },
    releaseIdentity: { releaseId: 'release-audit', gitSha: 'A'.repeat(40), artifactSha256: 'B'.repeat(64) },
    vercelBinding: { projectId: 'vercel-project-audit', deploymentId: 'deployment-audit' },
    infrastructureBinding: { status: 'unknown', evidenceVersion: 'infra-audit-v1' },
    wizardState: configureOwnerThresholds(createWizardState(tenantId), 72, 91),
    readinessState: { ready: false, reasons: ['P0_GATE'] },
  };
}

describe('local review audit provenance', () => {
  it('records unauthenticated browser review as explicit non-USER, non-admin local review', async () => {
    const repository = new InMemoryOnboardingRepository();
    const saved = await repository.saveOnboardingCheckpointAtomic(input());
    expect(saved.audit).toEqual({
      tenantId,
      actorType: 'local_review',
      operatorId: null,
      operatorRole: null,
      actorLabel: 'Unauthenticated Local Review',
      action: 'LOCAL_ONBOARDING_CHECKPOINT_SAVED',
      at: expect.any(String),
    });
    expect(JSON.stringify(repository.exportRedacted())).not.toMatch(/"actorType":"user"|"operatorRole":"admin"/);
  });

  it('rejects caller-supplied USER/admin attribution and operator impersonation fields', async () => {
    const repository = new InMemoryOnboardingRepository();
    await expect((repository.saveOnboardingCheckpointAtomic as unknown as (value: OnboardingCheckpointInput, options: object) => Promise<unknown>)(input(), {
      actorType: 'user', actorUserId: 'another-operator', operatorRole: 'admin', actorLabel: 'Another Operator',
    })).rejects.toThrow(/actor attribution|cannot be overridden/i);
  });
});
