/**
 * Phase 2C Segment 2c — SERVER CONFIG + WORKFLOW ARG ASSEMBLY (server boundary).
 *
 * Assembles the FULL ProvisioningInput (executor contract) from server-only
 * sources: approved release registry + env (WIF/team/quota/central store) +
 * the customer fields already validated by the start boundary. NOTHING here
 * comes from the browser body. No workflow SDK imports — fully type-checked
 * and unit-tested; the actual `start()`/`resumeHook()` calls are bound in
 * workflowRuntime.ts (excluded from tsc, handled by the platform build).
 */
import type { ProvisioningInput } from '../../src/provisioning/executor.js';
import type { ProvisionWorkflowArgs } from '../../workflows/provisionCustomer.js';
import type { GoldenReleaseIdentity } from '../../src/provisioning/releaseRegistry.js';

export interface ProvisionServerEnv {
  centralStoreUrl: string;
  bootstrapMember: string;
  wif: NonNullable<ProvisioningInput['wif']>;
}

export function readProvisionServerEnv(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): ProvisionServerEnv {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required server env: ${k}`);
    return v;
  };
  return {
    centralStoreUrl: required('CENTRAL_STORE_URL'),
    bootstrapMember: env['OPERATOR_SA_EMAIL'] ?? '',
    wif: {
      pool: env['WIF_POOL'] ?? 'lf-vercel-wif',
      provider: env['WIF_PROVIDER'] ?? 'vercel-oidc',
      centralProjectNumber: required('WIF_CENTRAL_PROJECT_NUMBER'),
      vercelTeamSlug: required('WIF_VERCEL_TEAM_SLUG'),
      vercelTeamId: required('VERCEL_TEAM_ID'),
    },
  };
}

export interface SecureStartOutcome {
  companyName: string;
  tenantId: string;
  slug: string;
  hostname: string;
  projectId: string;
  googleProjectId: string;
  websiteRestrictionConfirmed: boolean;
  websiteRestriction: string;
  placesKeyFingerprint: string;
  operatorUserId: string;
  /** Required proof of the successful APP_PASS handoff. */
  appPassState: 'created' | 'retained';
}

/** Build the fully server-derived workflow arguments (pure — unit-tested). */
export function buildProvisionWorkflowArgs(
  env: ProvisionServerEnv,
  startOutcome: SecureStartOutcome,
  goldenRelease: GoldenReleaseIdentity,
  reservationToken?: string,
): ProvisionWorkflowArgs {
  const input: ProvisioningInput = {
    companyName: startOutcome.companyName,
    slug: startOutcome.slug,
    googleProjectId: startOutcome.googleProjectId,
    placesKeyFingerprint: startOutcome.placesKeyFingerprint,
    goldenRelease,
    executionGate: true,
    centralStore: true,
    websiteRestrictionConfirmed: startOutcome.websiteRestrictionConfirmed,
    realPortalSmokeConfirmed: false,
    centralStoreUrl: env.centralStoreUrl,
    bootstrapMember: env.bootstrapMember,
    wif: env.wif,
  };
  return {
    input,
    ctx: {
      reservationToken,
      operatorUserId: startOutcome.operatorUserId,
      tenantId: startOutcome.tenantId,
      projectId: startOutcome.projectId,
      hostname: startOutcome.hostname,
      websiteRestrictionConfirmed: startOutcome.websiteRestrictionConfirmed,
      realPortalSmokeConfirmed: false,
    },
  };
}
