/**
 * Dashboard provisioning client — portal-health route contract.
 *
 * REGRESSION (production 2026-09-08): the client previously called the kebab
 * path `/api/provisioning/portal-health`, but the deployed Vercel function is
 * `api/provisioning/portalHealth.ts` → registered route
 * `/api/provisioning/portalHealth` (filesystem case-exact). The kebab path
 * returned platform 404 while the camelCase path was live (401 unauthenticated
 * proof). The client MUST call the exact registered route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
  isSupabaseConfigured: false,
}));

import { fetchPortalHealth } from './provisioningClient';

describe('provisioningClient — portal-health route contract', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'test-op-token' } } });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetchPortalHealth requests the exact camelCase route with slug query + auth headers', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ready: true, status: 200 }) } as Response);

    const result = await fetchPortalHealth('new-dummy');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/provisioning/portalHealth?slug=new-dummy');
    expect(url).not.toContain('/portal-health');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-op-token');
    expect(headers['content-type']).toBe('application/json');
    expect(result).toEqual({ ok: true, ready: true, status: 200 });
  });

  it('does NOT request the obsolete kebab path', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ready: false }) } as Response);

    await fetchPortalHealth('abc');

    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain('/api/provisioning/portalHealth');
    expect(url).not.toBe('/api/provisioning/portal-health?slug=abc');
    expect(url).not.toContain('portal-health?');
  });

  it('preserves failure response mapping (ok:false passthrough)', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, ready: false, reason: 'probe failed' }) } as Response);

    const result = await fetchPortalHealth('new-dummy');

    expect(result).toEqual({ ok: false, ready: false, reason: 'probe failed' });
  });
});
