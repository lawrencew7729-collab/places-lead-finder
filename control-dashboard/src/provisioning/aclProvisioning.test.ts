import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  aclUsernameFor,
  aclTokenFingerprint,
  buildAclDelUser,
  buildAclSetUser,
  generateAclPassword,
  provisionTenantAcl,
  provisionTenantAclWithRollback,
  revokeTenantAcl,
  type RedisAclAdmin,
} from './aclProvisioning';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Mock central-Redis admin implementing the Upstash REST-TOKEN contract:
 * ACL SETUSER registers the user with its password; ACL RESTTOKEN returns a
 * DISTINCT REST bearer token bound to (username, password).
 */
function memoryAdmin(restTokenFail = false) {
  const users = new Map<string, string>(); // username -> password
  const restTokens = new Map<string, string>(); // username -> REST token
  const revoked = new Set<string>();
  const calls: string[] = [];
  const admin: RedisAclAdmin = {
    async run(command) {
      calls.push(command);
      const m = command.match(/^ACL SETUSER (\S+) on >(\S+) (.*)$/);
      if (m) { users.set(m[1], m[2]); return; }
      const d = command.match(/^ACL DELUSER (\S+)$/);
      if (d) { users.delete(d[1]); restTokens.delete(d[1]); revoked.add(d[1]); return; }
      throw new Error('unexpected admin command ' + command.slice(0, 40));
    },
    async restToken(username, password) {
      calls.push(`ACL RESTTOKEN ${username} <password>`);
      if (restTokenFail) throw new Error('ACL RESTTOKEN failed');
      if (users.get(username) !== password) throw new Error('password mismatch');
      const token = 'rest-' + createHash('sha256').update(username + ':' + password).digest('hex').slice(0, 32);
      restTokens.set(username, token);
      return token;
    },
  };
  return { admin, users, restTokens, revoked, calls };
}

describe('R1 CENTRALIZED — per-tenant ACL provisioning (REST-TOKEN contract)', () => {
  it('derives a deterministic non-secret ACL username from the immutable tenant UUID', () => {
    expect(aclUsernameFor(TENANT_A)).toBe('lf_taaaaaaaaaaaa');
    expect(aclUsernameFor(TENANT_A)).toBe(aclUsernameFor(TENANT_A)); // deterministic
    expect(aclUsernameFor(TENANT_A)).not.toBe(aclUsernameFor(TENANT_B)); // per-tenant
    expect(aclUsernameFor(TENANT_A)).toMatch(/^[a-zA-Z0-9._-]+$/); // valid Redis ACL name
  });

  it('generates a strong ACL PASSWORD (distinct from the REST token)', () => {
    const p1 = generateAclPassword();
    const p2 = generateAclPassword();
    expect(p1).not.toBe(p2);
    expect(p1.length).toBeGreaterThanOrEqual(24);
  });

  it('ACL SETUSER: tenant-scoped keyspace + MINIMAL command allowlist; no +@all, no ACL admin, no other tenant prefix', () => {
    const cmd = buildAclSetUser('lf_taaaaaaaaaaaa', 'pw123', TENANT_A);
    expect(cmd).toContain(`~tenant:${TENANT_A}:*`);
    expect(cmd).not.toContain(`tenant:${TENANT_B}`);
    expect(cmd).not.toContain('+@all');
    expect(cmd).not.toContain('+acl');
    expect(cmd).not.toContain('+config');
    expect(cmd).not.toContain('+keys');
    expect(cmd).not.toContain('+flush');
    expect(cmd).not.toContain('+shutdown');
    const allow = cmd.split(/\s+/).filter((x) => x.startsWith('+'));
    expect(allow.sort()).toEqual(['+del', '+eval', '+expire', '+get', '+incrby', '+set']);
  });

  it('REST-TOKEN CONTRACT: SETUSER gets a generated password; RESTTOKEN called with EXACT username+password; the RETURNED REST token (NOT the password) is handed out', async () => {
    const { admin, users, restTokens, calls } = memoryAdmin();
    const result = await provisionTenantAcl(admin, TENANT_A);
    expect(result.ok).toBe(true);
    const username = 'lf_taaaaaaaaaaaa';

    // 1. SETUSER received a generated password (>=24 chars)
    const setuser = calls.find((c) => c.startsWith('ACL SETUSER'))!;
    const password = users.get(username)!;
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(setuser).toContain(`>${password}`);
    expect(setuser).toContain(`~tenant:${TENANT_A}:*`);

    // 2. ACL RESTTOKEN was called with exact username + that password
    expect(calls.some((c) => c === `ACL RESTTOKEN ${username} <password>`)).toBe(true);

    // 3. the transient token IS the RESTTOKEN return value, NOT the password
    const restToken = restTokens.get(username)!;
    expect(restToken).toBeTruthy();
    expect(restToken).not.toBe(password);
    expect(result.transientToken).toBe(restToken);

    // 4. the fingerprint hashes the REST TOKEN, not the password
    expect(result.identity.tokenFingerprint).toBe(aclTokenFingerprint(restToken));
    expect(result.identity.tokenFingerprint).not.toBe(aclTokenFingerprint(password));

    // 5+6. neither raw value is persisted in the identity/result metadata
    expect(JSON.stringify(result.identity)).not.toContain(password);
    expect(JSON.stringify(result.identity)).not.toContain(restToken);
  });

  it('ACL RESTTOKEN failure: provisioning fails closed AND the ACL user is revoked (no orphan user)', async () => {
    const { admin, users, revoked } = memoryAdmin(true);
    await expect(provisionTenantAcl(admin, TENANT_A)).rejects.toThrow('ACL RESTTOKEN failed');
    expect(users.has('lf_taaaaaaaaaaaa')).toBe(false); // revoked
    expect(revoked.has('lf_taaaaaaaaaaaa')).toBe(true);
  });

  it('rollback: revoke removes the tenant ACL user (provisioning failure path)', async () => {
    const { admin, users } = memoryAdmin();
    await provisionTenantAcl(admin, TENANT_A);
    await revokeTenantAcl(admin, aclUsernameFor(TENANT_A));
    expect(users.has(aclUsernameFor(TENANT_A))).toBe(false);
    expect(buildAclDelUser(aclUsernameFor(TENANT_A))).toBe('ACL DELUSER lf_taaaaaaaaaaaa');
  });

  it('Vercel env handoff failure: ACL user is revoked (withRollback)', async () => {
    const { admin, users, revoked } = memoryAdmin();
    const result = await provisionTenantAclWithRollback(admin, TENANT_A, async () => ({ ok: false, reason: 'vercel 403' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('vercel 403');
    expect(users.has('lf_taaaaaaaaaaaa')).toBe(false);
    expect(revoked.has('lf_taaaaaaaaaaaa')).toBe(true);
  });

  it('successful handoff keeps the user and returns only non-secret identity', async () => {
    const { admin, users, restTokens } = memoryAdmin();
    const result = await provisionTenantAclWithRollback(admin, TENANT_A, async (token) => {
      expect(token).toBe(restTokens.get('lf_taaaaaaaaaaaa')); // handoff receives the REST token
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    expect(users.has('lf_taaaaaaaaaaaa')).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.identity)).not.toContain(restTokens.get('lf_taaaaaaaaaaaa')!);
    }
  });

  it('cross-tenant isolation: ACL rules reference ONLY the owning tenant prefix', async () => {
    const a = buildAclSetUser(aclUsernameFor(TENANT_A), 'x', TENANT_A);
    const b = buildAclSetUser(aclUsernameFor(TENANT_B), 'y', TENANT_B);
    expect(a).not.toContain(`tenant:${TENANT_B}`);
    expect(b).not.toContain(`tenant:${TENANT_A}`);
  });
});
