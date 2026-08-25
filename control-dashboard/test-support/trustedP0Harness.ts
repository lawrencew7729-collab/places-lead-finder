import type { OperatorRole } from '../src/authorization';
import type { Signal } from '../src/domain';
import type { InMemoryOnboardingRepository } from '../src/onboardingRepository';

export type TestReadinessEvidenceKind = 'google_places' | 'monitoring' | 'vercel_deployment' | 'exact_domain' | 'quota_policy' | 'release_artifact';
type TestTrustedIssuer = 'google_adapter' | 'monitoring_adapter' | 'vercel_adapter' | 'control_plane' | 'release_registry';
export type TestAmberAction = 'provision' | 'activate';

export interface TestTrustedReadinessEvidence {
  readonly kind: TestReadinessEvidenceKind;
  readonly tenantId: string;
  readonly signal: Signal;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuer: TestTrustedIssuer;
  readonly googleProjectId?: string;
  readonly hostname?: string;
  readonly vercelProjectId?: string;
  readonly deploymentId?: string;
  readonly monitoringProjectId?: string;
  readonly monitoringResourceId?: string;
  readonly monthlyTarget?: number;
  readonly amberPercent?: number;
  readonly redPercent?: number;
  readonly releaseId?: string;
  readonly gitSha?: string;
  readonly artifactSha256?: string;
}

export interface TestTrustedAuthorizationDecision {
  readonly authorizationId: string;
  readonly operatorId: string;
  readonly operatorRole: string;
  readonly tenantId: string;
  readonly action: 'readiness_approval' | TestAmberAction;
  readonly infrastructureState: Signal;
  readonly evidenceVersion: string;
  readonly approved: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TestTrustedReadinessDecision {
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly tenantId: string;
  readonly evaluatedAt: string;
}

export interface TestTrustedSession {
  readonly sessionId: string;
}

export interface TestOperatorBootstrap {
  sessionId: string;
  operatorId: string;
  role: OperatorRole;
  active: boolean;
  displayLabel?: string;
}

interface SessionRecord extends TestOperatorBootstrap {
  displayLabel: string;
}
interface AuthorizationClaim extends TestTrustedAuthorizationDecision {
  session: TestTrustedSession;
}

const requiredIssuer: Record<TestReadinessEvidenceKind, TestTrustedIssuer> = {
  google_places: 'google_adapter',
  monitoring: 'monitoring_adapter',
  vercel_deployment: 'vercel_adapter',
  exact_domain: 'vercel_adapter',
  quota_policy: 'control_plane',
  release_artifact: 'release_registry',
};
const mandatoryKinds = Object.keys(requiredIssuer) as TestReadinessEvidenceKind[];

function finiteTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function uniqueReasons(reasons: string[]) {
  return Array.from(new Set(reasons));
}

/**
 * TEST-ONLY composition root. This file is outside src/ and is never imported by
 * the production application graph. It models the future server-side capabilities
 * without making any issuer available to browser/application modules.
 */
export function createTestOnlyTrustedP0Harness(options: {
  repository: InMemoryOnboardingRepository;
  tenantId: string;
  clock: { now: () => Date };
  operators: TestOperatorBootstrap[];
}) {
  const config = options.repository.readAuthoritativeReadinessConfiguration(options.tenantId);
  const sessions = new WeakMap<TestTrustedSession, SessionRecord>();
  const sessionsById = new Map<string, TestTrustedSession>();
  const evidenceClaims = new WeakMap<TestTrustedReadinessEvidence, TestTrustedReadinessEvidence>();
  const authorizationClaims = new WeakMap<TestTrustedAuthorizationDecision, AuthorizationClaim>();
  let authorizationSequence = 0;
  const maxAgeMs = 15 * 60 * 1000;

  for (const bootstrap of options.operators) {
    const record = Object.freeze({ ...bootstrap, displayLabel: bootstrap.displayLabel ?? bootstrap.operatorId });
    const session = Object.freeze({ sessionId: bootstrap.sessionId });
    sessions.set(session, record);
    sessionsById.set(bootstrap.sessionId, session);
  }

  const now = () => {
    const value = options.clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('Test trusted clock returned an invalid instant');
    return value;
  };

  const resolveSession = (session: TestTrustedSession | null | undefined) => {
    if (!session || typeof session !== 'object') return null;
    const actor = sessions.get(session);
    return actor?.active ? actor : null;
  };

  function issueEvidence(kind: TestReadinessEvidenceKind): TestTrustedReadinessEvidence {
    const issued = now();
    const base = {
      kind,
      tenantId: config.tenantId,
      signal: 'green' as const,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + maxAgeMs).toISOString(),
      issuer: requiredIssuer[kind],
    };
    let resource: Partial<TestTrustedReadinessEvidence> = {};
    if (kind === 'google_places') resource = { googleProjectId: config.googleProjectId };
    if (kind === 'monitoring') resource = { monitoringProjectId: config.monitoringBinding.projectId, monitoringResourceId: config.monitoringBinding.resourceId };
    if (kind === 'vercel_deployment') resource = { vercelProjectId: config.vercelBinding.projectId, deploymentId: config.vercelBinding.deploymentId };
    if (kind === 'exact_domain') resource = { hostname: config.hostname };
    if (kind === 'quota_policy') resource = { monthlyTarget: config.quotaPolicy.monthlyTarget, amberPercent: config.quotaPolicy.amberPercent, redPercent: config.quotaPolicy.redPercent };
    if (kind === 'release_artifact') resource = { ...config.releaseIdentity };
    const evidence = Object.freeze({ ...base, ...resource }) as TestTrustedReadinessEvidence;
    evidenceClaims.set(evidence, Object.freeze({ ...evidence }));
    return evidence;
  }

  function issueAuthorization(session: TestTrustedSession, action: TestTrustedAuthorizationDecision['action']) {
    const actor = resolveSession(session);
    const issued = now();
    const approved = Boolean(actor && ['admin', 'operator'].includes(actor.role));
    const decision = Object.freeze({
      authorizationId: `test-auth-${++authorizationSequence}`,
      operatorId: actor?.operatorId ?? 'untrusted',
      operatorRole: actor?.role ?? 'untrusted',
      tenantId: config.tenantId,
      action,
      infrastructureState: config.infrastructureBinding.status,
      evidenceVersion: config.infrastructureBinding.evidenceVersion,
      approved,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + maxAgeMs).toISOString(),
    }) as TestTrustedAuthorizationDecision;
    authorizationClaims.set(decision, Object.freeze({ ...decision, session }));
    return decision;
  }

  function authorizationReasons(session: TestTrustedSession, authorization: TestTrustedAuthorizationDecision | undefined, action: TestTrustedAuthorizationDecision['action']) {
    const reasons: string[] = [];
    const actor = resolveSession(session);
    if (!actor) reasons.push('UNTRUSTED_OPERATOR_SESSION');
    const claim = authorization && authorizationClaims.get(authorization);
    if (!claim) return [...reasons, 'UNTRUSTED_AUTHORIZATION'];
    if (!claim.approved || !['admin', 'operator'].includes(claim.operatorRole)) reasons.push('UNAUTHORIZED_OPERATOR');
    if (claim.session !== session || claim.operatorId !== actor?.operatorId) reasons.push('AUTHORIZATION_OPERATOR_MISMATCH');
    if (claim.tenantId !== config.tenantId) reasons.push('AUTHORIZATION_TENANT_MISMATCH');
    if (claim.action !== action) reasons.push('AUTHORIZATION_ACTION_MISMATCH');
    if (claim.infrastructureState !== config.infrastructureBinding.status) reasons.push('AUTHORIZATION_INFRASTRUCTURE_STATE_MISMATCH');
    if (claim.evidenceVersion !== config.infrastructureBinding.evidenceVersion) reasons.push('AUTHORIZATION_EVIDENCE_VERSION_MISMATCH');
    const current = now().getTime();
    if (finiteTime(claim.issuedAt) > current || finiteTime(claim.expiresAt) < current) reasons.push('STALE_AUTHORIZATION');
    return reasons;
  }

  function compareEvidence(claim: TestTrustedReadinessEvidence, reasons: string[]) {
    if (claim.tenantId !== config.tenantId) reasons.push('TENANT_MISMATCH');
    if (claim.issuer !== requiredIssuer[claim.kind]) reasons.push('INVALID_ISSUER');
    if (claim.signal !== 'green') reasons.push(`SIGNAL_${claim.signal.toUpperCase()}`);
    const current = now().getTime();
    if (finiteTime(claim.issuedAt) > current || finiteTime(claim.expiresAt) < current) reasons.push('STALE_EVIDENCE');
    if (claim.kind === 'google_places' && claim.googleProjectId !== config.googleProjectId) reasons.push('GOOGLE_PROJECT_MISMATCH');
    if (claim.kind === 'monitoring' && (claim.monitoringProjectId !== config.monitoringBinding.projectId || claim.monitoringResourceId !== config.monitoringBinding.resourceId)) reasons.push('MONITORING_RESOURCE_MISMATCH');
    if (claim.kind === 'vercel_deployment' && (claim.vercelProjectId !== config.vercelBinding.projectId || claim.deploymentId !== config.vercelBinding.deploymentId)) reasons.push('VERCEL_RESOURCE_MISMATCH');
    if (claim.kind === 'exact_domain' && claim.hostname !== config.hostname) reasons.push('HOSTNAME_MISMATCH');
    if (claim.kind === 'quota_policy' && (claim.monthlyTarget !== config.quotaPolicy.monthlyTarget || claim.amberPercent !== config.quotaPolicy.amberPercent || claim.redPercent !== config.quotaPolicy.redPercent)) reasons.push('QUOTA_POLICY_MISMATCH');
    if (claim.kind === 'release_artifact' && (claim.releaseId !== config.releaseIdentity.releaseId || claim.gitSha !== config.releaseIdentity.gitSha || claim.artifactSha256 !== config.releaseIdentity.artifactSha256)) reasons.push('RELEASE_IDENTITY_MISMATCH');
  }

  const authentication = Object.freeze({
    authenticate(sessionId: string) {
      return sessionsById.get(sessionId) ?? null;
    },
  });
  const providers = Object.freeze({
    issueGooglePlaces: () => issueEvidence('google_places'),
    issueMonitoring: () => issueEvidence('monitoring'),
    issueVercelDeployment: () => issueEvidence('vercel_deployment'),
    issueExactDomain: () => issueEvidence('exact_domain'),
    issueQuotaPolicy: () => issueEvidence('quota_policy'),
    issueReleaseArtifact: () => issueEvidence('release_artifact'),
    issueCompleteEvidence: () => mandatoryKinds.map(issueEvidence),
  });
  const authorization = Object.freeze({
    issueReadinessApproval: (session: TestTrustedSession) => issueAuthorization(session, 'readiness_approval'),
    issueAmberApproval: (session: TestTrustedSession, action: TestAmberAction) => issueAuthorization(session, action),
  });
  const readiness = Object.freeze({
    evaluate(request: { session: TestTrustedSession; authorization: TestTrustedAuthorizationDecision; evidence: TestTrustedReadinessEvidence[] }): TestTrustedReadinessDecision {
      const reasons = authorizationReasons(request.session, request.authorization, 'readiness_approval');
      const counts = new Map<TestReadinessEvidenceKind, number>();
      for (const evidence of request.evidence ?? []) {
        const claim = evidenceClaims.get(evidence);
        if (!claim) {
          reasons.push('UNTRUSTED_EVIDENCE');
          continue;
        }
        counts.set(claim.kind, (counts.get(claim.kind) ?? 0) + 1);
        compareEvidence(claim, reasons);
      }
      for (const kind of mandatoryKinds) {
        const count = counts.get(kind) ?? 0;
        if (count === 0) reasons.push(`MISSING_${kind.toUpperCase()}`);
        if (count > 1) reasons.push(`DUPLICATE_${kind.toUpperCase()}`);
      }
      return Object.freeze({ ready: reasons.length === 0, reasons: uniqueReasons(reasons), tenantId: config.tenantId, evaluatedAt: now().toISOString() });
    },
  });
  const infrastructureGate = Object.freeze({
    evaluate(request: { action: TestAmberAction; session: TestTrustedSession; authorization?: TestTrustedAuthorizationDecision }) {
      const status = config.infrastructureBinding.status;
      if (status === 'green') return { allowNewProvisioning: true, allowActivation: true, keepHealthyDeploymentsRunning: true, operatorReviewRequired: false, operatorReviewRecorded: false } as const;
      if (status === 'red' || status === 'unknown') return { allowNewProvisioning: false, allowActivation: false, keepHealthyDeploymentsRunning: true, operatorReviewRequired: false, operatorReviewRecorded: false } as const;
      const reasons = authorizationReasons(request.session, request.authorization, request.action);
      const allowed = reasons.length === 0;
      return {
        allowNewProvisioning: allowed && request.action === 'provision',
        allowActivation: allowed && request.action === 'activate',
        keepHealthyDeploymentsRunning: true,
        operatorReviewRequired: true,
        operatorReviewRecorded: allowed,
        reasons: uniqueReasons(reasons),
      } as const;
    },
  });

  return Object.freeze({ authentication, providers, authorization, readiness, infrastructureGate });
}
