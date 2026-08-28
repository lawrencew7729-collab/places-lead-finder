/**
 * R1 readiness — provider boundary for the provisioning executor.
 *
 * Interfaces describe the REAL provider operations. The FakeProvider is the
 * deterministic in-memory implementation used by unit/integration tests and
 * local verification. Real provider adapters (Vercel API / Google IAM /
 * Supabase service layer / Upstash ACL admin) are implemented behind these
 * interfaces — NEVER invoked from the browser.
 *
 * PRE-R1 PROVISIONING AUTOMATION REMEDIATION (2026-08-27, LOCAL batch):
 *   - WIF onboarding (A3 design): shared provider (team+environment
 *     condition) + exact per-project principalSet authorization.
 *   - serviceUsageConsumer grant + IAM readback.
 *   - Billing-account evidence + pre-activation usage check (read-only).
 *   - Per-tenant Upstash ACL provisioning wired into the executor.
 *   - Usage smoke (functional /api/usage verification).
 *
 * Owner/operator manual steps (by design, NOT automated):
 *   - create customer Google Cloud project
 *   - create customer Places browser API key
 *   - apply exact website referrer restriction / API restriction in Google Console
 * The executor only VERIFIES referrer readiness (bounded, read-only).
 */
import type { GoldenReleaseIdentity } from './releaseRegistry';
import type { RuntimeQuotaConfig } from './quotaContract';
import { KV_REST_API_TOKEN_FINGERPRINT_KEY, type DeviceLockProbe, type DeviceLockSecretsInput, type DevicePolicy } from './deviceLockContract';
import { aclTokenFingerprint, type RedisAclAdmin } from './aclProvisioning';

export type ProviderResult = { ok: true; resourceId?: string } | { ok: false; reason: string };

/**
 * A3b WIF SCALE DESIGN (owner correction 2026-08-27; owner record
 * PRE-R1-PROVISIONING-AUTOMATION-REMEDIATION-DESIGN.md):
 * ONE shared OIDC provider in the central GCP project, condition
 * `assertion.owner_id == "<team-id>" && assertion.environment == "production"`
 * (stable immutable team claim — NO customer project_id in the condition),
 * tenant authorization = exact per-project principalSet workloadIdentityUser
 * binding on THAT customer's OWN dedicated monitoring service account
 * (created in the customer's own Google project; USER_MANAGED keys = 0;
 * roles granted ONLY in the customer's own project). A workload authorized
 * for Customer A can NEVER impersonate Customer B's SA, and SA_A holds no
 * permissions on Project B. WIF_AUDIENCE (the shared provider full name) is
 * identical for every customer.
 */
export interface WifConfig {
  /** Workload identity pool id (central GCP project). */
  pool: string;
  /** OIDC provider id inside the pool. */
  provider: string;
  /** Central GCP project NUMBER (used to build principalSet + audience). */
  centralProjectNumber: string;
  /** Vercel team SLUG (OIDC issuer + audience). */
  vercelTeamSlug: string;
  /** Vercel team ID (immutable `team_…` — the `owner_id` claim pin in the provider condition). */
  vercelTeamId: string;
}

/** Deterministic customer monitoring SA account id (created once per customer, in the CUSTOMER project). */
export function customerMonitoringSaAccountId(tenantId: string): string {
  return `lf-monitor-${tenantId.replace(/-/g, '').toLowerCase().slice(0, 12)}`;
}

/** Customer monitoring SA email — lives in the customer's OWN Google project. */
export function customerMonitoringSaEmail(googleProjectId: string, tenantId: string): string {
  return `${customerMonitoringSaAccountId(tenantId)}@${googleProjectId}.iam.gserviceaccount.com`;
}

export interface TenantInput {
  companyName: string;
  slug: string;
  hostname: string;
  googleProjectId: string;
  keyFingerprint: string;
}

export interface CustomerConfigInput {
  tenantId: string;
  googleProjectId: string;
  keyFingerprint: string;
  websiteRestrictionExact: string;
  monitoringMode: 'shared_access';
  quota: RuntimeQuotaConfig;
  /** R1 TWO-DEVICE CONTRACT — non-secret device policy metadata (no secrets). */
  devicePolicy: DevicePolicy;
  /** PRE-R1 — non-secret billing activation evidence (migration 011). */
  billingAccountId?: string;
  billingActivationMonth?: string;
  billingPreActivationUsage?: number;
  /** PRE-R1 — non-secret per-tenant ACL identity metadata (migration 011). */
  aclUsername?: string;
  aclTokenFingerprint?: string;
  /** PRE-R1 A3b — the customer's OWN monitoring SA email (ownership = customer project; non-secret). */
  monitoringSaEmail?: string;
}

export interface RuntimeEnvInput {
  monthlyTarget: number;
  amberPercent: number;
  redPercent: number;
  enforcementMode: string;
  googleProjectId: string;
  /** PRE-R1 — WIF pool-provider full name (non-secret; REQUIRED by api/usage.js). */
  wifAudience: string;
  /** PRE-R1 — impersonated monitoring SA (non-secret; default = central SA). */
  centralMonitoringSa: string;
}

export interface VercelProvider {
  createProject(tenantId: string, slug: string): Promise<ProviderResult>;
  deployGolden(projectId: string, release: GoldenReleaseIdentity): Promise<ProviderResult>;
  bindDomain(projectId: string, hostname: string): Promise<ProviderResult>;
  setRuntimeEnv(projectId: string, env: RuntimeEnvInput): Promise<ProviderResult>;
  /** PRE-R1 — enable Vercel OIDC (team issuer mode) on the customer project, idempotent. */
  enableVercelOidc(projectId: string): Promise<ProviderResult>;
  /** PRE-R1 — env readback: every required key must exist on the project (fail-closed). */
  verifyEnv(projectId: string, keys: string[]): Promise<ProviderResult>;
}

/**
 * Ephemeral secret handoff — Stage 5 ONLY.
 * Consumes the transient customer Places browser key to configure the isolated
 * deployment, then discards it. Idempotent: if the deployment already carries
 * VITE_PLACES_API_KEY, the handoff is a no-op (retry never re-exposes the key).
 * The raw value never enters serializable provisioning state.
 */
export interface SecretHandoff {
  configurePlacesKey(projectId: string, rawPlacesKey?: string): Promise<ProviderResult>;
}

/**
 * R1 TWO-DEVICE CONTRACT — device-lock handoff + readiness verification.
 *
 * `configureDeviceLock` is an EPHEMERAL secret handoff (acl stage ONLY): it
 * writes the customer-specific privileged device env (central store URL, the
 * per-tenant ACL REST token, its non-secret fingerprint, customer access
 * code APP_PASS, immutable CUSTOMER_TENANT_ID) to the isolated deployment,
 * then the raw values are discarded. Never persisted/logged.
 *
 * `readStoreEnv` is the idempotency seam: the acl stage checks whether the
 * store credential is ALREADY configured before re-provisioning (a retry must
 * not mint a second token or re-expose a raw value).
 *
 * `verifyDeviceLock` is a bounded read-only HTTPS probe against the deployed
 * customer app (/api/device?mode=probe) — BOOLEAN lock state only.
 */
export interface DeviceLockProvider {
  configureDeviceLock(projectId: string, secrets: DeviceLockSecretsInput, tenantId: string): Promise<ProviderResult>;
  readStoreEnv(projectId: string): Promise<ProviderResult & { tokenPresent?: boolean; tokenFingerprint?: string; storeUrl?: string }>;
  verifyDeviceLock(hostname: string): Promise<ProviderResult & { probe?: DeviceLockProbe }>;
}

export interface GoogleProvider {
  verifyReferrer(googleProjectId: string, restrictionExact: string): Promise<ProviderResult>;
  /** A3b: grant a role to the CUSTOMER monitoring SA on the exact customer project. */
  grantMonitoringViewer(googleProjectId: string, customerMonitoringSa: string): Promise<ProviderResult>;
  /** A3b: serviceusage.serviceUsageConsumer for the CUSTOMER SA on the exact customer quota project. */
  grantServiceUsageConsumer(googleProjectId: string, customerMonitoringSa: string): Promise<ProviderResult>;
  /** A3b: shared provider create-if-missing with the EXACT owner_id+environment template; drift → FAIL. */
  reconcileWifProvider(wif: WifConfig): Promise<ProviderResult>;
  /** A3b: create/find the customer's OWN monitoring SA inside the customer project (idempotent). */
  createMonitoringServiceAccount(googleProjectId: string, accountId: string): Promise<ProviderResult & { saEmail?: string }>;
  /** A3b: USER_MANAGED keys MUST be 0 (SYSTEM_MANAGED only) — no SA JSON/private keys anywhere. */
  verifyUserManagedKeys(saEmail: string): Promise<ProviderResult & { userManagedCount?: number }>;
  /** A3b: exact per-project principalSet workloadIdentityUser binding on THAT customer's SA. */
  grantWorkloadIdentityUser(projectId: string, wif: WifConfig, customerMonitoringSa: string): Promise<ProviderResult>;
  /** A3b: readback — provider template + SA in customer project + keys=0 + exact binding + roles on customer project only. */
  verifyWifOnboarding(projectId: string, wif: WifConfig, customerMonitoringSa: string, googleProjectId: string): Promise<ProviderResult>;
  /** A3b: offboarding/rollback — remove the exact principalSet member from THAT customer's SA only. */
  revokeWifOnboarding(projectId: string, wif: WifConfig, customerMonitoringSa: string): Promise<ProviderResult>;
  /** PRE-R1 — billing account links EXACTLY ONE project == the customer project (read-only). */
  verifyBillingIsolation(billingAccountId: string, googleProjectId: string): Promise<ProviderResult>;
  /** PRE-R1 — Places request_count in the Pacific activation month (conservative proxy; 0 required). */
  preActivationPlacesUsage(googleProjectId: string): Promise<ProviderResult & { usage?: number }>;
}

export interface ControlPlaneProvider {
  insertTenant(input: TenantInput): Promise<ProviderResult>;
  insertCustomerConfig(config: CustomerConfigInput): Promise<ProviderResult>;
  insertRelease(identity: GoldenReleaseIdentity): Promise<ProviderResult>;
  insertAudit(event: { tenantId: string; action: string; detail: string }): Promise<ProviderResult>;
  findTenantBySlug(slug: string): Promise<ProviderResult & { tenantId?: string }>;
  findConfigByTenant(tenantId: string): Promise<ProviderResult & { config?: CustomerConfigInput }>;
  /** PRE-R1 — dedicated-store uniqueness guard (central model skips it). */
  findByStoreFingerprint(fingerprint: string): Promise<ProviderResult & { tenantId?: string }>;
  /** PRE-R1 — authoritative release registry lookup (unknown tag → not found → FAIL). */
  findRelease(tag: string): Promise<ProviderResult & { release?: GoldenReleaseIdentity }>;
}

export interface HealthProvider {
  smokeCheck(hostname: string): Promise<ProviderResult>;
}

/** PRE-R1 — functional activation smoke: 10-point black-box HTTPS verification. */
export interface UsageSmokeReport {
  domainHealthy: boolean;
  usageStructured: boolean;
  capIs1000: boolean;
  safetyStopIs900: boolean;
  maxSessionIs50: boolean;
  monitoringSource: boolean;
  deviceProbeLocked: boolean;
  /** /api/session status sessionId === the /api/usage lease sessionId (exact tenant namespace). */
  tenantIdentityExact: boolean;
  /** after compare-and-release, /api/session status reports NO active lease. */
  noActiveLeaseAfterRelease: boolean;
}

export interface UsageSmokeProvider {
  run(hostname: string): Promise<ProviderResult & { smoke?: UsageSmokeReport }>;
}

export interface ProvisioningProviders {
  vercel: VercelProvider;
  google: GoogleProvider;
  controlPlane: ControlPlaneProvider;
  health: HealthProvider;
  /** Ephemeral Stage-5 secret handoff (optional — real adapters provide it). */
  secrets?: SecretHandoff;
  /** R1 TWO-DEVICE CONTRACT — ephemeral device-lock handoff + readiness probe (REQUIRED). */
  deviceLock?: DeviceLockProvider;
  /** PRE-R1 — per-tenant Upstash ACL admin transport (REQUIRED; fail-closed when absent). */
  redisAcl?: RedisAclAdmin;
  /** PRE-R1 — functional activation smoke (REQUIRED; fail-closed when absent). */
  usageSmoke?: UsageSmokeProvider;
}

/** Deterministic fake implementation for tests/local verification. */
export interface FakeProviders extends ProvisioningProviders {
  /** Test control: replace the simulated failure set (e.g. clear after a first run to test retry/resume). */
  setFailures(stages: string[]): void;
  /** Test control: force a deployment's device-lock probe to open mode (env drift simulation). */
  setDeviceLockOpen(hostname: string): void;
  /** Test control: simulate pre-existing Places usage in the activation month. */
  setPreActivationUsage(googleProjectId: string, usage: number): void;
  /** Test control: billing account links MORE than one project (isolation violation). */
  setBillingProjects(billingAccountId: string, projectIds: string[]): void;
}

export function createFakeProviders(options: { failAt?: string[] } = {}): FakeProviders {
  const failures = new Set(options.failAt ?? []);
  const projects = new Map<string, string>(); // tenantId -> projectId
  const domains = new Map<string, string>(); // hostname -> projectId
  const tenants = new Map<string, { id: string; hostname: string }>();
  const configs = new Map<string, CustomerConfigInput>();
  const releases = new Map<string, GoldenReleaseIdentity>();
  const audits: Array<{ tenantId: string; action: string }> = [];
  const deviceLockConfigured = new Map<string, { secrets: DeviceLockSecretsInput; tenantId: string }>(); // projectId -> config
  const deviceLockOpenHosts = new Set<string>(); // force-open simulation (env drift)
  const projectEnv = new Map<string, Map<string, { value: string; encrypted: boolean }>>(); // projectId -> key -> value
  const oidcEnabled = new Set<string>(); // projectIds with team-mode OIDC
  let wifProviderCreated = false;
  let wifProviderCondition = '';
  // A3b: per-customer monitoring SA state (SA lives in the CUSTOMER project).
  const customerSas = new Map<string, { googleProjectId: string; accountId: string; userManagedKeys: number; bindings: Set<string> }>(); // saEmail -> state
  const projectIam = new Map<string, Map<string, string[]>>(); // projectId -> role -> members
  const aclUsers = new Map<string, { password: string; token: string; keyspace: string; allowlist: string[] }>();
  const preActivationUsage = new Map<string, number>(); // projectId -> usage
  const billingProjects = new Map<string, string[]>(); // billingAccountId -> linked project ids
  const usageSmokeFailHosts = new Set<string>();

  const maybeFail = (stage: string): ProviderResult | null =>
    failures.has(stage) ? { ok: false, reason: `${stage} simulated failure` } : null;

  const envOf = (projectId: string): Map<string, { value: string; encrypted: boolean }> => {
    let env = projectEnv.get(projectId);
    if (!env) {
      env = new Map();
      projectEnv.set(projectId, env);
    }
    return env;
  };

  return {
    setFailures(stages) {
      failures.clear();
      for (const stage of stages) failures.add(stage);
    },
    setDeviceLockOpen(hostname: string) {
      deviceLockOpenHosts.add(hostname);
    },
    setPreActivationUsage(googleProjectId: string, usage: number) {
      preActivationUsage.set(googleProjectId, usage);
    },
    setBillingProjects(billingAccountId: string, projectIds: string[]) {
      billingProjects.set(billingAccountId, projectIds);
    },
    vercel: {
      async createProject(tenantId, slug) {
        const fail = maybeFail('vercel.createProject');
        if (fail) return fail;
        if (projects.has(tenantId)) return { ok: true, resourceId: projects.get(tenantId) }; // idempotent
        const projectId = `prj_fake_${slug}`;
        projects.set(tenantId, projectId);
        return { ok: true, resourceId: projectId };
      },
      async deployGolden(projectId, release) {
        const fail = maybeFail('vercel.deployGolden');
        if (fail) return fail;
        return { ok: true, resourceId: `dpl_fake_${release.version}` };
      },
      async bindDomain(projectId, hostname) {
        const fail = maybeFail('vercel.bindDomain');
        if (fail) return fail;
        if (domains.has(hostname) && domains.get(hostname) !== projectId) return { ok: false, reason: 'domain already bound to another project' };
        domains.set(hostname, projectId);
        return { ok: true, resourceId: hostname };
      },
      async setRuntimeEnv(projectId, env) {
        const fail = maybeFail('vercel.setRuntimeEnv');
        if (fail) return fail;
        if (env.monthlyTarget !== 1000 || env.amberPercent !== 85 || env.redPercent !== 90) {
          return { ok: false, reason: 'runtime quota must match approved contract' };
        }
        if (!env.wifAudience || !env.centralMonitoringSa || !env.googleProjectId) {
          return { ok: false, reason: 'runtime env incomplete (WIF_AUDIENCE / CUSTOMER_MONITORING_SA / project required)' };
        }
        const envMap = envOf(projectId);
        for (const [key, value] of [
          ['VITE_CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget)],
          ['VITE_CUSTOMER_AMBER_PERCENT', String(env.amberPercent)],
          ['VITE_CUSTOMER_RED_PERCENT', String(env.redPercent)],
          ['VITE_CUSTOMER_ENFORCEMENT_MODE', env.enforcementMode],
          ['CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget)],
          ['CUSTOMER_GOOGLE_PROJECT_ID', env.googleProjectId],
          ['WIF_AUDIENCE', env.wifAudience],
          ['CUSTOMER_MONITORING_SA', env.centralMonitoringSa],
        ]) {
          envMap.set(key, { value, encrypted: key.startsWith('VITE_') });
        }
        return { ok: true, resourceId: projectId };
      },
      async enableVercelOidc(projectId) {
        const fail = maybeFail('vercel.enableVercelOidc');
        if (fail) return fail;
        oidcEnabled.add(projectId);
        return { ok: true, resourceId: projectId };
      },
      async verifyEnv(projectId, keys) {
        const fail = maybeFail('vercel.verifyEnv');
        if (fail) return fail;
        const envMap = envOf(projectId);
        const missing = keys.filter((k) => !envMap.has(k));
        if (missing.length > 0) return { ok: false, reason: `env readback: missing ${missing.join(',')}` };
        return { ok: true, resourceId: projectId };
      },
    },
    google: {
      async verifyReferrer(googleProjectId, restrictionExact) {
        const fail = maybeFail('google.verifyReferrer');
        if (fail) return fail;
        if (!restrictionExact.endsWith('/*')) return { ok: false, reason: 'exact wildcard restriction required' };
        return { ok: true, resourceId: restrictionExact };
      },
      async grantMonitoringViewer(googleProjectId, customerMonitoringSa) {
        const fail = maybeFail('google.grantMonitoringViewer');
        if (fail) return fail;
        let roles = projectIam.get(googleProjectId);
        if (!roles) {
          roles = new Map();
          projectIam.set(googleProjectId, roles);
        }
        const members = new Set(roles.get('roles/monitoring.viewer') ?? []);
        members.add(`serviceAccount:${customerMonitoringSa}`);
        roles.set('roles/monitoring.viewer', Array.from(members));
        return { ok: true, resourceId: googleProjectId };
      },
      async grantServiceUsageConsumer(googleProjectId, customerMonitoringSa) {
        const fail = maybeFail('google.grantServiceUsageConsumer');
        if (fail) return fail;
        let roles = projectIam.get(googleProjectId);
        if (!roles) {
          roles = new Map();
          projectIam.set(googleProjectId, roles);
        }
        const members = new Set(roles.get('roles/serviceusage.serviceUsageConsumer') ?? []);
        members.add(`serviceAccount:${customerMonitoringSa}`);
        roles.set('roles/serviceusage.serviceUsageConsumer', Array.from(members));
        return { ok: true, resourceId: googleProjectId };
      },
      async reconcileWifProvider(wif) {
        const fail = maybeFail('google.reconcileWifProvider');
        if (fail) return fail;
        const desiredCondition = `assertion.owner_id == "${wif.vercelTeamId}" && assertion.environment == "production"`;
        if (wifProviderCreated && wifProviderCondition !== desiredCondition) {
          return { ok: false, reason: 'WIF provider drift: existing provider condition differs from the A3b template' };
        }
        wifProviderCreated = true;
        wifProviderCondition = desiredCondition;
        return { ok: true, resourceId: wif.provider };
      },
      async createMonitoringServiceAccount(googleProjectId, accountId) {
        const fail = maybeFail('google.createMonitoringServiceAccount');
        if (fail) return fail;
        const saEmail = `${accountId}@${googleProjectId}.iam.gserviceaccount.com`;
        if (!customerSas.has(saEmail)) {
          customerSas.set(saEmail, { googleProjectId, accountId, userManagedKeys: 0, bindings: new Set() });
        }
        return { ok: true, resourceId: saEmail, saEmail };
      },
      async verifyUserManagedKeys(saEmail) {
        const fail = maybeFail('google.verifyUserManagedKeys');
        if (fail) return fail;
        const sa = customerSas.get(saEmail);
        if (!sa) return { ok: false, reason: 'customer monitoring SA missing' };
        return { ok: true, resourceId: saEmail, userManagedCount: sa.userManagedKeys };
      },
      async grantWorkloadIdentityUser(projectId, wif, customerMonitoringSa) {
        const fail = maybeFail('google.grantWorkloadIdentityUser');
        if (fail) return fail;
        const sa = customerSas.get(customerMonitoringSa);
        if (!sa) return { ok: false, reason: 'customer monitoring SA missing' };
        sa.bindings.add(principalSetFor(projectId, wif));
        return { ok: true, resourceId: principalSetFor(projectId, wif) };
      },
      async verifyWifOnboarding(projectId, wif, customerMonitoringSa, googleProjectId) {
        const fail = maybeFail('google.verifyWifOnboarding');
        if (fail) return fail;
        if (!wifProviderCreated) return { ok: false, reason: 'WIF provider missing' };
        if (!oidcEnabled.has(projectId)) return { ok: false, reason: 'Vercel OIDC not enabled on the customer project' };
        const sa = customerSas.get(customerMonitoringSa);
        if (!sa) return { ok: false, reason: 'customer monitoring SA missing' };
        // SA MUST live in the customer's own project (ownership/scope contract)
        if (sa.googleProjectId !== googleProjectId) return { ok: false, reason: 'customer monitoring SA not owned by the customer project' };
        if (sa.userManagedKeys !== 0) return { ok: false, reason: `USER_MANAGED keys must be 0 (got ${sa.userManagedKeys})` };
        if (!sa.bindings.has(principalSetFor(projectId, wif))) return { ok: false, reason: 'workloadIdentityUser binding missing on the customer SA' };
        const roles = projectIam.get(googleProjectId);
        const viewer = roles?.get('roles/monitoring.viewer')?.includes(`serviceAccount:${customerMonitoringSa}`) ?? false;
        const consumer = roles?.get('roles/serviceusage.serviceUsageConsumer')?.includes(`serviceAccount:${customerMonitoringSa}`) ?? false;
        if (!viewer || !consumer) return { ok: false, reason: 'customer SA roles missing on the customer project' };
        return { ok: true, resourceId: customerMonitoringSa };
      },
      async revokeWifOnboarding(projectId, wif, customerMonitoringSa) {
        const fail = maybeFail('google.revokeWifOnboarding');
        if (fail) return fail;
        const sa = customerSas.get(customerMonitoringSa);
        if (!sa) return { ok: false, reason: 'customer monitoring SA missing' };
        sa.bindings.delete(principalSetFor(projectId, wif));
        return { ok: true, resourceId: principalSetFor(projectId, wif) };
      },
      async verifyBillingIsolation(billingAccountId, googleProjectId) {
        const fail = maybeFail('google.verifyBillingIsolation');
        if (fail) return fail;
        const linked = billingProjects.get(billingAccountId) ?? [googleProjectId]; // honest default: exactly the customer project
        if (linked.length !== 1) return { ok: false, reason: `billing account links ${linked.length} projects (exactly 1 required)` };
        if (linked[0] !== googleProjectId) return { ok: false, reason: 'billing account project ≠ customer project' };
        return { ok: true, resourceId: billingAccountId };
      },
      async preActivationPlacesUsage(googleProjectId) {
        const fail = maybeFail('google.preActivationPlacesUsage');
        if (fail) return fail;
        const usage = preActivationUsage.get(googleProjectId) ?? 0;
        return { ok: true, resourceId: googleProjectId, usage };
      },
    },
    controlPlane: {
      async insertTenant(input) {
        const fail = maybeFail('cp.insertTenant');
        if (fail) return fail;
        if (tenants.has(input.slug)) return { ok: true, resourceId: tenants.get(input.slug)!.id }; // idempotent
        if (!/^[A-F0-9]{64}$/.test(input.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required' };
        const id = crypto.randomUUID();
        tenants.set(input.slug, { id, hostname: input.hostname });
        return { ok: true, resourceId: id };
      },
      async insertCustomerConfig(config) {
        const fail = maybeFail('cp.insertCustomerConfig');
        if (fail) return fail;
        if (!/^[A-F0-9]{64}$/.test(config.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required — raw key refused' };
        if (config.quota.monthlyTarget !== 1000 || config.quota.amberPercent !== 85 || config.quota.redPercent !== 90) {
          return { ok: false, reason: 'explicit contract quota required (1000/85/90)' };
        }
        if (config.devicePolicy.maxDevices !== 2 || config.devicePolicy.mode !== 'hard_lock' || config.devicePolicy.autoEviction) {
          return { ok: false, reason: 'device policy must match contract (max 2, hard_lock, no auto eviction)' };
        }
        if (!/^[A-F0-9]{64}$/.test(config.devicePolicy.storeFingerprint)) {
          return { ok: false, reason: 'full 64-hex store fingerprint required' };
        }
        if (config.aclTokenFingerprint !== undefined && !/^[A-F0-9]{64}$/.test(config.aclTokenFingerprint)) {
          return { ok: false, reason: 'full 64-hex ACL token fingerprint required' };
        }
        if (config.billingPreActivationUsage !== undefined && config.billingPreActivationUsage < 0) {
          return { ok: false, reason: 'billing pre-activation usage must be >= 0' };
        }
        // A3b ownership contract: the monitoring SA must belong to the customer's own project.
        if (config.monitoringSaEmail !== undefined && !config.monitoringSaEmail.endsWith(`@${config.googleProjectId}.iam.gserviceaccount.com`)) {
          return { ok: false, reason: 'monitoring SA not owned by the customer project' };
        }
        configs.set(config.tenantId, config);
        return { ok: true, resourceId: config.tenantId };
      },
      async insertRelease(identity) {
        const fail = maybeFail('cp.insertRelease');
        if (fail) return fail;
        releases.set(identity.tag, identity);
        return { ok: true, resourceId: identity.tag };
      },
      async insertAudit(event) {
        const fail = maybeFail('cp.insertAudit');
        if (fail) return fail;
        audits.push(event);
        return { ok: true };
      },
      async findTenantBySlug(slug) {
        const found = tenants.get(slug);
        return found ? { ok: true, tenantId: found.id, resourceId: found.id } : { ok: false, reason: 'not found' };
      },
      async findConfigByTenant(tenantId) {
        const found = configs.get(tenantId);
        return found ? { ok: true, config: found, resourceId: tenantId } : { ok: false, reason: 'not found' };
      },
      async findByStoreFingerprint(fingerprint) {
        const owners: string[] = [];
        configs.forEach((config, tenantId) => {
          if (config.devicePolicy.storeFingerprint === fingerprint) owners.push(tenantId);
        });
        if (owners.length === 0) return { ok: false, reason: 'not found' };
        return { ok: true, tenantId: owners[0], resourceId: owners[0] };
      },
      async findRelease(tag) {
        const found = releases.get(tag);
        return found ? { ok: true, release: found, resourceId: tag } : { ok: false, reason: 'not found' };
      },
    },
    health: {
      async smokeCheck(hostname) {
        const fail = maybeFail('health.smokeCheck');
        if (fail) return fail;
        return { ok: true, resourceId: hostname };
      },
    },
    secrets: {
      async configurePlacesKey(projectId, rawPlacesKey) {
        const fail = maybeFail('secrets.configurePlacesKey');
        if (fail) return fail;
        const envMap = envOf(projectId);
        if (envMap.has('VITE_PLACES_API_KEY')) return { ok: true, resourceId: projectId }; // idempotent resume
        if (!rawPlacesKey) return { ok: false, reason: 'OWNER ACTION REQUIRED: Places API key not configured' };
        if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(rawPlacesKey)) return { ok: false, reason: 'invalid Places browser key' };
        envMap.set('VITE_PLACES_API_KEY', { value: rawPlacesKey, encrypted: true });
        lastConfiguredPlacesKey = rawPlacesKey; // fake keeps the last transient value for assertions
        return { ok: true, resourceId: projectId };
      },
    },
    deviceLock: {
      async configureDeviceLock(projectId, secrets, tenantId) {
        const fail = maybeFail('deviceLock.configure');
        if (fail) return fail;
        if (!secrets || !secrets.kvRestApiUrl || !secrets.kvRestApiToken || !secrets.appPass || !tenantId) {
          return { ok: false, reason: 'incomplete device-lock secrets' };
        }
        lastDeviceLockSecrets = secrets; // test assertion only — executor never serializes it
        deviceLockConfigured.set(projectId, { secrets, tenantId });
        const envMap = envOf(projectId);
        envMap.set('KV_REST_API_URL', { value: secrets.kvRestApiUrl, encrypted: false });
        envMap.set('KV_REST_API_TOKEN', { value: secrets.kvRestApiToken, encrypted: true });
        envMap.set(KV_REST_API_TOKEN_FINGERPRINT_KEY, { value: aclTokenFingerprint(secrets.kvRestApiToken), encrypted: false });
        envMap.set('APP_PASS', { value: secrets.appPass, encrypted: true });
        envMap.set('CUSTOMER_TENANT_ID', { value: tenantId, encrypted: false });
        return { ok: true, resourceId: projectId };
      },
      async readStoreEnv(projectId) {
        const fail = maybeFail('deviceLock.readStoreEnv');
        if (fail) return fail;
        const envMap = envOf(projectId);
        const tokenPresent = envMap.has('KV_REST_API_TOKEN');
        return {
          ok: true,
          resourceId: projectId,
          tokenPresent,
          storeUrl: envMap.get('KV_REST_API_URL')?.value,
          tokenFingerprint: envMap.get('KV_REST_API_TOKEN_FINGERPRINT')?.value,
        };
      },
      async verifyDeviceLock(hostname) {
        const fail = maybeFail('deviceLock.verify');
        if (fail) return fail;
        const projectId = domains.get(hostname);
        const configured = projectId ? deviceLockConfigured.has(projectId) : false;
        const open = deviceLockOpenHosts.has(hostname) || !configured;
        return {
          ok: true,
          resourceId: hostname,
          probe: open
            ? { mode: 'open', maxDevices: 2, kvConfigured: false, appPassConfigured: false, tenantIdConfigured: false }
            : { mode: 'locked', maxDevices: 2, kvConfigured: true, appPassConfigured: true, tenantIdConfigured: true },
        };
      },
    },
    redisAcl: {
      async run(command) {
        const fail = maybeFail('redisAcl.run');
        if (fail && fail.ok === false) throw new Error(fail.reason);
        const m = /^ACL SETUSER (\S+) on >(\S+) ~tenant:(\S+):\* (.*)$/.exec(command);
        if (m) {
          aclUsers.set(m[1], { password: m[2], token: '', keyspace: `tenant:${m[3]}:*`, allowlist: m[4].split(' ') });
          return;
        }
        if (/^ACL DELUSER (\S+)$/.test(command)) {
          const u = /^ACL DELUSER (\S+)$/.exec(command)![1];
          aclUsers.delete(u);
          return;
        }
        throw new Error(`fake admin: unsupported command ${command}`);
      },
      async restToken(username, password) {
        const fail = maybeFail('redisAcl.restToken');
        if (fail && fail.ok === false) throw new Error(fail.reason);
        const user = aclUsers.get(username);
        if (!user || user.password !== password) throw new Error('fake admin: unknown ACL user/password');
        const token = `rest_tok_${username}`;
        user.token = token;
        return token;
      },
    },
    usageSmoke: {
      async run(hostname) {
        const fail = maybeFail('usageSmoke.run');
        if (fail) return fail;
        const projectId = domains.get(hostname);
        const configured = projectId ? deviceLockConfigured.has(projectId) : false;
        if (usageSmokeFailHosts.has(hostname) || !configured) {
          return { ok: false, reason: 'usage smoke failed (deployment not configured)' };
        }
        return {
          ok: true,
          resourceId: hostname,
          smoke: {
            domainHealthy: true,
            usageStructured: true,
            capIs1000: true,
            safetyStopIs900: true,
            maxSessionIs50: true,
            monitoringSource: true,
            deviceProbeLocked: true,
            tenantIdentityExact: true,
            noActiveLeaseAfterRelease: true,
          },
        };
      },
    },
  };
}

/** Exact A3 principalSet member for a customer Vercel project. */
export function principalSetFor(projectId: string, wif: WifConfig): string {
  return `principalSet://iam.googleapis.com/projects/${wif.centralProjectNumber}/locations/global/workloadIdentityPools/${wif.pool}/attribute.project_id/${projectId}`;
}

/** A3 provider full name — the fixed non-secret WIF_AUDIENCE env value. */
export function wifAudienceFor(wif: WifConfig): string {
  return `//iam.googleapis.com/projects/${wif.centralProjectNumber}/locations/global/workloadIdentityPools/${wif.pool}/providers/${wif.provider}`;
}

/** Last raw key handed to the fake secret handoff (test assertion only — never serialized by executor). */
let lastConfiguredPlacesKey: string | null = null;
export function lastHandedOffPlacesKey(): string | null {
  return lastConfiguredPlacesKey;
}

/** Last device-lock secrets handed to the fake (test assertion only — never serialized by executor). */
let lastDeviceLockSecrets: DeviceLockSecretsInput | null = null;
export function lastHandedOffDeviceLockSecrets(): DeviceLockSecretsInput | null {
  return lastDeviceLockSecrets;
}
