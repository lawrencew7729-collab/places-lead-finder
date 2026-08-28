/**
 * R1 final closure — real server-side provider adapters.
 *
 * All adapters are transport-injectable (fetch-like function) so they are
 * fully testable with mocked HTTP without executing any real mutation.
 * Privileged credentials (Vercel token, Supabase service key, Upstash ACL
 * admin, Google operator token) are read from server-side environment ONLY —
 * never from the browser.
 *
 * PRE-R1 PROVISIONING AUTOMATION REMEDIATION (2026-08-27, LOCAL batch):
 *   - WIF onboarding (A3 design): Vercel OIDC enable, shared provider
 *     create-if-missing with EXACT template verification (drift → FAIL),
 *     exact per-project principalSet workloadIdentityUser binding + readback.
 *   - serviceusage.serviceUsageConsumer grant (E3-ratified 403 fix).
 *   - Billing-account isolation readback + pre-activation usage check.
 *   - Upstash per-tenant ACL admin adapter (path-style REST protocol).
 *   - Functional usage smoke adapter (10-point black-box verification).
 *   - Idempotent env/key handoffs (skip-if-present — retries never
 *     re-expose raw values).
 *
 * STATUS: REAL ADAPTER IMPLEMENTED. REAL SANDBOX VERIFIED is the next
 * required dimension (T1 or an explicitly authorized sandbox) before R1
 * execution. No real provider call is made in this LOCAL batch.
 */
import { normalizeKvStoreUrl, KV_REST_API_TOKEN_FINGERPRINT_KEY } from './deviceLockContract';
import { aclTokenFingerprint } from './aclProvisioning';
import { pacificBillingMonth, pacificBillingMonthStartUtc } from './billingMonth';
import { principalSetFor, wifAudienceFor, type WifConfig } from './provisioningProviders';

export interface Transport {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;
}

/** Node 18+ fetch wrapper (server-side only). */
export function nodeFetchTransport(): Transport {
  return async (url, init) => {
    const response = await fetch(url, init as RequestInit);
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  };
}

/** In-memory fake transport for tests: records calls, consumes scripted responses in order. */
export function createFakeTransport(script: Array<{ urlPrefix: string; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const queue = [...script];
  const transport: Transport = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    // case-insensitive prefix match (URL path segments may preserve subcommand case)
    const index = queue.findIndex((s) => url.toLowerCase().includes(s.urlPrefix.toLowerCase()));
    const entry = index >= 0 ? queue.splice(index, 1)[0] : { urlPrefix: '', status: 200, body: {} };
    const body = entry.body ?? {};
    return {
      status: entry.status ?? 200,
      ok: (entry.status ?? 200) < 400,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { transport, calls };
}

/** GET the current env key→value map of a Vercel project (plain values readable). */
async function readProjectEnv(transport: Transport, api: string, projectId: string, teamId: string, auth: (extra?: Record<string, string>) => Record<string, string>) {
  const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(teamId)}`, { headers: auth() });
  if (!res.ok) return { ok: false as const, reason: `vercel readEnv ${res.status}` };
  const envList = (await res.json()) as Array<{ key: string; value?: string | null }>;
  const map = new Map<string, string | null>();
  for (const e of envList) map.set(e.key, e.value ?? null);
  return { ok: true as const, env: map };
}

// ---------------------------------------------------------------------------
// VERCEL adapter
// ---------------------------------------------------------------------------

export interface VercelAdapterOptions {
  token: string; // server-side only
  teamId: string;
  /**
   * CENTRAL model: the deployment ALWAYS receives the customer's own
   * restricted ACL credential (never a shared/full-access token), so the
   * canonical KV_REST_API_* pair is written even when store envs exist.
   */
  storeMode?: 'dedicated' | 'central';
  transport?: Transport;
}

export function createVercelAdapter(options: VercelAdapterOptions): import('./provisioningProviders').VercelProvider {
  const transport = options.transport ?? nodeFetchTransport();
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...extra });
  const api = `https://api.vercel.com`;

  return {
    async createProject(tenantId, slug) {
      // idempotent: look up first (find-before-create)
      const list = await transport(`${api}/v9/projects?teamId=${encodeURIComponent(options.teamId)}&search=${encodeURIComponent(slug)}`, { headers: auth() });
      const listJson = (await list.json()) as { projects?: Array<{ id: string; name: string }> };
      const existing = (listJson.projects ?? []).find((p) => p.name === `lf-customer-${slug}`);
      if (existing) return { ok: true, resourceId: existing.id };
      const res = await transport(`${api}/v9/projects?teamId=${encodeURIComponent(options.teamId)}`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          name: `lf-customer-${slug}`,
          framework: 'vite',
          buildCommand: 'npm run build',
          outputDirectory: 'dist',
          rootDirectory: '',
        }),
      });
      if (!res.ok) return { ok: false, reason: `vercel createProject ${res.status}` };
      const data = (await res.json()) as { id: string };
      return { ok: true, resourceId: data.id };
    },

    async deployGolden(projectId, release) {
      const res = await transport(`${api}/v13/deployments?teamId=${encodeURIComponent(options.teamId)}`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          name: projectId,
          project: projectId,
          gitSource: { type: 'github', ref: release.tag },
          target: 'production',
        }),
      });
      if (!res.ok) return { ok: false, reason: `vercel deployGolden ${res.status}` };
      const data = (await res.json()) as { id: string };
      return { ok: true, resourceId: data.id };
    },

    async bindDomain(projectId, hostname) {
      const res = await transport(`${api}/v10/projects/${encodeURIComponent(projectId)}/domains?teamId=${encodeURIComponent(options.teamId)}`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: hostname }),
      });
      if (!res.ok) return { ok: false, reason: `vercel bindDomain ${res.status}` };
      return { ok: true, resourceId: hostname };
    },

    async setRuntimeEnv(projectId, env) {
      // PRE-R1: full required runtime env BEFORE any build/deploy. Idempotent:
      // read the current env once and POST only keys that are missing or whose
      // readable (plain) value differs — a retry never rewrites an existing
      // encrypted value.
      const pairs: Array<[string, string, 'plain' | 'encrypted']> = [
        ['VITE_CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget), 'plain'],
        ['VITE_CUSTOMER_AMBER_PERCENT', String(env.amberPercent), 'plain'],
        ['VITE_CUSTOMER_RED_PERCENT', String(env.redPercent), 'plain'],
        ['VITE_CUSTOMER_ENFORCEMENT_MODE', env.enforcementMode, 'plain'],
        ['CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget), 'encrypted'],
        ['CUSTOMER_GOOGLE_PROJECT_ID', env.googleProjectId, 'encrypted'],
        ['WIF_AUDIENCE', env.wifAudience, 'plain'],
        ['CUSTOMER_MONITORING_SA', env.centralMonitoringSa, 'plain'],
      ];
      const read = await readProjectEnv(transport, api, projectId, options.teamId, auth);
      if (!read.ok) return read;
      for (const [key, value, type] of pairs) {
        const existing = read.env.get(key);
        if (existing !== undefined) {
          // plain-typed values are readable: exact value match = no write needed.
          if (type === 'plain' && existing === value) continue;
          // encrypted values are NOT readable; presence means already written.
          if (type === 'encrypted') continue;
          // plain mismatch → rewrite below (POST overwrites).
        }
        const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(options.teamId)}`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ key, value, target: ['production'], type }),
        });
        if (!res.ok) return { ok: false, reason: `vercel setRuntimeEnv ${key} ${res.status}` };
      }
      return { ok: true, resourceId: projectId };
    },

    async enableVercelOidc(projectId) {
      // Idempotent: read the project first; team-mode OIDC already on → pass.
      const getRes = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(options.teamId)}`, { headers: auth() });
      if (!getRes.ok) return { ok: false, reason: `vercel enableVercelOidc read ${getRes.status}` };
      const project = (await getRes.json()) as { oidcTokenConfig?: { enabled?: boolean; issuerMode?: string } };
      if (project.oidcTokenConfig?.enabled && project.oidcTokenConfig.issuerMode === 'team') {
        return { ok: true, resourceId: projectId }; // already enabled (team mode)
      }
      const patchRes = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(options.teamId)}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ oidcTokenConfig: { enabled: true, issuerMode: 'team' } }),
      });
      if (!patchRes.ok) return { ok: false, reason: `vercel enableVercelOidc patch ${patchRes.status}` };
      return { ok: true, resourceId: projectId };
    },

    async verifyEnv(projectId, keys) {
      const read = await readProjectEnv(transport, api, projectId, options.teamId, auth);
      if (!read.ok) return read;
      const missing = keys.filter((k) => !read.env.has(k));
      if (missing.length > 0) return { ok: false, reason: `env readback missing: ${missing.join(', ')}` };
      return { ok: true, resourceId: projectId };
    },
  };
}

// ---------------------------------------------------------------------------
// PLACES KEY adapter — VITE_PLACES_API_KEY transient build injection (Stage 5)
//   Idempotent: if the deployment already carries VITE_PLACES_API_KEY, the
//   handoff is a no-op — a retry NEVER re-exposes or re-writes the raw key.
//   Raw key missing + env missing → OWNER ACTION HOLD (fail-closed).
// ---------------------------------------------------------------------------

export function createPlacesKeyAdapter(options: VercelAdapterOptions): import('./provisioningProviders').SecretHandoff {
  const transport = options.transport ?? nodeFetchTransport();
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...extra });
  const api = `https://api.vercel.com`;

  return {
    async configurePlacesKey(projectId, rawPlacesKey) {
      const read = await readProjectEnv(transport, api, projectId, options.teamId, auth);
      if (!read.ok) return read;
      if (read.env.has('VITE_PLACES_API_KEY')) return { ok: true, resourceId: projectId }; // idempotent resume
      if (!rawPlacesKey) return { ok: false, reason: 'OWNER ACTION REQUIRED: Places API key not configured' };
      if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(rawPlacesKey)) return { ok: false, reason: 'invalid Places browser key' };
      const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(options.teamId)}`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ key: 'VITE_PLACES_API_KEY', value: rawPlacesKey, target: ['production'], type: 'encrypted' }),
      });
      if (!res.ok) return { ok: false, reason: `placesKey setEnv ${res.status}` };
      return { ok: true, resourceId: projectId };
    },
  };
}

// ---------------------------------------------------------------------------
// DEVICE-LOCK adapter (R1 TWO-DEVICE CONTRACT + PRE-R1 ACL handoff)
//   - configureDeviceLock: EPHEMERAL secret handoff (acl stage ONLY) — writes
//     the central store URL, the per-tenant ACL REST token, its non-secret
//     fingerprint, the customer access code (APP_PASS) and the immutable
//     CUSTOMER_TENANT_ID to the isolated Vercel project, then the raw values
//     are discarded by the caller. NEVER persisted/logged.
//   - readStoreEnv: idempotency seam (retry skip-if-present).
//   - verifyDeviceLock: bounded read-only HTTPS probe (/api/device?mode=probe).
// ---------------------------------------------------------------------------

export function createDeviceLockAdapter(options: VercelAdapterOptions): import('./provisioningProviders').DeviceLockProvider {
  const transport = options.transport ?? nodeFetchTransport();
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...extra });
  const api = `https://api.vercel.com`;

  return {
    async configureDeviceLock(projectId, secrets, tenantId) {
      // Owner correction (2026-08-26): NEVER duplicate an existing store
      // secret. Read the deployment's current env keys first (names; URL
      // values are readable for plain-typed vars and are NON-SECRET store
      // identifiers used for fingerprinting/drift checks only).
      const read = await readProjectEnv(transport, api, projectId, options.teamId, auth);
      if (!read.ok) return read;
      const valueOf = (key: string): string | null => read.env.get(key) ?? null;

      // Same precedence as api/device.js: KV_REST_API_* preferred, UPSTASH_* fallback.
      const existingUrl = valueOf('KV_REST_API_URL') ?? valueOf('UPSTASH_REDIS_REST_URL');
      const existingToken = valueOf('KV_REST_API_TOKEN') ?? valueOf('UPSTASH_REDIS_REST_TOKEN');
      const storeCredsPresent = Boolean(existingUrl && existingToken);
      const central = options.storeMode === 'central';

      const pairs: Array<[string, string, 'plain' | 'encrypted']> = [];
      if (central) {
        // CENTRAL model (owner-approved): the deployment ALWAYS receives the
        // customer's OWN restricted ACL credential — an existing env may hold
        // a shared/full-access token, which is never acceptable. Drift guard:
        // the deployment store URL (when readable) must equal the central URL.
        if (existingUrl && normalizeKvStoreUrl(existingUrl) !== normalizeKvStoreUrl(secrets.kvRestApiUrl)) {
          return { ok: false, reason: 'device policy drift: deployment store differs from central store' };
        }
        pairs.push(
          ['KV_REST_API_URL', secrets.kvRestApiUrl, 'plain'],
          // PRE-R1 ACL: the token is the per-tenant REST token (NEVER the
          // central admin credential); its full 64-hex fingerprint is written
          // next to it as a plain non-secret so retries/readbacks reconcile
          // identity without ever reading the raw token back.
          ['KV_REST_API_TOKEN', secrets.kvRestApiToken, 'encrypted'],
          [KV_REST_API_TOKEN_FINGERPRINT_KEY, aclTokenFingerprint(secrets.kvRestApiToken), 'plain'],
        );
      } else if (storeCredsPresent) {
        // Drift guard (belt-and-braces; the DB fingerprint guard also covers
        // this): when the deployment's store URL is readable, it must match
        // the transient handoff store.
        if (existingUrl && normalizeKvStoreUrl(existingUrl) !== normalizeKvStoreUrl(secrets.kvRestApiUrl)) {
          return { ok: false, reason: 'device policy drift: deployment store differs from handoff store' };
        }
      } else {
        // Fresh deployment: write the canonical pair (api/device.js prefers
        // KV_REST_API_*). The fingerprint env is still written for readback.
        pairs.push(
          ['KV_REST_API_URL', secrets.kvRestApiUrl, 'plain'],
          ['KV_REST_API_TOKEN', secrets.kvRestApiToken, 'encrypted'],
          [KV_REST_API_TOKEN_FINGERPRINT_KEY, aclTokenFingerprint(secrets.kvRestApiToken), 'plain'],
        );
      }
      pairs.push(['APP_PASS', secrets.appPass, 'encrypted'], ['CUSTOMER_TENANT_ID', tenantId, 'plain']);
      for (const [key, value, type] of pairs) {
        const existing = read.env.get(key);
        if (existing !== undefined) {
          if (type === 'plain' && existing === value) continue;
          if (type === 'encrypted') continue;
        }
        const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(options.teamId)}`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ key, value, target: ['production'], type }),
        });
        if (!res.ok) return { ok: false, reason: `deviceLock setEnv ${key} ${res.status}` };
      }
      return { ok: true, resourceId: projectId };
    },

    async readStoreEnv(projectId) {
      const read = await readProjectEnv(transport, api, projectId, options.teamId, auth);
      if (!read.ok) return read;
      const valueOf = (key: string): string | null => read.env.get(key) ?? null;
      return {
        ok: true,
        resourceId: projectId,
        storeUrl: valueOf('KV_REST_API_URL') ?? valueOf('UPSTASH_REDIS_REST_URL') ?? undefined,
        tokenPresent: Boolean(valueOf('KV_REST_API_TOKEN') ?? valueOf('UPSTASH_REDIS_REST_TOKEN')),
        tokenFingerprint: valueOf(KV_REST_API_TOKEN_FINGERPRINT_KEY) ?? undefined,
      };
    },

    async verifyDeviceLock(hostname) {
      const res = await transport(`https://${hostname}/api/device?mode=probe`, {});
      if (!res.ok) return { ok: false, reason: `deviceLock probe ${res.status}` };
      const body = (await res.json()) as Record<string, unknown>;
      if (body.mode !== 'locked' && body.mode !== 'open' && body.mode !== 'unconfigured') {
        return { ok: false, reason: 'unexpected probe shape' };
      }
      return {
        ok: true,
        resourceId: hostname,
        probe: {
          mode: body.mode,
          maxDevices: Number(body.maxDevices),
          kvConfigured: body.kvConfigured === true,
          appPassConfigured: body.appPassConfigured === true,
          tenantIdConfigured: body.tenantIdConfigured === true,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CONTROL PLANE (Supabase PostgREST) adapter — server-side service role
// ---------------------------------------------------------------------------

export interface ControlPlaneAdapterOptions {
  baseUrl: string; // https://<ref>.supabase.co
  serviceRoleKey: string; // server-side only
  /**
   * Real `auth.users` id of the operator performing the write. The live
   * schema requires `created_by`/`approved_by` to reference a REAL user
   * (FK to auth.users) — the zero-UUID placeholder is not accepted.
   */
  operatorUserId: string;
  transport?: Transport;
}

export function createControlPlaneAdapter(options: ControlPlaneAdapterOptions): import('./provisioningProviders').ControlPlaneProvider {
  const transport = options.transport ?? nodeFetchTransport();
  const headers = { Authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const api = `${options.baseUrl}/rest/v1`;

  return {
    async insertTenant(input) {
      // return=representation: read back the DB-generated authoritative tenant UUID
      const res = await transport(`${api}/tenants`, { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({
        company_name: input.companyName,
        slug: input.slug,
        exact_subdomain: input.hostname,
        status: 'setup_pending',
        created_by: '00000000-0000-0000-0000-000000000000', // replaced by server layer with the operator id
      }) });
      if (!res.ok) return { ok: false, reason: `cp insertTenant ${res.status}` };
      const rows = (await res.json()) as Array<{ id?: string }>;
      const id = rows[0]?.id;
      if (!id) return { ok: false, reason: 'cp insertTenant missing tenant id' };
      return { ok: true, resourceId: id };
    },

    async insertCustomerConfig(config) {
      // explicit quota contract values — NEVER schema defaults; PRE-R1
      // billing/ACL evidence (migration 011) — NON-SECRET only.
      const res = await transport(`${api}/customer_configurations`, { method: 'POST', headers, body: JSON.stringify({
        tenant_id: config.tenantId,
        google_project_id: config.googleProjectId,
        places_key_fingerprint: config.keyFingerprint, // FULL 64-hex — raw key refused by contract
        website_restriction_exact: config.websiteRestrictionExact,
        monitoring_mode: config.monitoringMode,
        monthly_usage_target: config.quota.monthlyTarget,
        amber_threshold_percent: config.quota.amberPercent,
        red_threshold_percent: config.quota.redPercent,
        quota_enforcement_mode: config.quota.enforcementMode,
        device_limit: config.devicePolicy.maxDevices,
        device_lock_mode: config.devicePolicy.mode,
        device_kv_namespace: config.devicePolicy.kvNamespace,
        device_store_fingerprint: config.devicePolicy.storeFingerprint,
        device_app_pass_configured: config.devicePolicy.appPassConfigured,
        billing_account_id: config.billingAccountId ?? null,
        billing_activation_month: config.billingActivationMonth ?? null,
        billing_pre_activation_usage: config.billingPreActivationUsage ?? 0,
        acl_username: config.aclUsername ?? null,
        acl_token_fingerprint: config.aclTokenFingerprint ?? null,
        monitoring_sa_email: config.monitoringSaEmail ?? null,
        updated_by: '00000000-0000-0000-0000-000000000000',
      }) });
      if (!res.ok) return { ok: false, reason: `cp insertCustomerConfig ${res.status}` };
      return { ok: true, resourceId: config.tenantId };
    },

    async insertRelease(identity) {
      // LIVE-SCHEMA mapping (migration 001 `releases`): there is NO `tag`
      // column. The tag is immutable provenance and is carried in the
      // NOT-NULL `artifact_uri` as `tag:<tag>`. `status` uses the live
      // `release_status` enum ('candidate' | 'approved' | ...). An approved
      // release additionally requires `approved_by` + `approved_at`
      // (schema CHECK), and `created_by`/`approved_by` must reference a
      // REAL auth.users id (FK). Raw values stay server-side only.
      const body: Record<string, string> = {
        version: identity.version,
        status: identity.status,
        git_sha: identity.commitSha,
        artifact_sha256: identity.artifactSha256,
        artifact_uri: `tag:${identity.tag}`,
        created_by: options.operatorUserId,
      };
      if (identity.status === 'approved') {
        body.approved_by = identity.approvedBy ?? options.operatorUserId;
        body.approved_at = identity.approvedAt ?? new Date().toISOString();
      }
      const res = await transport(`${api}/releases`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) return { ok: false, reason: `cp insertRelease ${res.status}` };
      return { ok: true, resourceId: identity.tag };
    },

    async insertAudit(event) {
      const res = await transport(`${api}/audit_logs`, { method: 'POST', headers, body: JSON.stringify({
        actor_label: 'provisioning-service',
        action: event.action,
        entity_type: 'tenant',
        entity_id: event.tenantId,
        tenant_id: event.tenantId,
      }) });
      if (!res.ok) return { ok: false, reason: `cp insertAudit ${res.status}` };
      return { ok: true };
    },

    async findTenantBySlug(slug) {
      const res = await transport(`${api}/tenants?slug=eq.${encodeURIComponent(slug)}&select=id,exact_subdomain`, { headers });
      if (!res.ok) return { ok: false, reason: `cp findTenantBySlug ${res.status}` };
      const rows = (await res.json()) as Array<{ id: string; exact_subdomain: string }>;
      if (rows.length === 0) return { ok: false, reason: 'not found' };
      // the authoritative tenant identity is the row's UUID — slug/subdomain are attributes
      return { ok: true, resourceId: rows[0].id, tenantId: rows[0].id };
    },

    async findConfigByTenant(tenantId) {
      const res = await transport(`${api}/customer_configurations?tenant_id=eq.${tenantId}&select=monthly_usage_target,amber_threshold_percent,red_threshold_percent,quota_enforcement_mode,device_limit,device_lock_mode,device_kv_namespace,device_store_fingerprint,device_app_pass_configured,billing_account_id,billing_activation_month,billing_pre_activation_usage,acl_username,acl_token_fingerprint,monitoring_sa_email`, { headers });
      if (!res.ok) return { ok: false, reason: `cp findConfigByTenant ${res.status}` };
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      if (rows.length === 0) return { ok: false, reason: 'not found' };
      const row = rows[0];
      const config: import('./provisioningProviders').CustomerConfigInput = {
        tenantId,
        googleProjectId: String(row.google_project_id ?? ''),
        keyFingerprint: String(row.places_key_fingerprint ?? ''),
        websiteRestrictionExact: String(row.website_restriction_exact ?? ''),
        monitoringMode: 'shared_access',
        quota: {
          monthlyTarget: Number(row.monthly_usage_target),
          amberPercent: Number(row.amber_threshold_percent),
          redPercent: Number(row.red_threshold_percent),
          enforcementMode: row.quota_enforcement_mode as 'warn_only' | 'disable_new_search',
        },
        devicePolicy: {
          maxDevices: Number(row.device_limit),
          mode: 'hard_lock',
          kvNamespace: String(row.device_kv_namespace ?? ''),
          appPassConfigured: row.device_app_pass_configured === true,
          tenantIdConfigured: true,
          autoEviction: false,
          storeFingerprint: String(row.device_store_fingerprint ?? ''),
        },
        billingAccountId: row.billing_account_id ? String(row.billing_account_id) : undefined,
        billingActivationMonth: row.billing_activation_month ? String(row.billing_activation_month) : undefined,
        billingPreActivationUsage: row.billing_pre_activation_usage !== null && row.billing_pre_activation_usage !== undefined ? Number(row.billing_pre_activation_usage) : undefined,
        aclUsername: row.acl_username ? String(row.acl_username) : undefined,
        aclTokenFingerprint: row.acl_token_fingerprint ? String(row.acl_token_fingerprint) : undefined,
        monitoringSaEmail: row.monitoring_sa_email ? String(row.monitoring_sa_email) : undefined,
      };
      return { ok: true, config, resourceId: tenantId };
    },

    async findByStoreFingerprint(fingerprint) {
      const res = await transport(`${api}/customer_configurations?device_store_fingerprint=eq.${encodeURIComponent(fingerprint)}&select=tenant_id`, { headers });
      if (!res.ok) return { ok: false, reason: `cp findByStoreFingerprint ${res.status}` };
      const rows = (await res.json()) as Array<{ tenant_id: string }>;
      if (rows.length === 0) return { ok: false, reason: 'not found' };
      return { ok: true, tenantId: rows[0].tenant_id, resourceId: rows[0].tenant_id };
    },

    async findRelease(tag) {
      // LIVE schema: tag is carried in artifact_uri as `tag:<tag>`.
      const res = await transport(`${api}/releases?artifact_uri=eq.${encodeURIComponent(`tag:${tag}`)}&select=version,status,git_sha,artifact_sha256,artifact_uri,approved_by,approved_at`, { headers });
      if (!res.ok) return { ok: false, reason: `cp findRelease ${res.status}` };
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      if (rows.length === 0) return { ok: false, reason: 'not found' };
      const row = rows[0];
      const uri = String(row.artifact_uri ?? '');
      const release: import('./releaseRegistry').GoldenReleaseIdentity = {
        version: String(row.version ?? ''),
        tag: uri.startsWith('tag:') ? uri.slice(4) : uri,
        commitSha: String(row.git_sha ?? ''),
        artifactSha256: String(row.artifact_sha256 ?? ''),
        sourcePath: 'control-plane releases registry',
        status: row.status === 'approved' ? 'approved' : 'candidate',
        approvedBy: row.approved_by ? String(row.approved_by) : undefined,
        approvedAt: row.approved_at ? String(row.approved_at) : undefined,
      };
      return { ok: true, release, resourceId: tag };
    },
  };
}

// ---------------------------------------------------------------------------
// GOOGLE adapter — Cloud Resource Manager + IAM + WIF + Cloud Billing + Monitoring
// ---------------------------------------------------------------------------

export interface GoogleAdapterOptions {
  /** Server-side short-lived token (operator OAuth / gcloud broker). */
  accessTokenProvider: () => Promise<string>;
  transport?: Transport;
}

export function createGoogleAdapter(options: GoogleAdapterOptions): import('./provisioningProviders').GoogleProvider {
  const transport = options.transport ?? nodeFetchTransport();
  const bearer = async (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${await options.accessTokenProvider()}`, 'Content-Type': 'application/json', ...extra });

  /** Idempotent IAM role grant: read policy, add the exact member if missing, write, read back. */
  async function grantIamRole(googleProjectId: string, role: string, member: string): Promise<{ ok: true; resourceId: string } | { ok: false; reason: string }> {
    const getRes = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}:getIamPolicy`, {
      method: 'POST',
      headers: await bearer(),
      body: JSON.stringify({}),
    });
    if (!getRes.ok) return { ok: false, reason: `google getIamPolicy ${getRes.status}` };
    const policy = (await getRes.json()) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
    const bindings = policy.bindings ?? [];
    const found = bindings.find((b) => b.role === role);
    if (found && found.members.includes(member)) return { ok: true, resourceId: googleProjectId }; // already granted — idempotent
    const nextBindings = found
      ? bindings.map((b) => (b === found ? { ...b, members: [...b.members, member] } : b))
      : [...bindings, { role, members: [member] }];
    const setRes = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}:setIamPolicy`, {
      method: 'POST',
      headers: await bearer(),
      body: JSON.stringify({ policy: { bindings: nextBindings, etag: policy.etag } }),
    });
    if (!setRes.ok) return { ok: false, reason: `google setIamPolicy ${setRes.status}` };
    return { ok: true, resourceId: googleProjectId };
  }

  return {
    // Bounded readiness: project exists + exact restriction format verified.
    // (Referrer enforcement itself happens in Google Console; owner applies it.)
    async verifyReferrer(googleProjectId, restrictionExact) {
      const res = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}`, {
        headers: await bearer(),
      });
      if (!res.ok) return { ok: false, reason: `google verifyProject ${res.status}` };
      if (!/^https:\/\/[a-z0-9-]+\.leadfinder\.business\/\*$/.test(restrictionExact)) {
        return { ok: false, reason: 'exact wildcard referrer restriction required' };
      }
      return { ok: true, resourceId: restrictionExact };
    },

    // Viewer-only IAM patch — never owner/editor.
    async grantMonitoringViewer(googleProjectId, centralMonitoringSa) {
      return grantIamRole(googleProjectId, 'roles/monitoring.viewer', `serviceAccount:${centralMonitoringSa}`);
    },

    // E3-ratified quota-project grant (X-Goog-User-Project path requires it).
    async grantServiceUsageConsumer(googleProjectId, centralMonitoringSa) {
      return grantIamRole(googleProjectId, 'roles/serviceusage.serviceUsageConsumer', `serviceAccount:${centralMonitoringSa}`);
    },

    // A3b WIF: shared provider create-if-missing with EXACT owner_id+environment
    // template (NO customer project_id in the condition); drift → FAIL.
    async reconcileWifProvider(wif) {
      const wifApi = `https://iam.googleapis.com/v1/projects/${encodeURIComponent(wif.centralProjectNumber)}/locations/global/workloadIdentityPools`;
      const poolUrl = `${wifApi}/${encodeURIComponent(wif.pool)}`;
      const providerUrl = `${poolUrl}/providers/${encodeURIComponent(wif.provider)}`;

      // 1. pool create-if-missing
      const poolRes = await transport(poolUrl, { headers: await bearer() });
      if (poolRes.status === 404) {
        const createPool = await transport(`${wifApi}?workloadIdentityPoolId=${encodeURIComponent(wif.pool)}`, {
          method: 'POST',
          headers: await bearer(),
          body: JSON.stringify({ displayName: wif.pool, description: 'LeadFinder Vercel WIF pool' }),
        });
        if (!createPool.ok) return { ok: false, reason: `wif createPool ${createPool.status}` };
      } else if (!poolRes.ok) {
        return { ok: false, reason: `wif readPool ${poolRes.status}` };
      }

      // 2. provider create-if-missing / exact-verify
      const providerRes = await transport(providerUrl, { headers: await bearer() });
      const desired = providerTemplate(wif);
      if (providerRes.status === 404) {
        const createProvider = await transport(`${poolUrl}/providers?workloadIdentityPoolProviderId=${encodeURIComponent(wif.provider)}`, {
          method: 'POST',
          headers: await bearer(),
          body: JSON.stringify(desired),
        });
        if (!createProvider.ok) return { ok: false, reason: `wif createProvider ${createProvider.status}` };
      } else if (!providerRes.ok) {
        return { ok: false, reason: `wif readProvider ${providerRes.status}` };
      } else {
        const existing = (await providerRes.json()) as Record<string, unknown>;
        const drift = providerDrift(existing, desired);
        if (drift) return { ok: false, reason: `WIF provider drift: ${drift} (fail-closed — owner must migrate explicitly)` };
      }

      // 3. readback: provider must now exist with the EXACT template
      const verify = await transport(providerUrl, { headers: await bearer() });
      if (!verify.ok) return { ok: false, reason: `wif verifyProvider ${verify.status}` };
      const finalProvider = (await verify.json()) as Record<string, unknown>;
      const drift = providerDrift(finalProvider, desired);
      if (drift) return { ok: false, reason: `WIF provider readback drift: ${drift}` };
      return { ok: true, resourceId: wif.provider };
    },

    // A3b: customer's OWN monitoring SA in the CUSTOMER project (idempotent find-before-create).
    async createMonitoringServiceAccount(googleProjectId, accountId) {
      const saUrl = `https://iam.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}/serviceAccounts/${encodeURIComponent(accountId)}`;
      const findRes = await transport(saUrl, { headers: await bearer() });
      if (findRes.ok) {
        const found = (await findRes.json()) as { email?: string };
        if (!found.email) return { ok: false, reason: 'wif readServiceAccount: missing email' };
        return { ok: true, resourceId: found.email, saEmail: found.email };
      }
      if (findRes.status !== 404) return { ok: false, reason: `wif readServiceAccount ${findRes.status}` };
      const createRes = await transport(`https://iam.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}/serviceAccounts?accountId=${encodeURIComponent(accountId)}`, {
        method: 'POST',
        headers: await bearer(),
        body: JSON.stringify({ displayName: 'LeadFinder customer monitoring', description: 'Per-customer monitoring SA (A3b); USER_MANAGED keys = 0' }),
      });
      if (!createRes.ok) return { ok: false, reason: `wif createServiceAccount ${createRes.status}` };
      const created = (await createRes.json()) as { email?: string };
      if (!created.email) return { ok: false, reason: 'wif createServiceAccount: missing email' };
      return { ok: true, resourceId: created.email, saEmail: created.email };
    },

    // A3b: USER_MANAGED SA keys MUST be 0 (SYSTEM_MANAGED only) — no JSON/private keys.
    async verifyUserManagedKeys(saEmail) {
      const res = await transport(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}/keys`, { headers: await bearer() });
      if (!res.ok) return { ok: false, reason: `wif listSaKeys ${res.status}` };
      const body = (await res.json()) as { keys?: Array<{ keyType?: string }> };
      const userManaged = (body.keys ?? []).filter((k) => k.keyType === 'USER_MANAGED').length;
      if (userManaged !== 0) return { ok: false, reason: `USER_MANAGED SA keys must be 0 (got ${userManaged})` };
      return { ok: true, resourceId: saEmail, userManagedCount: 0 };
    },

    // A3b: exact per-project principalSet binding on THAT customer's SA (idempotent + readback).
    async grantWorkloadIdentityUser(projectId, wif, customerMonitoringSa) {
      const member = principalSetFor(projectId, wif);
      const role = 'roles/iam.workloadIdentityUser';
      const saUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(customerMonitoringSa)}`;
      const getRes = await transport(`${saUrl}:getIamPolicy`, { method: 'POST', headers: await bearer(), body: JSON.stringify({}) });
      if (!getRes.ok) return { ok: false, reason: `wif getSaIamPolicy ${getRes.status}` };
      const policy = (await getRes.json()) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
      const bindings = policy.bindings ?? [];
      const found = bindings.find((b) => b.role === role);
      if (found && found.members.includes(member)) return { ok: true, resourceId: member }; // idempotent
      const nextBindings = found
        ? bindings.map((b) => (b === found ? { ...b, members: [...b.members, member] } : b))
        : [...bindings, { role, members: [member] }];
      const setRes = await transport(`${saUrl}:setIamPolicy`, {
        method: 'POST',
        headers: await bearer(),
        body: JSON.stringify({ policy: { bindings: nextBindings, etag: policy.etag } }),
      });
      if (!setRes.ok) return { ok: false, reason: `wif setSaIamPolicy ${setRes.status}` };
      return { ok: true, resourceId: member };
    },

    // A3b readback: provider exact template + customer SA (own project) + keys=0 +
    // exact binding on that SA + roles on the customer project ONLY.
    async verifyWifOnboarding(projectId, wif, customerMonitoringSa, googleProjectId) {
      const wifApi = `https://iam.googleapis.com/v1/projects/${encodeURIComponent(wif.centralProjectNumber)}/locations/global/workloadIdentityPools`;
      const providerUrl = `${wifApi}/${encodeURIComponent(wif.pool)}/providers/${encodeURIComponent(wif.provider)}`;
      const desired = providerTemplate(wif);

      const poolRes = await transport(`${wifApi}/${encodeURIComponent(wif.pool)}`, { headers: await bearer() });
      if (!poolRes.ok) return { ok: false, reason: `wif readback pool ${poolRes.status}` };
      const providerRes = await transport(providerUrl, { headers: await bearer() });
      if (!providerRes.ok) return { ok: false, reason: `wif readback provider ${providerRes.status}` };
      const provider = (await providerRes.json()) as Record<string, unknown>;
      const drift = providerDrift(provider, desired);
      if (drift) return { ok: false, reason: `WIF provider readback drift: ${drift}` };

      // SA ownership: the SA email domain MUST equal the customer project id.
      if (!customerMonitoringSa.endsWith(`@${googleProjectId}.iam.gserviceaccount.com`)) {
        return { ok: false, reason: 'customer monitoring SA not owned by the customer project' };
      }
      const keysCheck = await this.verifyUserManagedKeys(customerMonitoringSa);
      if (!keysCheck.ok) return keysCheck;

      const saUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(customerMonitoringSa)}`;
      const saRes = await transport(`${saUrl}:getIamPolicy`, { method: 'POST', headers: await bearer(), body: JSON.stringify({}) });
      if (!saRes.ok) return { ok: false, reason: `wif readback saIam ${saRes.status}` };
      const policy = (await saRes.json()) as { bindings?: Array<{ role: string; members: string[] }> };
      const member = principalSetFor(projectId, wif);
      const hasBinding = (policy.bindings ?? []).some((b) => b.role === 'roles/iam.workloadIdentityUser' && b.members.includes(member));
      if (!hasBinding) return { ok: false, reason: 'WIF readback: workloadIdentityUser binding missing on the customer SA' };

      // roles on the CUSTOMER project ONLY (never any other project)
      const iamRes = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}:getIamPolicy`, {
        method: 'POST',
        headers: await bearer(),
        body: JSON.stringify({}),
      });
      if (!iamRes.ok) return { ok: false, reason: `wif readback projectIam ${iamRes.status}` };
      const iamPolicy = (await iamRes.json()) as { bindings?: Array<{ role: string; members: string[] }> };
      const roleMembers = (role: string) => (iamPolicy.bindings ?? []).find((b) => b.role === role)?.members ?? [];
      if (!roleMembers('roles/monitoring.viewer').includes(`serviceAccount:${customerMonitoringSa}`)) {
        return { ok: false, reason: 'WIF readback: monitoring.viewer missing on the customer project' };
      }
      if (!roleMembers('roles/serviceusage.serviceUsageConsumer').includes(`serviceAccount:${customerMonitoringSa}`)) {
        return { ok: false, reason: 'WIF readback: serviceusage.serviceUsageConsumer missing on the customer project' };
      }
      return { ok: true, resourceId: customerMonitoringSa };
    },

    // A3b offboarding: remove the exact principalSet member from THAT customer's SA ONLY.
    async revokeWifOnboarding(projectId, wif, customerMonitoringSa) {
      const member = principalSetFor(projectId, wif);
      const role = 'roles/iam.workloadIdentityUser';
      const saUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(customerMonitoringSa)}`;
      const getRes = await transport(`${saUrl}:getIamPolicy`, { method: 'POST', headers: await bearer(), body: JSON.stringify({}) });
      if (!getRes.ok) return { ok: false, reason: `wif revoke getSaIamPolicy ${getRes.status}` };
      const policy = (await getRes.json()) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
      const bindings = policy.bindings ?? [];
      const found = bindings.find((b) => b.role === role);
      if (!found || !found.members.includes(member)) return { ok: true, resourceId: member }; // already absent — idempotent
      const nextBindings = bindings
        .map((b) => (b === found ? { ...b, members: b.members.filter((m) => m !== member) } : b))
        .filter((b) => b.members.length > 0);
      const setRes = await transport(`${saUrl}:setIamPolicy`, {
        method: 'POST',
        headers: await bearer(),
        body: JSON.stringify({ policy: { bindings: nextBindings, etag: policy.etag } }),
      });
      if (!setRes.ok) return { ok: false, reason: `wif revoke setSaIamPolicy ${setRes.status}` };
      return { ok: true, resourceId: member };
    },

    // Billing-account isolation (READ-ONLY): exactly ONE linked project == customer project.
    async verifyBillingIsolation(billingAccountId, googleProjectId) {
      const res = await transport(`https://cloudbilling.googleapis.com/v1/billingAccounts/${encodeURIComponent(billingAccountId)}/projects`, {
        headers: await bearer(),
      });
      if (!res.ok) return { ok: false, reason: `billing listProjects ${res.status}` };
      const body = (await res.json()) as { projects?: Array<{ projectId?: string; billingEnabled?: boolean }> };
      const linked = (body.projects ?? []).filter((p) => p.billingEnabled !== false);
      if (linked.length !== 1) return { ok: false, reason: `billing account links ${linked.length} enabled project(s) (exactly 1 required)` };
      if (linked[0].projectId !== googleProjectId) {
        return { ok: false, reason: `billing account project (${linked[0].projectId}) ≠ customer project (${googleProjectId})` };
      }
      return { ok: true, resourceId: billingAccountId };
    },

    // Pre-activation usage: broad Places request_count in the Pacific activation
    // month (conservative proxy — Monitoring has NO SKU dimension; never claimed
    // as billing/SKU reconciliation). 0 required for a fresh activation.
    async preActivationPlacesUsage(googleProjectId) {
      const now = new Date();
      const start = new Date(pacificBillingMonthStartUtc(now)).toISOString();
      const filter = encodeURIComponent(
        'metric.type="serviceruntime.googleapis.com/api/request_count"' +
        ' AND resource.labels.service="places.googleapis.com"'
      );
      const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(googleProjectId)}/timeSeries` +
        `?filter=${filter}` +
        `&interval.startTime=${encodeURIComponent(start)}` +
        `&interval.endTime=${encodeURIComponent(now.toISOString())}` +
        '&aggregation.alignmentPeriod=3600s' +
        '&aggregation.perSeriesAligner=ALIGN_SUM';
      const res = await transport(url, { headers: await bearer() });
      if (!res.ok) return { ok: false, reason: `monitoring preActivationUsage ${res.status}` };
      const j = (await res.json()) as { timeSeries?: Array<{ points?: Array<{ value?: { doubleValue?: number; int64Value?: string } }> }> };
      let total = 0;
      for (const ts of j.timeSeries ?? []) {
        for (const pt of ts.points ?? []) {
          const v = pt.value && (pt.value.doubleValue !== undefined ? pt.value.doubleValue : pt.value.int64Value);
          if (v) total += Number(v);
        }
      }
      return { ok: true, resourceId: googleProjectId, usage: Math.round(total) };
    },
  };
}

/** A3b provider template (the ONLY acceptable shared-provider shape). */
function providerTemplate(wif: WifConfig): Record<string, unknown> {
  return {
    displayName: `${wif.provider} (LeadFinder A3b)`,
    oidc: {
      issuerUri: `https://oidc.vercel.com/${wif.vercelTeamSlug}`,
      allowedAudiences: [`https://vercel.com/${wif.vercelTeamSlug}`],
    },
    attributeMapping: {
      'google.subject': 'assertion.sub',
      'attribute.project_id': 'assertion.project_id',
      'attribute.environment': 'assertion.environment',
      'attribute.owner_id': 'assertion.owner_id',
    },
    // Stable immutable team pin — NO customer project_id in the shared condition.
    // The customer-specific boundary is the exact principalSet binding on the
    // customer's OWN dedicated monitoring SA (A3b).
    attributeCondition: `assertion.owner_id == "${wif.vercelTeamId}" && assertion.environment == "production"`,
  };
}

/** Exact-template drift check — fail-closed: ANY deviation blocks provisioning. */
function providerDrift(existing: Record<string, unknown>, desired: Record<string, unknown>): string | null {
  const cond = existing.attributeCondition;
  if (cond !== desired.attributeCondition) return 'attributeCondition differs from the A3 template';
  const oidc = (existing.oidc ?? {}) as Record<string, unknown>;
  if (oidc.issuerUri !== (desired.oidc as Record<string, unknown>).issuerUri) return 'issuerUri differs from the A3 template';
  const audiences = oidc.allowedAudiences;
  const wantAudiences = (desired.oidc as Record<string, unknown>).allowedAudiences;
  if (!Array.isArray(audiences) || JSON.stringify(audiences) !== JSON.stringify(wantAudiences)) return 'allowedAudiences differ from the A3 template';
  const mapping = (existing.attributeMapping ?? {}) as Record<string, unknown>;
  const wantMapping = (desired.attributeMapping as Record<string, unknown>);
  for (const [k, v] of Object.entries(wantMapping)) {
    if (mapping[k] !== v) return `attributeMapping[${k}] differs from the A3 template`;
  }
  return null;
}

/** WIF_AUDIENCE value the executor writes into customer env (non-secret provider full name). */
export function wifAudienceValue(wif: WifConfig): string {
  return wifAudienceFor(wif);
}

// ---------------------------------------------------------------------------
// UPSTASH per-tenant ACL admin adapter — path-style REST protocol (verified
// live on the T1 store: POST /<cmd>/<args>, each arg URL-encoded, no body).
// Operates with the CENTRAL admin credential ONLY — never a customer token.
// ---------------------------------------------------------------------------

export interface UpstashRedisAclAdminOptions {
  /** Central Upstash REST URL (admin credential — server-side/operator-side ONLY). */
  adminUrl: string;
  /** Central admin REST token (server-side/operator-side ONLY). */
  adminToken: string;
  transport?: Transport;
}

export function createUpstashRedisAclAdmin(options: UpstashRedisAclAdminOptions): import('./aclProvisioning').RedisAclAdmin {
  const transport = options.transport ?? nodeFetchTransport();

  async function command(commandLine: string): Promise<unknown> {
    const argv = commandLine.trim().split(/\s+/);
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error('empty ACL command');
    // Path-style protocol: first segment = the Redis command (lowercased;
    // Redis commands are case-insensitive). Subcommands (SETUSER/RESTTOKEN/
    // DELUSER) and arguments stay verbatim — an argument may be a password
    // or keyspace that MUST NOT be case-folded.
    const path = [cmd.toLowerCase(), ...args.map((a) => encodeURIComponent(a))].join('/');
    const r = await transport(`${options.adminUrl}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.adminToken}`, 'Content-Type': 'application/json' },
    });
    const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!r.ok || j.error) throw new Error(`upstash acl ${cmd}: ${j.error ?? r.status}`);
    return j.result;
  }

  return {
    async run(commandLine) {
      await command(commandLine);
    },
    async restToken(username, password) {
      // ACL RESTTOKEN <user> <password> → the REST bearer token for that ACL user.
      // The password is an argument here and NEVER returned/logged by the caller.
      const result = await command(`ACL RESTTOKEN ${username} ${password}`);
      if (typeof result !== 'string' || result.length === 0) throw new Error('upstash acl RESTTOKEN: unexpected response');
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// HEALTH adapter — bounded HTTPS smoke check (HTML)
// ---------------------------------------------------------------------------

export function createHealthAdapter(options: { transport?: Transport } = {}): import('./provisioningProviders').HealthProvider {
  const transport = options.transport ?? nodeFetchTransport();
  return {
    async smokeCheck(hostname) {
      const res = await transport(`https://${hostname}/`, {});
      if (!res.ok) return { ok: false, reason: `health smokeCheck ${res.status}` };
      const text = await res.text();
      if (!text.includes('<!DOCTYPE html>') && !text.includes('<html')) return { ok: false, reason: 'unexpected response shape' };
      return { ok: true, resourceId: hostname };
    },
  };
}

// ---------------------------------------------------------------------------
// USAGE SMOKE adapter — 10-point functional activation verification.
// Black-box HTTPS against the DEPLOYED customer app (its OWN restricted
// credential): / (200 html) → /api/usage (structured, cap 1000, stop 900,
// session 50, source monitoring) → /api/session?mode=status (lease ownership
// = exact tenant identity) → /api/session?mode=release (compare-and-release)
// → status (NO residual lease) → /api/device?mode=probe (locked, max 2).
// Any failure = fail-closed provisioning HOLD.
// ---------------------------------------------------------------------------

export function createUsageSmokeAdapter(options: { transport?: Transport } = {}): import('./provisioningProviders').UsageSmokeProvider {
  const transport = options.transport ?? nodeFetchTransport();

  async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await transport(url, {});
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  return {
    async run(hostname) {
      const base = `https://${hostname}`;

      // 1. customer domain HTTP healthy (HTML shell)
      const page = await transport(`${base}/`, {});
      const pageText = await page.text().catch(() => '');
      if (!page.ok || (!pageText.includes('<!DOCTYPE html>') && !pageText.includes('<html'))) {
        return { ok: false, reason: `usage smoke: domain not healthy (${page.status})` };
      }

      // 2-6. /api/usage structured success + exact contract + Monitoring source
      const usage = await getJson(`${base}/api/usage`);
      if (usage.status !== 200 || usage.body.error) {
        return { ok: false, reason: `usage smoke: /api/usage failed (${usage.status}${usage.body.error ? ` ${String(usage.body.error)}` : ''})` };
      }
      if (usage.body.blocked === true) return { ok: false, reason: 'usage smoke: /api/usage BLOCKED at safety stop' };
      if (usage.body.locked === true) return { ok: false, reason: 'usage smoke: /api/usage LOCKED by an active session' };
      const used = Number(usage.body.used);
      if (!Number.isFinite(used) || used < 0) return { ok: false, reason: 'usage smoke: used not a number' };
      const sessionId = String(usage.body.sessionId ?? '');

      // 7. device probe locked + exact contract
      const probe = await getJson(`${base}/api/device?mode=probe`);
      const deviceLocked = probe.status === 200 && probe.body.mode === 'locked' && Number(probe.body.maxDevices) === 2
        && probe.body.kvConfigured === true && probe.body.appPassConfigured === true && probe.body.tenantIdConfigured === true;

      // 8-9. lease ownership (exact tenant identity) + compare-and-release + no residual lease
      const statusBefore = await getJson(`${base}/api/session?mode=status`);
      const identityExact = statusBefore.status === 200 && statusBefore.body.active === true
        && String(statusBefore.body.sessionId ?? '') === sessionId && sessionId.length > 0;
      const released = sessionId.length > 0
        ? await getJson(`${base}/api/session?mode=release&sessionId=${encodeURIComponent(sessionId)}`)
        : { status: 400, body: {} };
      const releasedOk = released.status === 200 && released.body.ok === true;
      const statusAfter = await getJson(`${base}/api/session?mode=status`);
      const noResidualLease = statusAfter.status === 200 && statusAfter.body.active === false;

      const smoke = {
        domainHealthy: true,
        usageStructured: usage.status === 200 && Number.isFinite(used),
        capIs1000: Number(usage.body.cap) === 1000,
        safetyStopIs900: Number(usage.body.safetyStop) === 900,
        maxSessionIs50: Number(usage.body.maxSessionRequests) === 50,
        monitoringSource: usage.body.source === 'monitoring',
        deviceProbeLocked: deviceLocked,
        tenantIdentityExact: identityExact,
        noActiveLeaseAfterRelease: noResidualLease && releasedOk,
      };
      const failed = Object.entries(smoke).filter(([, v]) => !v).map(([k]) => k);
      if (failed.length > 0) {
        return { ok: false, reason: `usage smoke failed: ${failed.join(', ')}` };
      }
      return { ok: true, resourceId: hostname, smoke };
    },
  };
}
