import { describe, expect, it } from 'vitest';
import { deriveOperationIdentity, InMemoryOnboardingRepository, type OnboardingCheckpointInput } from './onboardingRepository';
import { configureOwnerThresholds, createWizardState, transitionWizard } from './wizardWorkflow';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const collectedAt = '2026-08-24T10:00:00.000Z';

function checkpointInput(tenantId = tenantA): OnboardingCheckpointInput {
  let wizardState = configureOwnerThresholds(createWizardState(tenantId), 70, 90);
  for (let step = 0; step < 5; step += 1) wizardState = transitionWizard(wizardState, step, { outcome: 'pass', at: collectedAt });
  wizardState = transitionWizard(wizardState, 5, { outcome: 'unknown', at: collectedAt });
  return {
    tenantId,
    companyName: tenantId === tenantA ? 'Tenant A' : 'Tenant B',
    slug: tenantId === tenantA ? 'tenant-a' : 'tenant-b',
    hostname: tenantId === tenantA ? 'tenant-a.leadfinder.business' : 'tenant-b.leadfinder.business',
    googleProjectId: 'google-project-a',
    keyFingerprint: { algorithm: 'sha256', value: 'A'.repeat(64), computedBy: 'mock_provider_adapter', computedAt: collectedAt },
    runtimeArchitecture: 'browser_direct',
    monitoringMode: 'shared_access',
    monitoringBinding: { projectId: 'google-project-a', resourceId: 'shared_access' },
    providerEvidence: [
      { kind: 'google_places', tenantId, status: 'unknown', source: 'mock', resourceId: 'google-project-a', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt },
      { kind: 'monitoring', tenantId, status: 'unknown', source: 'mock', resourceId: 'shared_access', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt },
      { kind: 'vercel_capacity', tenantId, status: 'unknown', source: 'mock', resourceId: 'vercel-project-p0-mock', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt },
      { kind: 'deployment_health', tenantId, status: 'unknown', source: 'mock', resourceId: 'deployment-p0-mock', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt },
    ],
    quotaPolicy: { monthlyTarget: 1000, amberPercent: 70, redPercent: 90, status: 'owner_configured' },
    releaseIdentity: {
      releaseId: 'golden-root-626c0c1',
      gitSha: '626c0c133e7862616ec74bb53ff0ba6f934a9e04',
      artifactSha256: 'ADAE268878B124A2134DD11ED7CB672E7636DBFA6ADC6B1CE31B752D6F43D2DF',
    },
    vercelBinding: { projectId: 'vercel-project-p0-mock', deploymentId: 'deployment-p0-mock' },
    infrastructureBinding: { status: 'unknown', evidenceVersion: 'p0-local-unknown-v1' },
    wizardState,
    readinessState: { ready: false, reasons: ['MOCK_NON_AUTHORITATIVE', 'CUSTOMER_PROVISIONING_NOT_AUTHORIZED'] },
  };
}

describe('derived idempotency identity', () => {
  it('is stable for the same logical payload and ignores evidence timestamps', async () => {
    const first = checkpointInput();
    const timestampOnly = checkpointInput();
    timestampOnly.providerEvidence = timestampOnly.providerEvidence.map((item) => ({ ...item, collectedAt: '2026-08-24T10:09:00.000Z' }));
    timestampOnly.keyFingerprint = { ...timestampOnly.keyFingerprint, computedAt: '2026-08-24T10:09:00.000Z' };
    expect(await deriveOperationIdentity('save_onboarding_checkpoint', tenantA, first)).toBe(await deriveOperationIdentity('save_onboarding_checkpoint', tenantA, timestampOnly));
  });

  it('changes for a different tenant, operation, or meaningful payload', async () => {
    const input = checkpointInput();
    const identity = await deriveOperationIdentity('save_onboarding_checkpoint', tenantA, input);
    expect(await deriveOperationIdentity('save_onboarding_checkpoint', tenantB, { ...input, tenantId: tenantB })).not.toBe(identity);
    expect(await deriveOperationIdentity('create_draft', tenantA, input)).not.toBe(identity);
    expect(await deriveOperationIdentity('save_onboarding_checkpoint', tenantA, { ...input, googleProjectId: 'changed-project' })).not.toBe(identity);
  });
});

describe('complete atomic local onboarding checkpoint', () => {
  it('atomically stores and resumes the complete non-secret onboarding state', async () => {
    const repository = new InMemoryOnboardingRepository();
    const first = await repository.saveOnboardingCheckpointAtomic(checkpointInput());
    const retry = await repository.saveOnboardingCheckpointAtomic(checkpointInput());
    expect(retry.operationIdentity).toBe(first.operationIdentity);
    expect(repository.resume(tenantA)).toEqual(first);
    expect(first).toMatchObject({
      tenantId: tenantA,
      googleProjectId: 'google-project-a',
      monitoringMode: 'shared_access',
      releaseIdentity: { releaseId: 'golden-root-626c0c1' },
      vercelBinding: { projectId: 'vercel-project-p0-mock', deploymentId: 'deployment-p0-mock' },
      wizardState: { currentStep: 5, status: 'blocked' },
      readinessState: { ready: false },
      audit: { action: 'LOCAL_ONBOARDING_CHECKPOINT_SAVED' },
    });
    expect(repository.exportRedacted().audits).toHaveLength(1);
  });

  it('rejects caller identity injection and leaves no partial state when audit fails', async () => {
    const repository = new InMemoryOnboardingRepository();
    await expect((repository.saveOnboardingCheckpointAtomic as unknown as (input: OnboardingCheckpointInput, options: object) => Promise<unknown>)(checkpointInput(), { canonicalPayloadHash: 'A'.repeat(64) })).rejects.toThrow(/derived internally/i);
    await expect(repository.saveOnboardingCheckpointAtomic(checkpointInput(), { failAudit: true })).rejects.toThrow(/audit/i);
    expect(repository.resume(tenantA)).toBeNull();
    expect(repository.readTenant(tenantA)).toBeNull();
    expect(repository.exportRedacted().audits).toEqual([]);
  });

  it('keeps a failed Tenant A operation isolated from Tenant B', async () => {
    const repository = new InMemoryOnboardingRepository();
    const tenantBCheckpoint = await repository.saveOnboardingCheckpointAtomic(checkpointInput(tenantB));
    await expect(repository.saveOnboardingCheckpointAtomic(checkpointInput(), { failAudit: true })).rejects.toThrow();
    expect(repository.resume(tenantB)).toEqual(tenantBCheckpoint);
    expect(repository.resume(tenantA)).toBeNull();
  });

  it('exports metadata only and no raw secret-shaped values', async () => {
    const repository = new InMemoryOnboardingRepository();
    await repository.saveOnboardingCheckpointAtomic(checkpointInput());
    expect(JSON.stringify(repository.exportRedacted())).not.toMatch(/AIza|service_role|private_key|rawSecret|password/i);
  });
});