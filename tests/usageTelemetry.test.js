import { describe, expect, it } from 'vitest';
import { createUsageTelemetry, SESSION_CONTRACT } from '../src/usageTelemetry.js';

/** Fake same-origin fetch recording calls and scripting /api/usage + /api/session. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.includes('/api/usage')) {
      if (script.usageFailOnce && calls.filter((c) => c.url.includes('/api/usage')).length === 1) {
        return { ok: false, status: 503, json: async () => ({ error: 'x' }) };
      }
      return { ok: true, status: 200, json: async () => script.usageResponse };
    }
    if (u.includes('mode=claim')) {
      const c = calls.filter((x) => x.url.includes('mode=claim')).length;
      if (script.claimFailAfter && c > script.claimFailAfter) {
        return { ok: false, status: 409, json: async () => ({ ok: false, reason: script.claimFailReason || 'cap' }) };
      }
      if (script.claimFails) return { ok: false, status: 409, json: async () => ({ ok: false, reason: 'claim_failed' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, attempts: c, used: script.usageResponse.used + c }) };
    }
    if (u.includes('mode=release')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes('mode=status')) {
      return { ok: true, status: 200, json: async () => ({ active: script.statusActive || false, sessionId: script.statusActive ? 'sess-other' : null, used: 0 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { impl, calls };
}

const OK_START = { used: 100, cap: 1000, safetyStop: 900, sessionId: 'sess-1', maxSessionRequests: 50, expiresAt: '2026-08-26T00:00:00.000Z' };

describe('R1 CENTRALIZED — telemetry UX layer (server is the authority)', () => {
  it('RUN start: exactly ONE /api/usage call; session context returned', async () => {
    const { impl, calls } = fakeFetch({ usageResponse: OK_START });
    const t = createUsageTelemetry({ fetchImpl: impl });
    const start = await t.startRun('dev-A');
    expect(start.ok).toBe(true);
    expect(start.sessionId).toBe('sess-1');
    expect(start.used).toBe(100);
    expect(calls.filter((c) => c.url.includes('/api/usage')).length).toBe(1);
  });

  it('DEEP / STOP / refresh / idle produce ZERO /api/usage calls (claims and release only)', async () => {
    const { impl, calls } = fakeFetch({ usageResponse: OK_START });
    const t = createUsageTelemetry({ fetchImpl: impl });
    await t.startRun('dev-A');
    await t.claimRequest();
    await t.claimRequest();
    await t.releaseSession();
    const usageCalls = calls.filter((c) => c.url.includes('/api/usage'));
    expect(usageCalls.length).toBe(1); // only the RUN-start Monitoring query
  });

  it('blocked >= 900: startRun returns blocked, no session', async () => {
    const { impl } = fakeFetch({ usageResponse: { used: 900, cap: 1000, safetyStop: 900, blocked: true } });
    const t = createUsageTelemetry({ fetchImpl: impl });
    const start = await t.startRun('dev-A');
    expect(start.ok).toBe(false);
    expect(start.blocked).toBe(true);
    expect(t.hasSession()).toBe(false);
  });

  it('locked by another device: startRun returns locked (no session)', async () => {
    const { impl } = fakeFetch({ usageResponse: { used: 300, cap: 1000, safetyStop: 900, locked: true } });
    const t = createUsageTelemetry({ fetchImpl: impl });
    const start = await t.startRun('dev-A');
    expect(start.ok).toBe(false);
    expect(start.locked).toBe(true);
  });

  it('Monitoring/Redis failure at RUN start -> fail closed, RUN blocked', async () => {
    const { impl } = fakeFetch({ usageResponse: OK_START, usageFailOnce: true });
    const t = createUsageTelemetry({ fetchImpl: impl });
    const start = await t.startRun('dev-A');
    expect(start.ok).toBe(false);
    expect(start.blocked).toBe(true);
  });

  it('claim failure (cap/ownership/no_session/redis) -> request NOT issued (ok:false)', async () => {
    const { impl } = fakeFetch({ usageResponse: OK_START, claimFails: true });
    const t = createUsageTelemetry({ fetchImpl: impl });
    await t.startRun('dev-A');
    const claim = await t.claimRequest();
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('claim_failed');
  });

  it('server rejects claim #51 -> telemetry reports cap; the app never issues #51', async () => {
    const { impl } = fakeFetch({ usageResponse: OK_START, claimFailAfter: SESSION_CONTRACT.maxSessionRequests, claimFailReason: 'cap' });
    const t = createUsageTelemetry({ fetchImpl: impl });
    await t.startRun('dev-A');
    let issued = 0;
    for (let i = 1; i <= SESSION_CONTRACT.maxSessionRequests + 1; i++) {
      const claim = await t.claimRequest();
      if (claim.ok) issued++;
    }
    expect(issued).toBe(SESSION_CONTRACT.maxSessionRequests); // 50 issued, #51 refused
    expect(t.sessionAttempts()).toBe(SESSION_CONTRACT.maxSessionRequests);
  });

  it('status is Redis-only (no /api/usage call) — Device-B page-load UX', async () => {
    const { impl, calls } = fakeFetch({ usageResponse: OK_START, statusActive: true });
    const t = createUsageTelemetry({ fetchImpl: impl });
    const st = await t.status();
    expect(st.ok).toBe(true);
    expect(st.active).toBe(true);
    expect(st.activeSessionId).toBe('sess-other');
    expect(calls.filter((c) => c.url.includes('/api/usage')).length).toBe(0);
  });

  it('release clears the session (safe compare-and-release, not a Monitoring query)', async () => {
    const { impl, calls } = fakeFetch({ usageResponse: OK_START });
    const t = createUsageTelemetry({ fetchImpl: impl });
    await t.startRun('dev-A');
    expect(t.hasSession()).toBe(true);
    const rel = await t.releaseSession();
    expect(rel.ok).toBe(true);
    expect(t.hasSession()).toBe(false);
    expect(calls.filter((c) => c.url.includes('mode=release')).length).toBe(1);
  });

  it('no timer polling exists in the telemetry module', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const source = readFileSync(resolve(process.cwd(), 'src/usageTelemetry.js'), 'utf8');
    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('setTimeout(');
  });

  it('contract constants: 50 / 120s / 900 / 1000', () => {
    expect(SESSION_CONTRACT.maxSessionRequests).toBe(50);
    expect(SESSION_CONTRACT.leaseTtlSeconds).toBe(120);
    expect(SESSION_CONTRACT.safetyStop).toBe(900);
    expect(SESSION_CONTRACT.allowance).toBe(1000);
  });

  it('setQuota pre-seeds cap/safetyStop from the customer quota config (regression: setQuota is not a function crashed app boot)', () => {
    const t = createUsageTelemetry({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    expect(t.allowance()).toBe(SESSION_CONTRACT.allowance);
    expect(t.safetyStop()).toBe(SESSION_CONTRACT.safetyStop);
    // app.js calls telemetry.setQuota(customerQuota()) at module top level — must exist and apply
    t.setQuota({ monthlyTarget: 1000, redRequests: 900 });
    expect(t.allowance()).toBe(1000);
    expect(t.safetyStop()).toBe(900);
    // invalid values are ignored (fail-closed, never lowers the contract)
    t.setQuota({ monthlyTarget: -5, redRequests: 0 });
    expect(t.allowance()).toBe(1000);
    expect(t.safetyStop()).toBe(900);
  });
});
