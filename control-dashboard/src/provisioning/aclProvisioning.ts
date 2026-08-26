/**
 * R1 CENTRALIZED UPSTASH — per-tenant ACL provisioning (LOCAL preparation).
 *
 * Owner-approved architecture (2026-08-26):
 *   ONE central Upstash Redis database shared by ALL tenants. Isolation is
 *   enforced by the immutable tenant UUID namespace AND a per-tenant
 *   restricted ACL credential:
 *     ~tenant:<TENANT_ID>:*   (keyspace)
 *     +get +set +del +incrby +expire +eval   (minimal command allowlist)
 *   NEVER +@all, NEVER ACL administration, NEVER another tenant's prefix,
 *   NEVER the central/full-access credential in any customer project.
 *
 * Command allowlist justification (implemented runtime):
 *   - device registry: GET / SET
 *   - active-search lease: SET(EX,NX) / GET / DEL / EXPIRE (renew)
 *   - usage bridge: INCRBY / GET
 *   - atomic claim/release/reconcile: EVAL (internal commands GET/SET/EXPIRE/
 *     INCRBY/DEL are themselves checked against the same allowlist by Redis)
 *
 * UPSTASH REST-TOKEN CONTRACT (owner correction 2026-08-26): the value handed
 * to the customer deployment as KV_REST_API_TOKEN is the REST bearer token
 * RETURNED by `ACL RESTTOKEN <username> <password>` — NOT the ACL password
 * itself. The password and the REST token are two different credentials:
 *   ACL SETUSER <user> on ><password> ~tenant:<TID>:* <allowlist>
 *   ACL RESTTOKEN <user> <password>   -> returns the REST bearer token
 * BOTH raw values are transient only and discarded after handoff. Persist
 * only non-secret metadata: tenant ID, ACL username, central store
 * fingerprint, full SHA-256 fingerprint OF THE REST TOKEN, provisioning
 * status. If ACL RESTTOKEN fails, the ACL user is revoked (no orphan user).
 */
import { createHash, randomBytes } from 'node:crypto';

/** Deterministic non-secret ACL username derived from the immutable tenant UUID. */
export function aclUsernameFor(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '').toLowerCase();
  return `lf_t${hex.slice(0, 12)}`;
}

/** Cryptographically random ACL PASSWORD (never leaves this module). */
export function generateAclPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Full 64-hex uppercase SHA-256 fingerprint of the ACTUAL REST token. */
export function aclTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').toUpperCase();
}

/** Redis ACL command: create the restricted per-tenant user with a PASSWORD. */
export function buildAclSetUser(username: string, password: string, tenantId: string): string {
  return `ACL SETUSER ${username} on >${password} ~tenant:${tenantId}:* +get +set +del +incrby +expire +eval`;
}

/** Redis ACL command: revoke the tenant ACL identity (provisioning rollback). */
export function buildAclDelUser(username: string): string {
  return `ACL DELUSER ${username}`;
}

export interface TenantAclIdentity {
  tenantId: string;
  username: string;
  /** FULL 64-hex fingerprint OF THE REST TOKEN — never the password, never the raw token. */
  tokenFingerprint: string;
}

/** Admin transport for the central Redis (server-side/operator-side ONLY). */
export interface RedisAclAdmin {
  /** Executes a Redis command string; throws on failure. */
  run(command: string): Promise<void>;
  /**
   * Upstash: `ACL RESTTOKEN <username> <password>` — returns the REST bearer
   * token bound to that ACL user. The password is NEVER returned by this
   * interface and never leaves the provisioning module.
   */
  restToken(username: string, password: string): Promise<string>;
}

export interface AclProvisionResult {
  ok: true;
  identity: TenantAclIdentity;
  /** Raw TRANSIENT REST token — consumed by the env handoff, then discarded. */
  transientToken: string;
}

/**
 * Creates the restricted per-tenant ACL user, exchanges the password for the
 * Upstash REST bearer token, and returns ONLY the REST token transiently.
 * The password never leaves this function. If ACL RESTTOKEN fails, the ACL
 * user is revoked immediately (no orphan user) and the error propagates.
 */
export async function provisionTenantAcl(admin: RedisAclAdmin, tenantId: string): Promise<AclProvisionResult> {
  const username = aclUsernameFor(tenantId);
  const password = generateAclPassword();
  await admin.run(buildAclSetUser(username, password, tenantId));
  let restToken: string;
  try {
    restToken = await admin.restToken(username, password);
  } catch (e) {
    try {
      await revokeTenantAcl(admin, username);
    } catch {
      // best-effort revocation; the original error is the one to surface
    }
    throw e;
  }
  return { ok: true, identity: { tenantId, username, tokenFingerprint: aclTokenFingerprint(restToken) }, transientToken: restToken };
}

/**
 * Provision + transient handoff with rollback. If the handoff (e.g. Vercel
 * env write via configureDeviceLock) fails, the ACL user is revoked. Neither
 * the password nor the REST token is ever persisted or logged.
 */
export async function provisionTenantAclWithRollback(
  admin: RedisAclAdmin,
  tenantId: string,
  handoff: (transientRestToken: string) => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ ok: true; identity: TenantAclIdentity } | { ok: false; reason: string }> {
  const username = aclUsernameFor(tenantId);
  let created = false;
  try {
    const provisioned = await provisionTenantAcl(admin, tenantId);
    created = true;
    const handoffResult = await handoff(provisioned.transientToken);
    if (!handoffResult.ok) {
      await revokeTenantAcl(admin, username);
      return { ok: false, reason: `acl handoff failed: ${handoffResult.reason || 'unknown'}` };
    }
    return { ok: true, identity: provisioned.identity };
  } catch (e) {
    if (created) {
      try {
        await revokeTenantAcl(admin, username);
      } catch {
        // best-effort
      }
    }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Rollback: revoke the tenant ACL identity (must never leak the raw token). */
export async function revokeTenantAcl(admin: RedisAclAdmin, username: string): Promise<void> {
  await admin.run(buildAclDelUser(username));
}
