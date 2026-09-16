import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createControlHandler } from '../api/control.js';
import {
  OIDC_ISSUER, OIDC_AUDIENCE, CONTROL_PROJECT_ID, CONTROL_OWNER_ID, JWKS_URL,
} from '../api/controlAuth.js';

const TENANT = 't-control';
const NOW = new Date('2026-09-16T04:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

// --- a REAL RSA keypair stands in for the Vercel team signing key ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' };
const JWKS = { keys: [JWK] };
const { publicKey: otherPub, privateKey: otherPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_JWK = { ...otherPub.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' };

function sign(claims, key = privateKey, header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' }) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = b(header) + '.' + b(claims);
  return input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
}

const goodClaims = (over = {}) => ({
  iss: OIDC_ISSUER, aud: OIDC_AUDIENCE, project_id: CONTROL_PROJECT_ID, owner_id: CONTROL_OWNER_ID,
  environment: 'production', sub: 'owner:team:project:lf-control-dashboard:environment:production',
  project: 'lf-control-dashboard', iat: nowSeconds - 60, nbf: nowSeconds - 60, exp: nowSeconds + 300,
  ...over,
});

function fakeRedis(store = {}) {
  return {
    configured: () => true,
    get: async (k) => (k in store ? store[k] : null),
    set: async (k, v) => { store[k] = v; return 'OK'; },
    del: async () => 1, incrby: async () => 0, expire: async () => 1, eval: async (s, k, a) => a[0],
  };
}

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function make(store = {}) {
  const redis = fakeRedis(store);
  const handler = createControlHandler({ redis, tenantId: TENANT, now: () => NOW, getJwks: async () => JWKS });
  return { handler, redis, store };
}

const call = async (store, { token, action = 'STATUS', method = 'POST' } = {}) => {
  const { handler } = make(store);
  const res = fakeRes();
  await handler({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body: { action } }, res);
  return res;
};

describe('D. control endpoint security — Vercel OIDC pins (fail closed 401)', () => {
  it('ACCEPTS a correctly signed PRODUCTION dashboard token', async () => {
    const res = await call({}, { token: sign(goodClaims()), action: 'STATUS' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('REJECTS a token from another project (cross-customer escalation guard)', async () => {
    const res = await call({}, { token: sign(goodClaims({ project_id: 'prj_SOME_OTHER_CUSTOMER' })), action: 'STATUS' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('project_id_mismatch');
  });

  it('REJECTS a development-environment token', async () => {
    const res = await call({}, { token: sign(goodClaims({ environment: 'development' })), action: 'STATUS' });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('environment_mismatch');
  });

  it('REJECTS wrong issuer / wrong audience / wrong owner', async () => {
    expect((await call({}, { token: sign(goodClaims({ iss: 'https://oidc.vercel.com/attacker' })) })).body.error).toBe('issuer_mismatch');
    expect((await call({}, { token: sign(goodClaims({ aud: 'https://vercel.com/attacker' })) })).body.error).toBe('audience_mismatch');
    expect((await call({}, { token: sign(goodClaims({ owner_id: 'team_attacker' })) })).body.error).toBe('owner_id_mismatch');
  });

  it('REJECTS a token signed by the WRONG key (same kid) and an unknown kid', async () => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = b({ alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' }) + '.' + b(goodClaims());
    const forged = input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), otherPriv).toString('base64url');
    expect((await call({}, { token: forged })).body.error).toBe('bad_signature');
    expect((await call({}, { token: sign(goodClaims(), privateKey, { alg: 'RS256', kid: 'other-kid' }) })).body.error).toBe('unknown_key');
    expect(OTHER_JWK.kid).toBe('test-kid-1');
  });

  it('REJECTS expired, not-yet-valid, malformed and alg=none tokens', async () => {
    expect((await call({}, { token: sign(goodClaims({ exp: nowSeconds - 7200 })) })).body.error).toBe('token_expired');
    expect((await call({}, { token: sign(goodClaims({ nbf: nowSeconds + 7200, exp: nowSeconds + 9000 })) })).body.error).toBe('token_not_yet_valid');
    expect((await call({}, { token: 'not.a.jwt' })).body.error).toBe('malformed_token');
    expect((await call({}, { token: 'a.b' })).body.error).toBe('malformed_token');
    const noneTok = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-kid-1' })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify(goodClaims())).toString('base64url') + '.';
    expect((await call({}, { token: noneTok })).body.error).toBe('malformed_token');
    // same attack with a non-empty (dummy) signature segment reaches the alg pin
    const noneTok2 = noneTok + 'AAAA';
    const res2 = await call({}, { token: noneTok2 });
    expect(res2.statusCode).toBe(401);
    expect(res2.body.error).toBe('unsupported_alg');
  });

  it('REJECTS missing bearer, GET, and unavailable JWKS', async () => {
    expect((await call({}, { token: null })).body.error).toBe('missing_bearer_token');
    expect((await call({}, { token: sign(goodClaims()), method: 'GET' })).statusCode).toBe(405);
    const redis = fakeRedis({});
    const h = createControlHandler({ redis, tenantId: TENANT, now: () => NOW, getJwks: async () => { throw new Error('jwks down'); } });
    const res = fakeRes();
    await h({ method: 'POST', headers: { authorization: 'Bearer ' + sign(goodClaims()) }, body: { action: 'STATUS' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('jwks_unavailable');
  });

  it('JWKS url is the team endpoint (no per-project verification secret)', () => {
    expect(JWKS_URL).toBe('https://oidc.vercel.com/lawrencew7729-4682s-projects/.well-known/jwks');
  });
});

describe('control endpoint actions — state lives in THIS customer\'s own Redis', () => {
  it('STOP blocks search, keeps the portal usable, and is persisted locally', async () => {
    const store = {};
    const stop = await call(store, { token: sign(goodClaims()), action: 'STOP' });
    expect(stop.statusCode).toBe(200);
    expect(stop.body.state).toMatchObject({ serviceStatus: 'STOPPED', portalVersion: '1.0.11' });
    expect(JSON.parse(store[`tenant:${TENANT}:config`])).toMatchObject({ serviceStatus: 'STOPPED', package: 'STARTER_500' });
    expect(JSON.parse(store[`tenant:${TENANT}:config`]).updatedBy).toContain('dashboard');
  });

  it('RESUME restores ACTIVE and UPGRADE moves STARTER_500 -> FULL_900 without touching anything else', async () => {
    const store = {};
    await call(store, { token: sign(goodClaims()), action: 'STOP' });
    const up = await call(store, { token: sign(goodClaims()), action: 'UPGRADE_TO_FULL_900' });
    expect(up.body.state).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED' });   // upgrade does not resume
    const res = await call(store, { token: sign(goodClaims()), action: 'RESUME' });
    expect(res.body.state).toMatchObject({ package: 'FULL_900', serviceStatus: 'ACTIVE', searchStop: 900 });
  });

  it('STATUS is read-only and returns ONLY the agreed fields', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'STOPPED' }) };
    const before = JSON.stringify(store);
    const res = await call(store, { token: sign(goodClaims()), action: 'STATUS' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body.state).sort()).toEqual(['ceiling', 'month', 'package', 'packageLabel', 'portalVersion', 'searchStop', 'serviceStatus', 'usage']);
    expect(JSON.stringify(store)).toBe(before);   // zero mutation
  });

  it('rejects unknown / owner-only actions (no delete, no limit editing, no downgrade)', async () => {
    for (const action of ['DELETE_CUSTOMER', 'DOWNGRADE_TO_STARTER_500', 'SET_LIMIT', 'nonsense']) {
      const res = await call({}, { token: sign(goodClaims()), action });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('unsupported_action');
    }
  });
});
