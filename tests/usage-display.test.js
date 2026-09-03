/**
 * v1.0.10-direction — shared Google Monitoring usage display (frontend).
 * Source-level regression (app.js is a DOM entry; not directly importable).
 * Guards:
 *   1. portal entry/refresh fetches shared usage (no-store).
 *   2. shared usage (liveUsage) overrides the browser-local count.
 *   3. browser-local count remains ONLY the fallback when the fetch fails.
 *   4. server-side 900 safety-stop enforcement semantics are NOT touched by the
 *      display change (SESSION_CONTRACT stays authoritative in usageTelemetry).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_CONTRACT } from '../src/usageTelemetry.js';

const APP = readFileSync(join(process.cwd(), 'src', 'app.js'), 'utf8');

describe('shared Google Monitoring usage display', () => {
  it('enterApp fetches /api/usage?mode=peek with no-store (READ-ONLY shared usage on every entry/refresh)', () => {
    expect(APP).toContain("fetch('/api/usage?mode=peek', { cache: 'no-store' })");
    // the fetch is inside enterApp (portal entry path)
    const enterStart = APP.indexOf('function enterApp');
    const enterEnd = APP.indexOf('function showLogin');
    const enterBlock = APP.slice(enterStart, enterEnd);
    expect(enterBlock).toContain('/api/usage');
    expect(enterBlock).toContain('mode=peek');
    expect(enterBlock).toContain('no-store');
  });

  it('shared usage (liveUsage) takes priority over browser localStorage', () => {
    const currentStart = APP.indexOf('function currentUsage');
    const currentBlock = APP.slice(currentStart, currentStart + 420);
    // liveUsage first, active session second, localStorage last
    const order = [currentBlock.indexOf('liveUsage !== null'), currentBlock.indexOf('telemetry.hasSession()'), currentBlock.indexOf('getUsage()')].sort((a, b) => a - b);
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(currentBlock).toContain('liveUsage !== null ? liveUsage : telemetry.hasSession() ? telemetry.effectiveUsage() : getUsage()');
  });

  it('local usage remains the fallback when the shared fetch fails', () => {
    // fetch failure path keeps the local counter without throwing
    expect(APP).toMatch(/\.catch\(\(\) => \{\s*\/\* keep local fallback/);
    // localStorage reader still exists for fallback display
    expect(APP).toContain("localStorage.getItem('places_usage')");
  });

  it('900 server-side enforcement semantics remain unchanged', () => {
    // display-only change: telemetry contract (server mirror) still 900/50/1000
    expect(SESSION_CONTRACT.safetyStop).toBe(900);
    expect(SESSION_CONTRACT.maxSessionRequests).toBe(50);
    expect(SESSION_CONTRACT.allowance).toBe(1000);
    // server claim path is untouched by the display change (claim endpoint lives in usageTelemetry)
    const tel = readFileSync(join(process.cwd(), 'src', 'usageTelemetry.js'), 'utf8');
    expect(tel).toContain('mode=claim');
    expect(APP).toContain('telemetry.claimRequest');
  });
});
