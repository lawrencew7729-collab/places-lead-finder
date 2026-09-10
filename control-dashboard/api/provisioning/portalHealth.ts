/**
 * FINAL STAFF UX (2026-09-07) — GET /api/provisioning/portal-health?slug=
 * Authenticated staff/owner read: real portal readiness (server-side probe).
 * Non-secret response: { ok, ready, status?, reason? }.
 */
import { handlePortalHealthRequest, type PortalHealthDeps } from '../lib/provisioningHttp.js';
import { vercelEntry } from '../lib/vercelWeb.js';
import { probeCustomerPortal } from '../lib/portalHealth.js';
import { createCloudProvidersFromEnv } from '../../src/provisioning/cloudProvidersEnv.js';

export const config = { runtime: 'nodejs' };

export default vercelEntry(async (req) => {
  const deps: PortalHealthDeps = {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    providers: (await createCloudProvidersFromEnv()) as unknown as PortalHealthDeps['providers'],
    probe: (hostname) => probeCustomerPortal(hostname, { timeoutMs: 8000 }),
  };
  return handlePortalHealthRequest(req, deps);
});
