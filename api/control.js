// api/control.js — Customer Portal control endpoint (v1.0.11), OPTION B.
//
// Called ONLY by the Control Dashboard (server-to-server) with a Vercel OIDC
// bearer token that pins project_id = lf-control-dashboard (see controlAuth.js).
//
// Mutations: STOP | RESUME | UPGRADE_TO_FULL_900
// Read-only : STATUS
//
// The authoritative package/service state is written into THIS customer's own
// Redis (`tenant:<TENANT_ID>:config`). No secret is ever read by the Dashboard
// and nothing is mirrored centrally (no duplicate source of truth).
// ESM format (matches root package.json "type": "module").
import { verifyControlToken, parseBearer, createJwksProvider } from './controlAuth.js';
import { redisClient, tenantConfigKey, tenantUsageKey } from './redis.js';
import { pacificBillingMonth } from './billingMonth.js';
import { loadDeviceRegistry, removeDeviceSlot } from './device.js';
import {
  CONTROL_ACTIONS, GOOGLE_CEILING, parseTenantConfig, serializeTenantConfig,
  applyControlAction, packageStop, publicState, packageSelectionFacts, packageActionGate,
} from '../src/packageControl.js';

/** Dashboard identity attribution stored next to the state (non-secret). */
function callerLabel(claims) {
  return 'dashboard:' + String((claims && claims.project) || 'lf-control-dashboard');
}

/**
 * Month of the config's last state change — the fallback for configs written
 * before v1.0.12 (no `packageMonth`). Same Pacific billing month as STATUS.
 */
function fallbackMonthOf(config) {
  if (!config || !config.updatedAt) return null;
  const at = new Date(config.updatedAt);
  return Number.isFinite(at.getTime()) ? pacificBillingMonth(at) : null;
}

function readBody(req) {
  const b = req && req.body;
  if (!b) return {};
  if (typeof b === 'object') return b;
  try { return JSON.parse(String(b)); } catch (e) { return {}; }
}

export function createControlHandler(deps = {}) {
  const {
    redis = redisClient(),
    tenantId = process.env.CUSTOMER_TENANT_ID || '',
    now = () => new Date(),
    getJwks = createJwksProvider(),
    ceiling = Number(process.env.CUSTOMER_MONTHLY_TARGET) > 0 ? Number(process.env.CUSTOMER_MONTHLY_TARGET) : GOOGLE_CEILING,
  } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    // 1. authenticate — every failure is a fail-closed 401.
    const token = parseBearer(req.headers && (req.headers.authorization || req.headers.Authorization));
    if (!token) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });
    let jwks;
    try {
      jwks = await getJwks();
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'jwks_unavailable' });
    }
    const verified = verifyControlToken(token, { jwks, nowSeconds: Math.floor(now().getTime() / 1000) });
    if (!verified.ok) return res.status(401).json({ ok: false, error: verified.reason });

    if (!tenantId) return res.status(503).json({ ok: false, error: 'not_configured' });
    if (!redis.configured()) return res.status(503).json({ ok: false, error: 'redis_unavailable' });

    const action = String(readBody(req).action || '').toUpperCase();
    const configKey = tenantConfigKey(tenantId);

    // 2. read-only STATUS — never mutates, never touches the session lease.
    if (action === 'STATUS') {
      let raw;
      try {
        raw = await redis.get(configKey);
      } catch (e) {
        return res.status(503).json({ ok: false, error: 'state_unavailable' });
      }
      const config = parseTenantConfig(raw);
      let used = 0;
      const month = pacificBillingMonth(now());
      try {
        used = Number(await redis.get(tenantUsageKey(tenantId, month))) || 0;
      } catch (e) {
        used = 0;
      }
      // v1.0.12 — the month-selection authority is reported HERE so the Dashboard
      // renders 500/900 from this flag instead of re-implementing the rule.
      const facts = packageSelectionFacts({
        ...config,
        fallbackMonth: fallbackMonthOf(config),
        currentMonth: month,
      });
      // Device slots (2 max). This endpoint is OIDC-pinned to the Dashboard, so the
      // full device id is available for the hover; the partial PUBLIC peek payload
      // never carries device data.
      let registry = { devices: [], maxDevices: 0 };
      try {
        registry = await loadDeviceRegistry(redis, tenantId);
      } catch (e) { /* registry read failure → report empty, never a wrong device */ }
      return res.status(200).json({
        ok: true,
        state: {
          ...publicState({
            package: config.package,
            serviceStatus: config.serviceStatus,
            used,
            month,
            ceiling,
            packageMonth: facts.selectedMonth,
            packageSelectableThisMonth: facts.isNewMonth,
          }),
          devices: registry.devices,
          maxDevices: registry.maxDevices,
        },
      });
    }

    // 3. mutations — whitelist only.
    if (!CONTROL_ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, error: 'unsupported_action', allowed: [...CONTROL_ACTIONS, 'STATUS'] });
    }
    let current;
    try {
      current = parseTenantConfig(await redis.get(configKey));
    } catch (e) {
      return res.status(503).json({ ok: false, error: 'state_unavailable' });
    }
    // 3b. SERVER-SIDE monthly package rule (never UI-only): a package action is
    //     refused once this month's package has already been chosen — there is no
    //     900 -> 500 change inside a month.
    {
      const month = pacificBillingMonth(now());
      const facts = packageSelectionFacts({
        ...current,
        fallbackMonth: fallbackMonthOf(current),
        currentMonth: month,
      });
      const gated = packageActionGate(facts, action);
      if (gated && !gated.allowed) {
        return res.status(409).json({
          ok: false,
          error: 'package_already_selected_this_month',
          reason: gated.reason,
          state: publicState({
            package: current.package,
            serviceStatus: current.serviceStatus,
            used: null,
            month,
            ceiling,
            packageMonth: facts.selectedMonth,
            packageSelectableThisMonth: facts.isNewMonth,
          }),
        });
      }
    }
    // 3c. DEVICE SLOT CLEAR (v1.0.12) — a device action, never a package action.
    //     This endpoint only owns the SLOT; the device is revoked on its very next
    //     run because /api/usage validates the registry on every run start.
    if (action === 'CLEAR_DEVICE') {
      const body = readBody(req);
      const deviceId = String(body.deviceId || '').trim();
      const deviceIndex = Number.isInteger(body.deviceIndex) ? body.deviceIndex : undefined;
      if (!deviceId && deviceIndex === undefined) {
        return res.status(400).json({ ok: false, error: 'missing_device' });
      }
      let cleared;
      try {
        cleared = await removeDeviceSlot(redis, tenantId, { deviceId, deviceIndex });
      } catch (e) {
        return res.status(503).json({ ok: false, error: 'device_store_unavailable' });
      }
      if (!cleared.ok) return res.status(409).json({ ok: false, error: cleared.reason });

      const month = pacificBillingMonth(now());
      let used = 0;
      try {
        used = Number(await redis.get(tenantUsageKey(tenantId, month))) || 0;
      } catch (e) {
        used = 0;
      }
      const facts = packageSelectionFacts({
        ...current,
        fallbackMonth: fallbackMonthOf(current),
        currentMonth: month,
      });
      let registry = { devices: [], maxDevices: 0 };
      try {
        registry = await loadDeviceRegistry(redis, tenantId);
      } catch (e) { /* report empty rather than a wrong list */ }
      return res.status(200).json({
        ok: true,
        action,
        // non-secret suffix only (the full id is never written to the audit trail)
        removedDeviceSuffix: String(cleared.removed.id).slice(-6),
        removedDeviceLabel: cleared.removed.label,
        state: {
          ...publicState({
            package: current.package,
            serviceStatus: current.serviceStatus,
            used,
            month,
            ceiling,
            packageMonth: facts.selectedMonth,
            packageSelectableThisMonth: facts.isNewMonth,
          }),
          devices: registry.devices,
          maxDevices: registry.maxDevices,
        },
      });
    }

    // 3b. LEGACY FREEZE (owner 2026-09-17): the month derived from the PRE-WRITE
    //     `updatedAt` is pinned into `packageMonth` on the first write of a
    //     pre-v1.0.12 config, so a STOP / RESUME on the 1st cannot make the new
    //     month look "already chosen" and lock the 500/900 selection for that month.
    const next = applyControlAction(current, action, {
      updatedAt: now().toISOString(),
      updatedBy: callerLabel(verified.claims),
      month: pacificBillingMonth(now()),
      legacyMonth: fallbackMonthOf(current),
    });
    if (!next) return res.status(400).json({ ok: false, error: 'unsupported_action' });
    try {
      await redis.set(configKey, serializeTenantConfig(next));
    } catch (e) {
      return res.status(503).json({ ok: false, error: 'state_write_failed' });
    }
    const month = pacificBillingMonth(now());
    let used = 0;
    try {
      used = Number(await redis.get(tenantUsageKey(tenantId, month))) || 0;
    } catch (e) {
      used = 0;
    }
    const nextFacts = packageSelectionFacts({
      ...next,
      fallbackMonth: fallbackMonthOf(next),
      currentMonth: month,
    });
    return res.status(200).json({
      ok: true,
      action,
      state: publicState({
        package: next.package,
        serviceStatus: next.serviceStatus,
        used,
        month,
        ceiling,
        packageMonth: nextFacts.selectedMonth,
        packageSelectableThisMonth: nextFacts.isNewMonth,
      }),
      searchStop: packageStop(next.package),
    });
  };
}

export default createControlHandler();
