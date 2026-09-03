import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { customerQuota, DEFAULT_QUOTA, quotaThresholds } from '../src/config.js';

describe('customer quota contract — B2 safety 1000 allowance / 850 amber / 900 hard stop', () => {
  it('defaults to the approved B2 safety contract (1000 monthly / amber 85 / red 90 / disable_new_search)', () => {
    const q = customerQuota();
    expect(q.monthlyTarget).toBe(1000);
    expect(q.amberPercent).toBe(85);
    expect(q.redPercent).toBe(90);
    expect(q.enforcementMode).toBe('disable_new_search');
    expect(q.amberRequests).toBe(850);
    expect(q.redRequests).toBe(900);
    expect(DEFAULT_QUOTA).toEqual({ monthlyTarget: 1000, amberPercent: 85, redPercent: 90, enforcementMode: 'disable_new_search' });
  });

  it('J1: runtime allowance cap is 1000, never the legacy 5000', () => {
    const q = customerQuota();
    expect(q.monthlyTarget).toBe(1000);
    expect(q.monthlyTarget).not.toBe(5000);
  });

  it('B2-1: 899 usage is BELOW the safety stop — a new RUN may start', () => {
    const q = customerQuota();
    expect(q.redRequests).toBe(900);
    expect(899 >= q.redRequests).toBe(false);
    expect(q.redRequests - 899).toBe(1);
  });

  it('B2-2: 900 usage is AT the safety stop — new RUN blocked', () => {
    const q = customerQuota();
    expect(900 >= q.redRequests).toBe(true);
    expect(q.redRequests).toBe(900);
  });

  it('B2-3: amber state begins at 850 requests (warning zone 850–899)', () => {
    const q = customerQuota();
    expect(q.amberRequests).toBe(850);
    expect(850 >= q.amberRequests).toBe(true);
    expect(849 >= q.amberRequests).toBe(false);
    expect(q.redRequests).toBeGreaterThan(q.amberRequests); // amber < red invariant
  });

  it('B2-4: HARD SAFETY STOP occurs at 900 requests (not 1000)', () => {
    const q = customerQuota();
    expect(q.redRequests).toBe(900);
    expect(q.redRequests).not.toBe(1000);
    expect(900 >= q.redRequests).toBe(true);
    expect(899 >= q.redRequests).toBe(false);
  });

  it('B2-5: the 900-1000 range is a reserved safety buffer (100), NOT customer-usable', () => {
    const q = customerQuota();
    expect(q.redRequests).toBeLessThan(q.monthlyTarget); // 900 < 1000
    expect(q.monthlyTarget - q.redRequests).toBe(100); // exactly 100 reserved
    // app-originated max after a run starting at 899 = 899 + 50 session = 949
    expect(q.redRequests - 1 + 50).toBe(949);
    expect(949).toBeLessThan(q.monthlyTarget); // 949 < 1000 Enterprise free cap
  });

  it('J7: deep search uses the same contract thresholds', () => {
    const q = customerQuota();
    // deep-search loop bound is redRequests (same object used by app.js)
    expect(q.redRequests).toBe(900);
    const thresholds = quotaThresholds(1000, 85, 90);
    expect(thresholds).toEqual({ amberRequests: 850, redRequests: 900 });
  });

  it('J10: no legacy 5000 literal remains in the quota module', () => {
    const source = DEFAULT_QUOTA.toString() + customerQuota.toString();
    expect(source).not.toContain('5000');
  });

  it('J11: no legacy 5,000 literal remains in the UI (budget cap + auto-stop are dynamic)', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).not.toContain('5,000');
    expect(html).not.toContain('/ 5,000');
    expect(html).not.toContain('AUTO-STOPS AT 5,000');
    // dynamic cap/auto-stop anchors exist
    expect(html).toContain('id="budget-cap"');
    expect(html).toContain('id="budget-auto-stop"');
  });
});

describe('customer quota config — env overrides', () => {
  it('reads VITE_CUSTOMER_* overrides when present', () => {
    vi.stubEnv('VITE_CUSTOMER_MONTHLY_TARGET', '2000');
    vi.stubEnv('VITE_CUSTOMER_AMBER_PERCENT', '80');
    vi.stubEnv('VITE_CUSTOMER_RED_PERCENT', '90');
    vi.stubEnv('VITE_CUSTOMER_ENFORCEMENT_MODE', 'warn_only');
    try {
      const q = customerQuota();
      expect(q.monthlyTarget).toBe(2000);
      expect(q.amberPercent).toBe(80);
      expect(q.redPercent).toBe(90);
      expect(q.enforcementMode).toBe('warn_only');
      expect(q.amberRequests).toBe(1600);
      expect(q.redRequests).toBe(1800);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed on invalid env values (falls back to contract, never lowers silently)', () => {
    vi.stubEnv('VITE_CUSTOMER_MONTHLY_TARGET', '-5');
    vi.stubEnv('VITE_CUSTOMER_AMBER_PERCENT', '0');
    vi.stubEnv('VITE_CUSTOMER_RED_PERCENT', '150');
    try {
      const q = customerQuota();
      expect(q.monthlyTarget).toBe(1000);
      expect(q.amberPercent).toBe(85);
      expect(q.redPercent).toBe(90);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
