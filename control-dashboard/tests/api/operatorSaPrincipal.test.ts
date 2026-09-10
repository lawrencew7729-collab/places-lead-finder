/**
 * S2e ATOMIC CLOSURE — operator-SA temporary-IAM principal wiring proof.
 * Proves the NORMAL Dashboard-cloud path carries OPERATOR_SA_EMAIL from the
 * server env through the workflow args into executor input.bootstrapMember —
 * and that cleanup removes the SAME member. admin@leadfinder.business stays
 * the historical CLI/Jacker principal (separate constant).
 */
import { describe, expect, it } from 'vitest';
import { readProvisionServerEnv, buildProvisionWorkflowArgs, type SecureStartOutcome } from '../../api/lib/provisionServer.js';
import { BOOTSTRAP_MEMBER, BOOTSTRAP_MEMBER_OPERATOR_SA, BOOTSTRAP_ROLES } from '../../src/provisioning/bootstrapContract.js';
import { createFakeProviders } from '../../src/provisioning/provisioningProviders.js';
import { runProvisioning } from '../../src/provisioning/executor.js';

const OPERATOR_SA = 'operator-sa@leadfinder-shared-monitoring.iam.gserviceaccount.com';
const RAW_ENV: Record<string, string> = {
  CENTRAL_STORE_URL: 'https://central.example.com',
  WIF_POOL: 'lf-vercel-wif',
  WIF_PROVIDER: 'vercel-oidc',
  WIF_CENTRAL_PROJECT_NUMBER: '457413606752',
  WIF_VERCEL_TEAM_SLUG: 'lawrencew7729-4682s-projects',
  WIF_VERCEL_TEAM_ID: 'team_zYcaTVVBfNNI7QeVpwABxkan',
  VERCEL_TEAM_ID: 'team_zYcaTVVBfNNI7QeVpwABxkan',
  SUPABASE_URL: 'https://proj.supabase.co',
  OPERATOR_SA_EMAIL: OPERATOR_SA,
  OPERATOR_USER_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const OUTCOME: SecureStartOutcome = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  companyName: 'Cloud Co',
  slug: 'cloudco',
  hostname: 'cloudco.leadfinder.business',
  projectId: 'prj_cloudco',
  googleProjectId: 'cloudco-1',
  websiteRestrictionConfirmed: true,
  websiteRestriction: 'https://cloudco.leadfinder.business/*',
  placesKeyFingerprint: 'A'.repeat(64),
  operatorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const GOLDEN = { version: '1.0.0', tag: 'customer-app-v1.0.10', commitSha: 'c'.repeat(40), artifactSha256: 'A'.repeat(64), sourcePath: 'test', status: 'approved' as const };

describe('operator-SA cloud bootstrap principal (S2e closure)', () => {
  it('server env OPERATOR_SA_EMAIL flows into workflow args input.bootstrapMember', () => {
    const env = readProvisionServerEnv(RAW_ENV);
    expect(env.bootstrapMember).toBe(OPERATOR_SA);
    const args = buildProvisionWorkflowArgs(env, OUTCOME, GOLDEN, 'res-token');
    expect(args.input.bootstrapMember).toBe(OPERATOR_SA); // never admin@
    expect(args.input.bootstrapMember).not.toBe(BOOTSTRAP_MEMBER); // historical principal NOT used on the cloud path
  });

  it('contract: operator-SA constant matches the live central SA; admin@ is the separate historical CLI constant', () => {
    expect(BOOTSTRAP_MEMBER_OPERATOR_SA).toBe(OPERATOR_SA);
    expect(BOOTSTRAP_MEMBER).toBe('admin@leadfinder.business'); // HISTORICAL CLI/Jacker — separated
    expect(BOOTSTRAP_MEMBER_OPERATOR_SA).not.toBe(BOOTSTRAP_MEMBER);
  });

  it('the normal cloud role contract is exactly FOUR roles (no legacy roles/viewer)', () => {
    expect([...BOOTSTRAP_ROLES]).toEqual([
      'roles/iam.serviceAccountAdmin',
      'roles/iam.serviceAccountViewer',
      'roles/monitoring.viewer',
      'roles/resourcemanager.projectIamAdmin',
    ]);
  });

  it('executor cloud run grants NOTHING but cleans up the SAME operator-SA member at bootstrap_cleanup', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN as never);
    // simulate the staff grant of the 4 temporary roles to the operator-SA
    for (const role of BOOTSTRAP_ROLES) {
      providers.__seedProjectIam('cloudco-1', role as never, [OPERATOR_SA]);
    }
    const result = await runProvisioning(providers, {
      companyName: 'Cloud Co',
      slug: 'cloudco',
      googleProjectId: 'cloudco-1',
      placesKeyFingerprint: 'A'.repeat(64),
      bootstrapMember: OPERATOR_SA, // server env value on the cloud path
      goldenRelease: GOLDEN as never,
      executionGate: true,
      centralStore: true,
      websiteRestrictionConfirmed: true,
      realPortalSmokeConfirmed: true,
      centralStoreUrl: 'https://central.example.com',
      wif: { pool: 'lf-vercel-wif', provider: 'vercel-oidc', centralProjectNumber: '457413606752', vercelTeamSlug: 'lawrencew7729-4682s', vercelTeamId: 'team_lawrencew7729' },
    } as never, { placesApiKey: 'AIzaSyA_TEST_KEY_0000000000000000000000', deviceLockSecrets: { appPass: 'correct-horse-battery-staple' } } as never);
    expect(result.outcome).toBe('CUSTOMER_READY'); // cleanup succeeded → ACTIVE allowed
    expect(result.stages.every((s) => s.status === 'PASS')).toBe(true);
    // readback proof: the operator-SA member is now absent from all 4 roles
    for (const role of BOOTSTRAP_ROLES) {
      const policy = providers.__getProjectIam?.('cloudco-1');
      const members = policy?.get(role) ?? [];
      expect(members.some((m: string) => m.includes('operator-sa@') || m === OPERATOR_SA)).toBe(false);
    }
  });
});
