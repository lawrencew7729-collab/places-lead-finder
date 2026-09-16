/**
 * TEMPORARY smoke-only action route (owner-approved 2026-09-16) — REMOVE AFTER USE.
 * LOCKED SCOPE: hard-coded smoke portal only, 4 actions only, no URL/tenant input,
 * no control-plane access, no customer touch. The OIDC token is never output/logged
 * and the upstream body is never forwarded.
 */
import { getVercelOidcToken } from '@vercel/oidc';
import { vercelEntry } from '../lib/vercelWeb.js';

export const config = { runtime: 'nodejs' };

const TARGET = 'https://lf-v1011-smoke.vercel.app/api/control';
const ALLOWED = ['STATUS', 'UPGRADE_TO_FULL_900', 'STOP', 'RESUME'];

export default vercelEntry(async (req: Request) => {
  const action = String(new URL(req.url).searchParams.get('action') ?? 'STATUS').toUpperCase();
  const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!ALLOWED.includes(action)) return out({ ok: false, error: 'ACTION_NOT_ALLOWED', allowed: ALLOWED }, 400);
  let token: string;
  try { token = await getVercelOidcToken(); } catch { return out({ ok: false, error: 'oidc_mint_failed' }, 500); }
  let upstream: Response;
  try {
    upstream = await fetch(TARGET, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { return out({ ok: false, error: 'upstream_unreachable' }, 502); }
  const text = await upstream.text();
  let parsed: { ok?: boolean; state?: unknown; error?: string } | null = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return out({ ok: upstream.status === 200 && parsed?.ok === true, action, upstreamStatus: upstream.status, state: parsed?.state ?? null, error: parsed?.error ?? null });
});
