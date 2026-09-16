/**
 * Staff Customer Management handler (injectable — no platform calls of its own).
 *   GET  -> customer rows (control plane tenants + live portal STATUS probe)
 *   POST -> STOP | RESUME | UPGRADE_TO_FULL_900 (portal control + audit record)
 *
 * The Dashboard is the ONLY place staff can act; it never reads customer Redis
 * credentials and never bypasses the customer portal.
 */
import {
  STAFF_ACTIONS, buildAuditEvent, buildCustomerRow, staffRoleAllowed,
  type StaffAction, type PortalProbe,
} from '../../src/staff/customerControlContract.js';

export interface CustomerManagementDeps {
  /** verified operator session (existing dashboard auth) */
  authenticate: (req: Request) => Promise<{ ok: boolean; userId?: string; role?: string; reason?: string; token?: string }>;
  /** control-plane tenant list */
  listTenants: () => Promise<Array<{ tenantId: string; company: string; subdomain: string }>>;
  /** authenticated STATUS read of one portal (never mutates) */
  probePortal: (subdomain: string, token: string) => Promise<PortalProbe>;
  /** authenticated control call of one portal */
  callPortal: (subdomain: string, action: StaffAction, token: string) => Promise<PortalProbe>;
  /** existing audit primitive: public.write_user_audit_event */
  writeAudit: (params: ReturnType<typeof buildAuditEvent>) => Promise<{ ok: boolean; reason?: string }>;
  mintOidcToken: () => Promise<string>;
  now?: () => Date;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function createCustomerManagementHandler(deps: CustomerManagementDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handler(req: Request): Promise<Response> {
    const auth = await deps.authenticate(req);
    if (!auth.ok) return json({ ok: false, error: auth.reason ?? 'UNAUTHENTICATED' }, 401);
    if (!staffRoleAllowed(auth.role)) return json({ ok: false, error: 'UNAUTHORIZED_ROLE' }, 403);

    if (req.method === 'GET') {
      let tenants: Array<{ tenantId: string; company: string; subdomain: string }>;
      try {
        tenants = await deps.listTenants();
      } catch (e) {
        return json({ ok: false, error: 'TENANTS_UNAVAILABLE' }, 503);
      }
      let token: string;
      try {
        token = await deps.mintOidcToken();
      } catch (e) {
        // OIDC unavailable is a system fault — rows report UNAVAILABLE, never LEGACY.
        return json({ ok: true, rows: tenants.map((t) => buildCustomerRow({ ...t, probe: { error: 'oidc_unavailable' } })) });
      }
      const rows = [];
      for (const t of tenants) {
        let probe: PortalProbe;
        try {
          probe = await deps.probePortal(t.subdomain, token);
        } catch (e) {
          probe = { error: String((e && (e as Error).message) || e) };
        }
        rows.push(buildCustomerRow({ ...t, probe }));
      }
      return json({ ok: true, rows });
    }

    if (req.method !== 'POST') {
      return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    }
    let body: { tenantId?: string; action?: string };
    try {
      body = (await req.json()) as { tenantId?: string; action?: string };
    } catch (e) {
      return json({ ok: false, error: 'MALFORMED_BODY' }, 400);
    }
    const action = String(body.action ?? '').toUpperCase() as StaffAction;
    if (!STAFF_ACTIONS.includes(action)) {
      return json({ ok: false, error: 'UNSUPPORTED_ACTION', allowed: STAFF_ACTIONS }, 400);
    }
    let tenants: Array<{ tenantId: string; company: string; subdomain: string }>;
    try {
      tenants = await deps.listTenants();
    } catch (e) {
      return json({ ok: false, error: 'TENANTS_UNAVAILABLE' }, 503);
    }
    const tenant = tenants.find((t) => t.tenantId === body.tenantId);
    if (!tenant) return json({ ok: false, error: 'UNKNOWN_CUSTOMER' }, 404);

    let token: string;
    try {
      token = await deps.mintOidcToken();
    } catch (e) {
      return json({ ok: false, error: 'OIDC_UNAVAILABLE' }, 503);
    }
    // previous state for the audit trail (best effort, never blocks the action)
    let previousState: unknown = null;
    try {
      const before = await deps.probePortal(tenant.subdomain, token);
      previousState = (before.body as { state?: unknown } | undefined)?.state ?? null;
    } catch (e) { /* audit keeps null */ }

    let result: PortalProbe;
    try {
      result = await deps.callPortal(tenant.subdomain, action, token);
    } catch (e) {
      result = { error: String((e && (e as Error).message) || e) };
    }
    if (result.status !== 200 || (result.body as { ok?: boolean } | undefined)?.ok !== true) {
      return json({ ok: false, error: 'PORTAL_ACTION_FAILED', portal: result }, result.status === 404 ? 409 : 502);
    }

    const newState = (result.body as { state?: unknown }).state ?? null;
    let audit: { ok: boolean; reason?: string };
    try {
      audit = await deps.writeAudit(buildAuditEvent({
        actorUserId: auth.userId ?? 'unknown',
        tenantId: tenant.tenantId,
        subdomain: tenant.subdomain,
        action,
        previousState,
        newState,
        at: now(),
      }));
    } catch (e) {
      audit = { ok: false, reason: String((e && (e as Error).message) || e) };
    }
    if (!audit.ok) {
      // the portal already changed; surface the audit failure loudly (never silent)
      return json({ ok: false, error: 'AUDIT_WRITE_FAILED', action, state: newState, auditReason: audit.reason ?? null }, 500);
    }
    return json({ ok: true, action, state: newState, audited: true });
  };
}
