import { describe, expect, it } from 'vitest';
import {
  customerUrlFor,
  isValidSlug,
  isPlausiblePlacesKey,
  isPlausibleProjectId,
  restrictionForHostname,
  sha256Fingerprint,
  suggestSlug,
  validateCreateCustomerForm,
  websiteRestrictionFor,
} from './createCustomerDomain';

describe('createCustomerDomain — subdomain suggestion', () => {
  it('suggests the first word of the company name', () => {
    expect(suggestSlug('ABC Trading Sdn Bhd')).toBe('abc');
    expect(suggestSlug('Meridian Industrial')).toBe('meridian');
    expect(suggestSlug('Atlas Commerce Sdn Bhd')).toBe('atlas');
  });

  it('normalizes case and strips non-alphanumeric characters', () => {
    expect(suggestSlug('  Northstar Supplies  ')).toBe('northstar');
    expect(suggestSlug('O\'Connor Builders')).toBe('oconnor');
    expect(suggestSlug('123 Company')).toBe('123');
  });

  it('returns empty string for blank input', () => {
    expect(suggestSlug('')).toBe('');
    expect(suggestSlug('   ')).toBe('');
  });
});

describe('createCustomerDomain — slug / URL / restriction', () => {
  it('validates slugs against the approved pattern', () => {
    expect(isValidSlug('abc')).toBe(true);
    expect(isValidSlug('abc-trading')).toBe(true);
    expect(isValidSlug('ABC')).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('abc trading')).toBe(false);
    expect(isValidSlug('-abc')).toBe(false);
    expect(isValidSlug('abc.')).toBe(false);
  });

  it('generates the customer URL', () => {
    expect(customerUrlFor('abc')).toBe('https://abc.leadfinder.business');
    expect(customerUrlFor('ABC')).toBe('https://abc.leadfinder.business');
  });

  it('rejects invalid slugs in customerUrlFor', () => {
    expect(() => customerUrlFor('bad slug')).toThrow();
    expect(() => customerUrlFor('')).toThrow();
  });

  it('generates the exact website restriction for Google Console', () => {
    expect(websiteRestrictionFor('abc')).toBe('https://abc.leadfinder.business/*');
    expect(websiteRestrictionFor('meridian-industrial')).toBe('https://meridian-industrial.leadfinder.business/*');
  });

  it('reuses the approved exact-restriction contract for hostnames', () => {
    expect(restrictionForHostname('abc.leadfinder.business')).toBe('https://abc.leadfinder.business/*');
    expect(() => restrictionForHostname('other.com')).toThrow();
  });
});

describe('createCustomerDomain — plausible field validation', () => {
  it('accepts plausible Google project IDs', () => {
    expect(isPlausibleProjectId('abc-leadfinder-1234')).toBe(true);
    expect(isPlausibleProjectId('my-project-001')).toBe(true);
  });

  it('rejects implausible project IDs', () => {
    expect(isPlausibleProjectId('')).toBe(false);
    expect(isPlausibleProjectId('a')).toBe(false);
    expect(isPlausibleProjectId('has space')).toBe(false);
  });

  it('accepts plausible Places browser keys', () => {
    expect(isPlausiblePlacesKey('AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg')).toBe(true);
  });

  it('rejects implausible Places keys', () => {
    expect(isPlausiblePlacesKey('')).toBe(false);
    expect(isPlausiblePlacesKey('AIza')).toBe(false);
    expect(isPlausiblePlacesKey('not-a-key')).toBe(false);
  });
});

describe('createCustomerDomain — form validation', () => {
  it('reports all-present only when every field is valid', () => {
    const valid = validateCreateCustomerForm({
      companyName: 'ABC Trading Sdn Bhd',
      slug: 'abc',
      googleProjectId: 'abc-leadfinder-1234',
      placesApiKey: 'AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg',
    });
    expect(valid.allPresent).toBe(true);
    expect(valid.urlValid).toBe(true);
    expect(valid.restrictionValid).toBe(true);
  });

  it('fails closed when any field is missing', () => {
    const missingKey = validateCreateCustomerForm({
      companyName: 'ABC Trading Sdn Bhd',
      slug: 'abc',
      googleProjectId: 'abc-leadfinder-1234',
      placesApiKey: '',
    });
    expect(missingKey.allPresent).toBe(false);
    expect(missingKey.placesApiKeyPresent).toBe(false);
  });
});

describe('createCustomerDomain — fingerprint', () => {
  it('computes a deterministic SHA-256 fingerprint without exposing the raw key', async () => {
    const digest = await sha256Fingerprint('AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg');
    expect(digest).toMatch(/^[A-F0-9]{64}$/);
    const digestAgain = await sha256Fingerprint('AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg');
    expect(digestAgain).toBe(digest);
    expect(digest).not.toContain('AIza');
  });

  it('returns empty for empty input', async () => {
    expect(await sha256Fingerprint('')).toBe('');
  });
});
