/**
 * Phase 2C S2e Fix 1 — VercelRequest/VercelResponse adapter.
 *
 * LIVE runtime evidence: the web Request/Response handler shape under the
 * current Vercel Node launcher executed but lost/hung responses. The proven
 * working shape is VercelRequest/VercelResponse + explicit res.json().
 *
 * This helper converts an incoming VercelRequest into a standard web Request
 * so the existing testable business handlers (provisioningHttp) stay
 * untouched. Response bodies are JSON (all provisioning handlers return JSON).
 */
import type { VercelRequest } from '@vercel/node';

export function vercelRequestToWeb(req: VercelRequest): Request {
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'dashboard.leadfinder.business';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const url = `${proto}://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => typeof x === 'string' && headers.append(k, x));
  }
  const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
  const method = (req.method ?? 'GET').toUpperCase();
  // Web Fetch contract: GET/HEAD must never carry a body. The Vercel Node
  // launcher sets req.body = null whenever a JSON content-type is present
  // (even on GET) — forwarding it (JSON.stringify(null) === 'null') makes
  // new Request(GET, { body }) throw "Request with GET/HEAD method cannot
  // have body." (observed in production 2026-09-08 on
  // GET /api/provisioning/status). Mutating methods keep body semantics.
  const init: { method: string; headers: Headers; body?: string } = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = body;
  return new Request(url, init);
}

/** Wrap a web-handler so it can be exported as a Vercel Function entrypoint. */
export function vercelEntry(handle: (req: Request) => Promise<Response>): (req: VercelRequest, res: import('@vercel/node').VercelResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const web = vercelRequestToWeb(req);
      const response = await handle(web);
      const text = await response.text().catch(() => '');
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      res.status(response.status).json(body);
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : 'handler failed' });
    }
  };
}
