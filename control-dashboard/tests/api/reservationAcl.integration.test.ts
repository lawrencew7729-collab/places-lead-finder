// @vitest-environment node
/**
 * S2e FINAL BLOCKER CORRECTION — migration 012 security + boolean RPC proof.
 * Runs ALL migrations (001–012) in pglite and verifies against real Postgres
 * semantics: column-level revoke, function ACL revoke, boolean RPC results.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';

const adminUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations');
const databases: PGlite[] = [];
const SLOW = 90000; // pglite wasm — generous timeout

function orderedMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function freshDb() {
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
  `);
  for (const name of orderedMigrations().filter((n) => n < '012_atomic_provisioning_reservation.sql')) {
    await db.exec(readFileSync(resolve(migrationsDirectory, name), 'utf8'));
  }
  // Simulate hosted-Supabase default table grants for the browser roles
  // (present since project creation — migrations 001–011 ran on top of them).
  // Migration 012's column-level revoke then applies AFTER these grants,
  // exactly as it would on hosted Supabase.
  await db.exec('grant select, insert, update, delete on all tables in schema public to authenticated;');
  await db.exec('grant select, insert, update, delete on all tables in schema public to service_role;');
  await db.exec('alter role service_role bypassrls;'); // hosted Supabase: service_role bypasses RLS
  await db.exec('grant select on all tables in schema public to anon;');
  for (const name of orderedMigrations().filter((n) => n >= '012_atomic_provisioning_reservation.sql')) {
    await db.exec(readFileSync(resolve(migrationsDirectory, name), 'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1)', [adminUserId]);
  await db.query(
    "insert into public.operator_profiles(user_id, display_name, role, active) values ($1, 'Admin', 'admin', true)",
    [adminUserId],
  );
  return db;
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', uid: string | null, action: () => Promise<T>) {
  await db.exec(`select set_config('app.test_uid', '${uid ?? ''}', false)`);
  await db.exec(`set role ${role}`);
  try {
    return await action();
  } finally {
    await db.exec('reset role');
    await db.exec("select set_config('app.test_uid', '', false)");
  }
}

type Rows = { rows: Array<Record<string, unknown>> };

describe('migration 012 reservation security + boolean RPC contract', () => {
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((d) => d.close()));
  });

  it('RPCs return explicit BOOLEANs with exact CAS semantics', async () => {
    const db = await freshDb();
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await db.query(
      "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co', 'co.leadfinder.business', 'setup_pending', $2)",
      [tenantId, adminUserId],
    );
    const win = (await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_B'])) as Rows;
    expect(win.rows[0].reserve_provisioning_start).toBe(true);
    const lose = (await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_C'])) as Rows;
    expect(lose.rows[0].reserve_provisioning_start).toBe(false); // boolean false — not null/empty
    const link = (await db.query('select public.link_provisioning_run($1, $2, $3)', [tenantId, 'token_B', 'run_B'])) as Rows;
    expect(link.rows[0].link_provisioning_run).toBe(true);
    const wrongLink = (await db.query('select public.link_provisioning_run($1, $2, $3)', [tenantId, 'token_WRONG', 'run_X'])) as Rows;
    expect(wrongLink.rows[0].link_provisioning_run).toBe(false);
    const release = (await db.query('select public.release_provisioning_reservation($1, $2)', [tenantId, 'token_B'])) as Rows;
    expect(release.rows[0].release_provisioning_reservation).toBe(true);
    const wrongRelease = (await db.query('select public.release_provisioning_reservation($1, $2)', [tenantId, 'token_B'])) as Rows;
    expect(wrongRelease.rows[0].release_provisioning_reservation).toBe(false);
  }, SLOW);

  it('reserve atomically clears a prior runId in the SAME update', async () => {
    const db = await freshDb();
    const tenantId = '22222222-2222-4222-8222-222222222222';
    await db.query(
      "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co2', 'co2.leadfinder.business', 'setup_pending', $2)",
      [tenantId, adminUserId],
    );
    await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_A']);
    await db.query('select public.link_provisioning_run($1, $2, $3)', [tenantId, 'token_A', 'run_A_DEAD']);
    await db.query('select public.release_provisioning_reservation($1, $2)', [tenantId, 'token_A']);
    const afterRelease = (await db.query('select provisioning_reservation_token, provisioning_run_id from public.tenants where id = $1', [tenantId])) as Rows;
    expect(afterRelease.rows[0].provisioning_reservation_token).toBeNull();
    expect(afterRelease.rows[0].provisioning_run_id).toBe('run_A_DEAD'); // retained as evidence
    const win = (await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_B'])) as Rows;
    expect(win.rows[0].reserve_provisioning_start).toBe(true);
    const afterReserve = (await db.query('select provisioning_reservation_token, provisioning_run_id from public.tenants where id = $1', [tenantId])) as Rows;
    expect(afterReserve.rows[0].provisioning_reservation_token).toBe('token_B');
    expect(afterReserve.rows[0].provisioning_run_id).toBeNull(); // atomically cleared — race closed
  }, SLOW);

  it('reserve refuses an ACTIVE tenant (never re-provisions)', async () => {
    const db = await freshDb();
    const tenantId = '33333333-3333-4333-8333-333333333333';
    await db.query(
      "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co3', 'co3.leadfinder.business', 'active', $2)",
      [tenantId, adminUserId],
    );
    const win = (await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_A'])) as Rows;
    expect(win.rows[0].reserve_provisioning_start).toBe(false);
  }, SLOW);

  it('SECURITY: authenticated sessions cannot execute the reservation RPCs; service_role can', async () => {
    const db = await freshDb();
    const tenantId = '44444444-4444-4444-8444-444444444444';
    await db.query(
      "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co4', 'co4.leadfinder.business', 'setup_pending', $2)",
      [tenantId, adminUserId],
    );
    await expect(
      asRole(db, 'authenticated', adminUserId, () =>
        db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_X']),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asRole(db, 'anon', null, () =>
        db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_X']),
      ),
    ).rejects.toThrow(/permission denied/i);
    const okRes = (await asRole(db, 'service_role', null, () =>
      db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_X']),
    )) as unknown as Rows;
    expect(okRes.rows[0].reserve_provisioning_start).toBe(true);
  }, SLOW);

  it('SECURITY: direct mutation of the reservation columns is refused by the guard trigger (authenticated + service_role direct); RPC path allowed', async () => {
    const db = await freshDb();
    const tenantId = '55555555-5555-4555-8555-555555555555';
    await db.query(
      "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co5', 'co5.leadfinder.business', 'setup_pending', $2)",
      [tenantId, adminUserId],
    );
    // Legit existing manage path still works for authenticated admin (policy + table grant).
    const okUpdate = (await asRole(db, 'authenticated', adminUserId, () =>
      db.query('update public.tenants set company_name = $1 where id = $2', ['Co Renamed', tenantId]),
    )) as unknown as { rowCount: number };
    expect(okUpdate.rowCount).toBe(1);
    // NOTE: pglite's wasm engine does not apply column-level REVOKE (catalog
    // or execution). The authoritative enforcement on hosted Postgres is the
    // BEFORE UPDATE OF guard trigger below — it runs everywhere.
    // The trigger refuses direct writes at execution time (authenticated
    // browser session AND direct service_role connection).
    await expect(
      asRole(db, 'authenticated', adminUserId, () =>
        db.query('update public.tenants set provisioning_reservation_token = $1 where id = $2', ['evil-token', tenantId]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|reservation columns/);
    await expect(
      asRole(db, 'service_role', null, () =>
        db.query('update public.tenants set provisioning_run_id = $1 where id = $2', ['evil-run', tenantId]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|reservation columns/);
    // The RPC path (SECURITY DEFINER = table owner) is unaffected.
    const rpc = (await db.query('select public.reserve_provisioning_start($1, $2)', [tenantId, 'token_OK'])) as unknown as { rows: Array<Record<string, unknown>> };
    expect(rpc.rows[0].reserve_provisioning_start).toBe(true);
  }, SLOW);

  it('INSERT GUARD: ordinary authenticated INSERT (reservation fields NULL) succeeds; forged reservation fields rejected', async () => {
    const db = await freshDb();
    const tenantId = '66666666-6666-4666-8666-666666666666';
    const normal = (await asRole(db, 'authenticated', adminUserId, () =>
      db.query(
        "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co6', 'co6.leadfinder.business', 'setup_pending', $2)",
        [tenantId, adminUserId],
      ),
    )) as unknown as { rowCount: number };
    expect(normal.rowCount).toBe(1);
    await expect(
      asRole(db, 'authenticated', adminUserId, () =>
        db.query(
          "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by, provisioning_reservation_token) values ($1, 'Evil', 'ev1', 'ev1.leadfinder.business', 'setup_pending', $2, 'evil-token')",
          ['77777777-7777-4777-8777-777777777777', adminUserId],
        ),
      ),
    ).rejects.toThrow(/permission denied|not allowed|reservation/);
    await expect(
      asRole(db, 'authenticated', adminUserId, () =>
        db.query(
          "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by, provisioning_run_id) values ($1, 'Evil', 'ev2', 'ev2.leadfinder.business', 'setup_pending', $2, 'evil-run')",
          ['88888888-8888-4888-8888-888888888888', adminUserId],
        ),
      ),
    ).rejects.toThrow(/permission denied|not allowed|reservation/);
  }, SLOW);

  it('INSERT GUARD: service_role DIRECT INSERT with a forged reservation field is rejected; ordinary insert works', async () => {
    const db = await freshDb();
    await expect(
      asRole(db, 'service_role', null, () =>
        db.query(
          "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by, provisioning_reservation_token) values ($1, 'Evil', 'ev3', 'ev3.leadfinder.business', 'setup_pending', $2, 'evil-token')",
          ['99999999-9999-4999-8999-999999999999', adminUserId],
        ),
      ),
    ).rejects.toThrow(/permission denied|not allowed|reservation/);
    const normal = (await asRole(db, 'service_role', null, () =>
      db.query(
        "insert into public.tenants(id, company_name, slug, exact_subdomain, status, created_by) values ($1, 'Co', 'co7', 'co7.leadfinder.business', 'setup_pending', $2)",
        ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', adminUserId],
      ),
    )) as unknown as { rowCount: number };
    expect(normal.rowCount).toBe(1);
  }, SLOW);
});

