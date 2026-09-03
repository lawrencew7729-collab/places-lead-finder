/**
 * v1.0.8 — customer domain gate (EXPECTED_ORIGINS) regression.
 * The domain gate must accept a build-time VITE_CUSTOMER_ORIGIN so a customer
 * subdomain (e.g. https://jacker.leadfinder.business) can run searches, while
 * the static official origins remain the baseline. Source-level assertions
 * (app.js is a DOM entry; not directly importable under vitest).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(join(process.cwd(), 'src', 'app.js'), 'utf8');

describe('v1.0.8 customer domain gate (EXPECTED_ORIGINS)', () => {
  it('keeps the official baseline origins', () => {
    expect(APP).toContain("'https://places-lead-finder-site.vercel.app'");
    expect(APP).toContain("'https://leadfinder.business'");
  });

  it('expands EXPECTED_ORIGINS with a build-time VITE_CUSTOMER_ORIGIN', () => {
    // the dynamic spread must exist and reference the env var
    expect(APP).toContain('VITE_CUSTOMER_ORIGIN');
    expect(APP).toMatch(/\.\.\.\(import\.meta\.env\?\.VITE_CUSTOMER_ORIGIN/);
    // guard: the customer origin must be ADDED, not replace the baseline
    const expectedOriginsStart = APP.indexOf('const EXPECTED_ORIGINS');
    const segment = APP.slice(expectedOriginsStart, expectedOriginsStart + 400);
    expect(segment).toContain('...(');
  });

  it('is inert when VITE_CUSTOMER_ORIGIN is absent (baseline behavior unchanged)', () => {
    // no origin → no extra entries; the spread of undefined yields nothing
    expect(APP).toContain('import.meta.env?.VITE_CUSTOMER_ORIGIN ? [import.meta.env.VITE_CUSTOMER_ORIGIN] : []');
  });
});
