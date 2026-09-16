/**
 * Staff Customer Management contract (v1.0.11 package control).
 *
 * Staff act through the Dashboard; the customer portal is the ONLY authority
 * for its own package/service state (stored in that customer's own Redis).
 *
 * OWNER RULE 1 (revised) — never turn a fault into "legacy":
 *   LEGACY      ONLY with POSITIVE proof that the portal is v1.0.10
 *               (deployment identity resolves to the known v1.0.10 commit).
 *   UNAVAILABLE for a bare 404 (could be a broken v1.0.11 route/deployment),
 *               timeout, 401/OIDC error, 5xx, offline, malformed reply, or an
 *               unknown/underivable version.
 *
 * OWNER RULE 2 — every staff mutation must leave an audit record.
 */

export const LEGACY_LABEL = 'LEGACY / PACKAGE CONTROL NOT SUPPORTED';
export const UNAVAILABLE_LABEL = 'UNAVAILABLE / CHECK CONNECTION';

export type PortalState = 'V1_0_11' | 'LEGACY' | 'UNAVAILABLE';
export type PackageId = 'STARTER_500' | 'FULL_900';
export type ServiceStatus = 'ACTIVE' | 'STOPPED';

/** Staff mutation actions (identical to the portal control endpoint). */
export const STAFF_ACTIONS = ['STOP', 'RESUME', 'UPGRADE_TO_FULL_900'] as const;
export type StaffAction = (typeof STAFF_ACTIONS)[number];

export const PACKAGE_LABELS: Record<PackageId, string> = {
  STARTER_500: 'Starter 500',
  FULL_900: 'Full 900',
};

/**
 * Known customer-portal versions by commit SHA. This is the ONLY positive
 * version proof available for a portal that has no control endpoint yet
 * (v1.0.10). Extend it when a new portal Golden is released.
 */
export const KNOWN_PORTAL_VERSIONS: Record<string, string> = {
  '9f924c9a91eb36ee7f8d0aa7d8571852e0c025bd': '1.0.10',
};

export function versionFromCommit(commitSha?: string | null): string | null {
  if (!commitSha) return null;
  return KNOWN_PORTAL_VERSIONS[commitSha.trim().toLowerCase()] ?? null;
}

/** `andrew.leadfinder.business` -> `andrew` (the provisioning project slug). */
export function customerSlugFromSubdomain(subdomain: string): string {
  return String(subdomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('.')[0];
}

/** The provisioning project name for a customer subdomain. */
export function customerProjectName(subdomain: string): string {
  return 'lf-customer-' + customerSlugFromSubdomain(subdomain);
}

/**
 * Latest PRODUCTION deployment commit of a customer project (read-only).
 * Returns null when nothing usable is present — an unprovable version must
 * never be upgraded to a "legacy" verdict.
 */
export function chooseProductionCommit(
  deployments: Array<{ target?: string; meta?: { githubCommitSha?: string } }> | null | undefined,
): string | null {
  if (!Array.isArray(deployments)) return null;
  const prod = deployments.filter((d) => d && d.target === 'production');
  const first = prod[0] ?? null;
  const sha = first?.meta?.githubCommitSha;
  return typeof sha === 'string' && sha.length >= 7 ? sha : null;
}

export interface PortalProbe {
  status?: number;
  body?: unknown;
  /** transport-level failure (timeout, DNS, TLS, abort) — never legacy */
  error?: string;
}

export interface PortalClassification {
  state: PortalState;
  label: string | null;
  reason: string;
}

/** Transport/shape classification only — this NEVER returns LEGACY. */
export function classifyPortalProbe(probe: PortalProbe): PortalClassification {
  if (probe.error) return { state: 'UNAVAILABLE', label: UNAVAILABLE_LABEL, reason: 'transport:' + probe.error };
  const status = probe.status ?? 0;
  if (status === 404) {
    // A 404 alone proves NOTHING: the control route may simply be broken on a
    // current portal. Positive version proof is required (see classifyPortal).
    return { state: 'UNAVAILABLE', label: UNAVAILABLE_LABEL, reason: 'control_endpoint_absent_without_version_proof' };
  }
  if (status === 200) {
    const body = probe.body as { ok?: unknown; state?: { package?: unknown; serviceStatus?: unknown; portalVersion?: unknown } } | undefined;
    const st = body?.state;
    if (body?.ok === true && st && (st.package === 'STARTER_500' || st.package === 'FULL_900') && typeof st.portalVersion === 'string') {
      return { state: 'V1_0_11', label: null, reason: 'ok' };
    }
    return { state: 'UNAVAILABLE', label: UNAVAILABLE_LABEL, reason: 'malformed_state' };
  }
  return { state: 'UNAVAILABLE', label: UNAVAILABLE_LABEL, reason: 'http_' + status };
}

/** Full classification: live proof first, then positive version proof. */
export function classifyPortal(input: { probe: PortalProbe; provenVersion?: string | null }): PortalClassification {
  const live = classifyPortalProbe(input.probe);
  if (live.state === 'V1_0_11') return live;
  const proven = input.provenVersion ?? null;
  if (proven === '1.0.10') return { state: 'LEGACY', label: LEGACY_LABEL, reason: 'proven_version_1.0.10' };
  return {
    state: 'UNAVAILABLE',
    label: UNAVAILABLE_LABEL,
    reason: proven ? 'version_' + proven + ':' + live.reason : 'no_version_proof:' + live.reason,
  };
}

export type LimitStatus = 'OK' | 'LIMIT REACHED' | 'STOPPED' | 'UNKNOWN';

export interface CustomerRow {
  tenantId: string;
  company: string;
  subdomain: string;
  portalVersion: string | null;
  package: string | null;
  packageLabel: string | null;
  usage: number | null;
  searchStop: number | null;
  serviceStatus: ServiceStatus | null;
  limitStatus: LimitStatus;
  state: PortalState;
  /** shown instead of package/usage when the portal cannot be trusted */
  notice: string | null;
  actionsEnabled: boolean;
}

export function limitStatusOf(pkg: string | null, serviceStatus: ServiceStatus | null, usage: number | null): LimitStatus {
  if (serviceStatus === 'STOPPED') return 'STOPPED';
  if (pkg !== 'STARTER_500' && pkg !== 'FULL_900') return 'UNKNOWN';
  if (usage === null) return 'UNKNOWN';
  return usage >= (pkg === 'FULL_900' ? 900 : 500) ? 'LIMIT REACHED' : 'OK';
}

export function buildCustomerRow(input: {
  tenantId: string;
  company: string;
  subdomain: string;
  probe: PortalProbe;
  provenVersion?: string | null;
}): CustomerRow {
  const cls = classifyPortal({ probe: input.probe, provenVersion: input.provenVersion });
  const base = {
    tenantId: input.tenantId,
    company: input.company,
    subdomain: input.subdomain,
    state: cls.state,
    notice: cls.label,
    actionsEnabled: cls.state === 'V1_0_11',
  };
  if (cls.state !== 'V1_0_11') {
    return { ...base, portalVersion: null, package: null, packageLabel: null, usage: null, searchStop: null, serviceStatus: null, limitStatus: 'UNKNOWN' };
  }
  const st = (input.probe.body as { state: Record<string, unknown> }).state;
  const pkg = st.package as PackageId;
  const serviceStatus = (st.serviceStatus === 'STOPPED' ? 'STOPPED' : 'ACTIVE') as ServiceStatus;
  const usage = typeof st.usage === 'number' ? st.usage : null;
  return {
    ...base,
    portalVersion: String(st.portalVersion),
    package: pkg,
    packageLabel: PACKAGE_LABELS[pkg] ?? String(pkg),
    usage,
    searchStop: typeof st.searchStop === 'number' ? st.searchStop : null,
    serviceStatus,
    limitStatus: limitStatusOf(pkg, serviceStatus, usage),
    notice: null,
  };
}

/** Rule 2. Audit payload for `public.write_user_audit_event` (8-arg signature). */
export function buildAuditEvent(input: {
  actorUserId: string;
  tenantId: string;
  subdomain: string;
  action: StaffAction;
  previousState: unknown;
  newState: unknown;
  at: Date;
}): {
  p_tenant_id: string;
  p_action: string;
  p_entity_type: string;
  p_entity_id: string;
  p_previous_state_redacted: Record<string, unknown>;
  p_new_state_redacted: Record<string, unknown>;
} {
  return {
    p_tenant_id: input.tenantId,
    p_action: 'CUSTOMER_' + input.action,
    p_entity_type: 'customer_service_control',
    p_entity_id: input.subdomain,
    p_previous_state_redacted: { action: input.action, portal: input.subdomain, staffUserId: input.actorUserId, state: input.previousState as object, at: input.at.toISOString() },
    p_new_state_redacted: { action: input.action, portal: input.subdomain, staffUserId: input.actorUserId, state: input.newState as object, at: input.at.toISOString() },
  };
}

/** Only admin/operator may act (mirrors the approved audit ACL contract). */
export function staffRoleAllowed(role: string | undefined): boolean {
  return role === 'admin' || role === 'operator';
}
