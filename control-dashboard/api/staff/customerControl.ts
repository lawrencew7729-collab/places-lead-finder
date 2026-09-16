/**
 * Staff Customer Management — Vercel Function glue (no business logic here).
 *   GET  /api/staff/customerControl            -> customer rows
 *   POST /api/staff/customerControl {tenantId, action}
 *
 * Reuses existing primitives only:
 *   - operator session  : authenticateRequest (Supabase JWT + operator_profiles role)
 *   - dashboard identity: @vercel/oidc getVercelOidcToken() (project-scoped, production)
 *   - audit             : public.write_user_audit_event RPC
 * No shared secret is introduced; no customer Redis credential is read.
 */
import { getVercelOidcToken } from '@vercel/oidc';
import { createCustomerManagementHandler } from '../lib/customerControl.js';
import { vercelEntry } from '../lib/vercelWeb.js';
import { authenticateRequest } from '../lib/session.js';
import type { StaffAction } from '../../src/staff/customerControlContract.js';

export const config = { runtime: 'nodejs' };

const supabaseUrl = () => process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE ?? '';

async function rest(path: string, init: RequestInit = {}) {
  const key = serviceKey();
  const res = await fetch(supabaseUrl().replace(/\/$/, '') + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

function portalOrigin(subdomain: string) {
  return 'https://' + subdomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function portalCall(subdomain: string, token: string, body?: { action: StaffAction }, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(portalOrigin(subdomain) + '/api/control', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? { action: 'STATUS' }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export default vercelEntry(async (req: Request) => {
  const handler = createCustomerManagementHandler({
    async authenticate(request) {
      const auth = await authenticateRequest(request, supabaseUrl());
      if (!auth.ok || !auth.session) return { ok: false, reason: auth.reason ?? 'UNAUTHENTICATED' };
      const userId = String((auth.session as { userId?: string; sub?: string }).userId ?? (auth.session as { sub?: string }).sub ?? '');
      const profile = await rest('operator_profiles?select=role,active&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
      const row = Array.isArray(profile.json) ? (profile.json[0] as { role?: string; active?: boolean } | undefined) : undefined;
      if (!row || row.active === false) return { ok: false, reason: 'INACTIVE' };
      return { ok: true, userId, role: row.role };
    },
    async listTenants() {
      const res = await rest('tenants?select=id,company_name,exact_subdomain&archived_at=is.null&order=company_name.asc&limit=200');
      const rows = Array.isArray(res.json) ? res.json : [];
      return rows.map((r) => {
        const row = r as { id: string; company_name: string; exact_subdomain: string };
        return { tenantId: row.id, company: row.company_name, subdomain: row.exact_subdomain };
      });
    },
    probePortal: (subdomain, token) => portalCall(subdomain, token, { action: 'STATUS' }),
    callPortal: (subdomain, action, token) => portalCall(subdomain, token, { action }),
    mintOidcToken: () => getVercelOidcToken(),
    async writeAudit(params) {
      const res = await rest('rpc/write_user_audit_event', { method: 'POST', body: JSON.stringify(params) });
      return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, reason: 'rpc_' + res.status };
    },
  });
  return handler(req);
});
