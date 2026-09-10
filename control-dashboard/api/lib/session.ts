/**
 * Phase 2C Segment 2d — SESSION VERIFICATION (server boundary).
 *
 * Supabase Auth access tokens are verified server-side against the project's
 * public JWKS (ES256) — NO shared SUPABASE_JWT_SECRET dependency. The verified
 * `sub` IS the authoritative operatorUserId; anything the browser sends as
 * operatorUserId is ignored by construction.
 *
 * Role enforcement (staff/owner) is resolved from the `operator_profiles`
 * table by the route layer (service-role query) — see provisioningHttp.ts.
 */
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { VerifiedSession } from './sessionTypes.js';

export type { VerifiedSession };

export interface JwksGetter {
  (): Promise<{ status: number; json(): Promise<Record<string, unknown>> }>;
}

let jwksCache: { set: ReturnType<typeof createRemoteJWKSet>; url: string } | null = null;

/** Fetch the Supabase project JWKS (cached per URL). */
async function jwksFor(supabaseUrl: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  if (jwksCache && jwksCache.url === url) return jwksCache.set;
  const set = createRemoteJWKSet(new URL(url));
  jwksCache = { set, url };
  return set;
}

/**
 * Verify a Supabase ES256 access token against the project JWKS. Returns null
 * on ANY failure (fail-closed: malformed, expired, bad signature, wrong iss).
 */
export async function verifySessionToken(token: string, supabaseUrl: string): Promise<VerifiedSession | null> {
  try {
    const keys = await jwksFor(supabaseUrl);
    const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
    const { payload } = await jwtVerify(token, keys, { issuer });
    if (!payload.sub) return null;
    const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
    return { operatorUserId: payload.sub, roles: ['authenticated'], email: emailOf(payload), exp };
  } catch {
    return null; // fail-closed
  }
}

function emailOf(payload: JWTPayload): string | undefined {
  const email = payload.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/** Extract the bearer token from a Request (null when absent). */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const t = auth.slice(7).trim();
  return t.length > 0 ? t : null;
}

/**
 * Server-side auth gate used by every provisioning route.
 * Flat shape (no discriminated union) — older TS/narrowing environments
 * (Vercel platform compile) handle `ok` + optional fields reliably.
 * Note: `roles` here is claim-level ('authenticated'); the route layer
 * re-resolves staff/owner roles from operator_profiles.
 */
export async function authenticateRequest(req: Request, supabaseUrl: string): Promise<{ ok: boolean; session?: VerifiedSession; reason?: string }> {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: 'unauthenticated' };
  const session = await verifySessionToken(token, supabaseUrl);
  if (!session) return { ok: false, reason: 'invalid or expired session' };
  return { ok: true, session };
}
