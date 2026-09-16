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
import {
  CONTROL_ACTIONS, GOOGLE_CEILING, parseTenantConfig, serializeTenantConfig,
  applyControlAction, packageStop, publicState,
} from '../src/packageControl.js';

/** Dashboard identity attribution stored next to the state (non-secret). */
function callerLabel(claims) {
  return 'dashboard:' + String((claims && claims.project) || 'lf-control-dashboard');
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
      return res.status(200).json({ ok: true, state: publicState({ package: config.package, serviceStatus: config.serviceStatus, used, month, ceiling }) });
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
    const next = applyControlAction(current, action, {
      updatedAt: now().toISOString(),
      updatedBy: callerLabel(verified.claims),
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
    return res.status(200).json({
      ok: true,
      action,
      state: publicState({ package: next.package, serviceStatus: next.serviceStatus, used, month, ceiling }),
      searchStop: packageStop(next.package),
    });
  };
}

export default createControlHandler();
