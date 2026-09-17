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
    expect(stop.body.state).toMatchObject({ serviceStatus: 'STOPPED', portalVersion: '1.0.12' });
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

  it('STATUS is read-only and returns ONLY the agreed fields (incl. month-selection facts)', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' }) };
    const before = JSON.stringify(store);
    const res = await call(store, { token: sign(goodClaims()), action: 'STATUS' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body.state).sort()).toEqual(['ceiling', 'devices', 'maxDevices', 'month', 'package', 'packageLabel', 'packageMonth', 'packageSelectableThisMonth', 'portalVersion', 'searchStop', 'serviceStatus', 'usage']);
    expect(res.body.state).toMatchObject({ month: '2026-09', packageMonth: '2026-09', packageSelectableThisMonth: false });
    expect(JSON.stringify(store)).toBe(before);   // zero mutation
  });

  it('a FRESH customer (nothing written yet) is reported as selectable for this month', async () => {
    const store = {};
    const res = await call(store, { token: sign(goodClaims()), action: 'STATUS' });
    expect(res.body.state).toMatchObject({ package: 'STARTER_500', packageMonth: null, packageSelectableThisMonth: true, month: '2026-09' });
  });

  it('NEW MONTH: SELECT_STARTER_500 chooses 500 for the new month, preserves service, and stamps the month', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'ACTIVE', packageMonth: '2026-08' }) };
    const res = await call(store, { token: sign(goodClaims()), action: 'SELECT_STARTER_500' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'SELECT_STARTER_500' });
    expect(res.body.state).toMatchObject({ package: 'STARTER_500', serviceStatus: 'ACTIVE', searchStop: 500, packageMonth: '2026-09', packageSelectableThisMonth: false });
    const persisted = JSON.parse(store[`tenant:${TENANT}:config`]);
    expect(persisted).toMatchObject({ package: 'STARTER_500', serviceStatus: 'ACTIVE', packageMonth: '2026-09' });
    expect(persisted.updatedBy).toContain('dashboard');
  });

  it('THIS MONTH ALREADY 900: 500 is REFUSED server-side and nothing is written (no 900 -> 500 inside a month)', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'ACTIVE', packageMonth: '2026-09' }) };
    const before = JSON.stringify(store);
    const res = await call(store, { token: sign(goodClaims()), action: 'SELECT_STARTER_500' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'package_already_selected_this_month', reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' });
    expect(res.body.state).toMatchObject({ package: 'FULL_900', packageMonth: '2026-09', packageSelectableThisMonth: false });
    expect(JSON.stringify(store)).toBe(before);   // refused action never mutates
  });

  it('THIS MONTH ALREADY 500: the mid-month UPGRADE to 900 is the one allowed package change', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'STARTER_500', serviceStatus: 'ACTIVE', packageMonth: '2026-09' }) };
    const res = await call(store, { token: sign(goodClaims()), action: 'UPGRADE_TO_FULL_900' });
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toMatchObject({ package: 'FULL_900', serviceStatus: 'ACTIVE', searchStop: 900, packageMonth: '2026-09', packageSelectableThisMonth: false });
    // ...and after the upgrade the month is closed for the 500 selection
    const again = await call(store, { token: sign(goodClaims()), action: 'SELECT_STARTER_500' });
    expect(again.statusCode).toBe(409);
  });

  it('PRE-v1.0.12 CONFIG (no packageMonth): the month of its last change counts as chosen — 500 stays locked that month', async () => {
    const store = { [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'ACTIVE', updatedAt: '2026-09-10T00:00:00.000Z' }) };
    const before = JSON.stringify(store);
    const res = await call(store, { token: sign(goodClaims()), action: 'SELECT_STARTER_500' });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(store)).toBe(before);
  });

  it('rejects unknown / owner-only / removed actions (no delete, no limit editing, no arbitrary setter, no DOWNGRADE)', async () => {
    for (const action of ['DELETE_CUSTOMER', 'SET_LIMIT', 'CHANGE_GOLDEN', 'SET_PACKAGE', 'DOWNGRADE_TO_STARTER_500', 'nonsense']) {
      const res = await call({}, { token: sign(goodClaims()), action });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('unsupported_action');
    }
  });
});

/* ── month boundary walk-through ─────────────────────────────────────────── */
/** A dashboard token that is valid AT the simulated moment. */
const tokenAt = (when) => {
  const s = Math.floor(new Date(when).getTime() / 1000);
  return sign(goodClaims({ iat: s - 60, nbf: s - 60, exp: s + 300 }));
};
/**
 * Call the handler AT a simulated moment. The harness tokens are only valid at
 * NOW, so a caller-provided token is used when it is still valid at `now`,
 * otherwise a fresh one is minted for that moment (the month walk crosses
 * months, which would otherwise just test JWT expiry).
 */
const callAt = async (store, { token, action = 'STATUS', body = {}, now = NOW } = {}) => {
  const handler = createControlHandler({
    redis: fakeRedis(store), tenantId: TENANT, now: () => now, getJwks: async () => JWKS,
  });
  const res = fakeRes();
  const valid = (() => {
    if (!token) return false;
    try {
      const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
      return Number(claims.exp) > Math.floor(new Date(now).getTime() / 1000);
    } catch (e) { return false; }
  })();
  const useToken = valid ? token : tokenAt(now);
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' + useToken }, body: { action, ...body } }, res);
  return res;
};
const at = (iso) => new Date(iso);
const stored = (store) => JSON.parse(store[`tenant:${TENANT}:config`]);

describe('LEGACY CONFIG ACROSS THE MONTH BOUNDARY (owner-required proof)', () => {
  // A customer upgraded to FULL_900 in September, BEFORE v1.0.12 introduced
  // packageMonth. There is no explicit month in the config, so the month of its
  // last state change is what counts as "already chosen" — the SAFE direction
  // (a paying 900 customer can never be dropped to 500 in that same month).
  const seed = () => ({
    [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'ACTIVE', updatedAt: '2026-09-17T04:00:00.000Z' }),
  });

  it('9/30 locked -> 10/1 reopens -> 10月选900 locks October -> 11/1 reopens again', async () => {
    const store = seed();
    const token = sign(goodClaims());

    // --- 9/30: the month of the last change (2026-09) counts as chosen → 500 locked
    const sep = await callAt(store, { token, action: 'STATUS', now: at('2026-09-30T18:00:00Z') });
    expect(sep.body.state).toMatchObject({ month: '2026-09', packageMonth: '2026-09', packageSelectableThisMonth: false });
    const sepTry = await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-09-30T18:00:00Z') });
    expect(sepTry.statusCode).toBe(409);
    expect(stored(store).package).toBe('FULL_900');           // refused action wrote NOTHING
    expect(stored(store).packageMonth).toBeUndefined();        // still the legacy config

    // --- 10/1: a NEW month → both packages open again (no staff action needed)
    const oct = await callAt(store, { token, action: 'STATUS', now: at('2026-10-01T18:00:00Z') });
    expect(oct.body.state).toMatchObject({ month: '2026-10', packageMonth: '2026-09', packageSelectableThisMonth: true });

    // --- October chooses 900 → 500 locked for the WHOLE of October
    const octUp = await callAt(store, { token, action: 'UPGRADE_TO_FULL_900', now: at('2026-10-01T18:05:00Z') });
    expect(octUp.statusCode).toBe(200);
    expect(octUp.body.state).toMatchObject({ package: 'FULL_900', packageMonth: '2026-10', packageSelectableThisMonth: false });
    expect(stored(store).packageMonth).toBe('2026-10');        // now explicit
    const octTry = await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-10-20T18:00:00Z') });
    expect(octTry.statusCode).toBe(409);
    const octLate = await callAt(store, { token, action: 'STATUS', now: at('2026-10-31T23:00:00Z') });
    expect(octLate.body.state).toMatchObject({ month: '2026-10', packageSelectableThisMonth: false });

    // --- 11/1: reopens; this month the customer wants 500
    const novFirst = await callAt(store, { token, action: 'STATUS', now: at('2026-11-01T18:00:00Z') });
    expect(novFirst.body.state).toMatchObject({ month: '2026-11', packageSelectableThisMonth: true });
    const novSel = await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-11-01T18:01:00Z') });
    expect(novSel.statusCode).toBe(200);
    expect(novSel.body.state).toMatchObject({ package: 'STARTER_500', searchStop: 500, packageMonth: '2026-11', packageSelectableThisMonth: false });
    expect(stored(store)).toMatchObject({ package: 'STARTER_500', packageMonth: '2026-11' });
  });

  it('a 500 customer upgraded mid-month keeps 900 for that month and only reopens for 500 next month', async () => {
    const store = {};
    const token = sign(goodClaims());
    const sel = await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-10-02T18:00:00Z') });
    expect(sel.statusCode).toBe(200);
    expect(sel.body.state).toMatchObject({ package: 'STARTER_500', packageMonth: '2026-10' });
    const up = await callAt(store, { token, action: 'UPGRADE_TO_FULL_900', now: at('2026-10-15T18:00:00Z') });
    expect(up.statusCode).toBe(200);
    expect(up.body.state).toMatchObject({ package: 'FULL_900', packageMonth: '2026-10' });
    expect((await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-10-16T18:00:00Z') })).statusCode).toBe(409);
    expect((await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-11-02T18:00:00Z') })).statusCode).toBe(200);
  });

  it('OWNER CASE: legacy FULL_900/updatedAt=Sep -> 10/1 STOP freezes packageMonth=2026-09, so October stays open and 500 can still be chosen', async () => {
    const store = seed();
    const token = sign(goodClaims());
    // 10/1: staff press STOP BEFORE choosing this month's package
    const stop = await callAt(store, { token, action: 'STOP', now: at('2026-10-01T18:00:00Z') });
    expect(stop.statusCode).toBe(200);
    expect(stop.body.state).toMatchObject({ serviceStatus: 'STOPPED', packageMonth: '2026-09', packageSelectableThisMonth: true });
    // the FIRST write pinned the month from the OLD updatedAt (2026-09)...
    expect(stored(store)).toMatchObject({ packageMonth: '2026-09', serviceStatus: 'STOPPED' });
    // ...even though the write itself moved updatedAt into October
    expect(stored(store).updatedAt).toBe('2026-10-01T18:00:00.000Z');
    // October is therefore STILL open for the monthly selection
    const status = await callAt(store, { token, action: 'STATUS', now: at('2026-10-01T18:05:00Z') });
    expect(status.body.state).toMatchObject({ month: '2026-10', packageMonth: '2026-09', packageSelectableThisMonth: true });
    const sel = await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-10-01T18:06:00Z') });
    expect(sel.statusCode).toBe(200);
    expect(sel.body.state).toMatchObject({ package: 'STARTER_500', searchStop: 500, packageMonth: '2026-10', packageSelectableThisMonth: false });
  });

  it('OWNER CASE (RESUME variant): 10/1 STOP then 10/2 RESUME — the month is still open for selection', async () => {
    const store = seed();
    const token = sign(goodClaims());
    await callAt(store, { token, action: 'STOP', now: at('2026-10-01T18:00:00Z') });
    const resume = await callAt(store, { token, action: 'RESUME', now: at('2026-10-02T18:00:00Z') });
    expect(resume.statusCode).toBe(200);
    expect(resume.body.state).toMatchObject({ serviceStatus: 'ACTIVE', packageMonth: '2026-09', packageSelectableThisMonth: true });
    expect((await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-10-02T18:01:00Z') })).statusCode).toBe(200);
  });

  it('the freeze never OPENS the current month: legacy Sep config + a Sep STOP stays locked in September', async () => {
    const store = seed();
    const token = sign(goodClaims());
    const stop = await callAt(store, { token, action: 'STOP', now: at('2026-09-20T18:00:00Z') });
    expect(stop.body.state).toMatchObject({ packageMonth: '2026-09', packageSelectableThisMonth: false });
    expect((await callAt(store, { token, action: 'SELECT_STARTER_500', now: at('2026-09-21T18:00:00Z') })).statusCode).toBe(409);
  });
});

describe('DEVICE SLOTS — staff clear + immediate revocation', () => {
  const DEVICES_KEY = `tenant:${TENANT}:devices`;
  const withDevices = () => ({
    [DEVICES_KEY]: JSON.stringify({ devices: [
      { id: 'd-aaaaaa1111', label: 'Edge · Windows', firstSeen: 1, lastSeen: 2 },
      { id: 'd-bbbbbb2222', label: 'Chrome · macOS', firstSeen: 3, lastSeen: 4 },
    ] }),
  });

  it('STATUS lists the device slots (labels + full id for the hover; still zero mutation)', async () => {
    const store = withDevices();
    const before = JSON.stringify(store);
    const res = await call(store, { token: sign(goodClaims()), action: 'STATUS' });
    expect(res.body.state.devices.map((d) => d.label)).toEqual(['Edge · Windows', 'Chrome · macOS']);
    expect(res.body.state.devices.map((d) => d.id)).toEqual(['d-aaaaaa1111', 'd-bbbbbb2222']);
    expect(res.body.state.maxDevices).toBe(2);
    expect(JSON.stringify(store)).toBe(before);
  });

  it('CLEAR_DEVICE removes ONE slot by id and reports only the non-secret suffix', async () => {
    const store = withDevices();
    const res = await callAt(store, { token: sign(goodClaims()), action: 'CLEAR_DEVICE', body: { deviceId: 'd-aaaaaa1111' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'CLEAR_DEVICE', removedDeviceSuffix: 'aa1111', removedDeviceLabel: 'Edge · Windows' });
    expect(res.body.state.devices.map((d) => d.id)).toEqual(['d-bbbbbb2222']);
    expect(JSON.parse(store[DEVICES_KEY]).devices).toHaveLength(1);
  });

  it('CLEAR_DEVICE can also target a slot index (dashboard [x] on slot 2)', async () => {
    const store = withDevices();
    const res = await callAt(store, { token: sign(goodClaims()), action: 'CLEAR_DEVICE', body: { deviceIndex: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.body.state.devices.map((d) => d.id)).toEqual(['d-aaaaaa1111']);
  });

  it('an unknown device is refused (409) and the registry is untouched', async () => {
    const store = withDevices();
    const before = JSON.stringify(store);
    const res = await callAt(store, { token: sign(goodClaims()), action: 'CLEAR_DEVICE', body: { deviceId: 'd-nope' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('device_not_found');
    expect(JSON.stringify(store)).toBe(before);
  });

  it('a CLEAR_DEVICE without any device target is a 400 (never a blind wipe)', async () => {
    const store = withDevices();
    const res = await callAt(store, { token: sign(goodClaims()), action: 'CLEAR_DEVICE', body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('missing_device');
    expect(JSON.parse(store[DEVICES_KEY]).devices).toHaveLength(2);
  });

  it('clearing a device never touches the package or the service state', async () => {
    const store = { ...withDevices(), [`tenant:${TENANT}:config`]: JSON.stringify({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' }) };
    const res = await callAt(store, { token: sign(goodClaims()), action: 'CLEAR_DEVICE', body: { deviceId: 'd-bbbbbb2222' } });
    expect(res.body.state).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' });
    expect(JSON.parse(store[`tenant:${TENANT}:config`])).toMatchObject({ package: 'FULL_900', serviceStatus: 'STOPPED', packageMonth: '2026-09' });
  });
});
