import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PORTAL_VERSION, GOOGLE_CEILING, PACKAGE_STARTER, PACKAGE_FULL, SERVICE_ACTIVE, SERVICE_STOPPED,
  PACKAGE_STOPS, CONTROL_ACTIONS, defaultTenantConfig, normalizePackage, normalizeServiceStatus,
  parseTenantConfig, serializeTenantConfig, applyControlAction, packageStop, searchGate, publicState,
} from '../src/packageControl.js';

describe('v1.0.11 package contract — STARTER_500 / FULL_900 only', () => {
  it('exposes exactly two commercial packages with the agreed stops', () => {
    expect(Object.keys(PACKAGE_STOPS).sort()).toEqual(['FULL_900', 'STARTER_500']);
    expect(packageStop(PACKAGE_STARTER)).toBe(500);
    expect(packageStop(PACKAGE_FULL)).toBe(900);
    expect(GOOGLE_CEILING).toBe(1000);
    expect(PORTAL_VERSION).toBe('1.0.11');
  });

  it('NEVER exposes FULL_1000 as a package (1000 is the internal Google ceiling only)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/packageControl.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // ignore prose
    expect(code).not.toContain('FULL_1000');
    expect(code).not.toContain('450');
    expect(JSON.stringify(PACKAGE_STOPS)).not.toContain('1000');
    expect(Object.values(PACKAGE_STOPS)).toEqual([500, 900]);
  });

  it('new-customer default is STARTER_500 + ACTIVE', () => {
    expect(defaultTenantConfig()).toEqual({ package: 'STARTER_500', serviceStatus: 'ACTIVE', updatedAt: null, updatedBy: null });
    // missing / malformed / hostile raw values fall back to the safe default
    expect(parseTenantConfig(null).package).toBe('STARTER_500');
    expect(parseTenantConfig('{not json').serviceStatus).toBe('ACTIVE');
    expect(parseTenantConfig('{"package":"FULL_1000","serviceStatus":"BANANA"}')).toEqual(
      { package: 'STARTER_500', serviceStatus: 'ACTIVE', updatedAt: null, updatedBy: null });
    expect(normalizePackage(undefined)).toBe('STARTER_500');
    expect(normalizeServiceStatus(undefined)).toBe('ACTIVE');
  });

  it('round-trips through serialize/parse', () => {
    const cfg = { package: PACKAGE_FULL, serviceStatus: SERVICE_STOPPED, updatedAt: '2026-09-16T00:00:00.000Z', updatedBy: 'dashboard:lf-control-dashboard' };
    expect(parseTenantConfig(serializeTenantConfig(cfg))).toEqual(cfg);
  });
});

describe('A/B. search gate — package stop thresholds', () => {
  const at = (used, pkg, serviceStatus = SERVICE_ACTIVE) => searchGate({ package: pkg, serviceStatus, used });

  it('A. STARTER_500: <500 allowed, >=500 blocked', () => {
    expect(at(0, PACKAGE_STARTER).allowed).toBe(true);
    expect(at(499, PACKAGE_STARTER).allowed).toBe(true);
    expect(at(500, PACKAGE_STARTER)).toMatchObject({ allowed: false, reason: 'PACKAGE_LIMIT_REACHED', limit: 500 });
    expect(at(501, PACKAGE_STARTER).allowed).toBe(false);
  });

  it('B. FULL_900: 500–899 allowed (the range Starter would have blocked), >=900 blocked', () => {
    expect(at(500, PACKAGE_FULL).allowed).toBe(true);
    expect(at(899, PACKAGE_FULL).allowed).toBe(true);
    expect(at(900, PACKAGE_FULL)).toMatchObject({ allowed: false, reason: 'PACKAGE_LIMIT_REACHED', limit: 900 });
    expect(at(1000, PACKAGE_FULL).allowed).toBe(false);
  });

  it('C. service STOPPED blocks search at ANY usage, and RESUMEd state allows it again', () => {
    expect(at(0, PACKAGE_STARTER, SERVICE_STOPPED)).toMatchObject({ allowed: false, reason: 'SERVICE_STOPPED' });
    expect(at(10, PACKAGE_FULL, SERVICE_STOPPED)).toMatchObject({ allowed: false, reason: 'SERVICE_STOPPED' });
    expect(at(0, PACKAGE_STARTER, SERVICE_ACTIVE).allowed).toBe(true);
  });
});

describe('control actions', () => {
  it('whitelists STOP / RESUME / UPGRADE_TO_FULL_900 only (no delete, no downgrade, no limit editing)', () => {
    expect([...CONTROL_ACTIONS]).toEqual(['STOP', 'RESUME', 'UPGRADE_TO_FULL_900']);
    expect(CONTROL_ACTIONS).not.toContain('DELETE');
    expect(CONTROL_ACTIONS).not.toContain('DOWNGRADE_TO_STARTER_500');
    expect(CONTROL_ACTIONS).not.toContain('SET_LIMIT');
  });

  it('applies each action without touching the other field', () => {
    const base = { package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE };
    expect(applyControlAction(base, 'STOP')).toMatchObject({ package: 'STARTER_500', serviceStatus: 'STOPPED' });
    expect(applyControlAction({ package: PACKAGE_STARTER, serviceStatus: SERVICE_STOPPED }, 'RESUME')).toMatchObject({ package: 'STARTER_500', serviceStatus: 'ACTIVE' });
    expect(applyControlAction({ package: PACKAGE_STARTER, serviceStatus: SERVICE_STOPPED }, 'UPGRADE_TO_FULL_900')).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED' });
    expect(applyControlAction(base, 'NOPE')).toBeNull();
    expect(applyControlAction(base, 'DELETE_CUSTOMER')).toBeNull();
  });
});

describe('STATUS payload', () => {
  it('returns ONLY package / serviceStatus / usage / portalVersion (+ non-secret labels)', () => {
    const s = publicState({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE, used: 123, month: '2026-09', ceiling: 1000 });
    expect(Object.keys(s).sort()).toEqual(['ceiling', 'month', 'package', 'packageLabel', 'portalVersion', 'searchStop', 'serviceStatus', 'usage']);
    expect(s.packageLabel).toBe('Starter 500');
    expect(publicState({ package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, used: 0, month: '2026-09' }).packageLabel).toBe('Full 900');
    const json = JSON.stringify(s).toLowerCase();
    ['app_pass', 'acces', 'token', 'secret', 'aiza', 'apikey', 'api_key'].forEach((needle) => expect(json).not.toContain(needle));
  });
});
