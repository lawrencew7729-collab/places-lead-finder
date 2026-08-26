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

describe('Migration 008 — red safety-stop default hygiene (owner 2026-08-26)', () => {
  const safetyStop = () => readFileSync(resolve(process.cwd(), 'supabase/migrations/008_red_safety_stop_default.sql'), 'utf8').toLowerCase();
  const sums = () => readFileSync(resolve(process.cwd(), 'supabase/migrations/SHA256SUMS'), 'utf8');

  it('changes ONLY red_threshold_percent default 100 -> 95', () => {
    const sql = safetyStop();
    expect(sql).toContain('alter column red_threshold_percent set default 95');
    // no other column/default is touched
    expect(sql).not.toMatch(/set default (90|100)/);
    expect(sql).not.toContain('add column');
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('update public.customer_configurations');
  });

  it('does NOT rewrite existing tenant rows (T1 stays a separate audited Phase E update)', () => {
    const sql = safetyStop();
    expect(sql).not.toMatch(/update\s+public\.customer_configurations/i);
  });

  it('frozen migrations 005/006/007 checksums are unchanged in SHA256SUMS', () => {
    const s = sums();
    expect(s).toContain('474497cb02684eeea75b073c25a41115c3ea669b26581808096129a3efc42c79  005_quota_contract_alignment.sql');
    expect(s).toContain('1e2b679e82f6e34256f60316001051d326612939dd9eb142d04ef159b9df914d  006_full_fingerprint_contract.sql');
    expect(s).toContain('a451d2014014cc398e1a4aa86522bdb6161560c712f49ad3954ea132f86974a4  007_device_lock_contract.sql');
  });

  it('008 has a deterministic checksum recorded in SHA256SUMS', () => {
    const s = sums();
    expect(s).toContain('4a5cfed05c68fd5065b53d63825b941cdeec0751f9783302e10f4763488d7b17  008_red_safety_stop_default.sql');
  });
});
