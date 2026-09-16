/**
 * TEMPORARY one-off smoke route (owner-approved, retry 2026-09-16) — REMOVE AFTER USE.
 *
 * Proves the REAL production identity chain of lf-control-dashboard:
 *   production runtime -> getVercelOidcToken() -> POST https://lf-v1011-smoke.vercel.app/api/control
 *
 * DIAGNOSTIC BUILD: staged trace + 8s hard AbortController timeout on the
 * outbound call, so a stall can never again return "nothing at all".
 * The OIDC token is NEVER returned, echoed or logged — only its presence flag.
 * The trace contains stage NAMES and an HTTP status; no headers, no token,
 * no token payload, no upstream body beyond the portal's non-secret state.
 */
import { getVercelOidcToken } from '@vercel/oidc';

export const config = { runtime: 'nodejs' };

const TARGET = 'https://lf-v1011-smoke.vercel.app/api/control';
const UPSTREAM_TIMEOUT_MS = 8000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** Safe error summary: name + first 80 chars of message, no token material. */
function safeErr(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const msg = String(err?.message ?? e ?? 'unknown').slice(0, 80);
  return (err?.name ?? 'Error') + ':' + msg;
}

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
  const trace: string[] = [];
  const step = (s: string) => { trace.push(s); console.log('[smokeOidc] ' + s); };

  step('route_enter');

  let token: string | undefined;
  try {
    step('before_get_oidc');
    token = await getVercelOidcToken();
    step('after_get_oidc:tokenPresent=' + Boolean(token));
  } catch (e) {
    step('catch:oidc_mint_failed');
    return json({ pass: false, upstreamStatus: 0, trace, error: 'oidc_mint_failed:' + safeErr(e) });
  }
  if (!token) {
    step('catch:oidc_token_absent');
    return json({ pass: false, upstreamStatus: 0, trace, error: 'oidc_token_absent' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    step('before_fetch_smoke');
    upstream = await fetch(TARGET, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'STATUS' }),
      signal: controller.signal,
    });
    step('after_fetch_smoke:' + upstream.status);
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as { name?: string })?.name === 'AbortError';
    step('catch:' + (aborted ? 'SMOKE_UPSTREAM_TIMEOUT' : 'smoke_fetch_failed'));
    return json(
      { pass: false, upstreamStatus: 0, trace, error: aborted ? 'SMOKE_UPSTREAM_TIMEOUT' : 'smoke_fetch_failed:' + safeErr(e) },
      aborted ? 504 : 502,
    );
  }
  clearTimeout(timer);

  const text = await upstream.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const ok = upstream.status === 200 && (parsed as { ok?: boolean } | null)?.ok === true;
  step('done:ok=' + ok);
  return json({
    pass: ok,
    upstreamStatus: upstream.status,
    trace,
    state: safeState(parsed),
    error: ok ? null : ((parsed as { error?: string } | null)?.error ?? 'non_json_upstream'),
  });
}
