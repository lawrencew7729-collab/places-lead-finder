/**
 * BOOT REGRESSION TEST.
 *
 * The 2026-09-16 near-miss: src/app.js used an undeclared `liveSearchStop`,
 * so the bundle threw `ReferenceError` during initialisation. `Object.assign
 * (window,{...doLogin})` never ran, the UNLOCK button called an undefined
 * global, and the customer portal could not be logged into at all — while the
 * text-based contract tests stayed green.
 *
 * This test actually EXECUTES the app against the real index.html markup and
 * asserts it boots cleanly and exposes the globals the inline handlers need.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('customer portal boot', () => {
  it('app.js initialises without throwing and exposes the inline-handler globals', async () => {
    const html = readFileSync('index.html', 'utf8');
    const start = html.indexOf('<body');
    const end = html.indexOf('</body>');
    expect(start).toBeGreaterThan(-1);
    document.documentElement.innerHTML = '<head></head>' + html.slice(start, end + 7);
    // innerHTML does not execute inline <script>; run them so page-provided
    // globals exist exactly as they do in a real browser load.
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      new Function(m[1])();
    }

    // minimal environment stubs (no network in tests)
    const res = { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    globalThis.fetch = async () => res;
    window.fetch = globalThis.fetch;

    // execute the REAL module (Vite transforms it): an init-time ReferenceError
    // rejects this import, which is exactly the regression we must never ship.
    await expect(import('../src/app.js?boot')).resolves.toBeDefined();
    const src = readFileSync('src/app.js', 'utf8');

    // the login path the HTML wires with inline onclick / onkeydown
    expect(typeof window.doLogin).toBe('function');
    // the quota display must be driven by a DECLARED stop value
    expect(src).toMatch(/let liveSearchStop\s*=/);
  });
});
