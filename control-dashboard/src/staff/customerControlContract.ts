/**
 * Staff Customer Management contract (v1.0.11 package control).
 *
 * Staff act through the Dashboard; the customer portal is the ONLY authority
 * for its own package/service state (stored in that customer's own Redis).
 *
 * OWNER RULE 1 — classification must never confuse a fault with legacy:
 *   LEGACY      ONLY when the portal POSITIVELY proves it is v1.0.10, i.e. the
 *               control endpoint does not exist (HTTP 404).
 *   UNAVAILABLE for every timeout / 5xx / OIDC error / offline / malformed reply.
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

/** Rule 1. A 404 is the ONLY positive proof of a v1.0.10 portal. */
export function classifyPortalProbe(probe: PortalProbe): PortalClassification {
  if (probe.error) return { state: 'UNAVAILABLE', label: UNAVAILABLE_LABEL, reason: 'transport:' + probe.error };
  const status = probe.status ?? 0;
  if (status === 404) return { state: 'LEGACY', label: LEGACY_LABEL, reason: 'control_endpoint_absent' };
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
}): CustomerRow {
  const cls = classifyPortalProbe(input.probe);
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
