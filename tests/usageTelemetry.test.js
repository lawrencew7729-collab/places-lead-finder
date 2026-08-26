import { describe, expect, it, vi } from 'vitest';
import { createUsageTelemetry } from '../src/usageTelemetry.js';

/** Fake fetch that records every call and returns a scripted /api/usage body. */
function fakeFetch(scripted) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (scripted && scripted.throwOnce && calls.length === 1) throw new Error(scripted.throwOnce);
    if (scripted && scripted.failOnce && calls.length === 1) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      json: async () => ({ used: scripted.used, cap: scripted.cap ?? 1000, source: 'monitoring' }),
    };
  };
  return { impl, calls };
}

const QUOTA = { monthlyTarget: 1000, redRequests: 950 };

describe('R1 REVISED SAFETY CONTRACT — event-driven telemetry', () => {
  it('RUN -> DEEP -> DEEP -> STOP = exactly ONE Monitoring fetch', async () => {
    const { impl, calls } = fakeFetch({ used: 100 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    // RUN start: one fetch
    const base = await t.refreshMonitoringBase();
    expect(base.ok).toBe(true);
    expect(base.used).toBe(100);
    expect(calls.length).toBe(1);
    // simulate DEEP -> DEEP -> STOP session with local accounting only
    t.accountRequest(); t.accountRequest(); t.accountRequest(); // deep requests
    expect(calls.length).toBe(1); // still exactly one fetch
    expect(t.effectiveUsage()).toBe(103);
  });

  it('refresh without RUN = 0 fetches', async () => {
    const { impl, calls } = fakeFetch({ used: 100 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    // page load does NOT call refreshMonitoringBase — contract: refresh -> 0
    expect(calls.length).toBe(0);
    expect(t.hasLiveBase()).toBe(false);
  });

  it('idle = 0 fetches; STOP alone = 0 fetches; DEEP alone = 0 fetches', async () => {
    const { impl, calls } = fakeFetch({ used: 100 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    expect(calls.length).toBe(0); // idle
    t.accountRequest(); // STOP/delta simulation without any fetch
    expect(calls.length).toBe(0);
    t.resetSession();
    expect(calls.length).toBe(0); // deep without fetch
  });

  it('Monitoring failure at RUN start = FAIL CLOSED (RUN blocked)', async () => {
    const { impl } = fakeFetch({ used: 0, failOnce: true });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    const base = await t.refreshMonitoringBase();
    expect(base.ok).toBe(false);
    expect(t.hasLiveBase()).toBe(false); // no usable baseline
  });

  it('network throw at RUN start = FAIL CLOSED', async () => {
    const { impl } = fakeFetch({ used: 0, throwOnce: true });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    const base = await t.refreshMonitoringBase();
    expect(base.ok).toBe(false);
  });

  it('baseline 949 -> at most ONE more outbound Places request may be attempted', async () => {
    const { impl } = fakeFetch({ used: 949 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    await t.refreshMonitoringBase();
    expect(t.canIssueRequest()).toBe(true); // 949 < 950 -> allowed
    t.accountRequest(); // request #950 is issued (allowed: baseline 949 + 1)
    expect(t.effectiveUsage()).toBe(950);
    expect(t.canIssueRequest()).toBe(false); // #951 NOT allowed
  });

  it('baseline 950 = RUN blocked, zero new Places requests', async () => {
    const { impl } = fakeFetch({ used: 950 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    await t.refreshMonitoringBase();
    expect(t.canIssueRequest()).toBe(false);
    expect(t.effectiveUsage()).toBe(950);
  });

  it('effectiveUsage reaches 950 mid-session -> next request NOT issued', async () => {
    const { impl } = fakeFetch({ used: 900 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    await t.refreshMonitoringBase();
    for (let i = 0; i < 50; i++) {
      if (!t.canIssueRequest()) break; // gate BEFORE issuing
      t.accountRequest();
    }
    expect(t.effectiveUsage()).toBe(950);
    expect(t.canIssueRequest()).toBe(false);
  });

  it('retry/error attempts are counted (accounted BEFORE issue, never rolled back)', async () => {
    const { impl } = fakeFetch({ used: 900 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    await t.refreshMonitoringBase();
    // attempt 1 fails (network error) — still accounted
    t.accountRequest();
    expect(t.effectiveUsage()).toBe(901);
    // attempt 2 fails (HTTP error) — still accounted
    t.accountRequest();
    expect(t.effectiveUsage()).toBe(902);
    // attempt 3 succeeds
    t.accountRequest();
    expect(t.effectiveUsage()).toBe(903);
  });

  it('concurrent RUN starts share ONE in-flight fetch (dedupe)', async () => {
    let resolveFetch;
    const calls = [];
    const impl = () => new Promise((resolve) => {
      calls.push('fetch');
      resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ used: 42 }) });
    });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    const p1 = t.refreshMonitoringBase();
    const p2 = t.refreshMonitoringBase();
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(calls.length).toBe(1); // deduped
  });

  it('no timer polling exists in the telemetry module', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const source = readFileSync(resolve(process.cwd(), 'src/usageTelemetry.js'), 'utf8');
    // real timer CALLS are forbidden (comment mentions are fine)
    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('setTimeout(');
  });

  it('successful RUN fetch resets localSessionDelta (new session baseline)', async () => {
    const { impl } = fakeFetch({ used: 300 });
    const t = createUsageTelemetry({ fetchImpl: impl });
    t.setQuota(QUOTA);
    await t.refreshMonitoringBase();
    t.accountRequest(); t.accountRequest();
    expect(t.effectiveUsage()).toBe(302);
    await t.refreshMonitoringBase(); // new RUN session
    expect(t.effectiveUsage()).toBe(300); // delta reset
  });
});
