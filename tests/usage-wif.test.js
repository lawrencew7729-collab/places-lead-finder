import { describe, expect, it, beforeEach } from 'vitest';
import { createUsageHandler, DEFAULT_MONITORING_SA, RECONCILE_SCRIPT, SAFETY_STOP, GOOGLE_ALLOWANCE } from '../api/usage.js';
import { pacificBillingMonth, pacificBillingMonthStartUtc } from '../api/billingMonth.js';

const TENANT = '563bfb5f-5ec1-44a8-95b2-2e2ee3e9332b';

// projectId is read from server env at request time (request-time env reads).
beforeEach(() => {
  process.env.GOOGLE_CLOUD_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
});

function fakeRes() {
  const out = { statusCode: 200, body: null, setHeader() {}, status(c) { out.statusCode = c; return this; }, json(p) { out.body = p; return this; } };
  return out;
}

/** Scripted fetch serving STS -> IAMCredentials -> Monitoring; records every call. */
function scriptedFetch({ stsStatus = 200, stsBody = { access_token: 'fed-token-1' }, iamStatus = 200, iamBody = { accessToken: 'sa-token-1', expireTime: 'x' }, monStatus = 200, monBody = { timeSeries: [{ points: [{ value: { doubleValue: 42 } }] }] } } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('sts.googleapis.com')) {
      return { ok: stsStatus >= 200 && stsStatus < 300, status: stsStatus, json: async () => (stsStatus >= 200 && stsStatus < 300 ? stsBody : { error: 'x', error_description: 'sts down' }) };
    }
    if (url.includes('iamcredentials.googleapis.com')) {
      return { ok: iamStatus >= 200 && iamStatus < 300, status: iamStatus, json: async () => (iamStatus >= 200 && iamStatus < 300 ? iamBody : { error: { message: 'iam down' } }) };
    }
    if (url.includes('monitoring.googleapis.com')) {
      return { ok: monStatus >= 200 && monStatus < 300, status: monStatus, json: async () => (monStatus >= 200 && monStatus < 300 ? monBody : { error: { message: 'mon down' }, code: 403 }) };
    }
    throw new Error('unexpected url ' + url);
  };
  fn.calls = calls;
  return fn;
}

function memoryRedis({ usage = 0, lease = null } = {}) {
  let usageV = usage;
  let leaseV = lease;
  const calls = [];
  return {
    redis: {
      configured: () => true,
      get: async (k) => { calls.push(['get', k]); if (k.includes('usage')) return String(usageV); return leaseV; },
      set: async (k, v, ...opts) => {
        calls.push(['set', k]);
        if (k.includes('active_search')) { if (opts.includes('NX') && leaseV) return null; leaseV = v; return 'OK'; }
        usageV = Number(v) || usageV; return 'OK';
      },
      eval: async (script, keys, args) => {
        calls.push(['eval', script.slice(0, 20), keys[0]]);
        if (script.includes('current')) { const cur = Number(usageV || 0); const snap = Number(args[0]); const max = Math.max(cur, snap); if (max > cur) usageV = max; return String(max); }
        return String(usageV);
      },
    },
    calls,
  };
}

function handlerWith({ fetchImpl, redis, oidcProvider = async () => 'oidc-token-1' } = {}) {
  return createUsageHandler({
    oidcTokenProvider: oidcProvider,
    fetchImpl,
    monitoringSa: DEFAULT_MONITORING_SA,
    wifAudience: '//iam.googleapis.com/projects/457413606752/locations/global/workloadIdentityPools/lf-vercel-wif/providers/vercel-oidc',
    monthlyTarget: 1000,
    tenantId: TENANT,
    redis,
  });
}

describe('R1 v1.0.6 WIF two-stage auth (STS -> IAMCredentials -> Monitoring)', () => {
  it('STS request contains NO serviceAccount parameter; exchange -> generateAccessToken -> Monitoring uses the SA token', async () => {
    const fetchImpl = scriptedFetch();
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: { deviceId: 'dev-1' } }, res);

    const sts = fetchImpl.calls.find((c) => c.url.includes('sts.googleapis.com'));
    expect(sts).toBeTruthy();
    expect(String(sts.init.body)).not.toContain('serviceAccount');
    expect(String(sts.init.body)).not.toContain('service_account');
    expect(String(sts.init.body)).toContain(encodeURIComponent('https://www.googleapis.com/auth/cloud-platform'));

    const iam = fetchImpl.calls.find((c) => c.url.includes('iamcredentials.googleapis.com'));
    expect(iam).toBeTruthy();
    expect(iam.url).toContain('/projects/-/serviceAccounts/' + encodeURIComponent(DEFAULT_MONITORING_SA) + ':generateAccessToken');
    expect(iam.init.headers.Authorization).toBe('Bearer fed-token-1'); // federated token ONLY reaches IAMCredentials
    const iamBody = JSON.parse(iam.init.body);
    expect(iamBody.scope).toEqual(['https://www.googleapis.com/auth/monitoring.read']);
    expect(iamBody.lifetime).toBe('300s');

    const mon = fetchImpl.calls.find((c) => c.url.includes('monitoring.googleapis.com'));
    expect(mon).toBeTruthy();
    expect(mon.init.headers.Authorization).toBe('Bearer sa-token-1'); // SA token ONLY reaches Monitoring

    expect(res.statusCode).toBe(200);
    expect(res.body.used).toBe(42);
    expect(res.body.cap).toBe(GOOGLE_ALLOWANCE);
    expect(res.body.safetyStop).toBe(SAFETY_STOP);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.maxSessionRequests).toBe(50);
    expect(res.body.leaseTtlSeconds).toBe(120);
    expect(res.body.month).toBe(pacificBillingMonth());
  });

  it('Monitoring interval starts at the Pacific billing month start (DST-aware)', async () => {
    const fetchImpl = scriptedFetch();
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    const mon = fetchImpl.calls.find((c) => c.url.includes('monitoring.googleapis.com'));
    expect(mon.url).toContain(encodeURIComponent(pacificBillingMonthStartUtc().toISOString()));
  });

  it('STS failure fails closed (503, no IAMCredentials call)', async () => {
    const fetchImpl = scriptedFetch({ stsStatus: 500 });
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBeTruthy();
    expect(fetchImpl.calls.some((c) => c.url.includes('iamcredentials'))).toBe(false);
  });

  it('IAMCredentials failure fails closed (503, no Monitoring call)', async () => {
    const fetchImpl = scriptedFetch({ iamStatus: 403 });
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(fetchImpl.calls.some((c) => c.url.includes('monitoring.googleapis.com'))).toBe(false);
  });

  it('Monitoring failure fails closed (503, no lease acquired)', async () => {
    const fetchImpl = scriptedFetch({ monStatus: 403 });
    const { redis, calls } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(calls.some((c) => c[0] === 'set' && c[1].includes('active_search'))).toBe(false);
  });

  it('OIDC provider failure fails closed before STS', async () => {
    const fetchImpl = scriptedFetch();
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis, oidcProvider: async () => { throw new Error('no token'); } })({ query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('reconcile floor + NX lease acquire + safety stop 950 on the RUN-start path', async () => {
    // Monitoring 947 + Redis 956 -> effective 956 -> RUN blocked
    const fetchImpl = scriptedFetch({ monBody: { timeSeries: [{ points: [{ value: { doubleValue: 947 } }] }] } });
    const { redis } = memoryRedis({ usage: 956 });
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    expect(res.body.used).toBe(956);
    expect(res.body.blocked).toBe(true);
    expect(res.body.sessionId).toBeUndefined();
  });

  it('lease conflict: another active session -> locked (no sessionId)', async () => {
    const fetchImpl = scriptedFetch();
    const { redis } = memoryRedis({ lease: JSON.stringify({ sessionId: 'other', deviceId: 'dev-2', attempts: 0 }) });
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    expect(res.body.locked).toBe(true);
    expect(res.body.sessionId).toBeUndefined();
  });

  it('tokens are never logged: handler output + call bodies contain no token material', async () => {
    const fetchImpl = scriptedFetch();
    const { redis } = memoryRedis();
    const res = fakeRes();
    await handlerWith({ fetchImpl, redis })({ query: {} }, res);
    const serialized = JSON.stringify({ resBody: res.body, calls: fetchImpl.calls.map((c) => c.url) });
    expect(serialized).not.toContain('fed-token-1');
    expect(serialized).not.toContain('sa-token-1');
    expect(serialized).not.toContain('oidc-token-1');
  });
});
