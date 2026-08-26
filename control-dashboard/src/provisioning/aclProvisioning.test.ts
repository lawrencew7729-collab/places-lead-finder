import { describe, expect, it } from 'vitest';
import {
  aclUsernameFor,
  aclTokenFingerprint,
  buildAclDelUser,
  buildAclSetUser,
  generateAclToken,
  provisionTenantAcl,
  revokeTenantAcl,
  type RedisAclAdmin,
} from './aclProvisioning';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function memoryAdmin() {
  const users = new Map<string, string>();
  const admin: RedisAclAdmin = {
    async run(command) {
      const m = command.match(/^ACL SETUSER (\S+) on >(\S+) (.*)$/);
      if (m) { users.set(m[1], m[3]); return; }
      const d = command.match(/^ACL DELUSER (\S+)$/);
      if (d) { users.delete(d[1]); return; }
      throw new Error('unexpected admin command ' + command.slice(0, 40));
    },
  };
  return { admin, users };
}

describe('R1 CENTRALIZED — per-tenant ACL provisioning', () => {
  it('derives a deterministic non-secret ACL username from the immutable tenant UUID', () => {
    expect(aclUsernameFor(TENANT_A)).toBe('lf_taaaaaaaaaaaa');
    expect(aclUsernameFor(TENANT_A)).toBe(aclUsernameFor(TENANT_A)); // deterministic
    expect(aclUsernameFor(TENANT_A)).not.toBe(aclUsernameFor(TENANT_B)); // per-tenant
    expect(aclUsernameFor(TENANT_A)).toMatch(/^[a-zA-Z0-9._-]+$/); // valid Redis ACL name
  });

  it('generates a cryptographically random token with a full 64-hex fingerprint', () => {
    const t1 = generateAclToken();
    const t2 = generateAclToken();
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(24);
    expect(aclTokenFingerprint(t1)).toMatch(/^[A-F0-9]{64}$/);
    expect(aclTokenFingerprint(t1)).not.toBe(aclTokenFingerprint(t2));
  });

  it('ACL SETUSER: tenant-scoped keyspace + MINIMAL command allowlist; no +@all, no ACL admin, no other tenant prefix', () => {
    const cmd = buildAclSetUser('lf_taaaaaaaaaaaa', 'tok123', TENANT_A);
    expect(cmd).toContain(`~tenant:${TENANT_A}:*`);
    expect(cmd).not.toContain(`tenant:${TENANT_B}`);
    expect(cmd).not.toContain('+@all');
    expect(cmd).not.toContain('+acl');
    expect(cmd).not.toContain('+config');
    expect(cmd).not.toContain('+keys');
    expect(cmd).not.toContain('+flush');
    expect(cmd).not.toContain('+shutdown');
    // exact allowlist: get set del incrby expire eval
    for (const cmdName of ['+get', '+set', '+del', '+incrby', '+expire', '+eval']) {
      expect(cmd).toContain(cmdName);
    }
    const allow = cmd.split(/\s+/).filter((x) => x.startsWith('+'));
    expect(allow.sort()).toEqual(['+del', '+eval', '+expire', '+get', '+incrby', '+set']);
  });

  it('provision -> transient token returned; raw token NEVER persisted by the caller contract', async () => {
    const { admin, users } = memoryAdmin();
    const result = await provisionTenantAcl(admin, TENANT_A);
    expect(result.ok).toBe(true);
    expect(result.identity.username).toBe('lf_taaaaaaaaaaaa');
    expect(result.transientToken.length).toBeGreaterThanOrEqual(24);
    // only the fingerprint is the persisted metadata
    expect(result.identity.tokenFingerprint).toBe(aclTokenFingerprint(result.transientToken));
    expect(users.has('lf_taaaaaaaaaaaa')).toBe(true);
    const cmd = users.get('lf_taaaaaaaaaaaa')!;
    expect(cmd).toContain(`~tenant:${TENANT_A}:*`);
  });

  it('rollback: revoke removes the tenant ACL user (provisioning failure path)', async () => {
    const { admin, users } = memoryAdmin();
    await provisionTenantAcl(admin, TENANT_A);
    await revokeTenantAcl(admin, aclUsernameFor(TENANT_A));
    expect(users.has(aclUsernameFor(TENANT_A))).toBe(false);
    expect(buildAclDelUser(aclUsernameFor(TENANT_A))).toBe(`ACL DELUSER lf_taaaaaaaaaaaa`);
  });

  it('cross-tenant isolation: ACL rules reference ONLY the owning tenant prefix', async () => {
    const a = buildAclSetUser(aclUsernameFor(TENANT_A), 'x', TENANT_A);
    const b = buildAclSetUser(aclUsernameFor(TENANT_B), 'y', TENANT_B);
    expect(a).not.toContain(`tenant:${TENANT_B}`);
    expect(b).not.toContain(`tenant:${TENANT_A}`);
  });
});
