/**
 * S2e Fix 2 — real ControlPlane adapter findConfigByTenant SELECT regression.
 * The persisted google_project_id / places_key_fingerprint MUST be selected
 * and exposed — secureStartProvisioning relies on them for the fail-closed
 * slug/customer identity collision check.
 */
import { describe, expect, it } from 'vitest';
import { createControlPlaneAdapter } from '../../src/provisioning/adapters.js';

function transportMock(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string }> = [];
  return {
    calls,
    async fn(url: string) {
      calls.push({ url });
      return { ok: true, status: 200, json: async () => rows };
    },
  };
}

const CONFIG_ROW = {
  google_project_id: 'abc-leadfinder-1234',
  places_key_fingerprint: 'A'.repeat(64),
  website_restriction_exact: 'https://abc.leadfinder.business/*',
  monthly_usage_target: 1000,
  amber_threshold_percent: 85,
  red_threshold_percent: 90,
  quota_enforcement_mode: 'disable_new_search',
  device_limit: 2,
  device_lock_mode: 'hard_lock',
  device_kv_namespace: 'lf-device-abc',
  device_store_fingerprint: 'fp123',
  device_app_pass_configured: true,
  billing_account_id: '01B61E-759031-B494E4',
  monitoring_sa_email: 'mon@abc-leadfinder-1234.iam.gserviceaccount.com',
};

describe('ControlPlane findConfigByTenant SELECT (S2e Fix 2)', () => {
  it('SELECT includes google_project_id + places_key_fingerprint (collision evidence columns)', async () => {
    const mock = transportMock([CONFIG_ROW]);
    const adapter = createControlPlaneAdapter({
      baseUrl: 'https://cp.example.com',
      serviceRoleKey: 'sb_test_service_role',
      operatorUserId: '11111111-1111-1111-1111-111111111111',
      transport: mock.fn as never,
    });
    const r = await adapter.findConfigByTenant('22222222-2222-2222-2222-222222222222');
    expect(r.ok).toBe(true);
    const select = String(mock.calls[0].url.split('select=')[1] ?? '');
    expect(select).toContain('google_project_id');
    expect(select).toContain('places_key_fingerprint');
    expect(select).toContain('website_restriction_exact');
  });

  it('parsed result exposes the persisted google project id + key fingerprint', async () => {
    const mock = transportMock([CONFIG_ROW]);
    const adapter = createControlPlaneAdapter({
      baseUrl: 'https://cp.example.com',
      serviceRoleKey: 'sb_test_service_role',
      operatorUserId: '11111111-1111-1111-1111-111111111111',
      transport: mock.fn as never,
    });
    const r = await adapter.findConfigByTenant('22222222-2222-2222-2222-222222222222');
    expect(r.ok).toBe(true);
    expect(r.config?.googleProjectId).toBe('abc-leadfinder-1234');
    expect(r.config?.keyFingerprint).toBe('A'.repeat(64));
  });

  it('rows WITHOUT the identity columns surface empty strings (fail-closed triggers upstream)', async () => {
    const partial = Object.fromEntries(
      Object.entries(CONFIG_ROW).filter(([key]) => key !== 'google_project_id' && key !== 'places_key_fingerprint'),
    );
    const mock = transportMock([partial]);
    const adapter = createControlPlaneAdapter({
      baseUrl: 'https://cp.example.com',
      serviceRoleKey: 'sb_test_service_role',
      operatorUserId: '11111111-1111-1111-1111-111111111111',
      transport: mock.fn as never,
    });
    const r = await adapter.findConfigByTenant('22222222-2222-2222-2222-222222222222');
    expect(r.ok).toBe(true);
    expect(r.config?.googleProjectId).toBe('');
    expect(r.config?.keyFingerprint).toBe('');
  });
});
