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
import type { GoldenReleaseIdentity } from './releaseRegistry.js';
import type { RuntimeQuotaConfig } from './quotaContract.js';
import { KV_REST_API_TOKEN_FINGERPRINT_KEY, type DeviceLockProbe, type DeviceLockSecretsInput, type DevicePolicy } from './deviceLockContract.js';
import { aclTokenFingerprint, type RedisAclAdmin } from './aclProvisioning.js';

export type ProviderResult = { ok: true; resourceId?: string } | { ok: false; reason: string };

export type AppPassHandoffResult =
  | { ok: true; resourceId?: string; appPassState: 'created' | 'retained' }
  | { ok: false; reason: string };

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
  /** v1.0.8 — customer official origin (https://<hostname>) injected at build time; unlocks the domain gate. */
  customerOrigin: string;
}

export interface VercelProvider {
  createProject(tenantId: string, slug: string): Promise<ProviderResult>;
  deployGolden(projectId: string, release: GoldenReleaseIdentity): Promise<ProviderResult>;
  /** S2 — deployment readiness probe (readyState: READY | BUILDING | QUEUED | ERROR | CANCELED). */
  getDeploymentStatus(deploymentId: string): Promise<ProviderResult & { readyState?: string }>;
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
  /** Places key → encrypted VITE_PLACES_API_KEY (idempotent; raw optional when env exists). */
  configurePlacesKey(projectId: string, rawPlacesKey?: string): Promise<ProviderResult>;
  /** APP_PASS → encrypted APP_PASS env (idempotent; raw optional when env exists). Phase 2C cloud path. */
  /**
   * @returns appPassState: 'created' when this call wrote the code into the
   *   customer env; 'retained' when an existing APP_PASS was kept (never
   *   overwritten). The UI must NOT present a freshly generated code as valid
   *   when the runtime retained a previous one (retry/recovery mismatch).
   */
  configureAppPass(projectId: string, rawAppPass?: string): Promise<AppPassHandoffResult>;
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
  /** Read-only env probe: store credential presence + fingerprint + APP_PASS presence. */
  readStoreEnv(projectId: string): Promise<ProviderResult & { storeUrl?: string; tokenPresent?: boolean; tokenFingerprint?: string; appPassPresent?: boolean }>;
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
  /** Bootstrap cleanup: remove ONLY the exact (role, member) binding; preserve other members, other roles and conditions; idempotent; etag-safe. */
  removeExactRoleBinding(googleProjectId: string, role: string, member: string): Promise<ProviderResult>;
  /** Bootstrap cleanup readback: every listed role must no longer contain the member. */
  verifyBootstrapRolesAbsent(googleProjectId: string, roles: string[], member: string): Promise<ProviderResult>;
  /** A3b: offboarding/rollback — remove the exact principalSet member from THAT customer's SA only. */
  revokeWifOnboarding(projectId: string, wif: WifConfig, customerMonitoringSa: string): Promise<ProviderResult>;
  /**
   * S2e billing contract: project-side authoritative readback
   * (projects/{id}/billingInfo) — billingEnabled must be true and a linked
   * billingAccountName must exist. NO expected-value comparison, NO billing
   * account IAM, NO manual billing input. Returns the linked billing account
   * id as non-secret evidence.
   */
  verifyBillingReadback(googleProjectId: string): Promise<ProviderResult & { billingAccountId?: string }>;
  /** PRE-R1 — Places request_count in the Pacific activation month (conservative proxy; 0 required). */
  preActivationPlacesUsage(googleProjectId: string): Promise<ProviderResult & { usage?: number }>;
}

export interface ControlPlaneProvider {
  insertTenant(input: TenantInput): Promise<ProviderResult>;
  /** 2026-09-04: successful finalization flips tenants.status setup_pending → active. */
  updateTenantStatus(tenantId: string, status: string): Promise<ProviderResult>;
  insertCustomerConfig(config: CustomerConfigInput): Promise<ProviderResult>;
  insertRelease(identity: GoldenReleaseIdentity): Promise<ProviderResult>;
  insertAudit(event: { tenantId: string; action: string; detail: string }): Promise<ProviderResult>;
  /** S2e pre-E2E: most recent audit row for (tenant, action) — duplicate-run protection uses action timing. */
  getLastAudit(tenantId: string, action: string): Promise<ProviderResult & { at?: string }>;
  /** S2e pre-E2E: most recent WORKFLOW_STARTED:<runId> audit — evidence only (never the locking primitive). */
  getLastWorkflowStart(tenantId: string): Promise<ProviderResult & { runId?: string; at?: string }>;
  /** S2e FINAL: atomic reservation acquire — exactly ONE winner per tenant (RPC reserve_provisioning_start). */
  reserveProvisioningStart(tenantId: string, reservationToken: string): Promise<ProviderResult & { winner?: boolean }>;
  /** S2e FINAL: link the real workflow runId to the reservation (CAS on token; idempotent — workflow self-link uses this). */
  linkProvisioningRun(tenantId: string, reservationToken: string, runId: string): Promise<ProviderResult & { linked?: boolean }>;
  /** S2e FINAL: release a reservation (CAS on token — retry after an authoritatively terminal run). */
  releaseProvisioningReservation(tenantId: string, reservationToken: string): Promise<ProviderResult & { released?: boolean }>;
  /** S2e FINAL: read the reservation state (token/runId) for the tenant. */
  readProvisioningReservation(tenantId: string): Promise<ProviderResult & { reservationToken?: string | null; runId?: string | null }>;
  findTenantBySlug(slug: string): Promise<ProviderResult & { tenantId?: string; tenantStatus?: string | null }>;
  /** S2b — tenant existence by authoritative id (smoke-confirm gate). */
  findTenantById(tenantId: string): Promise<ProviderResult & { tenantId?: string; slug?: string }>;
  findConfigByTenant(tenantId: string): Promise<ProviderResult & { config?: CustomerConfigInput }>;
  /** PRE-R1 — dedicated-store uniqueness guard (central model skips it). */
  findByStoreFingerprint(fingerprint: string): Promise<ProviderResult & { tenantId?: string }>;
  /** PRE-R1 — authoritative release registry lookup (unknown tag → not found → FAIL). */
  findRelease(tag: string): Promise<ProviderResult & { release?: import('./releaseRegistry.js').GoldenReleaseIdentity }>;
  /** S2c — latest APPROVED release from the trusted registry (server-derived golden release). */
  listLatestApprovedRelease(): Promise<ProviderResult & { release?: import('./releaseRegistry.js').GoldenReleaseIdentity }>;
  /** S2d — authoritative operator profile (operator_profiles → role/active). */
  getOperatorProfile(userId: string): Promise<ProviderResult & { profile?: { userId: string; role: string; active: boolean } }>;
}

export interface HealthProvider {
  smokeCheck(hostname: string): Promise<ProviderResult>;
}

/**
 * PRE-R1 — functional activation smoke report. Points 1–10 are black-box HTTP
 * checks of the deployed app. Point 11 is the SERVER-SIDE REFERRER-ACCEPTANCE
 * PREFLIGHT (owner correction 2026-08-27): ONE bounded real Places request
 * from the exact origin with the customer key proves the Google referrer
 * restriction admits the origin — it does NOT prove the Customer Portal
 * browser runtime works. The FINAL real Customer Portal smoke is an explicit
 * OPERATOR-ASSISTED browser checkpoint (realPortalSmokeConfirmed in the
 * executor): the operator opens the deployed portal from the exact origin,
 * performs ONE bounded real Places search in the normal browser runtime and
 * confirms a successful result. A probe PASS alone can never reach readiness.
 */
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
  /** server-side referrer-acceptance PREFLIGHT (bounded): the customer key + exact-origin Referer are accepted by Google's referrer restriction. NOT a browser-runtime proof. */
  referrerAcceptanceProbe: boolean;
}

export interface UsageSmokeProvider {
  /**
   * @param hostname exact customer origin (no scheme)
   * @param placesApiKey transient raw customer key — absent ⇒ the adapter
   *   REPORTS referrerAcceptanceProbe=false (probe cannot run); the adapter
   *   never fails the whole smoke for the probe alone — the executor owns the
   *   fail-closed policy (key present + probe false → FAIL; key absent on the
   *   cloud path → real portal-smoke hold).
   */
  run(hostname: string, placesApiKey?: string): Promise<ProviderResult & { smoke?: UsageSmokeReport }>;
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
  /** Test control: seed project IAM (role -> members) to simulate the customer's temporary bootstrap grant. */
  __seedProjectIam(googleProjectId: string, role: string, members: string[]): void;
  /** S2e closure — test hook: read back a project's IAM (role -> members) for cleanup absence proofs. */
  __getProjectIam(googleProjectId: string): Map<string, string[]> | undefined;
  /** 2026-09-04 — test hook: read back a fake tenant's status by slug. */
  __getTenantStatus(slug: string): string | undefined;
  /** 2026-09-04 — test hook: read back audit rows (raw-secret non-persistence proof). */
  __audits(): Array<{ tenantId: string; action: string; detail: string }>;
  /** S2d — test hook: seed an operator profile (role enforcement). */
  __seedOperatorProfile(userId: string, role: string, active?: boolean): void;
  /** S2e Fix 2 — test hook: inject a ONE-SHOT failure for the next call of the named operation. */
  __failNext(name: string): void;
}

export function createFakeProviders(options: { failAt?: string[] } = {}): FakeProviders {
  const failures = new Set(options.failAt ?? []);
  const oneShotFailures = new Set<string>();
  const projects = new Map<string, string>(); // tenantId -> projectId
  const domains = new Map<string, string>(); // hostname -> projectId
  const tenants = new Map<string, { id: string; hostname: string; status: string }>();
  // S2e FINAL: atomic reservation state (fake mirrors the RPC semantics — the
  // reserve check+write happens synchronously so concurrent awaits serialize).
  const reservations = new Map<string, { token: string | null; runId: string | null }>();
  const configs = new Map<string, CustomerConfigInput>();
  const releases = new Map<string, GoldenReleaseIdentity>();
  const operatorProfiles = new Map<string, { userId: string; role: string; active: boolean }>();
  const audits: Array<{ tenantId: string; action: string; detail: string; at: string }> = [];
  const deviceLockConfigured = new Map<string, { secrets: DeviceLockSecretsInput; tenantId: string }>(); // projectId -> config
  const deviceLockOpenHosts = new Set<string>(); // force-open simulation (env drift)
  const projectEnv = new Map<string, Map<string, { value: string; encrypted: boolean }>>(); // projectId -> key -> value
  const oidcEnabled = new Set<string>(); // projectIds with team-mode OIDC
  // S2e: the central shared WIF provider is ONE-TIME pre-existing
  // infrastructure (never created/modified per customer) — the fake starts
  // with it present, mirroring the live central project.
  let wifProviderCreated = true;
  let wifProviderCondition = 'assertion.owner_id == "team_zYcaTVVBfNNI7QeVpwABxkan" && assertion.environment == "production"';
  let aclGentokenCounter = 0;
  // A3b: per-customer monitoring SA state (SA lives in the CUSTOMER project).
  const customerSas = new Map<string, { googleProjectId: string; accountId: string; userManagedKeys: number; bindings: Set<string> }>(); // saEmail -> state
  const projectIam = new Map<string, Map<string, string[]>>(); // projectId -> role -> members
  const aclUsers = new Map<string, { password: string; token: string; keyspace: string; allowlist: string[] }>();
  const preActivationUsage = new Map<string, number>(); // projectId -> usage
  const billingProjects = new Map<string, string[]>(); // billingAccountId -> linked project ids
  const usageSmokeFailHosts = new Set<string>();

  const maybeFail = (stage: string): ProviderResult | null => {
    if (failures.has(stage)) return { ok: false, reason: `${stage} simulated failure` };
    if (oneShotFailures.has(stage)) {
      oneShotFailures.delete(stage);
      return { ok: false, reason: `${stage} injected one-shot failure` };
    }
    return null;
  };

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
    __getProjectIam(googleProjectId: string) {
      return projectIam.get(googleProjectId);
    },
    __seedProjectIam(googleProjectId: string, role: string, members: string[]) {
      const roles = projectIam.get(googleProjectId) ?? new Map<string, string[]>();
      const existing = roles.get(role) ?? [];
      roles.set(role, Array.from(new Set([...existing, ...members])));
      projectIam.set(googleProjectId, roles);
    },
    __getTenantStatus(slug: string) {
      return tenants.get(slug)?.status;
    },
    __audits() {
      return [...audits];
    },
    __seedOperatorProfile(userId: string, role: string, active = true) {
      operatorProfiles.set(userId, { userId, role, active });
    },
    __failNext(name: string) {
      oneShotFailures.add(name);
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
      async getDeploymentStatus(deploymentId) {
        const fail = maybeFail('vercel.getDeploymentStatus');
        if (fail) return fail;
        // fake: deployments become READY on first probe unless in the failure set
        return { ok: true, resourceId: deploymentId, readyState: 'READY' };
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
        // EXACT single-subdomain form only — a wrong subdomain, broad wildcard
        // (e.g. https://*.leadfinder.business/*) or unrelated domain is refused.
        if (!/^https:\/\/[a-z0-9-]+\.leadfinder\.business\/\*$/.test(restrictionExact)) {
          return { ok: false, reason: 'exact wildcard referrer restriction required (single customer subdomain)' };
        }
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
      async removeExactRoleBinding(googleProjectId, role, member) {
        const fail = maybeFail('google.removeExactRoleBinding');
        if (fail) return fail;
        const roles = projectIam.get(googleProjectId);
        const members = roles?.get(role);
        // normalized matching — Google members carry type prefixes (user:…)
        const present = members?.some((m) => m === member || (!member.includes(':') && m === `user:${member}`)) ?? false;
        if (!members || !present) return { ok: true, resourceId: role }; // idempotent — nothing to remove
        const actual = members.find((m) => m === member || (!member.includes(':') && m === `user:${member}`))!;
        const next = members.filter((m) => m !== actual);
        if (next.length === 0) roles!.delete(role);
        else roles!.set(role, next);
        return { ok: true, resourceId: role };
      },
      async verifyBootstrapRolesAbsent(googleProjectId, roles, member) {
        const fail = maybeFail('google.verifyBootstrapRolesAbsent');
        if (fail) return fail;
        const projectRoles = projectIam.get(googleProjectId);
        const remaining = roles.filter((role) => (projectRoles?.get(role) ?? []).some((m) => m === member || (!member.includes(':') && m === `user:${member}`)));
        if (remaining.length > 0) return { ok: false, reason: `bootstrap roles still bound to ${member}: ${remaining.join(', ')}` };
        return { ok: true, resourceId: googleProjectId };
      },
      async verifyBillingReadback(googleProjectId) {
        const fail = maybeFail('google.verifyBillingReadback');
        if (fail) return fail;
        // fake mirrors the project-side readback AND keeps the isolation
        // contract observable (a seeded account linking ≠1 project fails) —
        // the live adapter cannot reverse-lookup account links without billing
        // IAM, so this stays a fake-side contract check + live readback evidence.
        let linkedAccount: string | undefined;
        billingProjects.forEach((projectIds, billingAccountId) => {
          if (projectIds.includes(googleProjectId)) linkedAccount = billingAccountId;
        });
        if (linkedAccount) {
          const projectIds = billingProjects.get(linkedAccount) ?? [];
          if (projectIds.length !== 1) return { ok: false, reason: `billing account links ${projectIds.length} projects (exactly 1 required)` };
          return { ok: true, resourceId: linkedAccount, billingAccountId: linkedAccount };
        }
        // honest default when no explicit link was seeded: the project is
        // linked to exactly its own billing (mirrors live enabled+linked)
        return { ok: true, resourceId: `01B61E-759031-B494E4`, billingAccountId: `01B61E-759031-B494E4` };
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
        tenants.set(input.slug, { id, hostname: input.hostname, status: 'setup_pending' });
        return { ok: true, resourceId: id };
      },
      async updateTenantStatus(tenantId, status) {
        const fail = maybeFail('cp.updateTenantStatus');
        if (fail) return fail;
        let entry: { id: string; hostname: string; status: string } | undefined;
        tenants.forEach((t) => { if (t.id === tenantId) entry = t; });
        if (!entry) return { ok: false, reason: 'cp updateTenantStatus: tenant not found' };
        entry.status = status;
        return { ok: true, resourceId: tenantId };
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
        audits.push({ ...event, at: new Date().toISOString() });
        return { ok: true };
      },
      async getLastAudit(tenantId, action) {
        const fail = maybeFail('cp.getLastAudit');
        if (fail) return fail;
        const matches = audits.filter((a) => a.tenantId === tenantId && a.action === action);
        const last = matches[matches.length - 1];
        return last ? { ok: true, at: last.at } : { ok: true };
      },
      async getLastWorkflowStart(tenantId) {
        const fail = maybeFail('cp.getLastWorkflowStart');
        if (fail) return fail;
        const matches = audits.filter((a) => a.tenantId === tenantId && a.action.startsWith('WORKFLOW_STARTED:'));
        const last = matches[matches.length - 1];
        if (!last) return { ok: true };
        return { ok: true, runId: last.action.slice('WORKFLOW_STARTED:'.length), at: last.at };
      },
      async reserveProvisioningStart(tenantId, reservationToken) {
        const fail = maybeFail('cp.reserveProvisioningStart');
        if (fail) return fail;
        const entry = reservations.get(tenantId) ?? { token: null, runId: null };
        if (entry.token !== null) return { ok: true, winner: false };
        // mirrors the revised RPC: a NEW reservation atomically clears any
        // prior runId (a fresh token must never look like a stale run).
        entry.token = reservationToken;
        entry.runId = null;
        reservations.set(tenantId, entry);
        return { ok: true, winner: true };
      },
      async linkProvisioningRun(tenantId, reservationToken, runId) {
        const fail = maybeFail('cp.linkProvisioningRun');
        if (fail) return fail;
        const entry = reservations.get(tenantId);
        if (!entry || entry.token !== reservationToken) return { ok: true, linked: false };
        entry.runId = runId;
        return { ok: true, linked: true };
      },
      async releaseProvisioningReservation(tenantId, reservationToken) {
        const fail = maybeFail('cp.releaseProvisioningReservation');
        if (fail) return fail;
        const entry = reservations.get(tenantId);
        if (!entry || entry.token !== reservationToken) return { ok: true, released: false };
        entry.token = null;
        return { ok: true, released: true };
      },
      async readProvisioningReservation(tenantId) {
        const fail = maybeFail('cp.readProvisioningReservation');
        if (fail) return fail;
        const entry = reservations.get(tenantId);
        if (!entry) return { ok: true, reservationToken: null, runId: null };
        return { ok: true, reservationToken: entry.token, runId: entry.runId };
      },
      async findTenantBySlug(slug) {
        const t = tenants.get(slug);
        return t ? { ok: true, resourceId: t.id, tenantId: t.id, tenantStatus: (t as { status?: string | null }).status ?? null } : { ok: false, reason: 'not found' };
      },
      async findTenantById(tenantId) {
        let foundSlug: string | undefined;
        tenants.forEach((t, slug) => {
          if (t.id === tenantId) foundSlug = slug;
        });
        if (foundSlug) return { ok: true, resourceId: tenantId, tenantId, slug: foundSlug };
        return { ok: false, reason: 'not found' };
      },
      async findConfigByTenant(tenantId) {
        const fail = maybeFail('cp.findConfigByTenant');
        if (fail) return fail;
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
        return found ? { ok: true, resourceId: tag, release: found } : { ok: false, reason: 'not found' };
      },
      async listLatestApprovedRelease() {
        let latest: GoldenReleaseIdentity | undefined;
        let latestApprovedAt = '';
        releases.forEach((r) => {
          if (r.status === 'approved' && (!r.approvedAt || r.approvedAt >= latestApprovedAt)) {
            latestApprovedAt = r.approvedAt ?? '';
            latest = r;
          }
        });
        return latest ? { ok: true, resourceId: latest.tag, release: latest } : { ok: false, reason: 'no approved release' };
      },
      async getOperatorProfile(userId) {
        const found = operatorProfiles.get(userId);
        return found ? { ok: true, resourceId: userId, profile: found } : { ok: false, reason: 'not found' };
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
      async configureAppPass(projectId, rawAppPass) {
        const fail = maybeFail('secrets.configureAppPass');
        if (fail && 'reason' in fail) return { ok: false, reason: fail.reason };
        const envMap = envOf(projectId);
        if (envMap.has('APP_PASS')) return { ok: true, resourceId: projectId, appPassState: 'retained' }; // idempotent — never overwrite
        if (!rawAppPass) return { ok: false, reason: 'OWNER ACTION REQUIRED: APP_PASS not configured' };
        envMap.set('APP_PASS', { value: rawAppPass, encrypted: true });
        return { ok: true, resourceId: projectId, appPassState: 'created' };
      },
    },
    deviceLock: {
      async configureDeviceLock(projectId, secrets, tenantId) {
        const fail = maybeFail('deviceLock.configure');
        if (fail) return fail;
        if (!secrets || !secrets.kvRestApiUrl || !secrets.kvRestApiToken || !tenantId) {
          return { ok: false, reason: 'incomplete device-lock secrets' };
        }
        const envMap = envOf(projectId);
        // Cloud path: APP_PASS may already exist in the encrypted env (written by
        // the start/bootstrap API) — never overwrite; raw may then be absent.
        const appPass = secrets.appPass ?? (envMap.has('APP_PASS') ? envMap.get('APP_PASS')!.value : undefined);
        if (!appPass) return { ok: false, reason: 'incomplete device-lock secrets (APP_PASS missing and env absent)' };
        const full = { ...secrets, appPass };
        lastDeviceLockSecrets = full; // test assertion only — executor never serializes it
        deviceLockConfigured.set(projectId, { secrets: full, tenantId });
        envMap.set('KV_REST_API_URL', { value: secrets.kvRestApiUrl, encrypted: false });
        envMap.set('KV_REST_API_TOKEN', { value: secrets.kvRestApiToken, encrypted: true });
        envMap.set(KV_REST_API_TOKEN_FINGERPRINT_KEY, { value: aclTokenFingerprint(secrets.kvRestApiToken), encrypted: false });
        envMap.set('APP_PASS', { value: appPass, encrypted: true });
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
          appPassPresent: envMap.has('APP_PASS'),
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
      async gentoken() {
        const fail = maybeFail('redisAcl.gentoken');
        if (fail && fail.ok === false) throw new Error(fail.reason);
        return `gt-fake-${++aclGentokenCounter}`; // Upstash-style GENTOKEN bound to the user (fake, deterministic-unique)
      },
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
      async run(hostname, placesApiKey) {
        const fail = maybeFail('usageSmoke.run');
        if (fail) return fail;
        const projectId = domains.get(hostname);
        const configured = projectId ? deviceLockConfigured.has(projectId) : false;
        if (usageSmokeFailHosts.has(hostname) || !configured) {
          return { ok: false, reason: 'usage smoke failed (deployment not configured)' };
        }
        // 11th point (owner-approved contract 2026-09-06): the SERVER-SIDE
        // referrer-acceptance PREFLIGHT needs the real key in the transient
        // handoff; absent key ⇒ probe REPORTED false (not a whole-run failure).
        // Simulates
        // Google's referrer check: key present + not in the injected-failure
        // set ⇒ the exact origin is accepted.
        let referrerAcceptanceProbe = typeof placesApiKey === 'string' && placesApiKey.length > 0;
        const placesFail = maybeFail('usageSmoke.places');
        if (placesFail) referrerAcceptanceProbe = false;
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
            referrerAcceptanceProbe,
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
