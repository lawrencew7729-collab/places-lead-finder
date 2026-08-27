/**
 * R1 TWO-DEVICE CONTRACT — customer-app device lock (api/device.js, v1.0.4).
 *
 * Owner policy (approved): every NEW Lead Finder customer deployment enforces
 * MAX_DEVICES = 2, keyed by the IMMUTABLE tenant id
 * (tenant:<CUSTOMER_TENANT_ID> — CENTRALIZED Upstash model, per-tenant ACL).
 * First two authorized devices claim the slots; a third unknown device is
 * DENIED; no automatic eviction; no TTL; owner-controlled release only.
 * Missing tenant id / KV / access code → FAIL CLOSED (never degrades to open).
 *
 * These tests exercise the real /api/device handler with a scripted
 * in-memory Upstash-REST-compatible KV transport (no live store).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import deviceHandler from '../api/device.js';

const KV_URL = 'https://kv-a.example.com';
const KV_TOKEN = 'tok_test_secret';
const APP_PASS = 'accesscode123456'; // 16-char customer access code
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** In-memory Upstash-REST-compatible KV backing store + call log (v1.0.4 protocol). */
function createKv() {
  const store = new Map();
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    const u = String(url);
    // Upstash REST path-style: /<command>/<arg1>/<arg2>... (URL-encoded)
    const segs = u.split('/').slice(3).map((s) => decodeURIComponent(s));
    const command = segs[0];
    if (command === 'get') {
      const raw = store.has(segs[1]) ? JSON.stringify(store.get(segs[1])) : null;
      return { ok: true, status: 200, json: async () => ({ result: raw }) };
    }
    if (command === 'set') {
      store.set(segs[1], JSON.parse(segs[2]));
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    if (command === 'del') {
      for (const k of segs.slice(1)) store.delete(k);
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    if (command === 'eval') {
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    throw new Error('unexpected kv url ' + u);
  });
  return { store, calls, fetchMock };
}

function makeReq(query, headers = {}, body = undefined) {
  return {
    query,
    headers: { host: 'abc.leadfinder.business', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36', ...headers },
    body,
  };
}

function makeRes() {
  const calls = [];
  const res = {
    status(code) { calls.push(['status', code]); return this; },
    json(payload) { calls.push(['json', payload]); return this; },
  };
  return { res, calls };
}

function jsonOf(resCalls) {
  const entry = resCalls.find(([kind]) => kind === 'json');
  return entry ? entry[1] : null;
}

async function register(tenantId, id, pass = APP_PASS, label = id) {
  const { res, calls } = makeRes();
  await deviceHandler(makeReq({ mode: 'register', id }, { 'x-forwarded-host': 'whatever.leadfinder.business' }, { id, label, pass }), res);
  return calls;
}

let kv;

beforeEach(() => {
  kv = createKv();
  vi.stubGlobal('fetch', kv.fetchMock);
  vi.stubEnv('CUSTOMER_TENANT_ID', TENANT_A);
  vi.stubEnv('KV_REST_API_URL', KV_URL);
  vi.stubEnv('KV_REST_API_TOKEN', KV_TOKEN);
  vi.stubEnv('APP_PASS', APP_PASS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('two-device contract — slot claiming', () => {
  it('MAX_DEVICES is exactly 2', async () => {
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'probe' }), res);
    expect(jsonOf(calls).maxDevices).toBe(2);
    expect(jsonOf(calls).maxDevices).not.toBe(1);
    expect(jsonOf(calls).maxDevices).not.toBe(3);
  });

  it('first authorized login (Device A) → registered, allowed', async () => {
    const calls = await register(TENANT_A, 'dev-A');
    expect(jsonOf(calls).allowed).toBe(true);
    expect(jsonOf(calls).devices).toBe(1);
    expect(jsonOf(calls).max).toBe(2);
  });

  it('second authorized login (Device B) → registered, allowed', async () => {
    await register(TENANT_A, 'dev-A');
    const calls = await register(TENANT_A, 'dev-B');
    expect(jsonOf(calls).allowed).toBe(true);
    expect(jsonOf(calls).devices).toBe(2);
  });

  it('third unknown device (Device C) → DENIED, limit', async () => {
    await register(TENANT_A, 'dev-A');
    await register(TENANT_A, 'dev-B');
    const calls = await register(TENANT_A, 'dev-C');
    const j = jsonOf(calls);
    expect(j.allowed).toBe(false);
    expect(j.reason).toBe('limit');
    expect(j.max).toBe(2);
    // denied device is NOT persisted
    expect(kv.store.get(`tenant:${TENANT_A}:devices`).devices.map((d) => d.id)).toEqual(['dev-A', 'dev-B']);
  });

  it('registered devices remain allowed (check + re-register idempotent)', async () => {
    await register(TENANT_A, 'dev-A');
    await register(TENANT_A, 'dev-B');
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    expect(jsonOf(calls).allowed).toBe(true);
    const calls2 = await register(TENANT_A, 'dev-A');
    expect(jsonOf(calls2).allowed).toBe(true);
    expect(jsonOf(calls2).devices).toBe(2);
    expect(kv.store.get(`tenant:${TENANT_A}:devices`).devices).toHaveLength(2);
  });

  it('wrong access code is refused even for a registered device (server APP_PASS enforcement)', async () => {
    await register(TENANT_A, 'dev-A');
    const calls = await register(TENANT_A, 'dev-A', 'wrongcode12345');
    expect(jsonOf(calls).allowed).toBe(false);
    expect(jsonOf(calls).reason).toBe('invalid');
  });

  it('unknown device id is not allowed by check before registration', async () => {
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'never-seen' }), res);
    expect(jsonOf(calls).allowed).toBe(false);
    expect(jsonOf(calls).reason).toBe('not_registered');
  });
});

describe('two-device contract — no automatic eviction', () => {
  it('registry write carries NO expiry (no EX TTL) — no automatic slot release', async () => {
    await register(TENANT_A, 'dev-A');
    const setCalls = kv.calls.filter((c) => c.url.includes('/set'));
    expect(setCalls.length).toBeGreaterThan(0);
    for (const c of setCalls) {
      expect(c.url).not.toMatch(/[?&]EX=/);
      expect(c.url).not.toContain('EX=');
    }
  });

  it('registry survives repeated activity without expiry refresh', async () => {
    await register(TENANT_A, 'dev-A');
    const { res } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    expect(kv.store.get(`tenant:${TENANT_A}:devices`).devices).toHaveLength(1);
  });
});

describe('two-device contract — owner-controlled isolated maintenance (no public reset path)', () => {
  it('NO public reset/remove/list endpoint exists (unknown mode → 400)', async () => {
    for (const mode of ['reset', 'remove', 'list']) {
      const { res, calls } = makeRes();
      await deviceHandler(makeReq({ mode, id: 'dev-A', admin: 'anything' }), res);
      expect(calls.some(([kind, code]) => kind === 'status' && code === 400)).toBe(true);
      expect(calls.some(([kind, code]) => kind === 'status' && code === 200)).toBe(false);
    }
  });

  it('owner maintenance clears ALL slots by operating directly on the dedicated store record', async () => {
    await register(TENANT_A, 'dev-A');
    await register(TENANT_A, 'dev-B');
    // OWNER-CONTROLLED ISOLATED MAINTENANCE: direct operation on THAT customer's
    // dedicated store key — no runtime endpoint involved.
    kv.store.delete(`tenant:${TENANT_A}:devices`);
    // both slots freed; a fresh device can claim slot 1 again
    const calls = await register(TENANT_A, 'dev-A');
    expect(jsonOf(calls).allowed).toBe(true);
    expect(jsonOf(calls).devices).toBe(1);
  });

  it('owner maintenance releases ONE slot by editing the store record directly (replacement occupies it)', async () => {
    await register(TENANT_A, 'dev-A');
    await register(TENANT_A, 'dev-B');
    // direct store edit: drop dev-A from the registry record (owner maintenance)
    const rec = kv.store.get(`tenant:${TENANT_A}:devices`);
    rec.devices = rec.devices.filter((d) => d.id !== 'dev-A');
    kv.store.set(`tenant:${TENANT_A}:devices`, rec);
    // replacement device C occupies the released slot
    const calls = await register(TENANT_A, 'dev-C');
    expect(jsonOf(calls).allowed).toBe(true);
    expect(jsonOf(calls).devices).toBe(2);
  });

  it('maintenance on ONE tenant never touches another tenant store (isolation)', async () => {
    await register(TENANT_A, 'A-dev1');
    await register(TENANT_A, 'A-dev2');
    vi.stubEnv('CUSTOMER_TENANT_ID', TENANT_B);
    await register(TENANT_B, 'B-dev1');
    await register(TENANT_B, 'B-dev2');
    // owner maintenance on tenant B's key only
    kv.store.delete(`tenant:${TENANT_B}:devices`);
    // tenant A registry untouched
    expect(kv.store.get(`tenant:${TENANT_A}:devices`).devices).toHaveLength(2);
    // tenant B freed
    expect(kv.store.has(`tenant:${TENANT_B}:devices`)).toBe(false);
    // B can now re-register; A is still at its limit
    vi.stubEnv('CUSTOMER_TENANT_ID', TENANT_B);
    const calls = await register(TENANT_B, 'B-dev1');
    expect(jsonOf(calls).allowed).toBe(true);
  });
});

describe('two-device contract — immutable tenant identity isolation', () => {
  it('different tenants NEVER share device slots (registry key = tenant id, not host)', async () => {
    // Tenant A fills both slots
    await register(TENANT_A, 'A-dev1');
    await register(TENANT_A, 'A-dev2');
    // Tenant B still has both slots free — same store, different tenant → separate registry
    vi.stubEnv('CUSTOMER_TENANT_ID', TENANT_B);
    const calls = await register(TENANT_B, 'B-dev1');
    expect(jsonOf(calls).allowed).toBe(true);
    expect(jsonOf(calls).devices).toBe(1);
    const calls2 = await register(TENANT_B, 'B-dev2');
    expect(jsonOf(calls2).allowed).toBe(true);
    expect(jsonOf(calls2).devices).toBe(2);
    const calls3 = await register(TENANT_B, 'B-dev3');
    expect(jsonOf(calls3).allowed).toBe(false);
    expect(jsonOf(calls3).reason).toBe('limit');
    // separate KV keys per tenant
    expect(kv.store.get(`tenant:${TENANT_A}:devices`).devices).toHaveLength(2);
    expect(kv.store.get(`tenant:${TENANT_B}:devices`).devices).toHaveLength(2);
  });

  it('same tenant across different hosts → SAME registry (hostname is NOT the identity)', async () => {
    await register(TENANT_A, 'dev-A');
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }, { host: 'completely.different.example' }), res);
    expect(jsonOf(calls).allowed).toBe(true);
  });
});

describe('two-device contract — secret boundary', () => {
  it('no response ever contains KV token / access code (no admin secret exists in v1.0.2)', async () => {
    await register(TENANT_A, 'dev-A');
    await register(TENANT_A, 'dev-B');
    // every runtime response carries registry state only — never credentials
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    const body = JSON.stringify(jsonOf(calls));
    expect(body).not.toContain(KV_TOKEN);
    expect(body).not.toContain(APP_PASS);
    // KV request bodies never carry tokens/secrets
    for (const c of kv.calls) {
      expect(JSON.stringify(c.body ?? '')).not.toContain(KV_TOKEN);
      expect(JSON.stringify(c.body ?? '')).not.toContain(APP_PASS);
    }
  });

  it('probe returns booleans only — never secret values', async () => {
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'probe' }), res);
    const j = jsonOf(calls);
    expect(j.mode).toBe('locked');
    expect(j.maxDevices).toBe(2);
    expect(j.kvConfigured).toBe(true);
    expect(j.appPassConfigured).toBe(true);
    expect(j.tenantIdConfigured).toBe(true);
    const body = JSON.stringify(j);
    expect(body).not.toContain(KV_TOKEN);
    expect(body).not.toContain(APP_PASS);
    expect(body).not.toContain(KV_URL);
    expect(body).not.toContain(TENANT_A);
  });
});

describe('two-device contract — FAIL CLOSED (never degrades to open mode)', () => {
  it('missing CUSTOMER_TENANT_ID → all device operations denied (not_configured)', async () => {
    vi.stubEnv('CUSTOMER_TENANT_ID', '');
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    expect(jsonOf(calls)).toEqual({ allowed: false, reason: 'not_configured' });
    const calls2 = await register('', 'dev-A');
    expect(jsonOf(calls2).allowed).toBe(false);
    expect(jsonOf(calls2).reason).toBe('not_configured');
    // probe reports unconfigured so provisioning fails closed too
    const { res: res3, calls: calls3 } = makeRes();
    await deviceHandler(makeReq({ mode: 'probe' }), res3);
    const probe = jsonOf(calls3);
    expect(probe.mode).toBe('unconfigured');
    expect(probe.tenantIdConfigured).toBe(false);
  });

  it('missing KV store → denied (not_configured), probe mode open', async () => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'check', id: 'dev-A' }), res);
    expect(jsonOf(calls).allowed).toBe(false);
    expect(jsonOf(calls).reason).toBe('not_configured');
    const calls2 = await register(TENANT_A, 'dev-A');
    expect(jsonOf(calls2).allowed).toBe(false);
    expect(jsonOf(calls2).reason).toBe('not_configured');
    const { res: res3, calls: calls3 } = makeRes();
    await deviceHandler(makeReq({ mode: 'probe' }), res3);
    const probe = jsonOf(calls3);
    expect(probe.mode).toBe('open');
    expect(probe.kvConfigured).toBe(false);
    expect(probe.maxDevices).toBe(2);
  });

  it('missing APP_PASS access code → registration denied (not_configured)', async () => {
    vi.stubEnv('APP_PASS', '');
    const calls = await register(TENANT_A, 'dev-A');
    expect(jsonOf(calls).allowed).toBe(false);
    expect(jsonOf(calls).reason).toBe('not_configured');
    const { res: res2, calls: calls2 } = makeRes();
    await deviceHandler(makeReq({ mode: 'probe' }), res2);
    expect(jsonOf(calls2).appPassConfigured).toBe(false);
  });

  it('unknown mode → 400', async () => {
    const { res, calls } = makeRes();
    await deviceHandler(makeReq({ mode: 'nonsense' }), res);
    expect(calls.some(([kind, code]) => kind === 'status' && code === 400)).toBe(true);
  });
});
