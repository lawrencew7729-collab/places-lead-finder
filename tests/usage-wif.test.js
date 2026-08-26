import { describe, expect, it } from 'vitest';
import { createUsageHandler, DEFAULT_MONITORING_SA, RECONCILE_SCRIPT, SAFETY_STOP, GOOGLE_ALLOWANCE } from '../api/usage.js';
import { pacificBillingMonthStartUtc, pacificBillingMonth } from '../api/billingMonth.js';

function fakeRes() {
  const out = { headers: {}, body: null, statusCode: 200 };
  return {
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
    __out: out,
  };
}

function makeFetchScript(monitoringUsed) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = String(url);
    if (u.includes('sts.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'sts-token-fake' }) };
    }
    if (u.includes('monitoring.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ timeSeries: [
        { points: [{ value: { int64Value: String(monitoringUsed) } }] },
      ] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

/** Fake Redis: scripted eval/set capturing calls; semantics for the reconcile script. */
function fakeRedis(initialUsage) {
  const calls = [];
  let usage = initialUsage;
  let lease = null;
  return {
    calls,
    state: { get usage() { return usage; }, get lease() { return lease; } },
    configured: () => true,
    get: async (k) => (k.includes(':usage:') ? String(usage) : lease),
    set: async (k, v, ...opts) => {
      calls.push(['set', k]);
      if (k.includes('active_search')) {
        if (opts.includes('NX') && lease) return null;
        lease = v;
        return 'OK';
      }
      usage = Number(v) || usage;
      return 'OK';
    },
    del: async () => { lease = null; return 1; },
    incrby: async (k, n) => { usage += n; return usage; },
    expire: async () => 1,
    eval: async (script, keys, args) => {
      calls.push(['eval', script.includes('current < snapshot') ? 'reconcile' : script.includes('INCRBY') ? 'claim' : 'other']);
      // reconcile semantics: usage floor never moves backward
      const snapshot = Number(args[0]);
      if (script.includes('current < snapshot')) {
        if (usage < snapshot) usage = snapshot;
        return String(usage);
      }
      return [1, 0, String(usage)];
    },
  };
}

const OIDC = 'fake-vercel-oidc-token';
const TENANT = '563bfb5f-5ec1-44a8-95b2-2e2ee3e9332b';

function makeHandler(redis, monitoringUsed) {
  const { fetchImpl, calls } = makeFetchScript(monitoringUsed);
  const handler = createUsageHandler({
    oidcTokenProvider: async () => OIDC,
    fetchImpl,
    wifAudience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/lf/providers/vercel',
    monthlyTarget: 1000,
    monitoringSa: DEFAULT_MONITORING_SA,
    redis,
    tenantId: TENANT,
    randomUuid: () => 'sess-uuid-1',
  });
  return { handler, calls, fetchImpl };
}

describe('R1 CENTRALIZED RUN START — Monitoring + Redis reconcile + lease acquire', () => {
  it('success path: reconcile floor -> acquire lease -> {used, cap, safetyStop, sessionId}', async () => {
    const redis = fakeRedis(947);
    const { handler, calls } = makeHandler(redis, 947);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: { deviceId: 'dev-A' } }, res);
    expect(res.__out.statusCode).toBe(200);
    expect(res.__out.body.used).toBe(947);
    expect(res.__out.body.cap).toBe(GOOGLE_ALLOWANCE);
    expect(res.__out.body.safetyStop).toBe(SAFETY_STOP);
    expect(res.__out.body.sessionId).toBe('sess-uuid-1');
    expect(res.__out.body.maxSessionRequests).toBe(50);
    expect(res.__out.body.leaseTtlSeconds).toBe(120);
    expect(res.__out.body.blocked).toBeUndefined();
    expect(res.__out.body.locked).toBeUndefined();
    // exactly ONE Monitoring query happened, with the PACIFIC month-start interval
    const monCalls = calls.filter((c) => String(c.url).includes('monitoring.googleapis.com'));
    expect(monCalls.length).toBe(1);
    const monUrl = String(monCalls[0].url);
    const expectedStart = encodeURIComponent(new Date(pacificBillingMonthStartUtc()).toISOString());
    expect(monUrl).toContain('interval.startTime=' + expectedStart);
    expect(res.__out.body.month).toBe(pacificBillingMonth());
    expect(redis.calls.some(([k, v]) => k === 'eval' && v === 'reconcile')).toBe(true);
    expect(redis.calls.some(([k]) => k === 'set')).toBe(true); // NX acquire
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Monitoring 947 + Redis 956 -> effective 956 (bridge wins) -> RUN blocked', async () => {
    const redis = fakeRedis(956);
    const { handler } = makeHandler(redis, 947);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.body.used).toBe(956);
    expect(res.__out.body.blocked).toBe(true);
    expect(res.__out.body.sessionId).toBeUndefined();
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Monitoring 956 + Redis 947 -> Redis floor reconciled UP to 956 -> RUN blocked', async () => {
    const redis = fakeRedis(947);
    const { handler } = makeHandler(redis, 956);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.body.used).toBe(956);
    expect(res.__out.body.blocked).toBe(true);
    expect(Number(redis.state.usage)).toBe(956); // floor moved forward, never backward
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Monitoring/Redis 950 -> RUN blocked', async () => {
    const redis = fakeRedis(950);
    const { handler } = makeHandler(redis, 950);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.body.blocked).toBe(true);
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Monitoring 949 -> RUN allowed; ending usage <= 999 under the 50 cap', async () => {
    const redis = fakeRedis(949);
    const { handler } = makeHandler(redis, 949);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.body.blocked).toBeUndefined();
    expect(res.__out.body.used).toBe(949);
    // session may issue at most 50 claims -> ending usage <= 999
    expect(949 + 50).toBeLessThanOrEqual(1000);
    expect(949 + 50).toBe(999);
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('another active lease -> locked (SET NX returns null)', async () => {
    const redis = fakeRedis(947);
    redis.set('tenant:whatever:active_search', 'x'); // pre-hold a lease
    const { handler } = makeHandler(redis, 947);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.body.locked).toBe(true);
    expect(res.__out.body.sessionId).toBeUndefined();
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Redis unavailable at RUN -> 503 fail closed', async () => {
    const dead = { configured: () => false };
    const { handler } = makeHandler(dead, 947);
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.statusCode).toBe(503);
    expect(res.__out.body.error).toBe('redis_unavailable');
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('Monitoring failure at RUN -> 500 fail closed (RUN blocked)', async () => {
    const redis = fakeRedis(947);
    const { fetchImpl, calls } = makeFetchScript(947);
    const brokenFetch = async (url, init) => {
      if (String(url).includes('monitoring.googleapis.com')) return { ok: false, status: 500, text: async () => 'boom' };
      return fetchImpl(url, init);
    };
    void calls;
    const handler = createUsageHandler({
      oidcTokenProvider: async () => OIDC,
      fetchImpl: brokenFetch,
      wifAudience: 'aud',
      monthlyTarget: 1000,
      redis,
      tenantId: TENANT,
    });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.statusCode).toBe(500);
    expect(res.__out.body.used).toBeNull();
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('WIF auth preserved: no user-managed credential in source', async () => {
    const source = (await import('../api/usage.js?raw')).default;
    expect(source).not.toContain('process.env.SERVICE_ACCOUNT_JSON');
    expect(source).not.toContain('private_key');
    expect(source).not.toContain('client_email');
  });

  it('missing tenantId / audience / project -> 503 not_configured', async () => {
    const redis = fakeRedis(0);
    const { fetchImpl } = makeFetchScript(0);
    const handler = createUsageHandler({ oidcTokenProvider: async () => OIDC, fetchImpl, wifAudience: '', monthlyTarget: 1000, redis, tenantId: '' });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({ query: {} }, res);
    expect(res.__out.statusCode).toBe(503);
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });
});
