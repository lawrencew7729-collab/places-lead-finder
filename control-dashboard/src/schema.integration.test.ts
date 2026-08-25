// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

describe('Phase 1 migration execution', () => {
  it('executes on PostgreSQL and creates all control-plane tables', async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create role authenticated;
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/001_phase1_foundation.sql'), 'utf8');
    await db.exec(sql);
    const quotaCorrection = readFileSync(resolve(process.cwd(), 'supabase/migrations/002_phase2_quota_policy.sql'), 'utf8');
    await db.exec(quotaCorrection);
    const result = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'tenants', 'customer_configurations', 'deployments', 'releases',
      'health_records', 'alerts', 'infrastructure_pools', 'audit_logs',
    ]));
    const defaults = await db.query<{ column_name: string; column_default: string | null }>(`
      select column_name, column_default from information_schema.columns
      where table_schema = 'public'
        and table_name = 'customer_configurations'
        and column_name in ('amber_threshold_percent', 'red_threshold_percent')
      order by column_name
    `);
    expect(defaults.rows).toEqual([
      { column_name: 'amber_threshold_percent', column_default: null },
      { column_name: 'red_threshold_percent', column_default: null },
    ]);
    await db.close();
  }, 30_000);
});
