// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = () => readFileSync(resolve(process.cwd(), 'supabase/migrations/001_phase1_foundation.sql'), 'utf8').toLowerCase();
const quotaCorrection = () => readFileSync(resolve(process.cwd(), 'supabase/migrations/002_phase2_quota_policy.sql'), 'utf8').toLowerCase();

describe('Phase 1 Supabase security contract', () => {
  it('defines every approved control-plane foundation table', () => {
    const sql = schema();
    for (const table of ['operator_profiles','tenants','customer_configurations','deployments','releases','health_records','alerts','infrastructure_pools','infrastructure_snapshots','audit_logs','commercial_settings']) {
      expect(sql).toContain(`create table public.${table}`);
    }
  });

  it('enables RLS and preserves append-only audit records', () => {
    const sql = schema();
    expect((sql.match(/enable row level security/g) ?? []).length).toBeGreaterThanOrEqual(11);
    expect(sql).toContain('audit logs are append-only');
    expect(sql).not.toContain('create policy "delete audit');
    expect(sql).not.toContain('create policy "update audit');
  });

  it('stores fingerprints and secret references, never raw credentials', () => {
    const sql = schema();
    expect(sql).toContain('places_key_fingerprint');
    expect(sql).toContain('monitoring_credential_secret_ref');
    expect(sql).not.toMatch(/places_api_key\s+text/);
    expect(sql).not.toMatch(/json_credential\s+json/);
  });

  it('makes tenant identity and approved release artifacts immutable', () => {
    const sql = schema();
    expect(sql).toContain('prevent_tenant_identity_change');
    expect(sql).toContain('prevent_approved_release_mutation');
  });

  it('removes unapproved AMBER and RED database defaults in the Phase 2 correction', () => {
    const sql = quotaCorrection();
    expect(sql).toContain('alter column amber_threshold_percent drop default');
    expect(sql).toContain('alter column red_threshold_percent drop default');
    expect(sql).not.toMatch(/set default\s+(80|95)/);
  });
});
