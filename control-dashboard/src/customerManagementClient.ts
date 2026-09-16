/**
 * Staff Customer Management API client (same auth pattern as provisioningClient).
 * The Dashboard backend performs the OIDC control call; the browser only talks
 * to its own /api/staff/customerControl route.
 */
import { supabase } from './supabase';
import type { StaffAction } from './staff/customerControlContract';

export interface ManagedCustomer {
  tenantId: string;
  company: string;
  subdomain: string;
  portalVersion: string | null;
  package: string | null;
  packageLabel: string | null;
  usage: number | null;
  searchStop: number | null;
  serviceStatus: 'ACTIVE' | 'STOPPED' | null;
  limitStatus: string;
  state: 'V1_0_11' | 'LEGACY' | 'UNAVAILABLE';
  notice: string | null;
  actionsEnabled: boolean;
}

export interface CustomerManagementApi {
  list(): Promise<{ ok: boolean; rows?: ManagedCustomer[]; error?: string }>;
  runAction(tenantId: string, action: StaffAction): Promise<{ ok: boolean; error?: string; state?: unknown }>;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  const token = data.session?.access_token;
  return token ? { Authorization: 'Bearer ' + token } : {};
}

const URL_BASE = '/api/staff/customerControl';

export const customerManagementClient: CustomerManagementApi = {
  async list() {
    const res = await fetch(URL_BASE, { headers: { ...(await authHeaders()) }, cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; rows?: ManagedCustomer[]; error?: string };
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? 'HTTP ' + res.status };
    return { ok: true, rows: body.rows ?? [] };
  },
  async runAction(tenantId, action) {
    const res = await fetch(URL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ tenantId, action }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; state?: unknown };
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? 'HTTP ' + res.status };
    return { ok: true, state: body.state };
  },
};
