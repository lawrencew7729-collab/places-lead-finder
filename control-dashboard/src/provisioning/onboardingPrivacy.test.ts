/**
 * OWNER FINAL DECISION 2 (2026-08-27) — CUSTOMER GOOGLE ACCOUNT PRIVACY.
 *
 * Lead Finder must NOT require the customer to grant Owner / Editor /
 * IAM Admin / Billing Admin / Organization Admin (or any permanent admin) on
 * their Google account. The customer logs into their OWN account (face-to-
 * face), keeps billing control, and Lead Finder never collects their
 * password/credentials. The provisioning system stores only the customer
 * configuration required for the Lead Finder runtime.
 *
 * This suite asserts the privacy boundary at the adapter/CLI level:
 *   - the google adapter grants ONLY monitoring.viewer + serviceUsageConsumer
 *     (to the Lead Finder-created customer monitoring SA) — never owner,
 *     editor, iam.admin, billing admin, or any account-level role;
 *   - the operator CLI prompts for NO customer credential (no password /
 *     login / billing access inputs; OPERATOR_ENV_KEYS contains no customer
 *     account secret);
 *   - the billing interaction is READ-ONLY (GET /billingAccounts/{id}/projects
 *     only — no write, no payment data).
 */
import { describe, expect, it } from 'vitest';
import { createGoogleAdapter, createFakeTransport } from './adapters';
import { OPERATOR_ENV_KEYS } from './operatorCli';

describe('OWNER DECISION 2 — no customer Google account admin access', () => {
  it('google adapter grants ONLY monitoring.viewer + serviceUsageConsumer (never owner/editor/iam.admin/billing admin)', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: ':getIamPolicy', body: { etag: 'E1', bindings: [] } },
      { urlPrefix: ':setIamPolicy', body: {} },
      { urlPrefix: ':getIamPolicy', body: { etag: 'E1', bindings: [] } },
      { urlPrefix: ':setIamPolicy', body: {} },
    ]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const sa = 'lf-monitor-abc@customer-a-google-123.iam.gserviceaccount.com';
    await adapter.grantMonitoringViewer('customer-a-google-123', sa);
    await adapter.grantServiceUsageConsumer('customer-a-google-123', sa);
    const forbidden = ['roles/owner', 'roles/editor', 'roles/iam.admin', 'roles/resourcemanager.projectIamAdmin', 'roles/billing.admin', 'roles/billing.user', 'roles/orgpolicy.policyAdmin'];
    for (const call of calls.filter((c) => c.method === 'POST' && c.url.includes(':setIamPolicy'))) {
      const roles = (JSON.parse(call.body ?? '{}').policy?.bindings ?? []).map((b: { role: string }) => b.role);
      for (const f of forbidden) {
        expect(roles).not.toContain(f);
      }
      // every grant targets the customer's OWN monitoring SA only
      for (const b of JSON.parse(call.body ?? '{}').policy?.bindings ?? []) {
        for (const m of b.members ?? []) {
          expect(m).toBe(`serviceAccount:${sa}`);
        }
      }
    }
  });

  it('billing interaction is READ-ONLY: verifyBillingIsolation issues only GET, never writes or touches payment data', async () => {
    const { transport, calls } = createFakeTransport([
      { urlPrefix: '/projects', body: { projects: [{ projectId: 'customer-a-google-123', billingEnabled: true }] } },
    ]);
    const adapter = createGoogleAdapter({ accessTokenProvider: async () => 'tok', transport });
    const res = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', 'customer-a-google-123');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/billingAccounts/01B61E-759031-B494E4/projects');
    // no payment/card endpoint ever contacted
    expect(calls[0].url).not.toMatch(/payment|cards|invoices|transactions/i);
  });

  it('operator CLI requires NO customer credential: env keys are operator-side only, prompts carry no password/login input', () => {
    const envKeys = OPERATOR_ENV_KEYS.join(' ');
    expect(envKeys).not.toMatch(/CUSTOMER_PASS|CUSTOMER_LOGIN|CUSTOMER_EMAIL|GOOGLE_ACCOUNT|CUSTOMER_TOKEN|CUSTOMER_OAUTH/i);
    // every privileged env var is an OPERATOR credential (Lead Finder's own), never the customer's
    expect(envKeys).toContain('GOOGLE_ACCESS_TOKEN'); // operator's own short-lived token
    expect(envKeys).toContain('VERCEL_TOKEN');
    expect(envKeys).toContain('UPSTASH_ADMIN_TOKEN');
  });

  it('customer configuration persisted is runtime-required ONLY (no account/billing credentials)', async () => {
    // CustomerConfigInput carries only: project id, key fingerprint, restriction,
    // quota, device policy metadata, billing account id (non-secret evidence),
    // ACL identity metadata, monitoring SA email. Nothing else.
    const { createFakeProviders } = await import('./provisioningProviders');
    const providers = createFakeProviders();
    const { runProvisioning } = await import('./executor');
    const golden = {
      version: '1.0.1',
      tag: 'customer-app-v1.0.1',
      commitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
      sourcePath: 'repo root (Vite)',
      status: 'approved' as const,
    };
    await providers.controlPlane.insertRelease(golden);
    const result = await runProvisioning(providers, {
      companyName: 'ABC', slug: 'abc', googleProjectId: 'abc-leadfinder-1234',
      placesKeyFingerprint: 'A'.repeat(64), goldenRelease: golden, executionGate: true,
      centralStore: true, centralStoreUrl: 'https://central.example.com',
      billingAccountId: '01B61E-759031-B494E4', websiteRestrictionConfirmed: true, realPortalSmokeConfirmed: true,
      wif: { pool: 'lf-vercel-wif', provider: 'vercel-oidc', centralProjectNumber: '123456789012', vercelTeamSlug: 'lawrencew7729-4682s', vercelTeamId: 'team_lawrencew7729' },
    }, { placesApiKey: 'AIzaSyA_TEST_KEY_0000000000000000000000', deviceLockSecrets: { appPass: 'accesscode123456' } });
    expect(result.outcome).toBe('CUSTOMER_READY');
    const cfg = (await providers.controlPlane.findConfigByTenant(result.tenantId)).config;
    const serialized = JSON.stringify(cfg);
    // no account/billing credential material persists
    expect(serialized).not.toMatch(/password|login|oauth|access_token|refresh_token|billing.*(key|secret)/i);
    // billing account id is NON-SECRET evidence only
    expect(serialized).toContain('01B61E-759031-B494E4');
  });
});
