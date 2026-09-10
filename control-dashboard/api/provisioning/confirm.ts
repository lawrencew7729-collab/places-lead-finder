/**
 * CONFIRM — authenticated staff smoke-confirm (Vercel Function).
 * LIVE-PROVEN shape: VercelRequest/VercelResponse + explicit res.json().
 * Thin platform glue over handleConfirmRequest.
 */
import { handleConfirmRequest, type HttpDeps } from '../lib/provisioningHttp.js';
import { vercelEntry } from '../lib/vercelWeb.js';
import { createCloudProvidersFromEnv } from '../../src/provisioning/cloudProvidersEnv.js';
import { workflowResumeSmoke } from '../lib/workflowRuntime.js';
import { probeCustomerPortal } from '../lib/portalHealth.js';

export const config = { runtime: 'nodejs' };

export default vercelEntry(async (req) => {
  const providers = await createCloudProvidersFromEnv();
  const deps: HttpDeps = {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    providers,
    workflowStart: async () => ({ ok: false, reason: 'start not applicable on confirm' }),
    workflowResumeSmoke,
    portalProbe: (hostname) => probeCustomerPortal(hostname, { timeoutMs: 8000 }),
    registry: {
      latestApproved: async () => null,
    },
  } as HttpDeps;
  return handleConfirmRequest(req, deps);
});
