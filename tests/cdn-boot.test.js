/**
 * v1.0.9 — CDN-independent portal boot + Excel Export removal regression.
 * Source-level assertions (index.html + app.js are not DOM-importable under vitest).
 * Guards:
 *   1. XLSX / Excel Export fully absent (UI button, code, CDN dependency).
 *   2. Splash dismissal does NOT depend on window load (external CDN cannot block boot).
 *   3. The only external script left (Tailwind) is async — never blocks parsing/load.
 *   4. Domain gate (VITE_CUSTOMER_ORIGIN, v1.0.8) remains intact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const APP = readFileSync(join(process.cwd(), 'src', 'app.js'), 'utf8');

describe('v1.0.9 CDN-independent boot + Excel removal', () => {
  it('XLSX / Excel Export is COMPLETELY absent (button, code, CDN script)', () => {
    expect(HTML).not.toContain('export-btn');
    expect(HTML).not.toContain('EXPORT');
    expect(HTML).not.toContain('XLSX');
    expect(HTML).not.toContain('xlsx');
    expect(APP).not.toContain('exportExcel');
    expect(APP).not.toContain('XLSX');
    expect(APP).not.toContain('updateExportState');
  });

  it('portal splash dismissal does NOT depend on window load', () => {
    expect(APP).toContain("document.addEventListener('DOMContentLoaded'");
    // the splash reveal block must not register on window load
    const splashBlock = APP.slice(APP.indexOf('splash → reveal'), APP.indexOf('splash → reveal') + 400);
    expect(splashBlock).not.toContain("window.addEventListener('load'");
  });

  it('external Tailwind script is async and cannot block the boot path', () => {
    const tailwind = HTML.match(/<script[^>]*src="https:\/\/cdn\.tailwindcss\.com"[^>]*>/);
    expect(tailwind).not.toBeNull();
    if (tailwind) expect(tailwind[0]).toContain('async');
    // NO other external CDN script remains
    const externalScripts = [...HTML.matchAll(/<script[^>]*src="https:[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(externalScripts.length).toBe(1);
    expect(externalScripts[0]).toContain('cdn.tailwindcss.com');
  });

  it('domain gate behavior from v1.0.8 remains intact (VITE_CUSTOMER_ORIGIN expansion)', () => {
    expect(APP).toMatch(/\.\.\.\(import\.meta\.env\?\.VITE_CUSTOMER_ORIGIN/);
    expect(APP).toContain("'https://leadfinder.business'");
  });
});
