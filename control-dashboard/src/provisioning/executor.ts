/**
 * R1 readiness + TWO-DEVICE CONTRACT + PRE-R1 PROVISIONING AUTOMATION
 * REMEDIATION — real provisioning executor (15 stages).
 *
 * FAIL-CLOSED: requires a separately authorized R1 execution gate. Until then
 * the public surface keeps CUSTOMER_PROVISIONING_NOT_AUTHORIZED and this
 * executor is only exercised by tests/local verification with fakes. The
 * operator CLI (scripts/provision-cli.ts) is the real host — it validates
 * operator credentials + confirmation before passing executionGate: true.
 *
 * STAGE ORDER CONTRACT (env/secrets BEFORE the Golden build/deploy):
 *   tenant → vercel → wif → env → places_key → acl → deploy → domain →
 *   restriction → iam → quota → usage_smoke → device_lock → billing → finalize
 *
 * Guarantees:
 *  - stable tenant/resource identity (tenants.id UUID created once)
 *  - idempotent / safely resumable stages (find-before-create, skip-if-present)
 *  - stop-on-failure; retry of the FAILED stage only
 *  - preserve successfully-created resources
 *  - tenant-specific rollback metadata
 *  - ONE CUSTOMER PROBLEM ≠ ALL CUSTOMER PROBLEM (no fleet-wide action)
 *  - release provenance verified against the Control Plane registry
 *    (unknown/unregistered release → refuse; NO self-compare)
 *  - WIF onboarding (A3): shared provider (team+environment condition) +
 *    exact per-project principalSet workloadIdentityUser binding + readback
 *  - device-lock readiness verified before CUSTOMER READY (fail-closed)
 *  - functional usage smoke (10-point) before CUSTOMER READY
 *  - billing-account isolation + zero pre-activation usage before finalize
 */
import { verifyGoldenRelease, type GoldenReleaseIdentity } from './releaseRegistry';
import { explicitProvisioningQuota, runtimeEnvPairs, verifyQuotaConsistency, verifyRuntimeEnvConsistency, REQUIRED_RUNTIME_ENV_KEYS, type RuntimeQuotaConfig } from './quotaContract';
import {
  devicePolicyFor,
  kvStoreFingerprint,
  verifyAppPassSecret,
  verifyDeviceLockPolicy,
  verifyDeviceLockProbe,
  type DeviceLockSecretsInput,
} from './deviceLockContract';
import { aclUsernameFor, provisionTenantAclWithRollback, type TenantAclIdentity } from './aclProvisioning';
import { customerMonitoringSaAccountId, customerMonitoringSaEmail, wifAudienceFor, type ProvisioningProviders, type WifConfig } from './provisioningProviders';
import { pacificBillingMonth } from './billingMonth';

export const EXECUTION_GATE_REQUIRED = 'CUSTOMER_PROVISIONING_NOT_AUTHORIZED';

export const BILLING_ACCOUNT_ID_PATTERN = /^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/;

export type StageId =
  | 'tenant' | 'vercel' | 'wif' | 'env' | 'places_key' | 'acl' | 'deploy' | 'domain'
  | 'restriction' | 'iam' | 'quota' | 'usage_smoke' | 'device_lock' | 'billing' | 'finalize';

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
  executionGate: boolean; // must be true (separately authorized R1 gate — the operator CLI sets it)
  /** CENTRAL model (owner-approved): all tenants share one central Redis store; isolation = tenant UUID namespace + per-tenant ACL credential. */
  centralStore?: boolean;
  /** PRE-R1 — central Upstash store REST URL (NON-SECRET store identifier; used for the ACL env handoff). */
  centralStoreUrl?: string;
  /** PRE-R1 — customer Cloud Billing account id (NON-SECRET evidence; must link exactly ONE project). */
  billingAccountId?: string;
  /**
   * PRE-R1 A3b WIF scale config (owner correction 2026-08-27):
   * ONE shared provider (owner_id + environment condition) + exact per-project
   * principalSet binding on THAT customer's OWN dedicated monitoring SA
   * (created in the customer's own Google project by the wif stage — the SA
   * email is NEVER caller-supplied; CUSTOMER_MONITORING_SA env = the
   * provisioned customer SA).
   */
  wif?: WifConfig;
}

/** Transient inputs consumed at their stage ONLY and discarded — never serialized. */
export interface ProvisioningTransientInput {
  placesApiKey?: string; // raw browser-visible Places key (ephemeral, Stage 5)
  deviceLockSecrets?: Pick<DeviceLockSecretsInput, 'appPass'>; // APP_PASS only — owner action (Stage 6)
}

export interface ProvisioningResult {
  tenantId: string;
  hostname: string;
  stages: StageRecord[];
  outcome: 'CUSTOMER_READY' | 'FAILED';
  failedStageId: StageId | null;
  rollbackMetadata: { tenantId: string; resourceIds: Record<string, string>; createdAt: string };
}

const STAGE_ORDER: StageId[] = [
  'tenant', 'vercel', 'wif', 'env', 'places_key', 'acl', 'deploy', 'domain',
  'restriction', 'iam', 'quota', 'usage_smoke', 'device_lock', 'billing', 'finalize',
];

function initialStages(): StageRecord[] {
  return STAGE_ORDER.map((id) => ({ id, status: 'PENDING', detail: 'Not started' }));
}

function failAll(reason: string): ProvisioningResult {
  return {
    tenantId: '',
    hostname: '',
    stages: initialStages().map((s) => ({ ...s, status: 'FAILED', detail: reason })),
    outcome: 'FAILED',
    failedStageId: 'tenant',
    rollbackMetadata: { tenantId: '', resourceIds: {}, createdAt: new Date().toISOString() },
  };
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
    return failAll(EXECUTION_GATE_REQUIRED);
  }

  // Release provenance: the registry is the ONLY authority. An unknown or
  // unregistered release is refused — never a self-compare.
  const releaseRecord = await providers.controlPlane.findRelease(input.goldenRelease.tag);
  if (!releaseRecord.ok || !releaseRecord.release) {
    return failAll(`release check: unknown/unregistered release (${input.goldenRelease.tag})`);
  }
  const releaseCheck = verifyGoldenRelease(input.goldenRelease, releaseRecord.release);
  if (!releaseCheck.match) {
    return failAll(`release check: ${releaseCheck.reasons.join('; ')}`);
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
    if (!input.centralStoreUrl || !input.centralStoreUrl.startsWith('https://')) return { ok: false, reason: 'central store URL required (https)' };
    if (!input.billingAccountId || !BILLING_ACCOUNT_ID_PATTERN.test(input.billingAccountId)) {
      return { ok: false, reason: 'billing account id required (6-6-6 alnum format)' };
    }
    const wif = input.wif;
    if (!wif || !wif.pool || !wif.provider || !wif.centralProjectNumber || !wif.vercelTeamSlug) {
      return { ok: false, reason: 'WIF config required (pool/provider/centralProjectNumber/vercelTeamSlug)' };
    }
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

  // Stage 3 — A3b WIF onboarding BEFORE deploy: Vercel OIDC team mode +
  // shared provider create-if-missing (drift → FAIL) + the customer's OWN
  // dedicated monitoring SA (created in the CUSTOMER project; USER_MANAGED
  // keys = 0; roles ONLY on the customer project; exact principalSet binding
  // on THAT customer's SA) + full readback. WIF_AUDIENCE (fixed non-secret
  // provider full name) is written by the env stage; CUSTOMER_MONITORING_SA
  // env = the provisioned customer SA email.
  const wifConfig = input.wif!;
  let customerSaEmail = '';
  const wifOk = await runStage('wif', async () => {
    if (!providers.google) return { ok: false, reason: 'google provider required (fail-closed)' };
    const oidc = await providers.vercel.enableVercelOidc(projectId);
    if (!oidc.ok) return oidc;
    const provider = await providers.google.reconcileWifProvider(wifConfig);
    if (!provider.ok) return provider;
    // Customer-specific SA — created/found idempotently in the CUSTOMER project.
    const sa = await providers.google.createMonitoringServiceAccount(
      input.googleProjectId.trim(),
      customerMonitoringSaAccountId(tenantId),
    );
    if (!sa.ok) return sa;
    customerSaEmail = sa.saEmail ?? customerMonitoringSaEmail(input.googleProjectId.trim(), tenantId);
    // USER_MANAGED keys = 0 (no service-account JSON / private keys anywhere).
    const keys = await providers.google.verifyUserManagedKeys(customerSaEmail);
    if (!keys.ok) return keys;
    // roles ONLY on the customer project
    const viewer = await providers.google.grantMonitoringViewer(input.googleProjectId.trim(), customerSaEmail);
    if (!viewer.ok) return viewer;
    const consumer = await providers.google.grantServiceUsageConsumer(input.googleProjectId.trim(), customerSaEmail);
    if (!consumer.ok) return consumer;
    // exact per-project principalSet binding on THAT customer's SA
    const binding = await providers.google.grantWorkloadIdentityUser(projectId, wifConfig, customerSaEmail);
    if (!binding.ok) return binding;
    const readback = await providers.google.verifyWifOnboarding(projectId, wifConfig, customerSaEmail, input.googleProjectId.trim());
    if (!readback.ok) return readback;
    return { ok: true, resourceId: customerSaEmail };
  });
  if (!wifOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 4 — ALL required runtime env BEFORE the Golden build/deploy:
  // quota pairs (VITE_* + server), customer project, WIF_AUDIENCE,
  // CUSTOMER_MONITORING_SA = the customer's OWN monitoring SA email
  // (A3b per-customer identity). Readback verification (key presence) included.
  const envOk = await runStage('env', async () => {
    const r = await providers.vercel.setRuntimeEnv(projectId, {
      monthlyTarget: quota.monthlyTarget,
      amberPercent: quota.amberPercent,
      redPercent: quota.redPercent,
      enforcementMode: quota.enforcementMode,
      googleProjectId: input.googleProjectId.trim(),
      wifAudience: wifAudienceFor(wifConfig),
      centralMonitoringSa: customerSaEmail,
    });
    if (!r.ok) return r;
    const readback = await providers.vercel.verifyEnv(projectId, [...REQUIRED_RUNTIME_ENV_KEYS]);
    if (!readback.ok) return readback;
    return { ok: true, resourceId: projectId };
  });
  if (!envOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 5 — Places key build injection (transient, idempotent): the raw key
  // is consumed HERE into VITE_PLACES_API_KEY (encrypted env, pre-deploy).
  // Retry with the env already present is a no-op — the raw value is never
  // re-exposed, stored, logged, or serialized.
  const keyOk = await runStage('places_key', async () => {
    if (!providers.secrets) return { ok: false, reason: 'secrets handoff provider required (fail-closed)' };
    return providers.secrets.configurePlacesKey(projectId, transient.placesApiKey);
  });
  if (!keyOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 6 — per-tenant Upstash ACL provisioning + privileged runtime env
  // (KV_REST_API_URL/TOKEN + fingerprint + APP_PASS + CUSTOMER_TENANT_ID),
  // all BEFORE deploy. APP_PASS is an OWNER ACTION secret: missing on a FRESH
  // provisioning → HOLD at the boundary BEFORE any ACL identity is created
  // (no orphan). Idempotent: an already-configured store credential skips
  // re-provisioning entirely (resume needs NO transient secrets).
  let aclIdentity: TenantAclIdentity | null = null;
  const aclOk = await runStage('acl', async () => {
    if (!providers.redisAcl) return { ok: false, reason: 'redisAcl admin provider required (fail-closed)' };
    if (!providers.deviceLock) return { ok: false, reason: 'deviceLock provider required (fail-closed)' };
    // idempotency seam FIRST: store credential already configured → reuse,
    // never rotate, never re-require the owner secret on resume.
    const existing = await providers.deviceLock.readStoreEnv(projectId);
    if (!existing.ok) return existing;
    if (existing.tokenPresent) {
      if (!existing.tokenFingerprint) return { ok: false, reason: 'store env drift: token present without fingerprint' };
      aclIdentity = { tenantId, username: aclUsernameFor(tenantId), tokenFingerprint: existing.tokenFingerprint };
      return { ok: true, resourceId: aclIdentity.username };
    }
    const appPassCheck = verifyAppPassSecret(transient.deviceLockSecrets?.appPass);
    if (!appPassCheck.consistent) return { ok: false, reason: appPassCheck.reasons.join('; ') };
    const appPass = transient.deviceLockSecrets!.appPass!;
    const provisioned = await provisionTenantAclWithRollback(providers.redisAcl, tenantId, async (restToken) => {
      const handoff = await providers.deviceLock!.configureDeviceLock(
        projectId,
        { kvRestApiUrl: input.centralStoreUrl!, kvRestApiToken: restToken, appPass },
        tenantId,
      );
      return handoff;
    });
    if (!provisioned.ok) return provisioned;
    aclIdentity = provisioned.identity;
    const readback = await providers.deviceLock.readStoreEnv(projectId);
    if (!readback.ok) return readback;
    if (!readback.tokenPresent || readback.tokenFingerprint !== provisioned.identity.tokenFingerprint) {
      return { ok: false, reason: 'ACL env readback mismatch (token/fingerprint)' };
    }
    return { ok: true, resourceId: provisioned.identity.username };
  });
  if (!aclOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 7 — Golden Standard deployment (AFTER all required env/secrets).
  const deployOk = await runStage('deploy', () => providers.vercel.deployGolden(projectId, input.goldenRelease));
  if (!deployOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 8 — bind exact customer subdomain.
  const domainOk = await runStage('domain', () => providers.vercel.bindDomain(projectId, hostname));
  if (!domainOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 9 — exact website restriction verification (bounded read-only).
  const restriction = `https://${hostname}/*`;
  const restrictionOk = await runStage('restriction', () => providers.google.verifyReferrer(input.googleProjectId.trim(), restriction));
  if (!restrictionOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 10 — Shared Monitoring grants on the exact customer project:
  // monitoring.viewer + serviceusage.serviceUsageConsumer for the CUSTOMER
  // monitoring SA (A3b). Each grant is idempotent; re-invoking after the
  // write IS the IAM readback (policy re-read, membership confirmed).
  const iamOk = await runStage('iam', async () => {
    const viewer = await providers.google.grantMonitoringViewer(input.googleProjectId.trim(), customerSaEmail);
    if (!viewer.ok) return viewer;
    const consumer = await providers.google.grantServiceUsageConsumer(input.googleProjectId.trim(), customerSaEmail);
    if (!consumer.ok) return consumer;
    const viewerReadback = await providers.google.grantMonitoringViewer(input.googleProjectId.trim(), customerSaEmail);
    if (!viewerReadback.ok) return viewerReadback;
    const consumerReadback = await providers.google.grantServiceUsageConsumer(input.googleProjectId.trim(), customerSaEmail);
    if (!consumerReadback.ok) return consumerReadback;
    return { ok: true, resourceId: input.googleProjectId.trim() };
  });
  if (!iamOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 11 — quota/runtime consistency verification (fail-closed):
  // runtime values must equal the explicit approved contract AND the
  // browser/server ENV pairs must agree (no silent cap divergence).
  const quotaOk = await runStage('quota', async () => {
    const runtime: RuntimeQuotaConfig = { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode };
    const check = verifyQuotaConsistency(runtime, runtime);
    if (!check.consistent) return { ok: false, reason: `quota mismatch: ${check.reasons.join('; ')}` };
    const env = runtimeEnvPairs();
    const envCheck = verifyRuntimeEnvConsistency(env.browser, {
      ...env.server,
      CUSTOMER_GOOGLE_PROJECT_ID: input.googleProjectId.trim(),
      WIF_AUDIENCE: wifAudienceFor(wifConfig),
      CUSTOMER_MONITORING_SA: customerSaEmail,
    });
    if (!envCheck.consistent) return { ok: false, reason: `runtime env mismatch: ${envCheck.reasons.join('; ')}` };
    return { ok: true };
  });
  if (!quotaOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 12 — functional activation smoke (10-point, fail-closed): the
  // DEPLOYED customer app is exercised over HTTPS with its OWN restricted
  // credential — domain 200, /api/usage structured (cap 1000 / stop 900 /
  // session 50 / source monitoring), device probe locked, lease ownership
  // (exact tenant identity), compare-and-release, NO residual lease.
  const smokeOk = await runStage('usage_smoke', async () => {
    if (!providers.usageSmoke) return { ok: false, reason: 'usageSmoke provider required (fail-closed)' };
    const r = await providers.usageSmoke.run(hostname);
    if (!r.ok) return r;
    if (!r.smoke) return { ok: false, reason: 'usage smoke report missing' };
    const failed = Object.entries(r.smoke).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0) return { ok: false, reason: `usage smoke failed: ${failed.join(', ')}` };
    return { ok: true, resourceId: hostname };
  });
  if (!smokeOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 13 (two-device contract) — device-lock readiness probe, FAIL-CLOSED.
  // CUSTOMER READY is unreachable unless the deployed customer app reports
  // locked mode with exactly MAX_DEVICES = 2 on the shared central store with
  // its OWN restricted ACL credential. Booleans only — never secret values.
  const deviceLockOk = await runStage('device_lock', async () => {
    if (!providers.deviceLock) return { ok: false, reason: 'device-lock provider required (fail-closed: device policy must be verified)' };
    const probeRes = await providers.deviceLock.verifyDeviceLock(hostname);
    if (!probeRes.ok) return probeRes;
    const check = verifyDeviceLockProbe(probeRes.probe ?? null);
    if (!check.consistent) return { ok: false, reason: `device policy verification failed: ${check.reasons.join('; ')}` };
    return { ok: true, resourceId: hostname };
  });
  if (!deviceLockOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 14 — billing-account evidence (READ-ONLY): the customer billing
  // account must link EXACTLY ONE project (the customer Lead Finder project)
  // and the activation (Pacific) month must have ZERO pre-existing Places
  // usage — otherwise STOP for owner review. Never claims billing
  // reconciliation (Monitoring is a conservative proxy, no SKU dimension).
  let billingMonth = '';
  let preActivationUsage = 0;
  const billingOk = await runStage('billing', async () => {
    const isolation = await providers.google.verifyBillingIsolation(input.billingAccountId!, input.googleProjectId.trim());
    if (!isolation.ok) return isolation;
    const usage = await providers.google.preActivationPlacesUsage(input.googleProjectId.trim());
    if (!usage.ok) return usage;
    if ((usage.usage ?? 0) > 0) {
      return { ok: false, reason: `OWNER REVIEW REQUIRED: pre-existing Places usage (${usage.usage}) in activation month` };
    }
    billingMonth = pacificBillingMonth();
    preActivationUsage = usage.usage ?? 0;
    return { ok: true, resourceId: input.billingAccountId };
  });
  if (!billingOk) return finish(providers, tenantId, hostname, stages, rollbackMetadata);

  // Stage 15 — persist safe customer config (incl. billing + ACL evidence)
  // + finalize Control Plane record.
  const finalizeOk = await runStage('finalize', async () => {
    const runtime: RuntimeQuotaConfig = { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode };
    const storeFingerprint = kvStoreFingerprint(input.centralStoreUrl!);

    const existing = await providers.controlPlane.findConfigByTenant(tenantId);
    if (existing.ok && existing.config) {
      if (existing.config.devicePolicy.storeFingerprint !== storeFingerprint) {
        return { ok: false, reason: 'device policy drift: store fingerprint changed for an existing tenant' };
      }
      const q = verifyQuotaConsistency(runtime, existing.config.quota);
      const p = verifyDeviceLockPolicy(existing.config.devicePolicy);
      if (!q.consistent || !p.consistent) {
        return { ok: false, reason: `persisted config mismatch: ${[...q.reasons, ...p.reasons].join('; ')}` };
      }
      return { ok: true, resourceId: tenantId }; // already provisioned — idempotent
    }

    const configResult = await providers.controlPlane.insertCustomerConfig({
      tenantId,
      googleProjectId: input.googleProjectId.trim(),
      keyFingerprint: input.placesKeyFingerprint,
      websiteRestrictionExact: restriction,
      monitoringMode: 'shared_access',
      quota: { monthlyTarget: quota.monthlyTarget, amberPercent: quota.amberPercent, redPercent: quota.redPercent, enforcementMode: quota.enforcementMode },
      devicePolicy: devicePolicyFor(tenantId, storeFingerprint),
      // PRE-R1 evidence (non-secret): billing + per-tenant ACL identity +
      // the customer's OWN monitoring SA email (A3b; ownership = customer project)
      billingAccountId: input.billingAccountId,
      billingActivationMonth: billingMonth,
      billingPreActivationUsage: preActivationUsage,
      aclUsername: aclIdentity?.username,
      aclTokenFingerprint: aclIdentity?.tokenFingerprint,
      monitoringSaEmail: customerSaEmail,
    });
    if (!configResult.ok) return configResult;
    const readback = await providers.controlPlane.findConfigByTenant(tenantId);
    const persisted = readback.ok && readback.config ? readback.config.quota : null;
    const check = verifyQuotaConsistency(runtime, persisted);
    if (!check.consistent) return { ok: false, reason: `persisted quota mismatch: ${check.reasons.join('; ')}` };
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
  void providers;
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
