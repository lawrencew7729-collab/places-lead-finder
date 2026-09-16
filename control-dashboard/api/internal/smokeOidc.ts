/**
 * TEMPORARY one-off smoke route (owner-approved, retry#2 2026-09-16) — REMOVE AFTER USE.
 *
 * Chain under test:
 *   production runtime -> getVercelOidcToken() -> POST https://lf-v1011-smoke.vercel.app/api/control
 *   -> read the JSON BODY (the real Customer Management backend must do this) -> return a FIXED small JSON
 *
 * The upstream body is NOT forwarded. The OIDC token is never returned, echoed or logged.
 * Trace carries stage NAMES only (plus a body LENGTH), never token material.
 */
import { getVercelOidcToken } from '@vercel/oidc';

export const config = { runtime: 'nodejs' };

const TARGET = 'https://lf-v1011-smoke.vercel.app/api/control';
const FETCH_TIMEOUT_MS = 8000;
const BODY_TIMEOUT_MS = 5000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function safeErr(e: unknown): string {
  const err = e as { name?: string; message?: string };
  return (err?.name ?? 'Error') + ':' + String(err?.message ?? e ?? 'unknown').slice(0, 80);
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
  if (!token) return json({ pass: false, upstreamStatus: 0, trace, error: 'oidc_token_absent' });

  const ac = new AbortController();
  const acTimer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    step('before_fetch_smoke');
    upstream = await fetch(TARGET, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'STATUS' }),
      signal: ac.signal,
    });
    step('after_fetch_smoke:' + upstream.status);
  } catch (e) {
    clearTimeout(acTimer);
    const aborted = (e as { name?: string })?.name === 'AbortError';
    step('catch:' + (aborted ? 'SMOKE_UPSTREAM_TIMEOUT' : 'smoke_fetch_failed'));
    return json({ pass: false, upstreamStatus: 0, trace, error: aborted ? 'SMOKE_UPSTREAM_TIMEOUT' : 'smoke_fetch_failed:' + safeErr(e) }, aborted ? 504 : 502);
  }
  clearTimeout(acTimer);

  // BODY READ — the real Customer Management backend must be able to do this too.
  let bodyLength = -1;
  let ok = false;
  let portalError: string | null = null;
  try {
    step('before_body_read');
    const read = await Promise.race([
      upstream.text().then((t) => ({ kind: 'text' as const, t })),
      new Promise<{ kind: 'timeout' }>((res) => setTimeout(() => res({ kind: 'timeout' }), BODY_TIMEOUT_MS)),
    ]);
    if (read.kind === 'timeout') {
      step('body_read_timeout');
      return json({ pass: false, upstreamStatus: upstream.status, trace, error: 'BODY_READ_TIMEOUT' }, 504);
    }
    bodyLength = read.t.length;
    step('after_body_read:length=' + bodyLength);
    try {
      const parsed = JSON.parse(read.t) as { ok?: boolean; error?: string };
      ok = upstream.status === 200 && parsed?.ok === true;
      portalError = ok ? null : (parsed?.error ?? 'non_json_upstream');
    } catch {
      portalError = 'body_not_json';
    }
  } catch (e) {
    step('catch:body_read_failed');
    return json({ pass: false, upstreamStatus: upstream.status, trace, error: 'body_read_failed:' + safeErr(e) }, 502);
  }

  step('done:pass=' + ok);
  // FIXED small JSON — the upstream body is deliberately NOT forwarded.
  return json({ pass: ok, upstreamStatus: upstream.status, bodyLength, trace, error: portalError });
}
