/**
 * R1 readiness — provider boundary for the provisioning executor.
 *
 * Interfaces describe the REAL provider operations. The FakeProvider is the
 * deterministic in-memory implementation used by unit/integration tests and
 * local verification. Real provider adapters (Vercel API / Google IAM /
 * Supabase service layer) are implemented behind these interfaces at R1
 * execution time — never invoked from the browser.
 *
 * Owner/Wingo manual steps (by design, NOT automated):
 *   - create customer Google Cloud project
 *   - create customer Places browser API key
 *   - apply exact website referrer restriction / API restriction in Google Console
 * The executor only VERIFIES referrer readiness (bounded, read-only).
 */
import type { GoldenReleaseIdentity } from './releaseRegistry';
import type { RuntimeQuotaConfig } from './quotaContract';
import type { DeviceLockProbe, DeviceLockSecretsInput, DevicePolicy } from './deviceLockContract';

export type ProviderResult = { ok: true; resourceId?: string } | { ok: false; reason: string };

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
}

export interface RuntimeEnvInput {
  monthlyTarget: number;
  amberPercent: number;
  redPercent: number;
  enforcementMode: string;
  googleProjectId: string;
}

export interface VercelProvider {
  createProject(tenantId: string, slug: string): Promise<ProviderResult>;
  deployGolden(projectId: string, release: GoldenReleaseIdentity): Promise<ProviderResult>;
  bindDomain(projectId: string, hostname: string): Promise<ProviderResult>;
  setRuntimeEnv(projectId: string, env: RuntimeEnvInput): Promise<ProviderResult>;
}

/**
 * Ephemeral secret handoff — Stage 5 ONLY.
 * Consumes the transient customer Places browser key to configure the isolated
 * deployment, then discards it. The raw value never enters serializable
 * provisioning state (stages/rollback/audit/DB).
 */
export interface SecretHandoff {
  configurePlacesKey(projectId: string, rawPlacesKey: string): Promise<ProviderResult>;
}

/**
 * R1 TWO-DEVICE CONTRACT — device-lock handoff + readiness verification.
 *
 * `configureDeviceLock` is an EPHEMERAL secret handoff (device_lock stage
 * ONLY): it writes the customer-specific privileged device env (dedicated KV
 * REST credentials, customer access code, immutable CUSTOMER_TENANT_ID) to
 * the isolated deployment, then the raw values are discarded — they never
 * enter serializable provisioning state.
 *
 * `verifyDeviceLock` is a bounded read-only HTTPS probe against the deployed
 * customer app (/api/device?mode=probe). It returns BOOLEAN lock state only
 * (no secret values). CUSTOMER READY is unreachable while this verification
 * fails (fail-closed).
 */
export interface DeviceLockProvider {
  configureDeviceLock(projectId: string, secrets: DeviceLockSecretsInput, tenantId: string): Promise<ProviderResult>;
  verifyDeviceLock(hostname: string): Promise<ProviderResult & { probe?: DeviceLockProbe }>;
}

export interface GoogleProvider {
  verifyReferrer(googleProjectId: string, restrictionExact: string): Promise<ProviderResult>;
  grantMonitoringViewer(googleProjectId: string, centralMonitoringSa: string): Promise<ProviderResult>;
}

export interface ControlPlaneProvider {
  insertTenant(input: TenantInput): Promise<ProviderResult>;
  insertCustomerConfig(config: CustomerConfigInput): Promise<ProviderResult>;
  insertRelease(identity: GoldenReleaseIdentity): Promise<ProviderResult>;
  insertAudit(event: { tenantId: string; action: string; detail: string }): Promise<ProviderResult>;
  findTenantBySlug(slug: string): Promise<ProviderResult & { tenantId?: string }>;
  findConfigByTenant(tenantId: string): Promise<ProviderResult & { config?: CustomerConfigInput }>;
  /** R1 TWO-DEVICE CONTRACT — dedicated-store uniqueness guard: who owns this store fingerprint? */
  findByStoreFingerprint(fingerprint: string): Promise<ProviderResult & { tenantId?: string }>;
}

export interface HealthProvider {
  smokeCheck(hostname: string): Promise<ProviderResult>;
}

export interface ProvisioningProviders {
  vercel: VercelProvider;
  google: GoogleProvider;
  controlPlane: ControlPlaneProvider;
  health: HealthProvider;
  /** Ephemeral Stage-5 secret handoff (optional — real adapters provide it). */
  secrets?: SecretHandoff;
  /** R1 TWO-DEVICE CONTRACT — ephemeral device-lock handoff + readiness probe (REQUIRED for CUSTOMER READY). */
  deviceLock?: DeviceLockProvider;
}

/** Deterministic fake implementation for tests/local verification. */
export interface FakeProviders extends ProvisioningProviders {
  /** Test control: replace the simulated failure set (e.g. clear after a first run to test retry/resume). */
  setFailures(stages: string[]): void;
  /** Test control: force a deployment's device-lock probe to open mode (env drift simulation). */
  setDeviceLockOpen(hostname: string): void;
}

export function createFakeProviders(options: { failAt?: string[] } = {}): FakeProviders {
  const failures = new Set(options.failAt ?? []);
  const projects = new Map<string, string>(); // tenantId -> projectId
  const domains = new Map<string, string>(); // hostname -> projectId
  // AUTHORITATIVE tenant identity: slug -> { id (UUID v4), hostname } — the id is
  // created ONCE at the customer identity boundary and reused for all retries.
  const tenants = new Map<string, { id: string; hostname: string }>();
  const configs = new Map<string, CustomerConfigInput>();
  const releases = new Map<string, GoldenReleaseIdentity>();
  const audits: Array<{ tenantId: string; action: string }> = [];
  // R1 TWO-DEVICE CONTRACT — fake device-lock state
  const deviceLockConfigured = new Map<string, { secrets: DeviceLockSecretsInput; tenantId: string }>(); // projectId -> config
  const deviceLockOpenHosts = new Set<string>(); // force-open simulation (env drift)

  const maybeFail = (stage: string): ProviderResult | null =>
    failures.has(stage) ? { ok: false, reason: `${stage} simulated failure` } : null;

  return {
    setFailures(stages) {
      failures.clear();
      for (const stage of stages) failures.add(stage);
    },
    /** Test control: simulate a deployment whose device lock is NOT active (e.g. env write lost). */
    setDeviceLockOpen(hostname: string) {
      deviceLockOpenHosts.add(hostname);
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
        if (env.monthlyTarget !== 1000 || env.amberPercent !== 90 || env.redPercent !== 95) {
          return { ok: false, reason: 'runtime quota must match approved contract' };
        }
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
      async grantMonitoringViewer(googleProjectId, centralMonitoringSa) {
        const fail = maybeFail('google.grantMonitoringViewer');
        if (fail) return fail;
        void centralMonitoringSa; // viewer-only grant to the exact project; SA identity recorded by caller
        return { ok: true, resourceId: googleProjectId };
      },
    },
    controlPlane: {
      async insertTenant(input) {
        const fail = maybeFail('cp.insertTenant');
        if (fail) return fail;
        if (tenants.has(input.slug)) return { ok: true, resourceId: tenants.get(input.slug)!.id }; // idempotent
        if (!/^[A-F0-9]{64}$/.test(input.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required' };
        // authoritative tenant identity: generated ONCE (UUID v4), persisted, reused
        const id = crypto.randomUUID();
        tenants.set(input.slug, { id, hostname: input.hostname });
        return { ok: true, resourceId: id };
      },
      async insertCustomerConfig(config) {
        const fail = maybeFail('cp.insertCustomerConfig');
        if (fail) return fail;
        if (!/^[A-F0-9]{64}$/.test(config.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required — raw key refused' };
        if (config.quota.monthlyTarget !== 1000 || config.quota.amberPercent !== 90 || config.quota.redPercent !== 95) {
          return { ok: false, reason: 'explicit contract quota required (1000/90/95)' };
        }
        // R1 TWO-DEVICE CONTRACT — persisted device policy must be exactly the contract
        if (config.devicePolicy.maxDevices !== 2 || config.devicePolicy.mode !== 'hard_lock' || config.devicePolicy.autoEviction) {
          return { ok: false, reason: 'device policy must match contract (max 2, hard_lock, no auto eviction)' };
        }
        if (!/^[A-F0-9]{64}$/.test(config.devicePolicy.storeFingerprint)) {
          return { ok: false, reason: 'full 64-hex store fingerprint required' };
        }
        // dedicated-store uniqueness: NO second tenant may own the same store
        let duplicateOwner = false;
        configs.forEach((other, otherTenant) => {
          if (otherTenant !== config.tenantId && other.devicePolicy.storeFingerprint === config.devicePolicy.storeFingerprint) {
            duplicateOwner = true;
          }
        });
        if (duplicateOwner) {
          return { ok: false, reason: 'KV store already owned by another tenant' };
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
        if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(rawPlacesKey)) return { ok: false, reason: 'invalid Places browser key' };
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
        return { ok: true, resourceId: projectId };
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
  };
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
