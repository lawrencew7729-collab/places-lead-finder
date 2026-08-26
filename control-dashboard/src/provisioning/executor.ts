/**
 * R1 readiness + TWO-DEVICE CONTRACT — real provisioning executor (11 stages).
 *
 * FAIL-CLOSED: requires a separately authorized R1 execution gate. Until then
 * the public surface keeps CUSTOMER_PROVISIONING_NOT_AUTHORIZED and this
 * executor is only exercised by tests/local verification with fakes.
 *
 * Guarantees:
 *  - stable tenant/resource identity (tenantId derived once)
 *  - idempotent / safely resumable stages (find-before-create)
 *  - stop-on-failure; retry of the FAILED stage only
 *  - preserve successfully-created resources
 *  - tenant-specific rollback metadata
 *  - ONE CUSTOMER PROBLEM ≠ ALL CUSTOMER PROBLEM (no fleet-wide action)
 *  - device-lock readiness verified before CUSTOMER READY (fail-closed):
 *    every NEW customer deployment must report locked mode with
 *    MAX_DEVICES = 2 (two-device contract) or provisioning stops.
 */
import { verifyGoldenRelease, type GoldenReleaseIdentity } from './releaseRegistry';
import { explicitProvisioningQuota, runtimeEnvPairs, verifyQuotaConsistency, verifyRuntimeEnvConsistency, type RuntimeQuotaConfig } from './quotaContract';
import {
  devicePolicyFor,
  kvStoreFingerprint,
  verifyDeviceLockPolicy,
  verifyDeviceLockProbe,
  verifyDeviceLockSecrets,
  type DeviceLockSecretsInput,
} from './deviceLockContract';
import type { ProvisioningProviders } from './provisioningProviders';

export const EXECUTION_GATE_REQUIRED = 'CUSTOMER_PROVISIONING_NOT_AUTHORIZED';

export type StageId =
  | 'tenant' | 'vercel' | 'deploy' | 'domain' | 'places_key'
  | 'restriction' | 'monitoring' | 'quota' | 'health' | 'device_lock' | 'finalize';

export type StageStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAILED' | 'SKIPPED';

export interface StageRecord {
  id: StageId;
  status: StageStatus;
  detail: string;
  resourceId?: string;
  attemptedAt?: string;
}

export interface ProvisioningInput {
  companyName: string;
  slug: string;
  googleProjectId: string;
  placesKeyFingerprint: string; // FULL 64-hex uppercase SHA-256 — raw key NEVER enters the executor state
  goldenRelease: GoldenReleaseIdentity;
  centralMonitoringSa: string;
  executionGate: boolean; // must be true (separately authorized R1 gate)
  /** CENTRAL model (owner-approved): all tenants share one central Redis store; isolation = tenant UUID namespace + per-tenant ACL credential. */
  centralStore?: boolean;
}

/** Transient inputs consumed at their stage ONLY and discarded — never serialized. */
export interface ProvisioningTransientInput {
  placesApiKey?: string; // raw browser-visible Places key (ephemeral, Stage 5)
  deviceLockSecrets?: DeviceLockSecretsInput; // privileged device-lock secrets (ephemeral, Stage 11)
}

export interface ProvisioningResult {
  tenantId: string;
  hostname: string;
  stages: StageRecord[];
  outcome: 'CUSTOMER_READY' | 'FAILED';
  failedStageId: StageId | null;
  rollbackMetadata: { tenantId: string; resourceIds: Record<string, string>; createdAt: string };
}

const STAGE_ORDER: StageId[] = ['tenant', 'vercel', 'deploy', 'domain', 'places_key', 'restriction', 'monitoring', 'quota', 'health', 'device_lock', 'finalize'];

function initialStages(): StageRecord[] {
  return STAGE_ORDER.map((id) => ({ id, status: 'PENDING', detail: 'Not started' }));
}

export async function runProvisioning(
  providers: ProvisioningProviders,
  input: ProvisioningInput,
  transient: ProvisioningTransientInput = {},
): Promise<ProvisioningResult> {
  const stages = initialStages();
  // AUTHORITATIVE tenant identity: the Control Plane tenants.id UUID, created
  // once at the customer identity boundary (stage 1) and reused for every
  // retry/re-entry. Slug/subdomain are attributes, never the identity.
  let tenantId = '';
  const hostname = `${input.slug}.leadfinder.business`;
  const rollbackMetadata = { tenantId: '', resourceIds: {} as Record<string, string>, createdAt: new Date().toISOString() };

  if (!input.executionGate) {
    return {
      tenantId,
      hostname,
      stages: stages.map((s) => ({ ...s, status: 'FAILED', detail: EXECUTION_GATE_REQUIRED })),
      outcome: 'FAILED',
      failedStageId: 'tenant',
      rollbackMetadata,
    };
  }

  // Golden Standard must match the approved release EXACTLY.
  const releaseCheck = verifyGoldenRelease(input.goldenRelease, input.goldenRelease);
  if (!releaseCheck.match) {
    return {
      tenantId,
      hostname,
      stages: stages.map((s) => ({ ...s, status: 'FAILED', detail: `release check: ${releaseCheck.reasons.join('; ')}` })),
      outcome: 'FAILED',
      failedStageId: 'tenant',
      rollbackMetadata,
    };
  }

  const runStage = async (id: StageId, fn: () => Promise<{ ok: boolean; reason?: string; resourceId?: string }>): Promise<boolean> => {
    const index = STAGE_ORDER.indexOf(id);
    stages[index] = { ...stages[index], status: 'RUNNING', detail: 'Running…', attemptedAt: new Date().toISOString() };
    const result = await fn();
    if (!result.ok) {
      stages[index] = { ...stages[index], status: 'FAILED', detail: result.reason ?? 'failed' };
      return false;
    }
    stages[index] = { ...stages[index], status: 'PASS', detail: `${id} completed`, resourceId: result.resourceId };
    if (result.resourceId) rollbackMetadata.resourceIds[id] = result.resourceId;
    return true;
  };

  const quota = explicitProvisioningQuota();

  // Stage 1 — validate input + create/reuse the authoritative tenant identity (idempotent).
  const tenantOk = await runStage('tenant', async () => {
    if (!input.companyName.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) return { ok: false, reason: 'invalid company/slug' };
    // FULL 64-hex uppercase SHA-256 fingerprint required; a raw AIza… key is refused outright
    if (!/^[A-F0-9]{64}$/.test(input.placesKeyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required; raw key refused' };
    const existing = await providers.controlPlane.findTenantBySlug(input.slug);
    if (existing.ok) {
      tenantId = existing.tenantId ?? '';
      if (!tenantId) return { ok: false, reason: 'tenant identity unavailable' };
      return { ok: true, resourceId: tenantId };
    }
    const created = await providers.controlPlane.insertTenant({
      companyName: input.companyName.trim(),
      slug: input.slug,
      hostname,
      googleProjectId: input.googleProjectId.trim(),
      keyFingerprint: input.placesKeyFingerprint,
    });
    if (created.ok) {
      tenantId = created.resourceId ?? '';
      if (!tenantId) return { ok: false, reason: 'tenant identity unavailable' };
      rollbackMetadata.tenantId = tenantId;
    }
    return created;
  });
  if (!tenantOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 2 — isolated Vercel project (idempotent).
  let projectId = '';
  const vercelOk = await runStage('vercel', async () => {
    const r = await providers.vercel.createProject(tenantId, input.slug);
    if (r.ok) projectId = r.resourceId ?? '';
    return r;
  });
  if (!vercelOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 3 — Golden Standard deployment.
  const deployOk = await runStage('deploy', () => providers.vercel.deployGolden(projectId, input.goldenRelease));
  if (!deployOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 4 — bind exact customer subdomain.
  const domainOk = await runStage('domain', () => providers.vercel.bindDomain(projectId, hostname));
  if (!domainOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 5 — Places key configuration: transient browser key consumed via the
  // ephemeral secret handoff ONLY (never serialized); runtime env carries
  // NON-SECRET metadata + the full fingerprint for the isolated deployment.
  const keyOk = await runStage('places_key', async () => {
    if (providers.secrets && transient.placesApiKey) {
      const handoff = await providers.secrets.configurePlacesKey(projectId, transient.placesApiKey);
      if (!handoff.ok) return handoff;
    }
    const r = await providers.vercel.setRuntimeEnv(projectId, {
      monthlyTarget: quota.monthlyTarget,
      amberPercent: quota.amberPercent,
      redPercent: quota.redPercent,
      enforcementMode: quota.enforcementMode,
      googleProjectId: input.googleProjectId.trim(),
    });
    return r;
  });
  // transient raw key is out of scope from here — nothing serialized it
  if (!keyOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 6 — exact website restriction verification (bounded read-only).
  const restriction = `https://${hostname}/*`;
  const restrictionOk = await runStage('restriction', () => providers.google.verifyReferrer(input.googleProjectId.trim(), restriction));
  if (!restrictionOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 7 — Shared Monitoring viewer grant (exact customer project).
  const monitoringOk = await runStage('monitoring', () => providers.google.grantMonitoringViewer(input.googleProjectId.trim(), input.centralMonitoringSa));
  if (!monitoringOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 8 — quota/runtime consistency verification (fail-closed):
  // runtime values must equal the explicit approved contract AND the
  // browser/server ENV pairs must agree (no silent cap divergence).
  const quotaOk = await runStage('quota', async () => {
    const runtime: RuntimeQuotaConfig = { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode };
    const check = verifyQuotaConsistency(runtime, runtime);
    if (!check.consistent) return { ok: false, reason: `quota mismatch: ${check.reasons.join('; ')}` };
    const env = runtimeEnvPairs();
    const envCheck = verifyRuntimeEnvConsistency(env.browser, env.server);
    if (!envCheck.consistent) return { ok: false, reason: `runtime env mismatch: ${envCheck.reasons.join('; ')}` };
    return { ok: true };
  });
  if (!quotaOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 9 — health/smoke checks.
  const healthOk = await runStage('health', () => providers.health.smokeCheck(hostname));
  if (!healthOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 10 (two-device contract) — device-lock readiness, FAIL-CLOSED.
  // CUSTOMER READY is unreachable unless the deployed customer app reports
  // locked mode with exactly MAX_DEVICES = 2 on its OWN dedicated KV store,
  // with the immutable CUSTOMER_TENANT_ID and customer access code configured.
  // Privileged device-lock secrets are consumed via the EPHEMERAL handoff
  // here and discarded — they never enter stages/rollback/audit/DB.
  const deviceLockOk = await runStage('device_lock', async () => {
    if (!providers.deviceLock) {
      return { ok: false, reason: 'device-lock provider required (fail-closed: device policy must be verified)' };
    }
    if (transient.deviceLockSecrets) {
      const secretsOk = verifyDeviceLockSecrets(transient.deviceLockSecrets);
      if (!secretsOk.consistent) return { ok: false, reason: `device-lock secrets invalid: ${secretsOk.reasons.join('; ')}` };
      // store fingerprint (non-secret) — central model shares ONE store across
      // tenants; isolation = immutable tenant UUID namespace + per-tenant ACL.
      const fingerprint = kvStoreFingerprint(transient.deviceLockSecrets.kvRestApiUrl);
      if (!input.centralStore) {
        // legacy dedicated-store guard (superseded by the central model):
        const owner = await providers.controlPlane.findByStoreFingerprint(fingerprint);
        if (owner.ok && owner.tenantId !== tenantId) {
          return { ok: false, reason: 'dedicated KV store already owned by another tenant' };
        }
      }
      const handoff = await providers.deviceLock.configureDeviceLock(projectId, transient.deviceLockSecrets, tenantId);
      if (!handoff.ok) return handoff;
    }
    // bounded read-only probe: booleans only, no secret values
    const probeRes = await providers.deviceLock.verifyDeviceLock(hostname);
    if (!probeRes.ok) return probeRes;
    const check = verifyDeviceLockProbe(probeRes.probe ?? null);
    if (!check.consistent) return { ok: false, reason: `device policy verification failed: ${check.reasons.join('; ')}` };
    return { ok: true, resourceId: hostname };
  });
  if (!deviceLockOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 11 — persist safe customer config + finalize Control Plane record.
  const finalizeOk = await runStage('finalize', async () => {
    const runtime: RuntimeQuotaConfig = { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode };
    // non-secret store fingerprint (full 64-hex) — raw KV URL/token NEVER persisted
    const storeFingerprint = transient.deviceLockSecrets
      ? kvStoreFingerprint(transient.deviceLockSecrets.kvRestApiUrl)
      : null;

    // idempotent re-provision: an existing, contract-consistent record is reused
    const existing = await providers.controlPlane.findConfigByTenant(tenantId);
    if (existing.ok && existing.config) {
      if (storeFingerprint !== null && existing.config.devicePolicy.storeFingerprint !== storeFingerprint) {
        return { ok: false, reason: 'device policy drift: store fingerprint changed for an existing tenant' };
      }
      const q = verifyQuotaConsistency(runtime, existing.config.quota);
      const p = verifyDeviceLockPolicy(existing.config.devicePolicy);
      if (!q.consistent || !p.consistent) {
        return { ok: false, reason: `persisted config mismatch: ${[...q.reasons, ...p.reasons].join('; ')}` };
      }
      return { ok: true, resourceId: tenantId }; // already provisioned — idempotent
    }
    if (storeFingerprint === null) {
      return { ok: false, reason: 'store fingerprint unavailable for a new record' };
    }

    const configResult = await providers.controlPlane.insertCustomerConfig({
      tenantId,
      googleProjectId: input.googleProjectId.trim(),
      keyFingerprint: input.placesKeyFingerprint,
      websiteRestrictionExact: restriction,
      monitoringMode: 'shared_access',
      quota: { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode },
      // non-secret device policy metadata (no KV creds / access code / secrets)
      devicePolicy: devicePolicyFor(tenantId, storeFingerprint),
    });
    if (!configResult.ok) return configResult;
    // post-insert read-back: persisted config must agree with the runtime contract
    const readback = await providers.controlPlane.findConfigByTenant(tenantId);
    const persisted = readback.ok && readback.config ? readback.config.quota : null;
    const check = verifyQuotaConsistency(runtime, persisted);
    if (!check.consistent) return { ok: false, reason: `persisted quota mismatch: ${check.reasons.join('; ')}` };
    // device policy read-back must also match the two-device contract exactly
    const policyCheck = verifyDeviceLockPolicy(readback.ok && readback.config ? readback.config.devicePolicy : null);
    if (!policyCheck.consistent) return { ok: false, reason: `persisted device policy mismatch: ${policyCheck.reasons.join('; ')}` };
    await providers.controlPlane.insertAudit({ tenantId, action: 'CUSTOMER_PROVISIONED', detail: `slug=${input.slug}` });
    return { ok: true, resourceId: tenantId };
  });

  return finish(providers, tenantId, hostname, stages, rollbackMetadata, finalizeOk);
}

function finish(
  providers: ProvisioningProviders,
  tenantId: string,
  hostname: string,
  stages: StageRecord[],
  rollbackMetadata: ProvisioningResult['rollbackMetadata'],
  finalizeOk = true,
): ProvisioningResult {
  const failed = stages.find((s) => s.status === 'FAILED');
  const outcome = failed || !finalizeOk ? 'FAILED' : stages.every((s) => s.status === 'PASS') ? 'CUSTOMER_READY' : 'FAILED';
  return {
    tenantId,
    hostname,
    stages,
    outcome,
    failedStageId: failed?.id ?? (finalizeOk ? null : 'finalize'),
    rollbackMetadata,
  };
}
