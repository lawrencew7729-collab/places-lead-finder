/**
 * Phase 2C Segment 2e — GOOGLE WORKER PROXY ADAPTER (1:1 method forwarding).
 *
 * Implements the GoogleProvider interface by forwarding EVERY method call to
 * the internal Google Worker Function (Option D production bridge):
 *
 *   Workflow step → HTTP (HMAC v1) → /api/internal/googlePhase
 *     → fresh request-scoped Vercel OIDC → STS → generateAccessToken
 *     → central operator-SA → execute the SAME GoogleProvider method
 *     → bounded NON-SECRET result back to the step.
 *
 * The executor business logic is untouched: the worker executes the exact
 * adapter method with the exact args (all non-secret identifiers). NO
 * credential enters workflow args/state/output. reconcileWifProvider is
 * refused here (central provider is one-time infrastructure, never part of
 * the per-customer runtime).
 */
import type { GoogleProvider, ProviderResult } from './provisioningProviders.js';

export interface WorkerGoogleAdapterOptions {
  /** Base URL of the deployment (https://{VERCEL_URL}). */
  baseUrl: string;
  /** Internal HMAC secret (LF_INTERNAL_SECRET env). */
  internalSecret: string;
  /** HTTP POST — injected (fake in tests). */
  post?(url: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<{ status: number; json(): Promise<Record<string, unknown>> }>;
}

export interface WorkerCall {
  method: string;
  args: unknown[];
}

export async function callGoogleWorker(options: WorkerGoogleAdapterOptions, method: string, args: unknown[]): Promise<ProviderResult & { saEmail?: string }> {
  const stamp = String(Math.floor(Date.now() / 1000));
  const { createHmac } = await import('node:crypto');
  const mac = createHmac('sha256', options.internalSecret).update(`lf:${stamp}`).digest('hex');
  const post =
    options.post ??
    (async (url, body, headers) => {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, json: () => res.json() as Promise<Record<string, unknown>> };
    });
  const res = await post(`${options.baseUrl.replace(/\/$/, '')}/api/internal/googlePhase`, { method, args }, {
    'content-type': 'application/json',
    'x-lf-internal': `v1:${stamp}:${mac}`,
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; resourceId?: string; saEmail?: string };
  if (res.status !== 200) {
    return { ok: false, reason: typeof body.reason === 'string' ? body.reason : `google worker HTTP ${res.status}` };
  }
  if (body.ok === true) {
    const out: { ok: true; resourceId?: string; reason?: never } & { saEmail?: string } = { ok: true };
    if (typeof body.resourceId === 'string') out.resourceId = body.resourceId;
    if (typeof body.saEmail === 'string') out.saEmail = body.saEmail;
    return out;
  }
  return { ok: false, reason: typeof body.reason === 'string' ? body.reason : 'google worker failed' };
}

const CENTRAL_PROVIDER_REFUSED = 'reconcileWifProvider is one-time central infrastructure — refused in the per-customer runtime';

/** Build the Worker-proxy GoogleProvider (used inside Workflow steps/routes). */
export function createWorkerGoogleAdapter(options: WorkerGoogleAdapterOptions): GoogleProvider {
  const forward =
    (method: string) =>
    (...args: unknown[]): Promise<ProviderResult & { saEmail?: string }> =>
      callGoogleWorker(options, method, args);

  return {
    reconcileWifProvider: async () => ({ ok: false, reason: CENTRAL_PROVIDER_REFUSED }),
    createMonitoringServiceAccount: forward('createMonitoringServiceAccount'),
    verifyUserManagedKeys: forward('verifyUserManagedKeys'),
    grantMonitoringViewer: forward('grantMonitoringViewer'),
    grantServiceUsageConsumer: forward('grantServiceUsageConsumer'),
    grantWorkloadIdentityUser: forward('grantWorkloadIdentityUser'),
    verifyWifOnboarding: forward('verifyWifOnboarding'),
    verifyReferrer: forward('verifyReferrer'),
    verifyBillingReadback: forward('verifyBillingReadback'),
    removeExactRoleBinding: forward('removeExactRoleBinding'),
    verifyBootstrapRolesAbsent: forward('verifyBootstrapRolesAbsent'),
    revokeWifOnboarding: forward('revokeWifOnboarding'),
    preActivationPlacesUsage: forward('preActivationPlacesUsage'),
  } as unknown as GoogleProvider;
}
