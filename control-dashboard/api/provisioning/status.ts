/**
 * STATUS — authenticated read of bounded business state (Vercel Function).
 * LIVE-PROVEN shape: VercelRequest/VercelResponse + explicit res.json().
 * Thin platform glue over handleStatusRequest.
 */
import { handleStatusRequest, type HttpDeps } from '../lib/provisioningHttp.js';
import { vercelEntry } from '../lib/vercelWeb.js';
import { createCloudProvidersFromEnv } from '../../src/provisioning/cloudProvidersEnv.js';
import { workflowSmokeReady, workflowRunStatus } from '../lib/workflowRuntime.js';

export const config = { runtime: 'nodejs' };

/** Production status deps — smoke proof + authoritative live-run status are
 * BOTH injected here so statusRoute can distinguish a terminal old run from an
 * active one (terminal-run recovery, 2026-09-08). Exported for glue-level tests. */
export async function buildStatusHttpDeps(): Promise<HttpDeps> {
  const providers = await createCloudProvidersFromEnv();
  return {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    providers,
    workflowStart: async () => ({ ok: false, reason: 'start not applicable on status' }),
    workflowResumeSmoke: async () => ({ ok: false, reason: 'resume not applicable on status' }),
    workflowSmokeReady,
    workflowRunStatus,
    registry: {
      latestApproved: async () => null,
    },
  } as HttpDeps;
}

export default vercelEntry(async (req) => {
  const deps = await buildStatusHttpDeps();
  return handleStatusRequest(req, deps);
});
