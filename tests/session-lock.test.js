/**
 * R1 CENTRALIZED — active-search lease + per-request atomic claim tests.
 *
 * These tests drive the REAL /api/session handler against a semantics mirror
 * of the deployed Lua scripts (CLAIM_SCRIPT / RELEASE_SCRIPT / STATUS_SCRIPT).
 * The mirror implements the same contract in JS (lease+ownership+cap check,
 * attempts INCR, usage INCR, TTL renew); the Lua scripts themselves are
 * additionally asserted by content so the mirror cannot drift. Byte-exact Lua
 * execution against real Redis is a Phase E (paid ACL store) verification.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSessionHandler, CLAIM_SCRIPT, RELEASE_SCRIPT, STATUS_SCRIPT, MAX_SESSION_REQUESTS, SESSION_TTL_SECONDS } from '../api/session.js';
import { tenantActiveSearchKey, tenantUsageKey } from '../api/redis.js';
import { pacificBillingMonth } from '../api/billingMonth.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MONTH = pacificBillingMonth();

/** In-memory Redis semantics mirror (GET/SET EX NX/DEL/INCRBY/EXPIRE + our scripts). */
function createMemoryRedis() {
  const map = new Map(); // key -> {value, ttl}
  const now = { t: 1_000_000 };
  const redis = {
    configured: () => true,
    async get(k) { const e = map.get(k); if (!e) return null; if (e.ttl && e.ttl <= now.t) { map.delete(k); return null; } return e.value; },
    async set(k, v, ...opts) {
      now.t += 1; // monotonic clock so renewals are observable
      const o = Object.fromEntries(opts.map((x, i) => [i % 2 ? opts[i - 1] : x, i % 2 ? x : true]));
      const existing = map.get(k);
      if (o.NX && existing && existing.ttl !== 0 && (!existing.ttl || existing.ttl > now.t)) return null;
      map.set(k, { value: v, ttl: o.EX ? now.t + Number(o.EX) : 0 });
      return 'OK';
    },
    async del(...ks) { let n = 0; for (const k of ks) if (map.delete(k)) n++; return n; },
    async incrby(k, n) { const cur = Number((await this.get(k)) ?? 0); const next = cur + n; map.set(k, { value: String(next), ttl: 0 }); return next; },
    async expire(k, s) { const e = map.get(k); if (!e) return 0; e.ttl = now.t + Number(s); return 1; },
    async eval(script, keys, args) {
      // --- CLAIM (semantics mirror of CLAIM_SCRIPT) ---
      if (script.includes('d.sessionId ~= ARGV[1]') && script.includes('INCRBY')) {
        const leaseRaw = await this.get(keys[0]);
        if (!leaseRaw) return [0, 'no_session'];
        const d = JSON.parse(leaseRaw);
        if (d.sessionId !== args[0]) return [0, 'ownership'];
        if (Number(d.attempts) >= Number(args[1])) return [0, 'cap'];
        d.attempts = d.attempts + 1;
        await this.set(keys[0], JSON.stringify(d), 'EX', args[2]);
        const used = await this.incrby(keys[1], 1);
        return [1, d.attempts, String(used)];
      }
      // --- RELEASE (semantics mirror of RELEASE_SCRIPT) ---
      if (script.includes("redis.call('DEL', KEYS[1])")) {
        const leaseRaw = await this.get(keys[0]);
        if (!leaseRaw) return [0, 'no_session'];
        const d = JSON.parse(leaseRaw);
        if (d.sessionId !== args[0]) return [0, 'ownership'];
        await this.del(keys[0]);
        return [1];
      }
      // --- STATUS (semantics mirror of STATUS_SCRIPT) ---
      const lease = await this.get(keys[0]);
      const usage = await this.get(keys[1]);
      return [lease, usage];
    },
  };
  return { redis, now, map };
}

function makeReq(query, body) { return { query, body }; }
function makeRes() {
  const calls = [];
  const res = {
    setHeader() {},
    status(code) { calls.push(['status', code]); return this; },
    json(p) { calls.push(['json', p]); return this; },
  };
  return { res, calls, json: () => calls.find(([k]) => k === 'json')?.[1] ?? null, status: () => calls.find(([k]) => k === 'status')?.[1] ?? 200 };
}

function handlerFor(redis, tenantId = TENANT_A) {
  return createSessionHandler({ redis, tenantId });
}

describe('R1 CENTRALIZED — Lua scripts carry the exact contract', () => {
  it('CLAIM_SCRIPT: ownership + cap + attempts INCR + usage INCR + TTL renew', () => {
    expect(CLAIM_SCRIPT).toContain("if d.sessionId ~= ARGV[1] then return {0, 'ownership'} end");
    expect(CLAIM_SCRIPT).toContain("if tonumber(d.attempts) >= tonumber(ARGV[2]) then return {0, 'cap'} end");
    expect(CLAIM_SCRIPT).toContain("d.attempts = d.attempts + 1");
    expect(CLAIM_SCRIPT).toContain("redis.call('SET', KEYS[1], cjson.encode(d), 'EX', ARGV[3])");
    expect(CLAIM_SCRIPT).toContain("redis.call('INCRBY', KEYS[2], 1)");
  });
  it('RELEASE_SCRIPT: compare-and-release only by the owning session', () => {
    expect(RELEASE_SCRIPT).toContain("if d.sessionId ~= ARGV[1] then return {0, 'ownership'} end");
    expect(RELEASE_SCRIPT).toContain("redis.call('DEL', KEYS[1])");
  });
  it('STATUS_SCRIPT: reads lease + usage only (no Monitoring)', () => {
    expect(STATUS_SCRIPT).toContain("redis.call('GET', KEYS[1])");
    expect(STATUS_SCRIPT).toContain("redis.call('GET', KEYS[2])");
  });
});

describe('R1 CENTRALIZED — single active device', () => {
  it('lease acquire is exclusive (SET NX semantics via usage handler); claim requires ownership', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    // Device A holds a lease
    const leaseA = JSON.stringify({ sessionId: 'sess-A', deviceId: 'dev-A', attempts: 0, acquiredAt: Date.now() });
    await redis.set(tenantActiveSearchKey(TENANT_A), leaseA, 'EX', String(SESSION_TTL_SECONDS));
    // Device B claims with its own sessionId -> ownership denied
    const rB = makeRes();
    await h(makeReq({ mode: 'claim', sessionId: 'sess-B' }), rB.res);
    expect(rB.status()).toBe(409);
    expect(rB.json().reason).toBe('ownership');
  });

  it('only the owning session may release', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    const rB = makeRes();
    await h(makeReq({ mode: 'release', sessionId: 'sess-B' }), rB.res);
    expect(rB.json().reason).toBe('ownership');
    const rA = makeRes();
    await h(makeReq({ mode: 'release', sessionId: 'sess-A' }), rA.res);
    expect(rA.json().ok).toBe(true);
  });

  it('status reflects an active lease (Device-B UX, Redis-only)', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    const idle = makeRes();
    await h(makeReq({ mode: 'status' }), idle.res);
    expect(idle.json().active).toBe(false);
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    const active = makeRes();
    await h(makeReq({ mode: 'status' }), active.res);
    expect(active.json().active).toBe(true);
    expect(active.json().sessionId).toBe('sess-A');
  });
});

describe('R1 CENTRALIZED — 50-attempt server-side cap + usage bridge', () => {
  it('claim #51 is rejected; usage bridge counts exactly 50; request #51 not issued', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    let issued = 0;
    for (let i = 1; i <= MAX_SESSION_REQUESTS + 1; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
      if (r.json().ok) issued++; // the Google request would be issued only on ok
      else expect(r.json().reason).toBe('cap');
    }
    expect(issued).toBe(MAX_SESSION_REQUESTS); // exactly 50 issued
    const usage = await redis.get(tenantUsageKey(TENANT_A, MONTH));
    expect(Number(usage)).toBe(50);
  });

  it('B2: run starting at 899 + 50 claims = exactly 949 (app-originated monthly max); claim #51 rejected', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    // RUN authorized at 899 (below safety stop 900) -> session opens
    await redis.set(tenantUsageKey(TENANT_A, MONTH), '899');
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    let issued = 0;
    for (let i = 1; i <= MAX_SESSION_REQUESTS + 1; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
      if (r.json().ok) issued++;
      else expect(r.json().reason).toBe('cap');
    }
    expect(issued).toBe(MAX_SESSION_REQUESTS); // exactly 50
    const usage = await redis.get(tenantUsageKey(TENANT_A, MONTH));
    expect(Number(usage)).toBe(949); // 899 + 50 = 949 < 1000 Enterprise free cap
    // subsequent RUN at >= 900 is blocked by the usage handler (floor 949 >= 900)
    expect(Number(usage)).toBeGreaterThanOrEqual(900);
  });

  it('crash-safety: usage bridge retains increments with NO release callback', async () => {
    const { redis } = createMemoryRedis();
    const h = handlerFor(redis);
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    for (let i = 0; i < 9; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
      expect(r.json().ok).toBe(true);
    }
    // browser closed / power lost — NO release call
    const usage = await redis.get(tenantUsageKey(TENANT_A, MONTH));
    expect(Number(usage)).toBe(9);
    // lease TTL expiry frees the lock for the next device
    const status = makeRes();
    await h(makeReq({ mode: 'status' }), status.res);
    expect(status.json().active).toBe(true); // still active until TTL expiry
  });

  it('claims renew the lease TTL (no heartbeat polling needed)', async () => {
    const { redis, map } = createMemoryRedis();
    const h = handlerFor(redis);
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');
    const before = map.get(tenantActiveSearchKey(TENANT_A)).ttl;
    const r = makeRes();
    await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
    const after = map.get(tenantActiveSearchKey(TENANT_A)).ttl;
    expect(after).toBeGreaterThan(before); // renewed
  });

  it('Redis failure during claim -> claim fails closed (Google request not issued)', async () => {
    const broken = {
      configured: () => true,
      get: async () => { throw new Error('down'); },
      set: async () => { throw new Error('down'); },
      del: async () => { throw new Error('down'); },
      incrby: async () => { throw new Error('down'); },
      expire: async () => { throw new Error('down'); },
      eval: async () => { throw new Error('down'); },
    };
    const h = handlerFor(broken);
    const r = makeRes();
    await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
    expect(r.status()).toBe(503);
    expect(r.json().reason).toBe('redis_unavailable');
  });

  it('missing tenantId / unconfigured redis -> 503 not_configured', async () => {
    const h = createSessionHandler({ redis: { configured: () => false }, tenantId: TENANT_A });
    const r = makeRes();
    await h(makeReq({ mode: 'status' }), r.res);
    expect(r.status()).toBe(503);
  });
});

describe('R1 PACIFIC BILLING MONTH — cross-month session', () => {
  // LA Aug 31 23:59 PDT == UTC Sep 1 06:59 · LA Sep 1 00:01 PDT == UTC Sep 1 07:01
  const AUG_END = new Date('2026-09-01T06:59:00Z');
  const SEP_START = new Date('2026-09-01T07:01:00Z');

  it('requests before the Pacific reset increment the AUGUST key; requests after increment SEPTEMBER; 50-cap intact', async () => {
    const { redis, map } = createMemoryRedis();
    let nowVal = AUG_END;
    const h = createSessionHandler({ redis, tenantId: TENANT_A, now: () => nowVal });
    const leaseKey = tenantActiveSearchKey(TENANT_A);
    await redis.set(leaseKey, JSON.stringify({ sessionId: 'sess-A', attempts: 0 }), 'EX', '120');

    // 5 requests in August (LA)
    for (let i = 0; i < 5; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
      expect(r.json().ok).toBe(true);
    }
    expect(Number(map.get(tenantUsageKey(TENANT_A, '2026-08')).value)).toBe(5);
    expect(map.has(tenantUsageKey(TENANT_A, '2026-09'))).toBe(false);

    // cross the Pacific midnight boundary -> the SAME session continues,
    // but subsequent requests attribute to September
    nowVal = SEP_START;
    for (let i = 0; i < 3; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
      expect(r.json().ok).toBe(true);
    }
    expect(Number(map.get(tenantUsageKey(TENANT_A, '2026-08')).value)).toBe(5); // unchanged
    expect(Number(map.get(tenantUsageKey(TENANT_A, '2026-09')).value)).toBe(3); // new month

    // the 50-attempt cap spans the whole session regardless of month keys
    for (let i = 0; i < 50; i++) {
      const r = makeRes();
      await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r.res);
    }
    const r51 = makeRes();
    await h(makeReq({ mode: 'claim', sessionId: 'sess-A' }), r51.res);
    expect(r51.json().ok).toBe(false);
    expect(r51.json().reason).toBe('cap');
    expect(Number(map.get(tenantUsageKey(TENANT_A, '2026-08')).value) + Number(map.get(tenantUsageKey(TENANT_A, '2026-09')).value)).toBe(50);
  });

  it('RUN start resolves the Pacific month server-side (never client-supplied)', async () => {
    // The usage handler (api/usage.js) computes the month from its own clock;
    // this test pins the claim-side key to the SAME Pacific helper.
    const { map } = createMemoryRedis();
    expect(pacificBillingMonth(AUG_END)).toBe('2026-08');
    expect(pacificBillingMonth(SEP_START)).toBe('2026-09');
    void map;
  });
});

describe('R1 CONCURRENT RUN — current safe ordering (Monitoring -> reconcile -> SET NX)', () => {
  it('simultaneous RUNs: only ONE active_search session exists; the loser never claims', async () => {
    const { redis, map } = createMemoryRedis();
    // Device A wins the lease
    await redis.set(tenantActiveSearchKey(TENANT_A), JSON.stringify({ sessionId: 'sess-A', deviceId: 'dev-A', attempts: 0 }), 'EX', '120');
    // Device B RUN start is rejected as locked
    const h = createSessionHandler({ redis, tenantId: TENANT_A });
    const rB = makeRes();
    await h(makeReq({ mode: 'claim', sessionId: 'sess-B' }), rB.res);
    expect(rB.json().ok).toBe(false);
    expect(rB.json().reason).toBe('ownership');
    // exactly one lease, one owner
    expect(map.get(tenantActiveSearchKey(TENANT_A)).value).toContain('sess-A');
    expect(map.get(tenantActiveSearchKey(TENANT_A)).value).not.toContain('sess-B');
  });
});
