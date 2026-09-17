import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PORTAL_VERSION, GOOGLE_CEILING, PACKAGE_STARTER, PACKAGE_FULL, SERVICE_ACTIVE, SERVICE_STOPPED,
  PACKAGE_STOPS, CONTROL_ACTIONS, PACKAGE_ACTIONS, defaultTenantConfig, normalizePackage, normalizeServiceStatus,
  parseTenantConfig, serializeTenantConfig, applyControlAction, packageStop, searchGate, publicState,
  packageSelectionFacts, packageActionGate,
} from '../src/packageControl.js';

describe('v1.0.12 package contract — STARTER_500 / FULL_900 only', () => {
  it('exposes exactly two commercial packages with the agreed stops', () => {
    expect(Object.keys(PACKAGE_STOPS).sort()).toEqual(['FULL_900', 'STARTER_500']);
    expect(packageStop(PACKAGE_STARTER)).toBe(500);
    expect(packageStop(PACKAGE_FULL)).toBe(900);
    expect(GOOGLE_CEILING).toBe(1000);
    expect(PORTAL_VERSION).toBe('1.0.12');
  });

  it('NEVER exposes FULL_1000 as a package (1000 is the internal Google ceiling only)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/packageControl.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // ignore prose
    expect(code).not.toContain('FULL_1000');
    expect(code).not.toContain('450');
    expect(JSON.stringify(PACKAGE_STOPS)).not.toContain('1000');
    expect(Object.values(PACKAGE_STOPS)).toEqual([500, 900]);
  });

  it('new-customer default is STARTER_500 + ACTIVE, with NO month chosen yet', () => {
    expect(defaultTenantConfig()).toEqual({ package: 'STARTER_500', serviceStatus: 'ACTIVE', packageMonth: null, updatedAt: null, updatedBy: null });
    // missing / malformed / hostile raw values fall back to the safe default
    expect(parseTenantConfig(null).package).toBe('STARTER_500');
    expect(parseTenantConfig('{not json').serviceStatus).toBe('ACTIVE');
    expect(parseTenantConfig('{"package":"FULL_1000","serviceStatus":"BANANA"}')).toEqual(
      { package: 'STARTER_500', serviceStatus: 'ACTIVE', packageMonth: null, updatedAt: null, updatedBy: null });
    expect(normalizePackage(undefined)).toBe('STARTER_500');
    expect(normalizeServiceStatus(undefined)).toBe('ACTIVE');
  });

  it('round-trips through serialize/parse (packageMonth included)', () => {
    const cfg = { package: PACKAGE_FULL, serviceStatus: SERVICE_STOPPED, packageMonth: '2026-09', updatedAt: '2026-09-16T00:00:00.000Z', updatedBy: 'dashboard:lf-control-dashboard' };
    expect(parseTenantConfig(serializeTenantConfig(cfg))).toEqual(cfg);
    // a hostile / malformed month is dropped, never trusted
    expect(parseTenantConfig('{"package":"FULL_900","packageMonth":"2026-13"}').packageMonth).toBeNull();
    expect(parseTenantConfig('{"package":"FULL_900","packageMonth":"sept"}').packageMonth).toBeNull();
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

describe('control actions — no 900 -> 500 inside a month', () => {
  it('whitelists exactly STOP / RESUME / UPGRADE_TO_FULL_900 / SELECT_STARTER_500 / CLEAR_DEVICE', () => {
    expect([...CONTROL_ACTIONS]).toEqual(['STOP', 'RESUME', 'UPGRADE_TO_FULL_900', 'SELECT_STARTER_500', 'CLEAR_DEVICE']);
    expect(PACKAGE_ACTIONS).toEqual(['UPGRADE_TO_FULL_900', 'SELECT_STARTER_500']);
    // explicitly NOT available: no destructive and no arbitrary setters
    expect(CONTROL_ACTIONS).not.toContain('DOWNGRADE_TO_STARTER_500');
    expect(CONTROL_ACTIONS).not.toContain('DELETE');
    expect(CONTROL_ACTIONS).not.toContain('DELETE_CUSTOMER');
    expect(CONTROL_ACTIONS).not.toContain('SET_LIMIT');
    expect(CONTROL_ACTIONS).not.toContain('CHANGE_GOLDEN');
    expect(CONTROL_ACTIONS).not.toContain('SET_PACKAGE');
  });

  it('STOP / RESUME touch ONLY the service and never clear the month selection', () => {
    const cfg = { package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, packageMonth: '2026-09' };
    expect(applyControlAction(cfg, 'STOP')).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' });
    expect(applyControlAction(cfg, 'RESUME')).toMatchObject({ package: 'FULL_900', serviceStatus: 'ACTIVE', packageMonth: '2026-09' });
    const starter = { package: PACKAGE_STARTER, serviceStatus: SERVICE_STOPPED, packageMonth: '2026-09' };
    expect(applyControlAction(starter, 'STOP')).toMatchObject({ package: 'STARTER_500', serviceStatus: 'STOPPED', packageMonth: '2026-09' });
  });

  it('package actions stamp the month they were selected FOR and preserve serviceStatus', () => {
    const at = (pkg, serviceStatus, action, month = '2026-09') =>
      applyControlAction({ package: pkg, serviceStatus }, action, { month, updatedAt: 'x', updatedBy: 'y' });
    expect(at(PACKAGE_STARTER, SERVICE_ACTIVE, 'UPGRADE_TO_FULL_900'))
      .toMatchObject({ package: 'FULL_900', serviceStatus: 'ACTIVE', packageMonth: '2026-09' });
    expect(at(PACKAGE_STARTER, SERVICE_STOPPED, 'UPGRADE_TO_FULL_900'))
      .toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' });   // never resumes
    expect(at(PACKAGE_FULL, SERVICE_ACTIVE, 'SELECT_STARTER_500'))
      .toMatchObject({ package: 'STARTER_500', serviceStatus: 'ACTIVE', packageMonth: '2026-09' });
    expect(packageStop(at(PACKAGE_STARTER, SERVICE_ACTIVE, 'UPGRADE_TO_FULL_900').package)).toBe(900);
    expect(packageStop(at(PACKAGE_FULL, SERVICE_ACTIVE, 'SELECT_STARTER_500').package)).toBe(500);
    expect(applyControlAction({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE }, 'NOPE')).toBeNull();
    expect(applyControlAction({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE }, 'DELETE_CUSTOMER')).toBeNull();
  });
});

describe('MONTHLY PACKAGE SELECTION — the owner rule table', () => {
  const facts = (o) => packageSelectionFacts({ package: PACKAGE_STARTER, packageMonth: null, fallbackMonth: null, currentMonth: '2026-09', ...o });

  it('new month, nothing chosen yet -> 500 selectable AND 900 selectable', () => {
    const f = facts({ package: PACKAGE_STARTER, packageMonth: '2026-08' });
    expect(f).toMatchObject({ isNewMonth: true, canSelectStarter500: true, canSelectFull900: true, selectedMonth: '2026-08', currentMonth: '2026-09' });
    expect(packageActionGate(f, 'SELECT_STARTER_500')).toMatchObject({ allowed: true });
    expect(packageActionGate(f, 'UPGRADE_TO_FULL_900')).toMatchObject({ allowed: true });
  });

  it('a customer carried over on FULL_900 also gets the free new-month choice', () => {
    const f = facts({ package: PACKAGE_FULL, packageMonth: '2026-08' });
    expect(f.isNewMonth).toBe(true);
    expect(packageActionGate(f, 'SELECT_STARTER_500').allowed).toBe(true);    // choose 500 for the NEW month
  });

  it('this month already chose 500 -> 500 grey, 900 upgrade allowed', () => {
    const f = facts({ package: PACKAGE_STARTER, packageMonth: '2026-09' });
    expect(f).toMatchObject({ isNewMonth: false, canSelectStarter500: false, canSelectFull900: true });
    expect(packageActionGate(f, 'SELECT_STARTER_500')).toMatchObject({ allowed: false, reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' });
    expect(packageActionGate(f, 'UPGRADE_TO_FULL_900')).toMatchObject({ allowed: true });
  });

  it('this month already chose 900 -> NO way back to 500; 900 stays current', () => {
    const f = facts({ package: PACKAGE_FULL, packageMonth: '2026-09' });
    expect(f).toMatchObject({ isNewMonth: false, canSelectStarter500: false, canSelectFull900: false });
    expect(packageActionGate(f, 'SELECT_STARTER_500')).toMatchObject({ allowed: false, reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' });
    expect(packageActionGate(f, 'UPGRADE_TO_FULL_900')).toMatchObject({ allowed: false, reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' });
  });

  it('next month the choice opens again (nothing to do in the meantime)', () => {
    const f = packageSelectionFacts({ package: PACKAGE_FULL, packageMonth: '2026-09', fallbackMonth: null, currentMonth: '2026-10' });
    expect(f).toMatchObject({ isNewMonth: true, canSelectStarter500: true, canSelectFull900: true });
  });

  it('STOP / RESUME are NOT package actions — the gate ignores them', () => {
    const f = facts({ package: PACKAGE_FULL, packageMonth: '2026-09' });
    expect(packageActionGate(f, 'STOP')).toBeNull();
    expect(packageActionGate(f, 'RESUME')).toBeNull();
  });

  it('a pre-v1.0.12 config (no packageMonth) is treated as chosen in the month of its last change — never re-selectable in that same month', () => {
    // andrew today: FULL_900 written 2026-09-17, no packageMonth -> 500 must stay locked in September
    const f = facts({ package: PACKAGE_FULL, packageMonth: null, fallbackMonth: '2026-09' });
    expect(f).toMatchObject({ selectedMonth: '2026-09', isNewMonth: false, canSelectStarter500: false });
    // ...and it self-heals at the next month boundary
    const next = packageSelectionFacts({ package: PACKAGE_FULL, packageMonth: null, fallbackMonth: '2026-09', currentMonth: '2026-10' });
    expect(next.isNewMonth).toBe(true);
  });

  it('a config that was never written (fresh customer) may pick either package', () => {
    const f = facts({ package: PACKAGE_STARTER, packageMonth: null, fallbackMonth: null });
    expect(f).toMatchObject({ selectedMonth: null, isNewMonth: true, canSelectStarter500: true, canSelectFull900: true });
  });

  it('the monthly choice can never lock a customer out: usage resets on the same Pacific boundary', () => {
    // Selecting 500 for the new month happens when usage is already 0, so the
    // selection itself is always safe (mid-month 500 is impossible by the gate).
    expect(searchGate({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE, used: 0 })).toMatchObject({ allowed: true, limit: 500 });
    expect(searchGate({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE, used: 600 })).toMatchObject({ allowed: false, reason: 'PACKAGE_LIMIT_REACHED' });
  });

  it('LEGACY FREEZE (owner 2026-09-17): the first write pins the PRE-WRITE month, so a 1st-of-month STOP cannot lock the new month', () => {
    const legacy = { package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, updatedAt: '2026-09-17T04:00:00.000Z' };
    const stopped = applyControlAction(legacy, 'STOP', { month: '2026-10', legacyMonth: '2026-09', updatedAt: '2026-10-01T18:00:00.000Z' });
    expect(stopped).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' });
    // the frozen month is now authoritative -> October is still selectable
    expect(packageSelectionFacts({ ...stopped, fallbackMonth: null, currentMonth: '2026-10' }))
      .toMatchObject({ selectedMonth: '2026-09', isNewMonth: true, canSelectStarter500: true });
    // RESUME freezes the same way
    expect(applyControlAction(stopped, 'RESUME', { month: '2026-10', legacyMonth: '2026-10', updatedAt: 'x' }))
      .toMatchObject({ serviceStatus: 'ACTIVE', packageMonth: '2026-09' });
    // an explicit month is never overwritten by the legacy fallback
    expect(applyControlAction({ package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, packageMonth: '2026-10' }, 'STOP', { month: '2026-10', legacyMonth: '2026-09', updatedAt: 'x' }).packageMonth).toBe('2026-10');
    // a config that was never written has nothing to freeze
    expect(applyControlAction({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE }, 'STOP', { month: '2026-10', legacyMonth: null, updatedAt: 'x' }).packageMonth).toBeNull();
  });
});

describe('STATUS payload', () => {
  it('returns ONLY the agreed non-secret fields (incl. the month-selection authority)', () => {
    const s = publicState({ package: PACKAGE_STARTER, serviceStatus: SERVICE_ACTIVE, used: 123, month: '2026-09', ceiling: 1000 });
    expect(Object.keys(s).sort()).toEqual(['ceiling', 'month', 'package', 'packageLabel', 'packageMonth', 'packageSelectableThisMonth', 'portalVersion', 'searchStop', 'serviceStatus', 'usage']);
    expect(s.packageMonth).toBeNull();                    // nothing chosen yet
    expect(s.packageSelectableThisMonth).toBe(false);     // default is NOT "open" — the caller must state it
    expect(s.month).toBe('2026-09');
    expect(s.packageLabel).toBe('Starter 500');
    expect(publicState({ package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, used: 0, month: '2026-09' }).packageLabel).toBe('Full 900');
    expect(publicState({ package: PACKAGE_FULL, serviceStatus: SERVICE_ACTIVE, used: 0, month: '2026-09', packageMonth: '2026-08', packageSelectableThisMonth: true }))
      .toMatchObject({ packageMonth: '2026-08', packageSelectableThisMonth: true });
    const json = JSON.stringify(s).toLowerCase();
    ['app_pass', 'acces', 'token', 'secret', 'aiza', 'apikey', 'api_key'].forEach((needle) => expect(json).not.toContain(needle));
  });
});
