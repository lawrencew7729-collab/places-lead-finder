import { createQuotaPolicy, normalizeCustomerHostname, validateServerFingerprintMetadata, validateTenantId, type MonitoringMode, type ServerFingerprintMetadata, type Signal } from './domain';
import type { WizardState } from './wizardWorkflow';

export type OnboardingOperation = 'create_draft' | 'save_onboarding_checkpoint';
export interface LocalProviderEvidenceRecord {
  kind: 'google_places' | 'monitoring' | 'vercel_capacity' | 'deployment_health';
  tenantId: string;
  status: 'pass' | 'warning' | 'fail' | 'unknown' | 'not_checked' | 'pending';
  source: 'mock' | 'provider';
  resourceId: string;
  diagnosticReason: string;
  collectedAt: string;
}
export interface OnboardingCheckpointInput {
  tenantId: string;
  companyName: string;
  slug: string;
  hostname: string;
  googleProjectId: string;
  keyFingerprint: ServerFingerprintMetadata;
  runtimeArchitecture: 'browser_direct';
  monitoringMode: MonitoringMode;
  monitoringBinding: { projectId: string; resourceId: string };
  providerEvidence: LocalProviderEvidenceRecord[];
  quotaPolicy: { monthlyTarget: 1000; amberPercent: number; redPercent: number; status: 'owner_configured' };
  releaseIdentity: { releaseId: string; gitSha: string; artifactSha256: string };
  vercelBinding: { projectId: string; deploymentId: string };
  infrastructureBinding: { status: Signal; evidenceVersion: string };
  wizardState: WizardState;
  readinessState: { ready: boolean; reasons: string[] };
}

export interface LocalTenantRow { tenantId: string; companyName: string; hostname: string; status: 'draft' }
export interface LocalConfigRow { tenantId: string; monthlyTarget: 1000; amberPercent: number; redPercent: number }
export interface LocalAuditRow {
  tenantId: string;
  actorType: 'local_review';
  operatorId: null;
  operatorRole: null;
  actorLabel: string;
  action: string;
  at: string;
}
export interface OwnedResource { tenantId: string; resourceId: string }
export interface SavedOnboardingCheckpoint extends OnboardingCheckpointInput {
  savedAt: string;
  operationIdentity: string;
  audit: LocalAuditRow;
}

export interface AuthoritativeReadinessConfiguration {
  tenantId: string;
  hostname: string;
  googleProjectId: string;
  monitoringBinding: { projectId: string; resourceId: string };
  quotaPolicy: { monthlyTarget: 1000; amberPercent: number; redPercent: number };
  releaseIdentity: { releaseId: string; gitSha: string; artifactSha256: string };
  vercelBinding: { projectId: string; deploymentId: string };
  infrastructureBinding: { status: Signal; evidenceVersion: string };
}

const VOLATILE_KEYS = new Set(['at', 'computedAt', 'checkedAt', 'collectedAt', 'measurementTimestamp', 'collectionTimestamp', 'evaluatedAt', 'savedAt', 'operationIdentity', 'audit']);

function canonicalize(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, parentKey));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item, key)]),
  );
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return ['tenantId', 'hostname', 'slug'].includes(parentKey) ? trimmed.toLowerCase() : trimmed;
  }
  return value;
}

export async function canonicalPayloadSha256(payload: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 unavailable');
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(payload)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function deriveOperationIdentity(operation: OnboardingOperation, tenantId: string, payload: unknown): Promise<string> {
  if (!validateTenantId(tenantId)) throw new Error('UUID Tenant ID required for operation identity');
  return canonicalPayloadSha256({ operation, tenantId: tenantId.toLowerCase(), payload });
}

function assertNoSecretShapedKeys(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|password|raw.*key|credential|service.?role|private.?key/i.test(key)) throw new Error('Raw secret-shaped fields are forbidden');
    assertNoSecretShapedKeys(item);
  }
}

/** App-scoped in-memory P0 adapter. It never uses browser storage or an external system. */
export class InMemoryOnboardingRepository {
  private tenants = new Map<string, LocalTenantRow>();
  private configs = new Map<string, LocalConfigRow>();
  private audits: LocalAuditRow[] = [];
  private checkpoints = new Map<string, SavedOnboardingCheckpoint>();
  private idempotency = new Map<string, SavedOnboardingCheckpoint>();

  async saveOnboardingCheckpointAtomic(input: OnboardingCheckpointInput, options?: { failAudit?: boolean }): Promise<SavedOnboardingCheckpoint> {
    if (options && Object.keys(options).some((key) => key !== 'failAudit')) throw new Error('Operation identity and actor attribution are derived internally and cannot be overridden by caller');
    if (Object.keys(input as unknown as Record<string, unknown>).some((key) => /^(actor|operator)(UserId|Id|Label|Role)$/i.test(key))) throw new Error('Caller-supplied actor attribution is forbidden');
    assertNoSecretShapedKeys(input);
    if (!validateTenantId(input.tenantId) || input.wizardState.tenantId !== input.tenantId) throw new Error('UUID Tenant/checkpoint mismatch rejected');
    if (!input.companyName.trim() || !input.googleProjectId.trim()) throw new Error('Complete customer and Google project identity required');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug.trim().toLowerCase())) throw new Error('Canonical tenant slug required');
    const hostname = normalizeCustomerHostname(input.hostname);
    const keyFingerprint = validateServerFingerprintMetadata(input.keyFingerprint);
    const policy = createQuotaPolicy({ monthlyTarget: input.quotaPolicy.monthlyTarget, amberPercent: input.quotaPolicy.amberPercent, redPercent: input.quotaPolicy.redPercent, enforcementMode: 'warn_only' });
    if (policy.monthlyTarget !== 1000 || input.quotaPolicy.status !== 'owner_configured') throw new Error('Approved owner-configured quota policy required');
    if (!/^[0-9a-f]{40}$/i.test(input.releaseIdentity.gitSha) || !/^[0-9a-f]{64}$/i.test(input.releaseIdentity.artifactSha256)) throw new Error('Exact immutable release Git/artifact identity required');
    if (!input.releaseIdentity.releaseId.trim() || !input.vercelBinding.projectId.trim() || !input.vercelBinding.deploymentId.trim()) throw new Error('Exact release and Vercel resource identity required');
    if (!input.monitoringBinding.projectId.trim() || !input.monitoringBinding.resourceId.trim()) throw new Error('Exact monitoring project/resource identity required');
    if (!input.infrastructureBinding.evidenceVersion.trim()) throw new Error('Authoritative infrastructure evidence version required');
    if (input.providerEvidence.length !== 4 || input.providerEvidence.some((item) => item.tenantId !== input.tenantId || Number.isNaN(Date.parse(item.collectedAt)))) throw new Error('Complete tenant-bound provider evidence required');
    const evidenceKinds = new Set(input.providerEvidence.map((item) => item.kind));
    if (evidenceKinds.size !== 4) throw new Error('Every provider evidence kind is required exactly once');
    const expectedEvidenceResources: Record<LocalProviderEvidenceRecord['kind'], string> = {
      google_places: input.googleProjectId.trim(),
      monitoring: input.monitoringBinding.resourceId.trim(),
      vercel_capacity: input.vercelBinding.projectId.trim(),
      deployment_health: input.vercelBinding.deploymentId.trim(),
    };
    if (input.providerEvidence.some((item) => item.resourceId !== expectedEvidenceResources[item.kind])) throw new Error('Provider evidence/resource binding mismatch');
    const existingHostOwner = Array.from(this.tenants.values()).find((row) => row.hostname === hostname && row.tenantId !== input.tenantId);
    if (existingHostOwner) throw new Error('Duplicate tenant hostname');

    const normalized: OnboardingCheckpointInput = {
      ...structuredClone(input),
      companyName: input.companyName.trim(),
      slug: input.slug.trim().toLowerCase(),
      hostname,
      googleProjectId: input.googleProjectId.trim(),
      keyFingerprint,
      monitoringBinding: { projectId: input.monitoringBinding.projectId.trim(), resourceId: input.monitoringBinding.resourceId.trim() },
      quotaPolicy: { monthlyTarget: 1000, amberPercent: policy.amberPercent, redPercent: policy.redPercent, status: 'owner_configured' },
      releaseIdentity: {
        releaseId: input.releaseIdentity.releaseId.trim(),
        gitSha: input.releaseIdentity.gitSha.toLowerCase(),
        artifactSha256: input.releaseIdentity.artifactSha256.toUpperCase(),
      },
      vercelBinding: { projectId: input.vercelBinding.projectId.trim(), deploymentId: input.vercelBinding.deploymentId.trim() },
      infrastructureBinding: { status: input.infrastructureBinding.status, evidenceVersion: input.infrastructureBinding.evidenceVersion.trim() },
    };
    const operationIdentity = await deriveOperationIdentity('save_onboarding_checkpoint', normalized.tenantId, normalized);
    const prior = this.idempotency.get(operationIdentity);
    if (prior) return structuredClone(prior);

    const savedAt = new Date().toISOString();
    const tenant: LocalTenantRow = { tenantId: normalized.tenantId, companyName: normalized.companyName, hostname, status: 'draft' };
    const config: LocalConfigRow = { tenantId: normalized.tenantId, monthlyTarget: 1000, amberPercent: policy.amberPercent, redPercent: policy.redPercent };
    const audit: LocalAuditRow = {
      tenantId: normalized.tenantId,
      actorType: 'local_review',
      operatorId: null,
      operatorRole: null,
      actorLabel: 'Unauthenticated Local Review',
      action: 'LOCAL_ONBOARDING_CHECKPOINT_SAVED',
      at: savedAt,
    };
    const checkpoint: SavedOnboardingCheckpoint = { ...normalized, savedAt, operationIdentity, audit };

    // Stage every validated row before publishing any state.
    if (options?.failAudit) throw new Error('Atomic onboarding checkpoint rolled back: audit write failed');
    this.tenants.set(normalized.tenantId, tenant);
    this.configs.set(normalized.tenantId, config);
    this.checkpoints.set(normalized.tenantId, checkpoint);
    this.audits.push(audit);
    this.idempotency.set(operationIdentity, checkpoint);
    return structuredClone(checkpoint);
  }

  resume(tenantId: string): SavedOnboardingCheckpoint | null { return structuredClone(this.checkpoints.get(tenantId) ?? null); }
  readTenant(tenantId: string): LocalTenantRow | null { return structuredClone(this.tenants.get(tenantId) ?? null); }
  readLatestCheckpoint(): SavedOnboardingCheckpoint | null {
    const latest = Array.from(this.checkpoints.values()).at(-1);
    return structuredClone(latest ?? null);
  }

  readAuthoritativeReadinessConfiguration(tenantId: string): AuthoritativeReadinessConfiguration {
    const checkpoint = this.checkpoints.get(tenantId);
    if (!checkpoint) throw new Error('Authoritative repository configuration not found');
    return Object.freeze(structuredClone({
      tenantId: checkpoint.tenantId,
      hostname: checkpoint.hostname,
      googleProjectId: checkpoint.googleProjectId,
      monitoringBinding: checkpoint.monitoringBinding,
      quotaPolicy: {
        monthlyTarget: checkpoint.quotaPolicy.monthlyTarget,
        amberPercent: checkpoint.quotaPolicy.amberPercent,
        redPercent: checkpoint.quotaPolicy.redPercent,
      },
      releaseIdentity: checkpoint.releaseIdentity,
      vercelBinding: checkpoint.vercelBinding,
      infrastructureBinding: checkpoint.infrastructureBinding,
    }));
  }

  assertResourceOwnership(requestTenantId: string, resource: OwnedResource): true {
    if (requestTenantId !== resource.tenantId || !this.tenants.has(requestTenantId)) throw new Error('Tenant/resource mismatch rejected');
    return true;
  }

  exportRedacted() {
    return structuredClone({ tenants: Array.from(this.tenants.values()), configs: Array.from(this.configs.values()), audits: this.audits, checkpoints: Array.from(this.checkpoints.values()) });
  }
}
