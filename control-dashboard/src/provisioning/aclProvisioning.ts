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
 * Raw ACL token/password is TRANSIENT ONLY: it is handed to the customer
 * deployment env and discarded. Persist/audit only non-secret metadata:
 * tenant ID, ACL username, central store fingerprint, full SHA-256 token
 * fingerprint, provisioning status.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Deterministic non-secret ACL username derived from the immutable tenant UUID. */
export function aclUsernameFor(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '').toLowerCase();
  return `lf_t${hex.slice(0, 12)}`;
}

/** Cryptographically random ACL credential (REST token = user password). */
export function generateAclToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Full 64-hex uppercase SHA-256 token fingerprint (non-secret metadata). */
export function aclTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').toUpperCase();
}

/** Redis ACL command: create the restricted per-tenant user. */
export function buildAclSetUser(username: string, token: string, tenantId: string): string {
  return `ACL SETUSER ${username} on >${token} ~tenant:${tenantId}:* +get +set +del +incrby +expire +eval`;
}

/** Redis ACL command: revoke the tenant ACL identity (provisioning rollback). */
export function buildAclDelUser(username: string): string {
  return `ACL DELUSER ${username}`;
}

export interface TenantAclIdentity {
  tenantId: string;
  username: string;
  /** FULL 64-hex token fingerprint — NEVER the raw token. */
  tokenFingerprint: string;
}

/** Admin transport for the central Redis (server-side/operator-side ONLY). */
export interface RedisAclAdmin {
  /** Executes a Redis command string; throws on failure. */
  run(command: string): Promise<void>;
}

export interface AclProvisionResult {
  ok: true;
  identity: TenantAclIdentity;
  /** Raw transient credential — consumed by the env handoff, then discarded. */
  transientToken: string;
}

/**
 * Creates the restricted per-tenant ACL user and returns the transient token.
 * Caller MUST hand the token to the customer env and discard it; only the
 * fingerprint is persisted.
 */
export async function provisionTenantAcl(admin: RedisAclAdmin, tenantId: string): Promise<AclProvisionResult> {
  const username = aclUsernameFor(tenantId);
  const token = generateAclToken();
  await admin.run(buildAclSetUser(username, token, tenantId));
  return { ok: true, identity: { tenantId, username, tokenFingerprint: aclTokenFingerprint(token) }, transientToken: token };
}

/** Rollback: revoke the tenant ACL identity (must never leak the raw token). */
export async function revokeTenantAcl(admin: RedisAclAdmin, username: string): Promise<void> {
  await admin.run(buildAclDelUser(username));
}
