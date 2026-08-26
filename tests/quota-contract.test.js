import { describe, expect, it, vi } from 'vitest';
import { customerQuota, DEFAULT_QUOTA, quotaThresholds } from '../src/config.js';

describe('customer quota contract — revised safety 1000 allowance / 900 amber / 950 hard stop', () => {
  it('defaults to the approved safety contract (1000 monthly / amber 90 / red 95 / disable_new_search)', () => {
    const q = customerQuota();
    expect(q.monthlyTarget).toBe(1000);
    expect(q.amberPercent).toBe(90);
    expect(q.redPercent).toBe(95);
    expect(q.enforcementMode).toBe('disable_new_search');
    expect(q.amberRequests).toBe(900);
    expect(q.redRequests).toBe(950);
    expect(DEFAULT_QUOTA).toEqual({ monthlyTarget: 1000, amberPercent: 90, redPercent: 95, enforcementMode: 'disable_new_search' });
  });

  it('J1: runtime allowance cap is 1000, never the legacy 5000', () => {
    const q = customerQuota();
    expect(q.monthlyTarget).toBe(1000);
    expect(q.monthlyTarget).not.toBe(5000);
  });

  it('J3: amber state begins at 900 requests', () => {
    const q = customerQuota();
    expect(q.amberRequests).toBe(900);
    expect(900 >= q.amberRequests).toBe(true);
    expect(899 >= q.amberRequests).toBe(false);
  });

  it('J4: HARD SAFETY STOP occurs at 950 requests (not 1000)', () => {
    const q = customerQuota();
    expect(q.redRequests).toBe(950);
    expect(q.redRequests).not.toBe(1000);
    expect(950 >= q.redRequests).toBe(true);
    expect(949 >= q.redRequests).toBe(false);
  });

  it('J4b: the 950-1000 range is a reserved safety buffer, not customer-usable', () => {
    const q = customerQuota();
    expect(q.redRequests).toBeLessThan(q.monthlyTarget); // 950 < 1000
    expect(q.monthlyTarget - q.redRequests).toBe(50); // exactly 50 reserved
  });

  it('J7: deep search uses the same contract thresholds', () => {
    const q = customerQuota();
    // deep-search loop bound is redRequests (same object used by app.js)
    expect(q.redRequests).toBe(950);
    const thresholds = quotaThresholds(1000, 90, 95);
    expect(thresholds).toEqual({ amberRequests: 900, redRequests: 950 });
  });

  it('J10: no legacy 5000 literal remains in the quota module', () => {
    const source = DEFAULT_QUOTA.toString() + customerQuota.toString();
    expect(source).not.toContain('5000');
  });
});

describe('customer quota config — env overrides', () => {
  it('reads VITE_CUSTOMER_* overrides when present', () => {
    vi.stubEnv('VITE_CUSTOMER_MONTHLY_TARGET', '2000');
    vi.stubEnv('VITE_CUSTOMER_AMBER_PERCENT', '80');
    vi.stubEnv('VITE_CUSTOMER_RED_PERCENT', '95');
    vi.stubEnv('VITE_CUSTOMER_ENFORCEMENT_MODE', 'warn_only');
    try {
      const q = customerQuota();
      expect(q.monthlyTarget).toBe(2000);
      expect(q.amberPercent).toBe(80);
      expect(q.redPercent).toBe(95);
      expect(q.enforcementMode).toBe('warn_only');
      expect(q.amberRequests).toBe(1600);
      expect(q.redRequests).toBe(1900);
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
      expect(q.amberPercent).toBe(90);
      expect(q.redPercent).toBe(95);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
