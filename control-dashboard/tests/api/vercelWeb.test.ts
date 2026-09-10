/**
 * S2e Fix 1 — vercelWeb adapter tests (VercelRequest → web Request conversion).
 */
import { describe, expect, it } from 'vitest';
import { vercelRequestToWeb } from '../../api/lib/vercelWeb.js';

function fakeVercelReq(over: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/provisioning/start',
    headers: { host: 'dashboard.leadfinder.business', 'x-lf-test': '1', 'content-type': 'application/json' },
    body: { slug: 'abc' },
    query: {},
    ...over,
  } as never;
}

describe('vercelWeb adapter (S2e Fix 1)', () => {
  it('converts VercelRequest into an absolute-URL web Request', () => {
    const web = vercelRequestToWeb(fakeVercelReq());
    expect(web.url).toBe('https://dashboard.leadfinder.business/api/provisioning/start');
    expect(web.method).toBe('POST');
    expect(web.headers.get('x-lf-test')).toBe('1');
  });

  it('preserves the parsed JSON body (request body semantics unchanged)', async () => {
    const web = vercelRequestToWeb(fakeVercelReq());
    const body = (await web.json()) as { slug: string };
    expect(body.slug).toBe('abc');
  });

  it('handles GET without body (query semantics unchanged)', async () => {
    const web = vercelRequestToWeb(fakeVercelReq({ method: 'GET', url: '/api/provisioning/status?slug=x', body: undefined }));
    expect(web.method).toBe('GET');
    expect(web.url).toContain('slug=x');
    expect(await web.text()).toBe('');
  });

  // REGRESSION (production 2026-09-08): GET /api/provisioning/status 500 —
  // "Request with GET/HEAD method cannot have body." The Vercel Node launcher
  // sets req.body = null when a JSON content-type is present even on GET; the
  // bridge previously serialized it (JSON.stringify(null) === 'null') and
  // passed a body to new Request(GET, ...) which throws.
  it('GET with launcher body=null must not construct a body (500 regression)', () => {
    expect(() => vercelRequestToWeb(fakeVercelReq({ method: 'GET', url: '/api/provisioning/status?slug=new-dummy', body: null }))).not.toThrow();
    const web = vercelRequestToWeb(fakeVercelReq({ method: 'GET', url: '/api/provisioning/status?slug=new-dummy', body: null }));
    expect(web.method).toBe('GET');
    expect(web.url).toContain('slug=new-dummy');
    expect(web.headers.get('x-lf-test')).toBe('1'); // auth/headers preserved
    expect(web.body).toBeNull(); // no body carried on GET
  });

  it('GET with an unexpected parsed body object also omits the body', () => {
    const web = vercelRequestToWeb(fakeVercelReq({ method: 'GET', url: '/api/provisioning/status?slug=x', body: { slug: 'x' } }));
    expect(web.method).toBe('GET');
    expect(web.body).toBeNull();
  });

  it('HEAD request never carries a body', () => {
    expect(() => vercelRequestToWeb(fakeVercelReq({ method: 'HEAD', url: '/api/provisioning/status', body: null }))).not.toThrow();
    const web = vercelRequestToWeb(fakeVercelReq({ method: 'HEAD', url: '/api/provisioning/status', body: null }));
    expect(web.method).toBe('HEAD');
    expect(web.body).toBeNull();
  });
});
