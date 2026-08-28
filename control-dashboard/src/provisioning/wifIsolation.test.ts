/**
 * A3b CROSS-CUSTOMER ISOLATION SUITE (owner-mandated negative tests, LOCAL).
 *
 * Proves the per-customer dedicated monitoring SA model:
 *   A principalSet → SA_A ALLOW; A → SA_B DENY; B → SA_B ALLOW; B → SA_A DENY;
 *   SA_A scope = Project A only; SA_B scope = Project B only;
 *   runtime config cannot select another customer's SA; project ownership
 *   match; unrelated project impersonates NOTHING; preview/dev rejected;
 *   USER_MANAGED keys = 0; idempotent retry; offboarding A cannot alter B.
 *
 * Uses the REAL Google adapter against a stateful in-memory IAM/WIF
 * simulation (transport-injected) — no live cloud mutation.
 */
import { describe, expect, it } from 'vitest';
import { createGoogleAdapter } from './adapters';
import { principalSetFor, customerMonitoringSaEmail, customerMonitoringSaAccountId } from './provisioningProviders';
import type { WifConfig } from './provisioningProviders';

const WIF: WifConfig = {
  pool: 'lf-vercel-wif',
  provider: 'vercel-oidc',
  centralProjectNumber: '111111111111',
  vercelTeamSlug: 'lawrencew7729-4682s',
  vercelTeamId: 'team_lawrencew7729',
};
const PRJ_A = 'customer-a-google-123';
const PRJ_B = 'customer-b-google-456';
const VERCEL_A = 'prj_customer_a';
const VERCEL_B = 'prj_customer_b';
const VERCEL_UNRELATED = 'prj_some_other_team_project';
const TID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SA_A = customerMonitoringSaEmail(PRJ_A, TID_A);
const SA_B = customerMonitoringSaEmail(PRJ_B, TID_B);
const MEMBER_A = principalSetFor(VERCEL_A, WIF);
const MEMBER_B = principalSetFor(VERCEL_B, WIF);

interface WifSimState {
  providers: Map<string, { attributeCondition: string; oidc: unknown; attributeMapping: unknown }>;
  pools: Set<string>;
  sas: Map<string, { bindings: Map<string, Set<string>>; keys: string[] }>;
  projects: Map<string, { iam: Map<string, Set<string>> }>;
}

/** Stateful in-memory simulation of the IAM/WIF/CRM endpoints the adapter calls. */
function wifSim() {
  const state: WifSimState = { providers: new Map(), pools: new Set(), sas: new Map(), projects: new Map() };
  const calls: string[] = [];

  const saFor = (email: string) => {
    let sa = state.sas.get(email);
    if (!sa) {
      sa = { bindings: new Map(), keys: ['SYSTEM_MANAGED'] };
      state.sas.set(email, sa);
    }
    return sa;
  };
  const projectFor = (id: string) => {
    let p = state.projects.get(id);
    if (!p) {
      p = { iam: new Map() };
      state.projects.set(id, p);
    }
    return p;
  };

  const transport = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push(`${method} ${url}`);

    const status = (n: number, data: unknown) => ({
      status: n,
      ok: n < 400,
      json: async () => data,
      text: async () => JSON.stringify(data),
    });

    // --- WIF pool / provider ---
    // provider CREATE comes first (its URL has a query, not a path id)
    let m = url.match(/workloadIdentityPools\/([^/]+)\/providers\?workloadIdentityPoolProviderId=([^&]+)/);
    if (m && method === 'POST') {
      const providerId = decodeURIComponent(m[2]);
      state.providers.set(providerId, {
        attributeCondition: body?.attributeCondition ?? '',
        oidc: body?.oidc ?? {},
        attributeMapping: body?.attributeMapping ?? {},
      });
      return status(200, { name: providerId, attributeCondition: body?.attributeCondition });
    }
    m = url.match(/workloadIdentityPools\/([^/]+)\/providers\/([^/?]+)(?:\?|$)/);
    if (m) {
      const providerId = decodeURIComponent(m[2]);
      if (method === 'GET') {
        const p = state.providers.get(providerId);
        if (!p) return status(404, { error: { message: 'provider not found' } });
        return status(200, { name: providerId, ...p });
      }
    }
    m = url.match(/workloadIdentityPools\?workloadIdentityPoolId=([^&]+)/);
    if (m && method === 'POST') {
      state.pools.add(decodeURIComponent(m[1]));
      return status(200, { name: decodeURIComponent(m[1]) });
    }
    m = url.match(/workloadIdentityPools\/([^/?]+)(?:\?|$)/);
    if (m) {
      const poolId = decodeURIComponent(m[1]);
      if (method === 'GET') {
        if (!state.pools.has(poolId)) return status(404, { error: { message: 'pool not found' } });
        return status(200, { name: poolId });
      }
    }

    // --- project IAM (CRM) ---
    m = url.match(/cloudresourcemanager\.googleapis\.com\/v1\/projects\/([^/:]+):(get|set)IamPolicy/);
    if (m) {
      const projectId = decodeURIComponent(m[1]);
      const op = m[2];
      const project = projectFor(projectId);
      if (op === 'get') {
        const bindings = Array.from(project.iam.entries()).map(([role, members]) => ({ role, members: Array.from(members) }));
        return status(200, { etag: 'E1', bindings });
      }
      const nextBindings: Array<{ role: string; members: string[] }> = body?.policy?.bindings ?? [];
      project.iam.clear();
      for (const b of nextBindings) project.iam.set(b.role, new Set(b.members));
      return status(200, { etag: 'E2', bindings: nextBindings });
    }

    // --- SA IAM policy ---
    m = url.match(/serviceAccounts\/([^/]+):(get|set)IamPolicy/);
    if (m) {
      const email = decodeURIComponent(m[1]);
      const op = m[2];
      const sa = saFor(email);
      if (op === 'get') {
        const bindings = Array.from(sa.bindings.entries()).map(([role, members]) => ({ role, members: Array.from(members) }));
        return status(200, { etag: 'E1', bindings });
      }
      const nextBindings: Array<{ role: string; members: string[] }> = body?.policy?.bindings ?? [];
      sa.bindings.clear();
      for (const b of nextBindings) sa.bindings.set(b.role, new Set(b.members));
      return status(200, { etag: 'E2', bindings: nextBindings });
    }

    // --- SA create/find in a project ---
    m = url.match(/iam\.googleapis\.com\/v1\/projects\/([^/]+)\/serviceAccounts\/([^/?]+)(?:\?|$)/);
    if (m) {
      const projectId = decodeURIComponent(m[1]);
      const accountId = decodeURIComponent(m[2]);
      const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
      if (method === 'GET') {
        if (!state.sas.has(email)) return status(404, { error: { message: 'not found' } });
        return status(200, { name: email, email });
      }
    }
    m = url.match(/iam\.googleapis\.com\/v1\/projects\/([^/]+)\/serviceAccounts\?accountId=([^&]+)/);
    if (m) {
      const projectId = decodeURIComponent(m[1]);
      const accountId = decodeURIComponent(m[2]);
      const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
      saFor(email);
      return status(200, { name: email, email });
    }

    // --- SA keys ---
    m = url.match(/serviceAccounts\/([^/]+)\/keys/);
    if (m) {
      const email = decodeURIComponent(m[1]);
      const sa = saFor(email);
      return status(200, { keys: sa.keys.map((keyType) => ({ name: `${email}/keys/${keyType}`, keyType })) });
    }

    return status(200, {});
  };

  const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'op-token', transport });

  /** Standard A3b onboarding for one customer (the exact executor sequence). */
  async function onboardCustomer(vercelProject: string, googleProject: string, tenantId: string) {
    const saEmail = customerMonitoringSaEmail(googleProject, tenantId);
    const accountId = customerMonitoringSaAccountId(tenantId);
    const r1 = await adapter.reconcileWifProvider(WIF);
    if (!r1.ok) throw new Error(`reconcile: ${(r1 as { reason: string }).reason}`);
    const r2 = await adapter.createMonitoringServiceAccount(googleProject, accountId);
    if (!r2.ok || !r2.saEmail) throw new Error(`create SA: ${(r2 as { reason: string }).reason}`);
    if (r2.saEmail !== saEmail) throw new Error(`SA email mismatch: ${r2.saEmail}`);
    const r3 = await adapter.verifyUserManagedKeys(saEmail);
    if (!r3.ok) throw new Error(`keys: ${(r3 as { reason: string }).reason}`);
    const r4 = await adapter.grantMonitoringViewer(googleProject, saEmail);
    if (!r4.ok) throw new Error(`viewer: ${(r4 as { reason: string }).reason}`);
    const r5 = await adapter.grantServiceUsageConsumer(googleProject, saEmail);
    if (!r5.ok) throw new Error(`consumer: ${(r5 as { reason: string }).reason}`);
    const r6 = await adapter.grantWorkloadIdentityUser(vercelProject, WIF, saEmail);
    if (!r6.ok) throw new Error(`binding: ${(r6 as { reason: string }).reason}`);
    const r7 = await adapter.verifyWifOnboarding(vercelProject, WIF, saEmail, googleProject);
    if (!r7.ok) throw new Error(`readback: ${(r7 as { reason: string }).reason}`);
    return { saEmail, accountId };
  }

  return { transport, state, calls, adapter, onboardCustomer };
}

describe('A3b — cross-customer isolation (negative suite, local)', () => {
  it('1+3 ALLOW: A principalSet → SA_A; B principalSet → SA_B (exact bindings on the right SAs)', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    // both customer SAs carry their OWN exact principalSet binding
    const verifyA = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_A, PRJ_A);
    const verifyB = await adapter.verifyWifOnboarding(VERCEL_B, WIF, SA_B, PRJ_B);
    expect(verifyA.ok).toBe(true);
    expect(verifyB.ok).toBe(true);
  });

  it('2 DENY: A principalSet CANNOT impersonate SA_B (no A binding on SA_B)', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    // A's workloadId → SA_B: verifyWifOnboarding(A, SA_B, projectB) must FAIL
    const deny = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_B, PRJ_B);
    expect(deny.ok).toBe(false);
    expect((deny as { reason: string }).reason).toContain('binding missing');
  });

  it('4 DENY: B principalSet CANNOT impersonate SA_A', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    const deny = await adapter.verifyWifOnboarding(VERCEL_B, WIF, SA_A, PRJ_A);
    expect(deny.ok).toBe(false);
    expect((deny as { reason: string }).reason).toContain('binding missing');
  });

  it('5+6 SA scope: SA_A roles on Project A ONLY; SA_B roles on Project B ONLY', async () => {
    const { adapter, state, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    const viewerA = (m: string) => Array.from(state.projects.get(PRJ_A)?.iam.get('roles/monitoring.viewer') ?? []).includes(m);
    const viewerB = (m: string) => Array.from(state.projects.get(PRJ_B)?.iam.get('roles/monitoring.viewer') ?? []).includes(m);
    const consumerA = (m: string) => Array.from(state.projects.get(PRJ_A)?.iam.get('roles/serviceusage.serviceUsageConsumer') ?? []).includes(m);
    const consumerB = (m: string) => Array.from(state.projects.get(PRJ_B)?.iam.get('roles/serviceusage.serviceUsageConsumer') ?? []).includes(m);
    expect(viewerA(`serviceAccount:${SA_A}`)).toBe(true);
    expect(consumerA(`serviceAccount:${SA_A}`)).toBe(true);
    expect(viewerB(`serviceAccount:${SA_B}`)).toBe(true);
    expect(consumerB(`serviceAccount:${SA_B}`)).toBe(true);
    // NO cross-project roles in either direction
    expect(viewerA(`serviceAccount:${SA_B}`)).toBe(false);
    expect(viewerB(`serviceAccount:${SA_A}`)).toBe(false);
    expect(consumerA(`serviceAccount:${SA_B}`)).toBe(false);
    expect(consumerB(`serviceAccount:${SA_A}`)).toBe(false);
    void adapter;
  });

  it('7 runtime config cannot select another customer SA: verifyWifOnboarding refuses SA_B for project A', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    // even if someone tried to write CUSTOMER_MONITORING_SA=SA_B on deployment A,
    // the onboarding readback for A with SA_B fails (SA_B not owned by PRJ_A)
    const cross = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_B, PRJ_A);
    expect(cross.ok).toBe(false);
    expect((cross as { reason: string }).reason).toContain('not owned by the customer project');
  });

  it('8 customer Google project MUST match CUSTOMER_MONITORING_SA ownership', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    // SA_A claimed for project B → refused (ownership contract)
    const wrongProject = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_A, PRJ_B);
    expect(wrongProject.ok).toBe(false);
    expect((wrongProject as { reason: string }).reason).toContain('not owned by the customer project');
  });

  it('9 unrelated Vercel project passes NO customer SA impersonation', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    // an unrelated project's token has no binding anywhere → denied on SA_A
    const deny = await adapter.verifyWifOnboarding(VERCEL_UNRELATED, WIF, SA_A, PRJ_A);
    expect(deny.ok).toBe(false);
    expect((deny as { reason: string }).reason).toContain('binding missing');
  });

  it('10 preview/development rejected: provider condition pins environment == production (drift → FAIL)', async () => {
    const { adapter, state, transport } = wifSim();
    // existing provider with a condition that DROPS the production pin (or pins a
    // customer project) must be refused — never silently rewritten
    state.providers.set(WIF.provider, {
      attributeCondition: `assertion.owner_id == "${WIF.vercelTeamId}"`, // no environment check — weaker
      oidc: { issuerUri: `https://oidc.vercel.com/${WIF.vercelTeamSlug}`, allowedAudiences: [`https://vercel.com/${WIF.vercelTeamSlug}`] },
      attributeMapping: { 'google.subject': 'assertion.sub' },
    });
    state.pools.add(WIF.pool);
    const res = await adapter.reconcileWifProvider(WIF);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toContain('drift');
    // and the template itself pins production
    const created = wifSim();
    await created.adapter.reconcileWifProvider(WIF);
    const providerUrl = `https://iam.googleapis.com/v1/projects/${WIF.centralProjectNumber}/locations/global/workloadIdentityPools/${WIF.pool}/providers/${WIF.provider}`;
    const read = await created.transport(providerUrl, {});
    const provider = (await read.json()) as { attributeCondition: string };
    expect(provider.attributeCondition).toBe(`assertion.owner_id == "${WIF.vercelTeamId}" && assertion.environment == "production"`);
    void transport;
  });

  it('11 USER_MANAGED keys = 0 contract: a user-managed key fails the onboarding readback', async () => {
    const { adapter, state, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    // inject drift: someone created a USER_MANAGED key on SA_A
    state.sas.get(SA_A)!.keys.push('USER_MANAGED');
    const keys = await adapter.verifyUserManagedKeys(SA_A);
    expect(keys.ok).toBe(false);
    expect((keys as { reason: string }).reason).toContain('USER_MANAGED');
    // the full onboarding readback also fails closed
    const verify = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_A, PRJ_A);
    expect(verify.ok).toBe(false);
  });

  it('12 retry is idempotent: same SA reused, single binding, no drift', async () => {
    const { adapter, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    const again = await onboardCustomer(VERCEL_A, PRJ_A, TID_A); // full re-run
    expect(again.saEmail).toBe(SA_A);
    const verify = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_A, PRJ_A);
    expect(verify.ok).toBe(true);
  });

  it('13 offboarding A cannot alter B: revoking A leaves SA_B intact', async () => {
    const { adapter, state, onboardCustomer } = wifSim();
    await onboardCustomer(VERCEL_A, PRJ_A, TID_A);
    await onboardCustomer(VERCEL_B, PRJ_B, TID_B);
    const revoked = await adapter.revokeWifOnboarding(VERCEL_A, WIF, SA_A);
    expect(revoked.ok).toBe(true);
    // SA_A no longer authorizes A…
    const denyA = await adapter.verifyWifOnboarding(VERCEL_A, WIF, SA_A, PRJ_A);
    expect(denyA.ok).toBe(false);
    // …but SA_B still authorizes B (unchanged), and B's binding never held A
    const verifyB = await adapter.verifyWifOnboarding(VERCEL_B, WIF, SA_B, PRJ_B);
    expect(verifyB.ok).toBe(true);
    const bBindings = state.sas.get(SA_B)!.bindings.get('roles/iam.workloadIdentityUser') ?? new Set();
    expect(bBindings.has(MEMBER_A)).toBe(false);
    expect(bBindings.has(MEMBER_B)).toBe(true);
  });
});
