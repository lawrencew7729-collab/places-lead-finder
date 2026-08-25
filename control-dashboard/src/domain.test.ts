import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMERCIAL_MODEL,
  createKeyFingerprintMetadata,
  createQuotaPolicy,
  exactRestrictionFor,
  generateTenantId,
  selectInfrastructureStatus,
  isTenantId,
  quotaStatus,
  releaseIsImmutable,
} from './domain';

describe('customer isolation contracts', () => {
  it('normalizes and generates only an exact one-customer Lead Finder restriction', () => {
    expect(exactRestrictionFor('Acme.LeadFinder.Business')).toBe('https://acme.leadfinder.business/*');
  });

  it.each([
    '*.leadfinder.business',
    'leadfinder.business',
    'a.b.leadfinder.business',
    'https://acme.leadfinder.business',
    'acme.leadfinder.business/path',
    'acme.example.com',
    '-bad.leadfinder.business',
  ])('rejects non-approved exact hostname %s', (host) => {
    expect(() => exactRestrictionFor(host)).toThrow(/exact customer hostname/i);
  });

  it('uses immutable RFC 4122 UUID tenant IDs with deterministic injection', () => {
    const expected = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    expect(generateTenantId(() => expected)).toBe(expected);
    expect(isTenantId(expected)).toBe(true);
    expect(isTenantId('tnt_test_sandbox')).toBe(false);
    expect(() => generateTenantId(() => 'tnt_fictional')).toThrow(/uuid/i);
  });

  it('accepts metadata-only server-generated SHA-256 fingerprints, never raw credentials', () => {
    const metadata = createKeyFingerprintMetadata({
      value: 'A'.repeat(64),
      computedBy: 'server_provider_adapter',
      computedAt: '2026-08-24T10:00:00.000Z',
    });
    expect(metadata).toEqual({ algorithm: 'sha256', value: 'A'.repeat(64), computedBy: 'server_provider_adapter', computedAt: '2026-08-24T10:00:00.000Z' });
        expect(() => createKeyFingerprintMetadata({ value: 'A1B2C3D4', computedBy: 'browser' as never, computedAt: '2026-08-24T10:00:00.000Z' })).toThrow(/adapter/i);
  });
});

describe('configurable business and quota policy', () => {
  it('uses the approved commercial baseline', () => {
    expect(DEFAULT_COMMERCIAL_MODEL.annualRevenueMyr).toBe(1500);
    expect(DEFAULT_COMMERCIAL_MODEL.monthlyEquivalentMyr).toBe(125);
  });

  it('requires owner-provided AMBER and RED thresholds without policy defaults', () => {
    const policy = createQuotaPolicy({ monthlyTarget: 1000, amberPercent: 70, redPercent: 90, enforcementMode: 'warn_only' });
    expect(policy.telemetryIsDelayed).toBe(true);
    expect(quotaStatus(699, policy)).toBe('green');
    expect(quotaStatus(700, policy)).toBe('amber');
    expect(quotaStatus(900, policy)).toBe('red');
  });

  it('accepts equal AMBER/RED as allowed by 0 ≤ AMBER ≤ RED ≤ 100', () => {
    expect(createQuotaPolicy({ amberPercent: 90, redPercent: 90, enforcementMode: 'warn_only' }).redPercent).toBe(90);
  });

  it('rejects missing, invalid, or reversed quota thresholds', () => {
    expect(() => createQuotaPolicy({ monthlyTarget: 1000, amberPercent: Number.NaN, redPercent: 90, enforcementMode: 'warn_only' })).toThrow();
    expect(() => createQuotaPolicy({ monthlyTarget: 1000, amberPercent: 95, redPercent: 90, enforcementMode: 'warn_only' })).toThrow();
    expect(() => createQuotaPolicy({ monthlyTarget: 0, amberPercent: 70, redPercent: 90, enforcementMode: 'warn_only' })).toThrow();
  });
});

describe('provider and release safety gates', () => {
  it('selects one authoritative infrastructure status with fail-closed priority', () => {
    expect(selectInfrastructureStatus(['green', 'amber'])).toBe('amber');
    expect(selectInfrastructureStatus(['green', 'red', 'unknown'])).toBe('red');
    expect(selectInfrastructureStatus(['green', 'unknown'])).toBe('unknown');
    expect(selectInfrastructureStatus(['green', 'green'])).toBe('green');
  });

  it('requires a new release identity when artifact checksum changes', () => {
    expect(releaseIsImmutable('v1.0.0', 'abc', 'v1.0.0', 'def')).toBe(false);
    expect(releaseIsImmutable('v1.0.0', 'abc', 'v1.0.1', 'def')).toBe(true);
  });
});
