/**
 * R1 final closure — real server-side provider adapters.
 *
 * All adapters are transport-injectable (fetch-like function) so they are
 * fully testable with mocked HTTP without executing any real mutation.
 * Privileged credentials (Vercel token, Supabase service key, Google SA)
 * are read from server-side environment ONLY — never from the browser.
 *
 * STATUS: REAL ADAPTER IMPLEMENTED (orchestration + adapter code present).
 * REAL SANDBOX VERIFIED is the next required dimension (T1 or an explicitly
 * authorized sandbox) before R1 execution. No real provider call is made here.
 */

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
    const index = queue.findIndex((s) => url.includes(s.urlPrefix));
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

// ---------------------------------------------------------------------------
// VERCEL adapter
// ---------------------------------------------------------------------------

export interface VercelAdapterOptions {
  token: string; // server-side only
  teamId: string;
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
      // non-secret quota metadata (browser VITE_* + server CUSTOMER_*) — quota contract only
      const pairs = [
        ['VITE_CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget)],
        ['VITE_CUSTOMER_AMBER_PERCENT', String(env.amberPercent)],
        ['VITE_CUSTOMER_RED_PERCENT', String(env.redPercent)],
        ['VITE_CUSTOMER_ENFORCEMENT_MODE', env.enforcementMode],
        ['CUSTOMER_MONTHLY_TARGET', String(env.monthlyTarget)],
        ['CUSTOMER_GOOGLE_PROJECT_ID', env.googleProjectId],
      ];
      for (const [key, value] of pairs) {
        const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(options.teamId)}`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ key, value, target: ['production'], type: 'encrypted' }),
        });
        if (!res.ok) return { ok: false, reason: `vercel setRuntimeEnv ${key} ${res.status}` };
      }
      return { ok: true, resourceId: projectId };
    },
  };
}

// ---------------------------------------------------------------------------
// DEVICE-LOCK adapter (R1 TWO-DEVICE CONTRACT)
//   - configureDeviceLock: EPHEMERAL secret handoff — writes the customer's
//     dedicated-store credentials (KV_REST_API_URL/TOKEN), customer access
//     code (APP_PASS) and immutable CUSTOMER_TENANT_ID to the isolated
//     Vercel project, then the raw values are discarded by the caller.
//     NEVER persisted/logged. No DEVICE_ADMIN_SECRET in the R1 contract.
//   - verifyDeviceLock: bounded read-only HTTPS probe of the deployed
//     customer app (/api/device?mode=probe) — booleans only, no secrets.
// ---------------------------------------------------------------------------

export function createDeviceLockAdapter(options: VercelAdapterOptions): import('./provisioningProviders').DeviceLockProvider {
  const transport = options.transport ?? nodeFetchTransport();
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...extra });
  const api = `https://api.vercel.com`;

  return {
    async configureDeviceLock(projectId, secrets, tenantId) {
      const pairs: Array<[string, string]> = [
        ['KV_REST_API_URL', secrets.kvRestApiUrl],
        ['KV_REST_API_TOKEN', secrets.kvRestApiToken],
        ['APP_PASS', secrets.appPass],
        ['CUSTOMER_TENANT_ID', tenantId],
      ];
      for (const [key, value] of pairs) {
        const res = await transport(`${api}/v9/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(options.teamId)}`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ key, value, target: ['production'], type: 'encrypted' }),
        });
        if (!res.ok) return { ok: false, reason: `deviceLock setEnv ${key} ${res.status}` };
      }
      return { ok: true, resourceId: projectId };
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
      // explicit quota contract values — NEVER schema defaults
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
        // R1 TWO-DEVICE CONTRACT — non-secret device policy metadata (no secrets);
        // device_limit is the migration-001 column (check tightened to = 2 in 007)
        device_limit: config.devicePolicy.maxDevices,
        device_lock_mode: config.devicePolicy.mode,
        device_kv_namespace: config.devicePolicy.kvNamespace,
        device_store_fingerprint: config.devicePolicy.storeFingerprint,
        device_app_pass_configured: config.devicePolicy.appPassConfigured,
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
      const res = await transport(`${api}/customer_configurations?tenant_id=eq.${tenantId}&select=monthly_usage_target,amber_threshold_percent,red_threshold_percent,quota_enforcement_mode,device_limit,device_lock_mode,device_kv_namespace,device_store_fingerprint,device_app_pass_configured`, { headers });
      if (!res.ok) return { ok: false, reason: `cp findConfigByTenant ${res.status}` };
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      if (rows.length === 0) return { ok: false, reason: 'not found' };
      const row = rows[0];
      const config: import('./provisioningProviders').CustomerConfigInput = {
        tenantId,
        googleProjectId: '',
        keyFingerprint: '',
        websiteRestrictionExact: '',
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
          tenantIdConfigured: true, // tenant_id IS the authoritative identity (FK/PK)
          autoEviction: false,
          storeFingerprint: String(row.device_store_fingerprint ?? ''),
        },
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
  };
}

// ---------------------------------------------------------------------------
// GOOGLE adapter — Cloud Resource Manager + IAM (viewer-only)
// ---------------------------------------------------------------------------

export interface GoogleAdapterOptions {
  accessTokenProvider: () => Promise<string>; // server-side short-lived token
  transport?: Transport;
}

export function createGoogleAdapter(options: GoogleAdapterOptions): import('./provisioningProviders').GoogleProvider {
  const transport = options.transport ?? nodeFetchTransport();

  return {
    // Bounded readiness: project exists + exact restriction format verified.
    // (Referrer enforcement itself happens in Google Console; owner applies it.)
    async verifyReferrer(googleProjectId, restrictionExact) {
      const token = await options.accessTokenProvider();
      const res = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, reason: `google verifyProject ${res.status}` };
      if (!/^https:\/\/[a-z0-9-]+\.leadfinder\.business\/\*$/.test(restrictionExact)) {
        return { ok: false, reason: 'exact wildcard referrer restriction required' };
      }
      return { ok: true, resourceId: restrictionExact };
    },

    // Viewer-only IAM patch: read policy, add ONLY monitoring.viewer for the
    // central SA, write back. Never owner/editor.
    async grantMonitoringViewer(googleProjectId, centralMonitoringSa) {
      const token = await options.accessTokenProvider();
      const getRes = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}:getIamPolicy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!getRes.ok) return { ok: false, reason: `google getIamPolicy ${getRes.status}` };
      const policy = (await getRes.json()) as { bindings?: Array<{ role: string; members: string[] }> };
      const bindings = policy.bindings ?? [];
      const viewer = bindings.find((b) => b.role === 'roles/monitoring.viewer');
      if (viewer && viewer.members.includes(`serviceAccount:${centralMonitoringSa}`)) {
        return { ok: true, resourceId: googleProjectId }; // already granted — idempotent
      }
      const nextBindings = viewer
        ? bindings.map((b) => (b === viewer ? { ...b, members: [...b.members, `serviceAccount:${centralMonitoringSa}`] } : b))
        : [...bindings, { role: 'roles/monitoring.viewer', members: [`serviceAccount:${centralMonitoringSa}`] }];
      const setRes = await transport(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(googleProjectId)}:setIamPolicy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { bindings: nextBindings, etag: (policy as { etag?: string }).etag } }),
      });
      if (!setRes.ok) return { ok: false, reason: `google setIamPolicy ${setRes.status}` };
      return { ok: true, resourceId: googleProjectId };
    },
  };
}

// ---------------------------------------------------------------------------
// HEALTH adapter — bounded HTTPS smoke check
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
