import { describe, expect, it } from 'vitest';
import { createUsageHandler, DEFAULT_MONITORING_SA } from '../api/usage.js';

function fakeRes() {
  const out = { headers: {}, body: null, statusCode: 200 };
  return {
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
    __out: out,
  };
}

function makeFetchScript() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = String(url);
    if (u.includes('sts.googleapis.com')) {
      if (init && init.body && String(init.body).includes('fail_sts')) {
        return { ok: false, status: 403, json: async () => ({ error: 'invalid_grant' }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'sts-token-fake' }) };
    }
    if (u.includes('monitoring.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ timeSeries: [
        { points: [{ value: { int64Value: '733' } }, { value: { doubleValue: 77 } }] },
      ] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const OIDC = 'fake-vercel-oidc-token';

describe('R1 REVISED SHARED MONITORING AUTH — Vercel OIDC -> WIF -> central SA', () => {
  it('no user-managed service-account credential is required by the new candidate (source check)', async () => {
    const source = (await import('../api/usage.js?raw')).default;
    expect(source).not.toContain('process.env.SERVICE_ACCOUNT_JSON');
    expect(source).not.toContain('private_key');
    expect(source).not.toContain('client_email');
  });

  it('success path: OIDC token -> STS exchange -> Monitoring -> {used, cap}', async () => {
    const { fetchImpl, calls } = makeFetchScript();
    const handler = createUsageHandler({
      oidcTokenProvider: async () => OIDC,
      fetchImpl,
      wifAudience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/lf-vercel/providers/vercel',
      monthlyTarget: 1000,
      monitoringSa: DEFAULT_MONITORING_SA,
    });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({}, res);
    expect(res.__out.statusCode).toBe(200);
    expect(res.__out.body.used).toBe(810); // 733 + 77
    expect(res.__out.body.cap).toBe(1000);
    expect(res.__out.body.source).toBe('monitoring');
    // STS call shape (form-encoded; Google STS uses camelCase parameters)
    const sts = calls.find((c) => String(c.url).includes('sts.googleapis.com'));
    expect(sts).toBeTruthy();
    const body = String(sts.init.body);
    expect(body).toContain('grantType=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange');
    expect(body).toContain('subjectTokenType=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Ajwt');
    expect(body).toContain('subjectToken=' + OIDC);
    expect(body).toContain('audience=');
    expect(body).toContain('serviceAccount=' + encodeURIComponent(DEFAULT_MONITORING_SA));
    expect(body).toContain('scope=' + encodeURIComponent('https://www.googleapis.com/auth/monitoring.read'));
    // Monitoring call authenticated with the impersonated token
    const mon = calls.find((c) => String(c.url).includes('monitoring.googleapis.com'));
    expect(mon.init.headers.Authorization).toBe('Bearer sts-token-fake');
    expect(String(mon.url)).toContain('lf-t1-sbx-563bfb5f/timeSeries');
    expect(String(mon.url)).toContain('serviceruntime.googleapis.com%2Fapi%2Frequest_count');
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('missing WIF_AUDIENCE = 503 not_configured (fail closed)', async () => {
    const { fetchImpl } = makeFetchScript();
    const handler = createUsageHandler({ oidcTokenProvider: async () => OIDC, fetchImpl, wifAudience: '', monthlyTarget: 1000 });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({}, res);
    expect(res.__out.statusCode).toBe(503);
    expect(res.__out.body.used).toBeNull();
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('OIDC token provider failure = 503 oidc_unavailable (fail closed)', async () => {
    const { fetchImpl } = makeFetchScript();
    const handler = createUsageHandler({
      oidcTokenProvider: async () => { throw new Error('no oidc'); },
      fetchImpl,
      wifAudience: 'aud',
      monthlyTarget: 1000,
    });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({}, res);
    expect(res.__out.statusCode).toBe(503);
    expect(res.__out.body.error).toBe('oidc_unavailable');
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('no OIDC token returned = 503 not_configured (fail closed)', async () => {
    const { fetchImpl } = makeFetchScript();
    const handler = createUsageHandler({ oidcTokenProvider: async () => null, fetchImpl, wifAudience: 'aud', monthlyTarget: 1000 });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({}, res);
    expect(res.__out.statusCode).toBe(503);
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });

  it('STS failure = 500, used null (fail closed), no secret leakage in response', async () => {
    const { fetchImpl } = makeFetchScript();
    const handler = createUsageHandler({
      oidcTokenProvider: async () => OIDC,
      fetchImpl,
      wifAudience: 'aud_fail_sts',
      monthlyTarget: 1000,
    });
    process.env.CUSTOMER_GOOGLE_PROJECT_ID = 'lf-t1-sbx-563bfb5f';
    const res = fakeRes();
    await handler({}, res);
    expect(res.__out.statusCode).toBe(500);
    expect(res.__out.body.used).toBeNull();
    const serialized = JSON.stringify(res.__out.body);
    expect(serialized).not.toContain(OIDC);
    expect(serialized).not.toContain('sts-token-fake');
    expect(serialized).not.toContain('fake-vercel');
    delete process.env.CUSTOMER_GOOGLE_PROJECT_ID;
  });
});
