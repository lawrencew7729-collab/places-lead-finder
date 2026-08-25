import { describe, expect, it } from 'vitest';
import { createTestOnlyTrustedP0Harness, type TestOperatorBootstrap, type TestTrustedReadinessEvidence } from '../test-support/trustedP0Harness';
import { InMemoryOnboardingRepository, type OnboardingCheckpointInput } from './onboardingRepository';
import { configureOwnerThresholds, createWizardState, transitionWizard } from './wizardWorkflow';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const at = '2026-08-24T10:00:00.000Z';

function checkpointInput(overrides: Partial<OnboardingCheckpointInput> = {}): OnboardingCheckpointInput {
  const tenantId = overrides.tenantId ?? tenantA;
  let wizardState = configureOwnerThresholds(createWizardState(tenantId), 70, 90);
  wizardState = transitionWizard(wizardState, 0, { outcome: 'pass', at });
  return {
    tenantId,
    companyName: 'Trusted Boundary Tenant',
    slug: 'trusted-boundary',
    hostname: 'trusted-boundary.leadfinder.business',
    googleProjectId: 'google-project-1',
    keyFingerprint: { algorithm: 'sha256', value: 'A'.repeat(64), computedBy: 'mock_provider_adapter', computedAt: at },
    runtimeArchitecture: 'browser_direct',
    monitoringMode: 'shared_access',
    monitoringBinding: { projectId: 'monitoring-project-1', resourceId: 'monitoring-resource-1' },
    providerEvidence: [
      { kind: 'google_places', tenantId, status: 'unknown', source: 'mock', resourceId: 'google-project-1', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'monitoring', tenantId, status: 'unknown', source: 'mock', resourceId: 'monitoring-resource-1', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'vercel_capacity', tenantId, status: 'unknown', source: 'mock', resourceId: 'vercel-project-1', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
      { kind: 'deployment_health', tenantId, status: 'unknown', source: 'mock', resourceId: 'deployment-1', diagnosticReason: 'MOCK_NON_AUTHORITATIVE', collectedAt: at },
    ],
    quotaPolicy: { monthlyTarget: 1000, amberPercent: 70, redPercent: 90, status: 'owner_configured' },
    releaseIdentity: { releaseId: 'release-1', gitSha: '626c0c133e7862616ec74bb53ff0ba6f934a9e04', artifactSha256: 'A'.repeat(64) },
    vercelBinding: { projectId: 'vercel-project-1', deploymentId: 'deployment-1' },
    infrastructureBinding: { status: 'amber', evidenceVersion: 'infra-v1' },
    wizardState,
    readinessState: { ready: false, reasons: ['P0_GATE'] },
    ...overrides,
  };
}

async function setup(overrides: Partial<OnboardingCheckpointInput> = {}, operatorOverrides: TestOperatorBootstrap[] = []) {
  const repository = new InMemoryOnboardingRepository();
  const input = checkpointInput(overrides);
  input.providerEvidence = input.providerEvidence.map((item) => ({
    ...item,
    resourceId: item.kind === 'google_places'
      ? input.googleProjectId
      : item.kind === 'monitoring'
        ? input.monitoringBinding.resourceId
        : item.kind === 'vercel_capacity'
          ? input.vercelBinding.projectId
          : input.vercelBinding.deploymentId,
  }));
  await repository.saveOnboardingCheckpointAtomic(input);
  let now = '2026-08-24T10:05:00.000Z';
  const harness = createTestOnlyTrustedP0Harness({
    repository,
    tenantId: overrides.tenantId ?? tenantA,
    clock: { now: () => new Date(now) },
    operators: [
      { sessionId: 'session-admin', operatorId: 'op-admin', role: 'admin', active: true },
      { sessionId: 'session-other', operatorId: 'op-other', role: 'operator', active: true },
      { sessionId: 'session-viewer', operatorId: 'op-viewer', role: 'viewer', active: true },
      ...operatorOverrides,
    ],
  });
  return { repository, harness, setNow: (value: string) => { now = value; } };
}

function forgedEvidence(kind = 'google_places') {
  return {
    tenantId: tenantA, kind, signal: 'green', source: 'authoritative', authoritative: true,
    provenance: kind === 'release_artifact' ? 'release_registry' : 'provider_adapter',
    issuedAt: at, expiresAt: '2026-08-24T10:15:00.000Z', googleProjectId: 'google-project-1',
    hostname: 'trusted-boundary.leadfinder.business', vercelProjectId: 'vercel-project-1', deploymentId: 'deployment-1',
    releaseId: 'release-1', gitSha: '626c0c133e7862616ec74bb53ff0ba6f934a9e04', artifactSha256: 'A'.repeat(64),
    monitoringProjectId: 'monitoring-project-1', monitoringResourceId: 'monitoring-resource-1', monthlyTarget: 1000, amberPercent: 70, redPercent: 90,
  } as unknown as TestTrustedReadinessEvidence;
}

async function trustedInputs() {
  const { harness, setNow } = await setup();
  const session = harness.authentication.authenticate('session-admin');
  if (!session) throw new Error('trusted session missing');
  const evidence = harness.providers.issueCompleteEvidence();
  const authorization = harness.authorization.issueReadinessApproval(session);
  return { harness, session, evidence, authorization, setNow };
}

describe('P0-1 trusted authoritative readiness boundary', () => {
  it.each([
    ['plain forged object', forgedEvidence()],
    ['forged source authoritative', forgedEvidence('monitoring')],
    ['forged Google provider', forgedEvidence('google_places')],
    ['forged Vercel provider', forgedEvidence('vercel_deployment')],
    ['forged release registry', forgedEvidence('release_artifact')],
  ])('rejects %s', async (_label, forged) => {
    const { harness, session, evidence, authorization } = await trustedInputs();
    const replaced = evidence.map((item) => item.kind === forged.kind ? forged : item);
    expect(harness.readiness.evaluate({ session, authorization, evidence: replaced })).toMatchObject({ ready: false, reasons: expect.arrayContaining(['UNTRUSTED_EVIDENCE']) });
  });

  it('rejects forged operator approval and caller-created session', async () => {
    const { harness, evidence } = await trustedInputs();
    const forgedSession = { sessionId: 'session-admin' } as never;
    const forgedApproval = { approved: true, operatorId: 'op-admin', tenantId: tenantA } as never;
    expect(harness.readiness.evaluate({ session: forgedSession, authorization: forgedApproval, evidence })).toMatchObject({ ready: false, reasons: expect.arrayContaining(['UNTRUSTED_OPERATOR_SESSION', 'UNTRUSTED_AUTHORIZATION']) });
  });

  it('accepts the complete internally composed test-only set but cannot authorize the browser workflow', async () => {
    const { harness, session, evidence, authorization } = await trustedInputs();
    const decision = harness.readiness.evaluate({ session, authorization, evidence });
    expect(decision).toMatchObject({ ready: true, tenantId: tenantA, reasons: [] });
    const state = { ...configureOwnerThresholds(createWizardState(tenantA), 70, 90), currentStep: 20, completedSteps: Array.from({ length: 20 }, (_, index) => index) };
    expect(transitionWizard(state, 20, { outcome: 'pass', at, readinessDecision: decision })).toMatchObject({ status: 'blocked', blockReason: 'AUTHORITATIVE_READINESS_BOUNDARY_NOT_CONNECTED' });
  });

  it.each([
    ['Tenant ID', { tenantId: tenantB }],
    ['Google Project ID', { googleProjectId: 'wrong-google' }],
    ['hostname', { hostname: 'wrong-host.leadfinder.business' }],
    ['Vercel project/deployment', { vercelBinding: { projectId: 'wrong-vercel', deploymentId: 'wrong-deployment' } }],
    ['Release/Git/artifact', { releaseIdentity: { releaseId: 'wrong-release', gitSha: 'B'.repeat(40), artifactSha256: 'B'.repeat(64) } }],
    ['monitoring project/resource', { monitoringBinding: { projectId: 'wrong-monitoring-project', resourceId: 'wrong-monitoring-resource' } }],
    ['owner quota policy', { quotaPolicy: { monthlyTarget: 1000, amberPercent: 71, redPercent: 91, status: 'owner_configured' as const } }],
  ])('rejects trusted evidence bound to the wrong %s', async (_label, wrongConfig) => {
    const current = await trustedInputs();
    const wrong = await setup(wrongConfig as Partial<OnboardingCheckpointInput>);
    const wrongEvidence = wrong.harness.providers.issueCompleteEvidence();
    expect(current.harness.readiness.evaluate({ session: current.session, authorization: current.authorization, evidence: wrongEvidence }).ready).toBe(false);
  });

  it('rejects stale evidence using its internal clock even when caller supplies a fake current time', async () => {
    const { harness, session, evidence, authorization, setNow } = await trustedInputs();
    setNow('2026-08-24T11:00:00.000Z');
    const request = { session, authorization, evidence, now: '2026-08-24T10:05:00.000Z' } as never;
    expect(harness.readiness.evaluate(request)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['STALE_EVIDENCE', 'STALE_AUTHORIZATION']) });
  });

  it('rejects partial and duplicate mandatory evidence', async () => {
    const { harness, session, evidence, authorization } = await trustedInputs();
    expect(harness.readiness.evaluate({ session, authorization, evidence: evidence.slice(0, -1) }).ready).toBe(false);
    expect(harness.readiness.evaluate({ session, authorization, evidence: [...evidence.slice(0, -1), evidence[0]] }).ready).toBe(false);
  });

  it('rejects a cloned formerly-issued object because branding is runtime opaque', async () => {
    const { harness, session, evidence, authorization } = await trustedInputs();
    const clone = structuredClone(evidence[0]) as TestTrustedReadinessEvidence;
    expect(harness.readiness.evaluate({ session, authorization, evidence: [clone, ...evidence.slice(1)] })).toMatchObject({ ready: false, reasons: expect.arrayContaining(['UNTRUSTED_EVIDENCE']) });
  });
});

describe('P1-2 trusted AMBER authorization boundary', () => {
  it('rejects a forged AMBER approval', async () => {
    const { harness } = await setup();
    const session = harness.authentication.authenticate('session-admin')!;
    expect(harness.infrastructureGate.evaluate({ action: 'activate', session, authorization: { approved: true } as never }).allowActivation).toBe(false);
  });

  it('rejects wrong operator, role, tenant, action, stale and old-evidence approvals', async () => {
    const current = await setup();
    const admin = current.harness.authentication.authenticate('session-admin')!;
    const other = current.harness.authentication.authenticate('session-other')!;
    const viewer = current.harness.authentication.authenticate('session-viewer')!;
    const valid = current.harness.authorization.issueAmberApproval(admin, 'activate');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: other, authorization: valid }).allowActivation).toBe(false);
    const viewerApproval = current.harness.authorization.issueAmberApproval(viewer, 'activate');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: viewer, authorization: viewerApproval }).allowActivation).toBe(false);
    const otherTenant = await setup({ tenantId: tenantB, hostname: 'tenant-b.leadfinder.business', slug: 'tenant-b' });
    const otherAdmin = otherTenant.harness.authentication.authenticate('session-admin')!;
    const otherTenantApproval = otherTenant.harness.authorization.issueAmberApproval(otherAdmin, 'activate');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: admin, authorization: otherTenantApproval }).allowActivation).toBe(false);
    const provisionApproval = current.harness.authorization.issueAmberApproval(admin, 'provision');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: admin, authorization: provisionApproval }).allowActivation).toBe(false);
    current.setNow('2026-08-24T11:00:00.000Z');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: admin, authorization: valid }).allowActivation).toBe(false);
    const old = await setup({ infrastructureBinding: { status: 'amber', evidenceVersion: 'infra-v0' } });
    const oldAdmin = old.harness.authentication.authenticate('session-admin')!;
    const oldApproval = old.harness.authorization.issueAmberApproval(oldAdmin, 'activate');
    expect(current.harness.infrastructureGate.evaluate({ action: 'activate', session: admin, authorization: oldApproval }).allowActivation).toBe(false);
  });

  it('accepts a fresh trusted approval and keeps GREEN healthy while RED/UNKNOWN fail closed', async () => {
    const amber = await setup();
    const session = amber.harness.authentication.authenticate('session-admin')!;
    const approval = amber.harness.authorization.issueAmberApproval(session, 'activate');
    expect(amber.harness.infrastructureGate.evaluate({ action: 'activate', session, authorization: approval })).toMatchObject({ allowActivation: true, operatorReviewRecorded: true, keepHealthyDeploymentsRunning: true });
    for (const status of ['red', 'unknown'] as const) {
      const blocked = await setup({ infrastructureBinding: { status, evidenceVersion: `infra-${status}` } });
      expect(blocked.harness.infrastructureGate.evaluate({ action: 'activate', session: blocked.harness.authentication.authenticate('session-admin')! })).toMatchObject({ allowActivation: false, keepHealthyDeploymentsRunning: true });
    }
    const green = await setup({ infrastructureBinding: { status: 'green', evidenceVersion: 'infra-green' } });
    expect(green.harness.infrastructureGate.evaluate({ action: 'activate', session: green.harness.authentication.authenticate('session-admin')! })).toMatchObject({ allowActivation: true, keepHealthyDeploymentsRunning: true });
  });
});
