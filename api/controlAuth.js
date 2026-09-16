// api/controlAuth.js — Dashboard -> Customer Portal control authentication.
//
// v1.0.11 (owner-approved OPTION B): the Dashboard proves its identity with a
// Vercel OIDC token it mints from its OWN production deployment; the customer
// portal verifies it against the Vercel TEAM JWKS. There is NO shared secret,
// NO customer Redis credential held centrally and NO new auth system.
//
// Fail closed: EVERY mismatch is a 401. Issuer/audience alone are NOT enough:
// every project in the team receives the same iss/aud, so accepting those alone
// would let ANY customer portal mint a token and drive ANOTHER customer's
// control endpoint. project_id pins the ONLY accepted caller (lf-control-dashboard).

import crypto from 'node:crypto';

export const OIDC_ISSUER = 'https://oidc.vercel.com/lawrencew7729-4682s-projects';
export const OIDC_AUDIENCE = 'https://vercel.com/lawrencew7729-4682s-projects';
export const CONTROL_PROJECT_ID = 'prj_12C9gBPZwfSE9x8TWXNJeu4WFZKh'; // lf-control-dashboard
export const CONTROL_OWNER_ID = 'team_zYcaTVVBfNNI7QeVpwABxkan';
export const CONTROL_ENVIRONMENT = 'production';
export const JWKS_URL = OIDC_ISSUER + '/.well-known/jwks';
const CLOCK_SKEW_SECONDS = 60;
export const REQUIRED_ALG = 'RS256';

/** "Bearer <jwt>" -> jwt, else null. */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return m ? m[1] : null;
}

function b64urlToJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Decodes without verifying. Throws on malformed structure. */
export function decodeJwt(token) {
  if (typeof token !== 'string') throw new Error('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('malformed token');
  const header = b64urlToJson(parts[0]);
  const claims = b64urlToJson(parts[1]);
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw new Error('malformed token');
  return { header, claims, signingInput: parts[0] + '.' + parts[1], signature: Buffer.from(parts[2], 'base64url') };
}

/** RS256 verification with node:crypto — no extra dependency. */
export function verifySignature({ signingInput, signature, jwk }) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key, signature);
}

function audienceMatches(aud) {
  if (Array.isArray(aud)) return aud.includes(OIDC_AUDIENCE);
  return aud === OIDC_AUDIENCE;
}

/** Claim pins — order matters only for the reported reason. */
export function verifyClaims(claims, nowSeconds) {
  if (claims.iss !== OIDC_ISSUER) return { ok: false, reason: 'issuer_mismatch' };
  if (!audienceMatches(claims.aud)) return { ok: false, reason: 'audience_mismatch' };
  if (claims.project_id !== CONTROL_PROJECT_ID) return { ok: false, reason: 'project_id_mismatch' };
  if (claims.owner_id !== CONTROL_OWNER_ID) return { ok: false, reason: 'owner_id_mismatch' };
  if (claims.environment !== CONTROL_ENVIRONMENT) return { ok: false, reason: 'environment_mismatch' };
  const nbf = Number(claims.nbf);
  const exp = Number(claims.exp);
  if (!Number.isFinite(nbf) || !Number.isFinite(exp)) return { ok: false, reason: 'malformed_time_claims' };
  if (exp <= nowSeconds - CLOCK_SKEW_SECONDS) return { ok: false, reason: 'token_expired' };
  if (nbf > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'token_not_yet_valid' };
  return { ok: true, reason: null };
}

/** Full verification. Returns {ok:false, reason} for anything unexpected. */
export function verifyControlToken(token, { jwks, nowSeconds } = {}) {
  let decoded;
  try {
    decoded = decodeJwt(token);
  } catch (e) {
    return { ok: false, reason: 'malformed_token' };
  }
  if (decoded.header.alg !== REQUIRED_ALG) return { ok: false, reason: 'unsupported_alg' };
  const keys = (jwks && Array.isArray(jwks.keys)) ? jwks.keys : [];
  const jwk = keys.find((k) => k && k.kid === decoded.header.kid && k.kty === 'RSA');
  if (!jwk) return { ok: false, reason: 'unknown_key' };
  let signatureOk = false;
  try {
    signatureOk = verifySignature({ signingInput: decoded.signingInput, signature: decoded.signature, jwk });
  } catch (e) {
    return { ok: false, reason: 'signature_verification_failed' };
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };
  const claims = verifyClaims(decoded.claims, Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000));
  if (!claims.ok) return claims;
  return { ok: true, reason: null, claims: decoded.claims };
}

/** Short-lived JWKS cache (the team key set is public and rotates rarely). */
export function createJwksProvider({ fetchImpl = fetch, ttlSeconds = 300, now = () => Date.now() } = {}) {
  let cached = null;
  let fetchedAt = 0;
  return async function getJwks() {
    const t = now();
    if (cached && t - fetchedAt < ttlSeconds * 1000) return cached;
    const r = await fetchImpl(JWKS_URL, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('jwks ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.keys) || j.keys.length === 0) throw new Error('jwks empty');
    cached = j;
    fetchedAt = t;
    return cached;
  };
}
