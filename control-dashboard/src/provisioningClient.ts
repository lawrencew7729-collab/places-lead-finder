/**
 * Phase 2C Segment 2c — DASHBOARD PROVISIONING CLIENT (minimal wiring).
 *
 * Calls the authenticated provisioning API with the CURRENT Supabase session
 * token. The browser NEVER sends operatorUserId or a golden release — the
 * server derives both. Response values are safe business state only.
 */
import { supabase } from './supabase';

async function sessionHeaders(): Promise<HeadersInit> {
  if (!supabase) throw new Error('supabase client unavailable');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

export interface ProvisionStartRequest {
  companyName: string;
  slug: string;
  googleProjectId: string;
  websiteRestrictionConfirmed: boolean;
  placesApiKey: string;
  appPass?: string;
  /** Existing non-secret recovery identity saved from the original start. */
  recoveryTenantId?: string;
}

export interface ProvisionStartResponse {
  ok: boolean;
  reason?: string;
  runId?: string;
  tenantId?: string;
  status?: string;
  alreadyActive?: boolean;
  /** Access Code contract: 'created' = the submitted code was written to the
   *  customer env; 'retained' = an existing APP_PASS was kept (recovery) — the
   *  submitted code is NOT valid and must never be shown as such. */
  appPassState?: 'created' | 'retained';
}

export async function startProvision(req: ProvisionStartRequest): Promise<ProvisionStartResponse> {
  const res = await fetch('/api/provisioning/start', {
    method: 'POST',
    headers: await sessionHeaders(),
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as ProvisionStartResponse;
  if (body.ok && !body.alreadyActive && body.appPassState !== 'created' && body.appPassState !== 'retained') {
    return { ok: false, reason: 'APP_PASS handoff contract error: missing or unknown appPassState' };
  }
  return body;
}

export async function confirmSmoke(tenantId: string): Promise<{ ok: boolean; status?: string; alreadyActive?: boolean; reason?: string; retryable?: boolean }> {
  const res = await fetch('/api/provisioning/confirm', {
    method: 'POST',
    headers: await sessionHeaders(),
    body: JSON.stringify({ tenantId }),
  });
  return (await res.json()) as { ok: boolean; status?: string; alreadyActive?: boolean; reason?: string; retryable?: boolean };
}

export interface ProvisionStatusResponse {
  ok: boolean;
  status?: 'draft' | 'provisioning' | 'waiting_smoke' | 'active' | 'failed' | 'unknown';
  reason?: string;
  tenantStatus?: string;
  confirmationReady?: boolean;
  /** true when the reserved run is authoritatively terminal and staff may
   *  re-verify + start ONE fresh run (never set for unknown/live runs). */
  restartable?: boolean;
}

export async function fetchProvisionStatus(slug: string): Promise<ProvisionStatusResponse> {
  const res = await fetch(`/api/provisioning/status?slug=${encodeURIComponent(slug)}`, {
    headers: await sessionHeaders(),
  });
  return (await res.json()) as ProvisionStatusResponse;
}

export interface PortalHealthResponse {
  ok: boolean;
  ready: boolean;
  status?: number;
  reason?: string;
}

/** Staff-safe readiness proof through the existing authenticated server probe. */
export async function fetchPortalHealth(slug: string): Promise<PortalHealthResponse> {
  const res = await fetch(`/api/provisioning/portalHealth?slug=${encodeURIComponent(slug)}`, {
    headers: await sessionHeaders(),
  });
  return (await res.json()) as PortalHealthResponse;
}
