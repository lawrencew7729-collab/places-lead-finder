import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsageHandler } from '../api/usage.js';
import { parseTenantConfig } from '../src/packageControl.js';

const TENANT = 't-enforce';

function fakeRedis(store = {}) {
  return {
    configured: () => true,
    get: async (k) => (k in store ? store[k] : null),
    set: async (k, v) => { store[k] = v; return 'OK'; },
    del: async () => 1,
    incrby: async () => 0,
    expire: async () => 1,
    eval: async (script, keys, args) => args[0],   // reconcile floor = monitoring snapshot
  };
}

function fakeFetch(used) {
  return async (url) => {
    const u = String(url);
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes('sts.googleapis.com')) return json({ access_token: 'federated' });
    if (u.includes('iamcredentials.googleapis.com')) return json({ accessToken: 'sa-token' });
    if (u.includes('monitoring.googleapis.com')) return json({ timeSeries: [{ points: [{ value: { int64Value: String(used) } }] }] });
    throw new Error('unexpected fetch ' + u);
  };
}

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function handlerFor({ used, config }) {
  const store = {};
  if (config) store[`tenant:${TENANT}:config`] = typeof config === 'string' ? config : JSON.stringify(config);
  const redis = fakeRedis(store);
  const handler = createUsageHandler({
    oidcTokenProvider: async () => 'oidc-token',
    fetchImpl: fakeFetch(used),
    monitoringSa: 'sa@example.iam.gserviceaccount.com',
    wifAudience: 'wif-audience',
    monthlyTarget: 1000,
    redis,
    tenantId: TENANT,
    now: () => new Date('2026-09-10T04:00:00Z'),
    randomUuid: () => 'session-1',
  });
  return { handler, store };
}

const run = async (opts, query = {}) => {
  const { handler, store } = handlerFor(opts);
  const res = fakeRes();
  await handler({ method: 'GET', query, headers: {} }, res);
  return { res, store };
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('v1.0.11 server-side package enforcement (/api/usage)', () => {
  it('A. STARTER_500: usage 499 allows a session; usage 500 blocks (no session issued)', async () => {
    vi.stubEnv('CUSTOMER_GOOGLE_PROJECT_ID', 'proj-x');
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';

    const ok = await run({ used: 499 });
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.body.blocked).toBe(false);
    expect(ok.res.body.sessionId).toBe('session-1');
    expect(ok.res.body.package).toBe('STARTER_500');
    expect(ok.res.body.searchStop).toBe(500);

    const blocked = await run({ used: 500 });
    expect(blocked.res.statusCode).toBe(200);
    expect(blocked.res.body).toMatchObject({ blocked: true, blockReason: 'PACKAGE_LIMIT_REACHED', package: 'STARTER_500' });
    expect(blocked.res.body.sessionId).toBeUndefined();          // no lease → no search
    expect(blocked.store[`tenant:${TENANT}:active_search`]).toBeUndefined();
  });

  it('B. FULL_900: usage 500 and 899 allowed; usage 900 blocked', async () => {
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';
    const full = { package: 'FULL_900', serviceStatus: 'ACTIVE' };
    for (const used of [500, 899]) {
      const r = await run({ used, config: full });
      expect(r.res.body.blocked).toBe(false);
      expect(r.res.body.sessionId).toBe('session-1');
      expect(r.res.body.searchStop).toBe(900);
    }
    const at900 = await run({ used: 900, config: full });
    expect(at900.res.body).toMatchObject({ blocked: true, blockReason: 'PACKAGE_LIMIT_REACHED', package: 'FULL_900' });
  });

  it('C. STOPPED blocks at any usage and RESUMEd state restores search under the package limit', async () => {
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';
    const stopped = await run({ used: 3, config: { package: 'FULL_900', serviceStatus: 'STOPPED' } });
    expect(stopped.res.body).toMatchObject({ blocked: true, blockReason: 'SERVICE_STOPPED', serviceStatus: 'STOPPED' });
    const resumed = await run({ used: 3, config: { package: 'FULL_900', serviceStatus: 'ACTIVE' } });
    expect(resumed.res.body.blocked).toBe(false);
    expect(resumed.res.body.sessionId).toBe('session-1');
  });

  it('missing config key → new-customer default STARTER_500 / ACTIVE (stop 500)', async () => {
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';
    const r = await run({ used: 0, config: null });
    expect(r.res.body).toMatchObject({ package: 'STARTER_500', serviceStatus: 'ACTIVE', searchStop: 500, blocked: false });
    expect(parseTenantConfig(r.store[`tenant:${TENANT}:config`] ?? null).package).toBe('STARTER_500');
  });

  it('peek is read-only: reports state, never acquires the lease', async () => {
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';
    const r = await run({ used: 12, config: { package: 'STARTER_500', serviceStatus: 'ACTIVE' } }, { mode: 'peek' });
    expect(r.res.body).toMatchObject({ peek: true, package: 'STARTER_500', blocked: false });
    expect('usage' in r.res.body).toBe(false);   // display field is `used`, never a package rename
    expect(r.res.body.used).toBe(12);
    expect(r.res.body.portalVersion).toBe('1.0.11');
    expect(r.store[`tenant:${TENANT}:active_search`]).toBeUndefined();
    expect(r.store[`tenant:${TENANT}:config`]).toBeDefined();   // peek never rewrites state
  });

  it('FAIL CLOSED: an unreadable authoritative state returns 503 (never silently unenforced)', async () => {
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'proj-x';
    const redis = fakeRedis({});
    redis.get = async () => { throw new Error('redis read failed'); };
    const handler = createUsageHandler({
      oidcTokenProvider: async () => 'oidc-token', fetchImpl: fakeFetch(0),
      monitoringSa: 'sa@example.iam.gserviceaccount.com', wifAudience: 'wif-audience',
      monthlyTarget: 1000, redis, tenantId: TENANT,
      now: () => new Date('2026-09-10T04:00:00Z'), randomUuid: () => 'session-1',
    });
    const res = fakeRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('state_unavailable');
  });
});
