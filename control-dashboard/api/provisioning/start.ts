/**
 * START — authenticated provisioning start (Vercel Function).
 * LIVE-PROVEN shape: VercelRequest/VercelResponse + explicit res.json()
 * (web Request/Response loses its response under this Node launcher).
 * Thin platform glue over handleStartRequest; production deps bound here.
 */
import { handleStartRequest, type HttpDeps } from '../lib/provisioningHttp.js';
import { vercelEntry } from '../lib/vercelWeb.js';
import { createCloudProvidersFromEnv } from '../../src/provisioning/cloudProvidersEnv.js';
import { workflowStart, workflowRunStatus } from '../lib/workflowRuntime.js';

export const config = { runtime: 'nodejs' };

export default vercelEntry(async (req) => {
  // NOTE: readProvisionServerEnv() must NOT be parsed here — handlers read raw
  // process.env exactly once (Blocker 1). deps.env is deliberately omitted.
  const deps: HttpDeps = {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    // Providers for the pre-auth release lookup / any read path. The
    // authoritative providers used for ALL customer writes are built lazily
    // by createProviders AFTER authentication, bound to the verified session
    // operator (Verify 4 attribution) — never a static env identity.
    providers: (await createCloudProvidersFromEnv()) as unknown as HttpDeps['providers'],
    createProviders: async (operatorUserId) => {
      const built = await createCloudProvidersFromEnv(undefined, operatorUserId);
      return built as unknown as HttpDeps['providers'];
    },
    workflowStart,
    workflowRunStatus,
    workflowResumeSmoke: async () => ({ ok: false, reason: 'resume not applicable on start' }),
    registry: {
      latestApproved: async () => {
        const latest = await (await createCloudProvidersFromEnv()).controlPlane.listLatestApprovedRelease();
        return latest.ok && latest.release ? { tag: latest.release.tag } : null;
      },
    },
  } as HttpDeps;
  return handleStartRequest(req, deps);
});
