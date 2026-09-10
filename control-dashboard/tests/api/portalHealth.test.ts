import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCustomerPortal } from '../../api/lib/portalHealth.js';

afterEach(() => vi.unstubAllGlobals());

describe('real customer portal health probe', () => {
  it('matches the real vanilla-DOM customer-app shell (id="splash") before ready', async () => {
    // customer-app v1.0.10 is a Vite vanilla-DOM build — the initial server
    // HTML carries the pre-login splash container, NOT a React id="root".
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body><div id="splash" class="fixed inset-0 z-[60]"></div></body></html>', { status: 200 })));
    await expect(probeCustomerPortal('portal.leadfinder.business')).resolves.toMatchObject({ ok: true, ready: true, status: 200 });
  });

  it('does NOT treat a React-only id="root" page as ready (old marker regression)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body><div id="root"></div></body></html>', { status: 200 })));
    await expect(probeCustomerPortal('portal.leadfinder.business')).resolves.toMatchObject({ ok: true, ready: false, status: 200 });
  });

  it('does not treat a generic HTTP 200 page as portal ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>generic page</body></html>', { status: 200 })));
    await expect(probeCustomerPortal('portal.leadfinder.business')).resolves.toMatchObject({ ok: true, ready: false, status: 200 });
  });

  it('keeps non-success HTTP responses not ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(probeCustomerPortal('portal.leadfinder.business')).resolves.toMatchObject({ ok: true, ready: false, status: 404 });
  });
});
