/**
 * TEMPORARY one-off smoke route (owner-approved 2026-09-16) — REMOVE AFTER USE.
 *
 * Proves the REAL production identity chain of lf-control-dashboard:
 *   production runtime -> getVercelOidcToken() -> POST https://lf-v1011-smoke.vercel.app/api/control
 *
 * The OIDC token is held in server memory only: it is NEVER returned, echoed,
 * logged, or written anywhere. The response carries only:
 *   pass, upstreamStatus, the portal's non-secret state summary, and a safe error code.
 */
import { getVercelOidcToken } from '@vercel/oidc';

export const config = { runtime: 'nodejs' };

const TARGET = 'https://lf-v1011-smoke.vercel.app/api/control';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** Only the non-secret fields of the portal STATUS reply are ever surfaced. */
function safeState(body: unknown) {
  const st = (body as { state?: Record<string, unknown> } | null)?.state;
  if (!st) return null;
  return {
    portalVersion: st.portalVersion ?? null,
    package: st.package ?? null,
    serviceStatus: st.serviceStatus ?? null,
    usage: st.usage ?? null,
    searchStop: st.searchStop ?? null,
  };
}

export default async function handler(req: Request): Promise<Response> {
  let token: string;
  try {
    token = await getVercelOidcToken();
  } catch (e) {
    return json({ pass: false, upstreamStatus: 0, error: 'oidc_mint_failed' });
  }
  if (!token) return json({ pass: false, upstreamStatus: 0, error: 'oidc_token_absent' });

  let upstream: Response;
  try {
    upstream = await fetch(TARGET, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'STATUS' }),
    });
  } catch (e) {
    return json({ pass: false, upstreamStatus: 0, error: 'upstream_unreachable' });
  }
  const text = await upstream.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const ok = upstream.status === 200 && (parsed as { ok?: boolean } | null)?.ok === true;
  return json({
    pass: ok,
    upstreamStatus: upstream.status,
    state: safeState(parsed),
    error: ok ? null : ((parsed as { error?: string } | null)?.error ?? 'non_json_upstream'),
  });
}
