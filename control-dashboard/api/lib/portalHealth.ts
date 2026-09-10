/**
 * FINAL STAFF UX (2026-09-07) — REAL portal-ready probe.
 *
 * Bounded server-side HTTPS check of the customer portal. The browser cannot
 * probe cross-origin (no CORS on the customer app), so staff-side "PORTAL
 * READY" is decided here. 100% on the progress card is ONLY this: the portal
 * is openable/testable — never ACTIVE (ACTIVE comes from tenants.status after
 * finalize).
 *
 * Marker: HTTP 200 + the real customer-app shell. customer-app v1.0.10 is a
 * Vite vanilla-DOM build (NOT a React-root app): it emits `<div id="splash">`
 * in the initial server HTML (pre-login loading splash). A Vercel
 * DEPLOYMENT_NOT_FOUND / not-ready page does not contain it.
 */
export interface PortalProbeResult {
  ok: boolean;
  ready: boolean;
  status?: number;
  reason?: string;
}

export async function probeCustomerPortal(hostname: string, opts: { timeoutMs?: number } = {}): Promise<PortalProbeResult> {
  const base = `https://${hostname}`;
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(base + '/', { signal: controller.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: true, ready: false, status: res.status, reason: `HTTP ${res.status}` };
    const text = await res.text().catch(() => '');
    const ready = text.includes('id="splash"') && text.includes('<html');
    return { ok: true, ready, status: 200 };
  } catch (err) {
    return { ok: false, ready: false, reason: err instanceof Error ? err.message : 'portal probe failed' };
  }
}
