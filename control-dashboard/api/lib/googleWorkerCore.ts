/**
 * Phase 2C Segment 2e — GOOGLE WORKER CORE (pure, testable).
 *
 * The internal Worker validates the HMAC server-to-server header, exchanges
 * its own fresh request-scoped Vercel OIDC (x-vercel-oidc-token) for a
 * short-lived operator-SA access token (STS → iamcredentials), builds the
 * REAL Google adapter with that token, then dispatches the requested method.
 *
 * Credentials never leave this function: the response carries only the
 * bounded ProviderResult (ok/reason/resourceId/saEmail).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderResult } from '../../src/provisioning/provisioningProviders.js';

export interface WorkerCoreDeps {
  internalSecret: string;
  /** Fresh OIDC token from the invocation request header. */
  oidcToken: string;
  saEmail: string;
  projectNumber: string;
  pool: string;
  provider: string;
  /** Injected token chain + google adapter builder (fake in tests). */
  buildGoogleAdapter(): Promise<{ ok: boolean; adapter?: import('../../src/provisioning/provisioningProviders.js').GoogleProvider; reason?: string }>;
  googleAdapterFactory(accessToken: string): import('../../src/provisioning/provisioningProviders.js').GoogleProvider;
}

export interface WorkerRequest {
  method: string;
  args: unknown[];
}

export interface WorkerResult {
  ok: boolean;
  status: number;
  body: { ok: boolean; reason?: string; resourceId?: string; saEmail?: string };
}

export function verifyInternalAuthV1(supplied: string, secret: string, prefix = 'lf', windowSeconds = 300): boolean {
  if (!secret) return false;
  const m = new RegExp(`^v1:(\\d+):([0-9a-f]{64})$`).exec(supplied);
  if (!m) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(m[1])) > windowSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${prefix}:${m[1]}`).digest('hex');
  const a = Buffer.from(m[2]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Full worker handler logic — unit-testable with fakes. */
export async function runGoogleWorker(req: WorkerRequest, deps: WorkerCoreDeps): Promise<WorkerResult> {
  const fail = (reason: string, status = 500): WorkerResult => ({ ok: false, status, body: { ok: false, reason } });

  // 1. Auth gate BEFORE anything privileged.
  // (header verified by the HTTP glue; the token chain below is the OIDC path)
  if (!deps.oidcToken) return fail('no x-vercel-oidc-token on this invocation', 403);

  // 2. Central-provider protection: per-customer runtime never reconciles.
  if (req.method === 'reconcileWifProvider') return fail('reconcileWifProvider is one-time central infrastructure — refused in the per-customer runtime', 403);

  // 3. Fresh OIDC → STS → generateAccessToken → operator-SA (fail-closed: any
  //    customer Google mutation happens only AFTER this succeeds).
  const built = await deps.buildGoogleAdapter();
  if (!built.ok || !built.adapter) return fail(built.reason ?? 'operator identity unavailable', 500);

  // 4. Dispatch the requested idempotent method on the REAL adapter.
  const adapter = built.adapter as unknown as Record<string, (...a: unknown[]) => Promise<ProviderResult>>;
  const method = adapter[req.method];
  if (typeof method !== 'function') return fail(`unknown google worker method: ${req.method}`, 400);
  try {
    const result = await (method as (...a: unknown[]) => Promise<ProviderResult>).apply(adapter, req.args);
    if (!result.ok) {
      const failReason = (result as { reason?: string }).reason;
      return { ok: false, status: 500, body: { ok: false, reason: failReason ?? 'google worker op failed' } };
    }
    const okResult = result as { resourceId?: string; saEmail?: string };
    const okBody: WorkerResult['body'] = { ok: true };
    if (okResult.resourceId) okBody.resourceId = okResult.resourceId;
    if (okResult.saEmail) okBody.saEmail = okResult.saEmail;
    return { ok: true, status: 200, body: okBody };
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'worker dispatch failed');
  }
}
