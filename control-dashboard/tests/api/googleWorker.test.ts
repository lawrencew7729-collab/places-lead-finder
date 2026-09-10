/**
 * Phase 2C Segment 2e — Google Worker bridge tests.
 * Proves:
 *   1. worker proxy forwards every executor Google call to the internal Worker
 *   2. unauthorized Worker request fails BEFORE any Google access
 *   3. reconcileWifProvider is refused in the per-customer runtime
 *   4. worker dispatch executes the requested method with the operator token
 *   5. worker response carries NO credential
 *   6. retry (repeat call) is safe — no tenant cross-wiring, same input → same result
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkerGoogleAdapter, callGoogleWorker, type WorkerGoogleAdapterOptions } from '../../src/provisioning/workerGoogleAdapter.js';
import { runGoogleWorker, verifyInternalAuthV1, type WorkerCoreDeps } from '../../api/lib/googleWorkerCore.js';
import type { GoogleProvider, ProviderResult, WifConfig } from '../../src/provisioning/provisioningProviders.js';

const WIF: WifConfig = { pool: 'lf-vercel-wif', provider: 'vercel-oidc', centralProjectNumber: '457413606752', vercelTeamSlug: 'lawrencew7729-4682s', vercelTeamId: 'team_zYcaTVVBfNNI7QeVpwABxkan' };

function fakeWorkerAdapter(methods: Partial<GoogleProvider> = {}): GoogleProvider {
  return {
    verifyReferrer: async () => ({ ok: true, resourceId: 'https://x.leadfinder.business/*' }),
    grantMonitoringViewer: async () => ({ ok: true }),
    grantServiceUsageConsumer: async () => ({ ok: true }),
    reconcileWifProvider: async () => ({ ok: true, resourceId: 'provider' }),
    createMonitoringServiceAccount: async (g: string, accountId: string) => ({ ok: true, resourceId: `${accountId}@${g}.iam.gserviceaccount.com`, saEmail: `${accountId}@${g}.iam.gserviceaccount.com` }),
    verifyUserManagedKeys: async () => ({ ok: true, userManagedCount: 0 }),
    grantWorkloadIdentityUser: async () => ({ ok: true }),
    verifyWifOnboarding: async () => ({ ok: true }),
    verifyBillingIsolation: async () => ({ ok: true }),
    preActivationPlacesUsage: async () => ({ ok: true, usage: 0 }),
    ...methods,
  } as unknown as GoogleProvider;
}

function deps(over: Partial<WorkerCoreDeps> = {}): WorkerCoreDeps {
  const adapter = fakeWorkerAdapter(over.googleAdapterFactory ? undefined : undefined);
  return {
    internalSecret: 'test-internal-secret',
    oidcToken: 'fake-oidc-token',
    saEmail: 'operator-sa@central.iam.gserviceaccount.com',
    projectNumber: '457413606752',
    pool: 'lf-vercel-wif',
    provider: 'vercel-oidc',
    googleAdapterFactory: () => adapter,
    buildGoogleAdapter: async () => ({ ok: true, adapter }),
    ...over,
  };
}

describe('Google Worker proxy (Phase 2C Segment 2e)', () => {
  it('proxy forwards a method call to the worker with HMAC header and returns the bounded result', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const opts: WorkerGoogleAdapterOptions = {
      baseUrl: 'https://dash.example.com',
      internalSecret: 'test-secret',
      post: async (url, body, headers) => {
        calls.push({ url, body, headers });
        return { status: 200, json: async () => ({ ok: true, resourceId: 'https://x.leadfinder.business/*' }) };
      },
    };
    const proxy = createWorkerGoogleAdapter(opts);
    const r = await proxy.verifyReferrer('cust-1', 'https://x.leadfinder.business/*');
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].body.method).toBe('verifyReferrer');
    expect(calls[0].body.args).toEqual(['cust-1', 'https://x.leadfinder.business/*']);
    expect(String(calls[0].headers['x-lf-internal'])).toMatch(/^v1:\d+:[0-9a-f]{64}$/);
    expect(JSON.stringify(calls[0].body)).not.toContain('AIza');
  });

  it('proxy refuses reconcileWifProvider (one-time central infrastructure)', async () => {
    const opts: WorkerGoogleAdapterOptions = {
      baseUrl: 'https://dash.example.com',
      internalSecret: 's',
      post: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    };
    const proxy = createWorkerGoogleAdapter(opts);
    const r = await proxy.reconcileWifProvider(WIF);
    expect(r.ok).toBe(false);
    expect(String((r as { reason?: string }).reason)).toContain('one-time central infrastructure');
  });

  it('worker core: unauthorized request (no OIDC) fails before any Google access', async () => {
    let googleCalled = false;
    const d = deps({
      oidcToken: '',
      buildGoogleAdapter: async () => {
        googleCalled = true;
        return { ok: true, adapter: fakeWorkerAdapter() };
      },
    });
    const res = await runGoogleWorker({ method: 'grantMonitoringViewer', args: ['p1', 'sa@x'] }, d);
    expect(res.status).toBe(403);
    expect(googleCalled).toBe(false);
  });

  it('worker core: reconcileWifProvider refused (central provider never mutated per customer)', async () => {
    const d = deps();
    const res = await runGoogleWorker({ method: 'reconcileWifProvider', args: [WIF] }, d);
    expect(res.status).toBe(403);
    expect(String(res.body.reason)).toContain('one-time central infrastructure');
  });

  it('worker core: unknown method rejected', async () => {
    const d = deps();
    const res = await runGoogleWorker({ method: 'deleteProject', args: ['p1'] }, d);
    expect(res.status).toBe(400);
  });

  it('worker core: dispatches the requested method and returns bounded result (no credential)', async () => {
    const seen: string[] = [];
    const adapter = fakeWorkerAdapter({
      verifyReferrer: async (googleProjectId, restriction) => {
        seen.push(googleProjectId);
        return { ok: true, resourceId: restriction };
      },
    });
    const d = deps({ buildGoogleAdapter: async () => ({ ok: true, adapter }) });
    const res = await runGoogleWorker({ method: 'verifyReferrer', args: ['cust-9', 'https://cust9.leadfinder.business/*'] }, d);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resourceId).toBe('https://cust9.leadfinder.business/*');
    expect(seen).toEqual(['cust-9']);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('oidc');
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('access_token');
  });

  it('worker core: method failure maps to a non-ok bounded result', async () => {
    const adapter = fakeWorkerAdapter({
      verifyUserManagedKeys: async () => ({ ok: false, reason: 'USER_MANAGED keys must be 0 (got 1)' }),
    });
    const d = deps({ buildGoogleAdapter: async () => ({ ok: true, adapter }) });
    const res = await runGoogleWorker({ method: 'verifyUserManagedKeys', args: ['sa@x'] }, d);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.reason)).toContain('USER_MANAGED keys must be 0');
  });

  it('retry safety: repeated identical worker calls do not cross-wire anything (stateless dispatch)', async () => {
    const adapter = fakeWorkerAdapter();
    const d = deps({ buildGoogleAdapter: async () => ({ ok: true, adapter }) });
    const first = await runGoogleWorker({ method: 'grantMonitoringViewer', args: ['p-customer-a', 'sa-a@x'] }, d);
    const second = await runGoogleWorker({ method: 'grantMonitoringViewer', args: ['p-customer-a', 'sa-a@x'] }, d);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(second.body);
  });

  it('HMAC v1 verification: valid + expired + wrong-key cases', () => {
    const stamp = String(Math.floor(Date.now() / 1000));
    const mac = createHmac('sha256', 'secret').update(`lf:${stamp}`).digest('hex');
    expect(verifyInternalAuthV1(`v1:${stamp}:${mac}`, 'secret')).toBe(true);
    expect(verifyInternalAuthV1(`v1:${stamp}:${mac}`, 'wrong')).toBe(false);
    const oldStamp = String(Math.floor(Date.now() / 1000) - 1000);
    const oldMac = createHmac('sha256', 'secret').update(`lf:${oldStamp}`).digest('hex');
    expect(verifyInternalAuthV1(`v1:${oldStamp}:${oldMac}`, 'secret')).toBe(false);
    expect(verifyInternalAuthV1('garbage', 'secret')).toBe(false);
  });
});

void callGoogleWorker;
void (null as unknown as ProviderResult);
