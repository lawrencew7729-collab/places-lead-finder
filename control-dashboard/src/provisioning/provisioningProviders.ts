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
}

/** Deterministic fake implementation for tests/local verification. */
export interface FakeProviders extends ProvisioningProviders {
  /** Test control: replace the simulated failure set (e.g. clear after a first run to test retry/resume). */
  setFailures(stages: string[]): void;
}

export function createFakeProviders(options: { failAt?: string[] } = {}): FakeProviders {
  const failures = new Set(options.failAt ?? []);
  const projects = new Map<string, string>(); // tenantId -> projectId
  const domains = new Map<string, string>(); // hostname -> projectId
  const tenants = new Map<string, TenantInput>();
  const configs = new Map<string, CustomerConfigInput>();
  const releases = new Map<string, GoldenReleaseIdentity>();
  const audits: Array<{ tenantId: string; action: string }> = [];

  const maybeFail = (stage: string): ProviderResult | null =>
    failures.has(stage) ? { ok: false, reason: `${stage} simulated failure` } : null;

  return {
    setFailures(stages) {
      failures.clear();
      for (const stage of stages) failures.add(stage);
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
        if (env.monthlyTarget !== 1000 || env.amberPercent !== 90 || env.redPercent !== 100) {
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
        if (tenants.has(input.slug)) return { ok: true, resourceId: tenants.get(input.slug)!.hostname }; // idempotent
        if (!/^[A-F0-9]{64}$/.test(input.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required' };
        tenants.set(input.slug, input);
        return { ok: true, resourceId: input.hostname };
      },
      async insertCustomerConfig(config) {
        const fail = maybeFail('cp.insertCustomerConfig');
        if (fail) return fail;
        if (!/^[A-F0-9]{64}$/.test(config.keyFingerprint)) return { ok: false, reason: 'full 64-hex uppercase fingerprint required — raw key refused' };
        if (config.quota.monthlyTarget !== 1000 || config.quota.amberPercent !== 90 || config.quota.redPercent !== 100) {
          return { ok: false, reason: 'explicit contract quota required (1000/90/100)' };
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
        return found ? { ok: true, tenantId: found.hostname, resourceId: found.hostname } : { ok: false, reason: 'not found' };
      },
      async findConfigByTenant(tenantId) {
        const found = configs.get(tenantId);
        return found ? { ok: true, config: found, resourceId: tenantId } : { ok: false, reason: 'not found' };
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
  };
}
/** Last raw key handed to the fake secret handoff (test assertion only — never serialized by executor). */
let lastConfiguredPlacesKey: string | null = null;
export function lastHandedOffPlacesKey(): string | null {
  return lastConfiguredPlacesKey;
}
