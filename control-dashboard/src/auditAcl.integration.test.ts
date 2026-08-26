// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const inactiveUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations');
const databases: PGlite[] = [];

function orderedMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function hostedSupabaseDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  databases.push(db);
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.test_uid', true), '')::uuid
    $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create role public_probe;
    alter default privileges in schema public
      grant execute on functions to anon, authenticated, service_role;
  `);
  for (const name of orderedMigrations()) {
    await db.exec(readFileSync(resolve(migrationsDirectory, name), 'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1), ($2)', [userId, inactiveUserId]);
  await db.query(
    "insert into public.operator_profiles(user_id, display_name, role, active) values ($1, 'Trusted Operator', 'admin', true)",
    [userId],
  );
  return db;
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role' | 'public_probe', uid: string | null, action: () => Promise<T>) {
  await db.exec(`select set_config('app.test_uid', '${uid ?? ''}', false)`);
  await db.exec(`set role ${role}`);
  try {
    return await action();
  } finally {
    await db.exec('reset role');
    await db.exec("select set_config('app.test_uid', '', false)");
  }
}

async function callSystemWriter(db: PGlite, actor = 'control_plane') {
  return db.query(
    "select public.write_system_audit_event($1, null, 'TEST', 'verification', 'local', '{}'::jsonb, '{}'::jsonb)",
    [actor],
  );
}

async function callUserWriter(db: PGlite) {
  return db.query(
    "select public.write_user_audit_event(null, 'TEST', 'verification', 'local', '{}'::jsonb, '{}'::jsonb)",
  );
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe('hosted Supabase audit writer ACL correction', () => {
  it('sets the exact final ACL matrix despite hosted explicit default grants', async () => {
    const db = await hostedSupabaseDb();
    const result = await db.query<{
      identity: string;
      public_execute: boolean;
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_role_execute: boolean;
    }>(`
      select p.oid::regprocedure::text identity,
        exists (
          select 1
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        ) public_execute,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') service_role_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('write_system_audit_event', 'write_user_audit_event')
      order by p.proname
    `);

    expect(result.rows).toEqual([
      {
        identity: 'write_system_audit_event(text,uuid,text,text,text,jsonb,jsonb,uuid)',
        public_execute: false,
        anon_execute: false,
        authenticated_execute: false,
        service_role_execute: true,
      },
      {
        identity: 'write_user_audit_event(uuid,text,text,text,jsonb,jsonb,uuid,text)',
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true,
        service_role_execute: false,
      },
    ]);
    const names = orderedMigrations();
    // 009 (R1 CENTRALIZED store/ACL model) is now the latest migration;
    // the ACL contract itself was fixed in 004 and remains unchanged.
    expect(names[names.length - 1]).toBe('009_central_store_acl_model.sql');
    expect(names).toContain('004_fix_audit_function_acl.sql');
    expect(names).toContain('005_quota_contract_alignment.sql');
    expect(names).toContain('006_full_fingerprint_contract.sql');
    expect(names).toContain('007_device_lock_contract.sql');
    expect(names).toContain('008_red_safety_stop_default.sql');
  }, 30_000);

  it('rejects anonymous, public and wrong-role calls before either writer can insert', async () => {
    const db = await hostedSupabaseDb();

    await expect(asRole(db, 'anon', null, () => callSystemWriter(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole(db, 'authenticated', userId, () => callSystemWriter(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole(db, 'public_probe', null, () => callSystemWriter(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole(db, 'anon', userId, () => callUserWriter(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole(db, 'public_probe', userId, () => callUserWriter(db))).rejects.toThrow(/permission denied/i);

    const rows = await db.query<{ count: number }>('select count(*)::int count from public.audit_logs');
    expect(rows.rows[0].count).toBe(0);
  }, 30_000);

  it('rejects authenticated USER calls without trusted authenticated provenance', async () => {
    const db = await hostedSupabaseDb();

    await expect(asRole(db, 'authenticated', null, () => callUserWriter(db))).rejects.toThrow(/Authenticated USER actor required/i);
    await expect(asRole(db, 'authenticated', inactiveUserId, () => callUserWriter(db))).rejects.toThrow(/Active admin\/operator profile required/i);

    const rows = await db.query<{ count: number }>('select count(*)::int count from public.audit_logs');
    expect(rows.rows[0].count).toBe(0);
  }, 30_000);

  it('preserves authenticated USER provenance and prevents caller-selected identity', async () => {
    const db = await hostedSupabaseDb();

    await asRole(db, 'authenticated', userId, () => callUserWriter(db));
    const rows = await db.query<{ actor_type: string; actor_user_id: string; actor_label: string }>(
      'select actor_type, actor_user_id, actor_label from public.audit_logs',
    );
    expect(rows.rows).toEqual([{ actor_type: 'user', actor_user_id: userId, actor_label: 'Trusted Operator' }]);

    const signature = await db.query<{ args: string }>(`
      select pg_get_function_identity_arguments(p.oid) args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='write_user_audit_event'
    `);
    expect(signature.rows[0].args).not.toMatch(/actor_user_id|actor_label/i);
  }, 30_000);

  it('preserves the trusted SYSTEM path, actor allow-list, safe search_path, constraints and RLS', async () => {
    const db = await hostedSupabaseDb();

    await expect(asRole(db, 'service_role', null, () => callSystemWriter(db, 'untrusted_client'))).rejects.toThrow(/Unrecognized trusted SYSTEM actor/i);
    await asRole(db, 'service_role', null, () => callSystemWriter(db));

    const audit = await db.query<{ actor_type: string; actor_user_id: string | null; actor_label: string }>(
      'select actor_type, actor_user_id, actor_label from public.audit_logs',
    );
    expect(audit.rows).toEqual([{ actor_type: 'system', actor_user_id: null, actor_label: 'control_plane' }]);

    const functions = await db.query<{ proname: string; security_definer: boolean; settings: string[] }>(`
      select p.proname, p.prosecdef security_definer, p.proconfig settings
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('write_system_audit_event','write_user_audit_event')
      order by p.proname
    `);
    expect(functions.rows).toEqual([
      { proname: 'write_system_audit_event', security_definer: true, settings: ['search_path=public, pg_temp'] },
      { proname: 'write_user_audit_event', security_definer: true, settings: ['search_path=public, pg_temp'] },
    ]);

    const rls = await db.query<{ count: number }>("select count(*)::int count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity");
    expect(rls.rows[0].count).toBe(11);
    const directInsert = await db.query<{ count: number }>("select count(*)::int count from pg_policies where schemaname='public' and tablename='audit_logs' and cmd='INSERT'");
    expect(directInsert.rows[0].count).toBe(0);
    const constraints = await db.query<{ conname: string }>("select conname from pg_constraint where conrelid='public.audit_logs'::regclass and conname in ('audit_logs_actor_type_check','audit_logs_actor_identity_check') order by conname");
    expect(constraints.rows.map((row) => row.conname)).toEqual(['audit_logs_actor_identity_check', 'audit_logs_actor_type_check']);
  }, 30_000);
});
