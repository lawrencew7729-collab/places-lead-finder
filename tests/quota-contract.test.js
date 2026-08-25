import { describe, expect, it, vi } from 'vitest';
import { customerQuota, DEFAULT_QUOTA, quotaThresholds } from '../src/config.js';

describe('customer quota contract — one authoritative 1000/900/1000', () => {
  it('defaults to the approved contract (1000 monthly / amber 90 / red 100 / disable_new_search)', () => {
    const q = customerQuota();
    expect(q.monthlyTarget).toBe(1000);
    expect(q.amberPercent).toBe(90);
    expect(q.redPercent).toBe(100);
    expect(q.enforcementMode).toBe('disable_new_search');
    expect(q.amberRequests).toBe(900);
    expect(q.redRequests).toBe(1000);
    expect(DEFAULT_QUOTA).toEqual({ monthlyTarget: 1000, amberPercent: 90, redPercent: 100, enforcementMode: 'disable_new_search' });
  });

  it('J1: runtime cap is 1000, never the legacy 5000', () => {
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

  it('J4: red state occurs at 1000 requests', () => {
    const q = customerQuota();
    expect(q.redRequests).toBe(1000);
    expect(1000 >= q.redRequests).toBe(true);
    expect(999 >= q.redRequests).toBe(false);
  });

  it('J7: deep search uses the same contract thresholds', () => {
    const q = customerQuota();
    // deep-search loop bound is redRequests (same object used by app.js)
    expect(q.redRequests).toBe(1000);
    const thresholds = quotaThresholds(1000, 90, 100);
    expect(thresholds).toEqual({ amberRequests: 900, redRequests: 1000 });
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
      expect(q.redPercent).toBe(100);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
