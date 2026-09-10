/**
 * Phase 2C Segment 2c — CLOUD PROVIDERS FROM ENV.
 *
 * Builds the REAL provisioning provider set from the deployment environment
 * (Vercel function / Workflow runtime env). Used INSIDE the workflow function
 * (serializable-arguments rule) and by the HTTP route layer.
 *
 * All values come from server env — NEVER from browser input. Raw customer
 * secrets are never present here (they live in the customer Vercel project's
 * encrypted env only).
 */
import { createVercelAdapter, createDeviceLockAdapter, createPlacesKeyAdapter, createUsageSmokeAdapter, createControlPlaneAdapter, createUpstashRedisAclAdmin, createGoogleAdapter } from './adapters.js';
import { createWorkerGoogleAdapter } from './workerGoogleAdapter.js';
import type { ProvisioningProviders } from './provisioningProviders.js';

export interface CloudEnvConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  operatorUserId: string;
  vercelTeamToken: string;
  vercelTeamId: string;
  vercelRepoId: number;
  centralStoreUrl: string;
  operatorGoogleAccessTokenProvider?: () => Promise<string>;
  googleProjectId?: string;
}

export function readCloudEnv(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): CloudEnvConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required server env: ${k}`);
    return v;
  };
  return {
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE'),
    operatorUserId: required('OPERATOR_USER_ID'),
    vercelTeamToken: required('VERCEL_TEAM_TOKEN'),
    vercelTeamId: required('VERCEL_TEAM_ID'),
    vercelRepoId: Number(env['VERCEL_REPO_ID'] ?? '1319226252'),
    centralStoreUrl: required('CENTRAL_STORE_URL'),
    googleProjectId: env['GOOGLE_PROJECT_ID'] ?? undefined,
  };
}

/** Assemble the full provider set (real adapters) from the deployment env. */
export async function createCloudProvidersFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  operatorUserIdOverride?: string,
): Promise<ProvisioningProviders> {
  const cfg = readCloudEnv(env);
  const vercel = createVercelAdapter({
    token: cfg.vercelTeamToken,
    teamId: cfg.vercelTeamId,
    repoId: cfg.vercelRepoId,
  });
  const controlPlane = createControlPlaneAdapter({
    baseUrl: cfg.supabaseUrl,
    serviceRoleKey: cfg.supabaseServiceRoleKey,
    // Verify 4 (S2e): the AUTHENTICATED operator identity (session sub carried
    // in the workflow ctx) overrides any static env default for attribution.
    operatorUserId: operatorUserIdOverride ?? cfg.operatorUserId,
  });
  // KEYLESS Google operator identity (S2e production bridge): the Google
  // provider used inside Workflow steps / routes is a PROXY that forwards each
  // method to the internal Google Worker Function (/api/internal/googlePhase).
  // The Worker obtains its OWN fresh OIDC → STS → operator-SA inside its own
  // invocation — NO credential ever exists in the workflow process/state.
  const vercelUrl = (env['VERCEL_URL'] ?? '').replace(/\/$/, '');
  const google = createWorkerGoogleAdapter({
    baseUrl: vercelUrl ? `https://${vercelUrl}` : 'https://dashboard.leadfinder.business',
    internalSecret: env['LF_INTERNAL_SECRET'] ?? '',
  }) as unknown as ReturnType<typeof createGoogleAdapter>;
  const redisAcl = createUpstashRedisAclAdmin({ adminUrl: cfg.centralStoreUrl.replace(/\/$/, ''), adminToken: env['UPSTASH_ADMIN_TOKEN'] ?? '' });
  const secrets = createPlacesKeyAdapter({ token: cfg.vercelTeamToken, teamId: cfg.vercelTeamId });
  const deviceLock = createDeviceLockAdapter({ token: cfg.vercelTeamToken, teamId: cfg.vercelTeamId, storeMode: 'central' });
  const usageSmoke = createUsageSmokeAdapter();
  return {
    vercel,
    controlPlane,
    google,
    redisAcl,
    deviceLock,
    secrets,
    usageSmoke,
  } as unknown as ProvisioningProviders;
}
