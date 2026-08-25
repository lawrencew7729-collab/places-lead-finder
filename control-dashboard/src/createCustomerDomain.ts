/**
 * PRE-R1 Create Customer one-page domain logic (pure functions).
 *
 * - slug suggestion from company name (editable by owner)
 * - customer URL + exact website restriction generation
 * - Places key fingerprinting (raw key never leaves the form state)
 */
import { exactRestrictionFor, normalizeCustomerHostname } from './domain';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 'ABC Trading Sdn Bhd' → 'abc' (first word, lowercased, alphanumeric only). */
export function suggestSlug(companyName: string): string {
  const words = companyName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const word of words) {
    const candidate = word.replace(/[^a-z0-9]+/g, '');
    if (candidate) return candidate;
  }
  return '';
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug.trim().toLowerCase());
}

/** https://{slug}.leadfinder.business — throws on invalid slug. */
export function customerUrlFor(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!isValidSlug(normalized)) throw new Error('Valid subdomain required');
  return `https://${normalized}.leadfinder.business`;
}

/** https://{slug}.leadfinder.business/* — exact referrer restriction for Google Console. */
export function websiteRestrictionFor(slug: string): string {
  const hostname = customerUrlFor(slug).replace(/^https:\/\//, '');
  return exactRestrictionFor(hostname);
}

/** Reuses the approved exact-hostname contract; throws if the restriction is not exact. */
export function restrictionForHostname(hostname: string): string {
  return exactRestrictionFor(normalizeCustomerHostname(hostname));
}

/** SHA-256 hex of the raw Places key — safe metadata only, never the key itself. */
export async function sha256Fingerprint(rawKey: string): Promise<string> {
  if (!rawKey) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export interface CreateCustomerFormState {
  companyName: string;
  slug: string;
  googleProjectId: string;
  placesApiKey: string;
}

export function isPlausibleProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{2,60}$/i.test(value.trim());
}

export function isPlausiblePlacesKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{30,}$/.test(value.trim());
}

export interface FormValidationResult {
  companyNamePresent: boolean;
  slugValid: boolean;
  urlValid: boolean;
  restrictionValid: boolean;
  googleProjectIdPresent: boolean;
  placesApiKeyPresent: boolean;
  allPresent: boolean;
}

export function validateCreateCustomerForm(form: CreateCustomerFormState): FormValidationResult {
  let urlValid = false;
  let restrictionValid = false;
  try {
    customerUrlFor(form.slug);
    urlValid = true;
  } catch {
    urlValid = false;
  }
  try {
    websiteRestrictionFor(form.slug);
    restrictionValid = true;
  } catch {
    restrictionValid = false;
  }
  const companyNamePresent = form.companyName.trim().length >= 2;
  const slugValid = isValidSlug(form.slug);
  const googleProjectIdPresent = isPlausibleProjectId(form.googleProjectId);
  const placesApiKeyPresent = isPlausiblePlacesKey(form.placesApiKey);
  return {
    companyNamePresent,
    slugValid,
    urlValid,
    restrictionValid,
    googleProjectIdPresent,
    placesApiKeyPresent,
    allPresent: companyNamePresent && slugValid && urlValid && restrictionValid && googleProjectIdPresent && placesApiKeyPresent,
  };
}
