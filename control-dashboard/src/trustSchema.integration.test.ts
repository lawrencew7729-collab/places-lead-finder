// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantId = '11111111-1111-4111-8111-111111111111';

async function migratedDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_uid', true), '')::uuid
    $$;
    create role authenticated;
  `);
  for (const name of ['001_phase1_foundation.sql', '002_phase2_quota_policy.sql', '003_trusted_provenance_and_identity_contracts.sql']) {
    await db.exec(migration(name));
  }
  await db.query('insert into auth.users(id) values ($1)', [userId]);
  await db.query("insert into public.operator_profiles(user_id, display_name, role, active) values ($1, 'Trusted Operator', 'admin', true)", [userId]);
  await db.exec(`select set_config('app.test_uid', '${userId}', false)`);
  return db;
}

describe('ordered additive Phase 2 trust-contract migration', () => {
  it('derives USER audit actor provenance from auth.uid and trusted operator profile', async () => {
    const db = await migratedDb();
    await db.query("insert into public.tenants(id, company_name, slug, exact_subdomain, created_by) values ($1, 'Valid', 'valid', 'valid.leadfinder.business', $2)", [tenantId, userId]);
    await db.query("select public.write_user_audit_event($1, 'CHECKPOINT_SAVED', 'tenant', $2, '{}'::jsonb, '{}'::jsonb)", [tenantId, tenantId]);
    const result = await db.query<{ actor_type: string; actor_user_id: string; actor_label: string }>('select actor_type, actor_user_id, actor_label from public.audit_logs');
    expect(result.rows).toEqual([{ actor_type: 'user', actor_user_id: userId, actor_label: 'Trusted Operator' }]);
    const signature = migration('003_trusted_provenance_and_identity_contracts.sql').toLowerCase();
    expect(signature).not.toMatch(/write_user_audit_event\s*\([^)]*actor_user_id/);
    expect(signature).not.toMatch(/write_user_audit_event\s*\([^)]*actor_label/);
    await db.close();
  }, 30_000);

  it('removes authenticated direct audit INSERT and keeps an explicit non-human system path', async () => {
    const db = await migratedDb();
    const policies = await db.query<{ policyname: string; cmd: string }>("select policyname, cmd from pg_policies where schemaname='public' and tablename='audit_logs'");
    expect(policies.rows.some((row) => row.cmd === 'INSERT')).toBe(false);
    const privileges = await db.query<{ grantee: string }>("select grantee from information_schema.routine_privileges where routine_schema='public' and routine_name='write_system_audit_event' and grantee in ('PUBLIC','authenticated')");
    expect(privileges.rows).toEqual([]);
    const sql = migration('003_trusted_provenance_and_identity_contracts.sql').toLowerCase();
    expect(sql).toContain("'system'");
    expect(sql).toContain('write_system_audit_event');
    await db.close();
  }, 30_000);

  it('accepts exactly one customer hostname and rejects invalid/duplicate contracts', async () => {
    const db = await migratedDb();
    await db.query("insert into public.tenants(id, company_name, slug, exact_subdomain, created_by) values ($1, 'Valid', 'valid', 'valid.leadfinder.business', $2)", [tenantId, userId]);
    for (const [index, hostname] of ['valid.example.com', '*.leadfinder.business', 'https://bad.leadfinder.business', 'bad.leadfinder.business/path', '-bad.leadfinder.business', 'a.b.leadfinder.business', 'leadfinder.business'].entries()) {
      await expect(db.query("insert into public.tenants(id, company_name, slug, exact_subdomain, created_by) values (gen_random_uuid(), $1, $2, $3, $4)", [`Invalid ${index}`, `invalid-${index}`, hostname, userId])).rejects.toThrow();
    }
    await expect(db.query("insert into public.tenants(id, company_name, slug, exact_subdomain, created_by) values (gen_random_uuid(), 'Duplicate', 'duplicate', 'valid.leadfinder.business', $1)", [userId])).rejects.toThrow();
    await db.close();
  }, 30_000);

  it('stores only a complete 64-hex Places fingerprint and rejects truncated/non-hex/raw-key-looking values', async () => {
    const db = await migratedDb();
    await db.query("insert into public.tenants(id, company_name, slug, exact_subdomain, created_by) values ($1, 'Valid', 'valid', 'valid.leadfinder.business', $2)", [tenantId, userId]);
    await db.query("insert into public.customer_configurations(tenant_id, places_key_fingerprint, amber_threshold_percent, red_threshold_percent, updated_by) values ($1, $2, 70, 90, $3)", [tenantId, 'A'.repeat(64), userId]);
    const stored = await db.query<{ places_key_fingerprint: string }>('select places_key_fingerprint from public.customer_configurations where tenant_id=$1', [tenantId]);
    expect(stored.rows[0].places_key_fingerprint).toBe('A'.repeat(64));
    for (const value of ['A'.repeat(16), 'G'.repeat(64), `${'AI'}zaSyExampleRawKeyLookingValue123456789`]) {
      await expect(db.query('update public.customer_configurations set places_key_fingerprint=$1 where tenant_id=$2', [value, tenantId])).rejects.toThrow();
    }
    await db.close();
  }, 30_000);
});
