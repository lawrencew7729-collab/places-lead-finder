/* ============================================================
   Lead Finder — Device Lock API (R1 CENTRALIZED model, v1.0.4)
   一个账号最多绑定 2 台设备（hard lock）。
   老板意图：客户买一个 account 只许手机+电脑两台用，防跟同行共享。

   Identity : CUSTOMER_TENANT_ID（immutable UUID，server env）
     registry key = tenant:<CUSTOMER_TENANT_ID>:devices
     tenantId 缺失 → FAIL CLOSED（not_configured）。
     hostname 不再是身份（可 rebind/redeploy 会重置身份）。
     Legacy 部署（无此 env）保留旧版行为，不在本合约范围。

   Storage : CENTRALIZED Upstash Redis（owner-approved 2026-08-26）
     ONE central DB shared by all tenants; each customer uses its OWN
     restricted ACL REST credential (~tenant:<TENANT_ID>:* + minimal
     command allowlist). NEVER a shared/full-access token.
     env KV_REST_API_URL / KV_REST_API_TOKEN（canonical）
     或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（兼容旧命名）
     KV 缺失 → FAIL CLOSED（不降级 open mode）。

   Auth : env APP_PASS — customer access code（16-char，server 端校验）
     缺失 → register FAIL CLOSED。永不进 browser bundle / Git。

   Recovery : 无公开 reset/remove endpoint。device slot 释放 =
     OWNER-CONTROLLED ISOLATED MAINTENANCE —— 直接在 THAT customer 的
     tenant:<tenantId>:devices 记录上操作。
     无 central shared reset secret。无 browser-accessible admin 机制。

   No automatic eviction : registry 无 TTL；slot 只由 owner 显式释放。

   Probe (provisioning readiness) : mode=probe 返回布尔型锁定状态
     （locked/open/unconfigured · maxDevices · kvConfigured ·
     appPassConfigured · tenantIdConfigured）— 不含任何 secret 值。
   ============================================================ */
import { redisClient, tenantDevicesKey } from './redis.js';

export const MAX_DEVICES = 2;          // 一账号 2 台设备

/* ============================================================
   DEMO BUILD — SALESMAN DEMO ONLY (branch: demo-salesman)

   This branch is deployed ONLY to the apex leadfinder.business demo portal
   so that an unlimited number of sales staff can log in from any device.

   WHAT IT CHANGES (and nothing else):
     - an unknown device is ALLOWED (no 2-slot registry limit is enforced)
     - the search path does not require this device to hold a slot
   WHAT IT DOES NOT CHANGE:
     - APP_PASS is still required to log in (no anonymous access)
     - the device registry is still recorded/visible for staff reporting
     - the Golden release (tag customer-app-v1.0.12) is untouched

   NEVER merge this into a Golden release. A real customer portal must keep the
   2-device contract.
   ============================================================ */
export const DEMO_UNLIMITED_DEVICES = true;

/** Immutable registry identity. Missing tenant id → fail closed. */
function accountKey() {
  const tid = process.env.CUSTOMER_TENANT_ID;
  if (!tid) return null;
  return tenantDevicesKey(tid);
}

function notConfigured(res) {
  return res.json({ allowed: false, reason: 'not_configured' });
}

async function kvGet(key, redis) {
  const j = await redis.get(key);
  return j ? JSON.parse(j) : null;
}

async function kvSet(key, value, redis) {
  // No TTL: registry persists until an explicit owner release (no automatic eviction).
  await redis.set(key, JSON.stringify(value));
}

function labelFromUA(ua = '') {
  const s = String(ua);
  let os = 'Other';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS/.test(s)) os = 'macOS';
  else if (/iPhone|iPad/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = 'Browser';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/Chrome\//.test(s)) br = 'Chrome';
  else if (/Safari\//.test(s)) br = 'Safari';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  return `${br} · ${os}`;
}

async function handleCheck(req, res, key, id, redis) {
  if (!key || !redis.configured()) return notConfigured(res);
  const rec = await kvGet(key, redis);
  const devs = rec && Array.isArray(rec.devices) ? rec.devices : [];
  const known = devs.find((d) => d.id === id);
  if (known) {
    known.lastSeen = Date.now();
    await kvSet(key, rec, redis);
    return res.json({ allowed: true, devices: devs.length, max: MAX_DEVICES });
  }
  // DEMO BUILD: an unknown device is allowed (no slot limit for sales demos).
  if (DEMO_UNLIMITED_DEVICES) {
    return res.json({ allowed: true, demoUnlimited: true, devices: devs.length, max: MAX_DEVICES });
  }
  return res.json({ allowed: false, reason: 'not_registered', devices: devs.length, max: MAX_DEVICES });
}

async function handleRegister(req, res, key, id, redis) {
  if (!id) return res.status(400).json({ error: 'missing device id' });
  if (!key) return notConfigured(res);
  const expected = process.env.APP_PASS;
  if (!expected) return notConfigured(res); // fail closed: no access code configured
  if (!req.body || req.body.pass !== expected) {
    return res.json({ allowed: false, reason: 'invalid' });
  }
  if (!redis.configured()) return notConfigured(res); // fail closed: no dedicated store configured
  const rec = (await kvGet(key, redis)) || { devices: [] };
  if (!Array.isArray(rec.devices)) rec.devices = [];
  const devs = rec.devices;
  const known = devs.find((d) => d.id === id);
  if (known) {
    known.lastSeen = Date.now();
    if (req.body && req.body.label) known.label = req.body.label;
  } else {
    if (!DEMO_UNLIMITED_DEVICES && devs.length >= MAX_DEVICES) {
      return res.json({
        allowed: false,
        reason: 'limit',
        devices: devs.map((d) => ({ label: d.label, firstSeen: d.firstSeen })),
        max: MAX_DEVICES,
      });
    }
    devs.push({
      id,
      label: (req.body && req.body.label) || labelFromUA(req.headers['user-agent']),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
  }
  await kvSet(key, rec, redis);
  return res.json({ allowed: true, devices: devs.length, max: MAX_DEVICES });
}

async function handleProbe(req, res, key, redis) {
  return res.json({
    mode: !key ? 'unconfigured' : redis.configured() ? 'locked' : 'open',
    maxDevices: MAX_DEVICES,
    kvConfigured: redis.configured(),
    appPassConfigured: !!process.env.APP_PASS,
    tenantIdConfigured: !!key,
  });
}

export function createDeviceHandler(deps = {}) {
  const { redis = redisClient() } = deps;
  return async function handler(req, res) {
    const key = accountKey();
    const mode = req.query && req.query.mode;
    try {
      switch (mode) {
        case 'check':      return await handleCheck(req, res, key, req.query.id, redis);
        case 'register':   return await handleRegister(req, res, key, req.query.id, redis);
        case 'probe':      return await handleProbe(req, res, key, redis);
        /* DEMO BUILD: non-secret capability probe — the portal uses it to decide
           whether to always show the login gate (shared salesman access code). */
        case 'config':     return res.json({ demoUnlimited: DEMO_UNLIMITED_DEVICES, maxDevices: MAX_DEVICES });
        default:           return res.status(400).json({ error: 'unknown mode' });
      }
    } catch (err) {
      // FAIL CLOSED on any Redis failure — never degrade to open mode.
      return res.status(503).json({ error: 'internal', detail: String((err && err.message) || err) });
    }
  };
}

export default createDeviceHandler();

/* ============================================================
   v1.0.12 — STAFF-FACING device registry access (used by the
   OIDC-pinned /api/control endpoint and by the search path).

   The customer portal still has NO public release endpoint: clearing a slot is
   an authenticated STAFF action on the Dashboard, and the search path now
   validates the device on EVERY run so a cleared device is revoked immediately
   (not only at its next portal load / login).
   ============================================================ */

/** Read the registry (never throws on shape). `configured: false` = no lock in use. */
export async function loadDeviceRegistry(redis, tenantId) {
  const key = tenantId ? tenantDevicesKey(tenantId) : null;
  if (!key || !redis || !redis.configured()) return { configured: false, devices: [], maxDevices: MAX_DEVICES };
  const rec = await kvGet(key, redis);
  const raw = rec && Array.isArray(rec.devices) ? rec.devices : [];
  const devices = raw.map((d, index) => ({
    index,
    id: String(d.id || ''),
    label: String(d.label || ''),
    firstSeen: Number.isFinite(Number(d.firstSeen)) ? Number(d.firstSeen) : null,
    lastSeen: Number.isFinite(Number(d.lastSeen)) ? Number(d.lastSeen) : null,
  }));
  return { configured: true, devices, maxDevices: MAX_DEVICES };
}

/**
 * TRUE when this device id holds a slot of this account. A tenant with an EMPTY
 * registry has no lock in use yet → anything is allowed (first device registers
 * through the normal login path). Missing device id is NEVER authorized once the
 * lock is in use (fail closed).
 */
export async function isDeviceAuthorized(redis, tenantId, deviceId) {
  const reg = await loadDeviceRegistry(redis, tenantId);
  // DEMO BUILD: the search path never requires a registered slot.
  if (DEMO_UNLIMITED_DEVICES) return { configured: true, authorized: true, demoUnlimited: true };
  if (!reg.configured) return { configured: false, authorized: false };
  if (!reg.devices.length) return { configured: true, authorized: true };
  const id = String(deviceId || '');
  return { configured: true, authorized: Boolean(id) && reg.devices.some((d) => d.id === id) };
}

/** Remove ONE slot: exact id first, else the index. Returns the removed device. */
export async function removeDeviceSlot(redis, tenantId, { deviceId, deviceIndex } = {}) {
  const key = tenantId ? tenantDevicesKey(tenantId) : null;
  if (!key || !redis || !redis.configured()) return { ok: false, reason: 'kv_not_configured' };
  const rec = (await kvGet(key, redis)) || { devices: [] };
  const devs = Array.isArray(rec.devices) ? rec.devices : [];
  let at = -1;
  if (deviceId) at = devs.findIndex((d) => String(d.id) === String(deviceId));
  else if (Number.isInteger(deviceIndex) && deviceIndex >= 0 && deviceIndex < devs.length) at = deviceIndex;
  if (at < 0) return { ok: false, reason: 'device_not_found' };
  const [removed] = devs.splice(at, 1);
  await kvSet(key, { ...rec, devices: devs }, redis);
  return { ok: true, removed: { id: String(removed.id || ''), label: String(removed.label || '') }, devices: devs.length, max: MAX_DEVICES };
}
