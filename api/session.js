/* ============================================================
   Lead Finder — Active-Search Session API (R1 CENTRALIZED model)
   Server-authoritative per-request claim + single-active-device lease.

   Owner-approved contract (2026-08-26):
   - ONE centralized Upstash Redis DB; per-tenant ACL REST credential.
   - Keys: tenant:<TENANT_ID>:active_search / tenant:<TENANT_ID>:usage:<YYYY-MM>
   - Only ONE device may hold an active search session (SET NX lease).
   - HARD session cap = 50 outbound Places request ATTEMPTS — enforced
     ATOMICALLY here (the browser counter is UX only, not the authority).
   - Lease TTL 120s; EVERY successful claim renews it; no heartbeat polling.
   - STOP/finish: compare-and-release immediately.
   - All operations use ONLY the customer's own restricted ACL credential
     (~tenant:<TENANT_ID>:* + minimal command allowlist).
   ============================================================ */
import { redisClient, tenantActiveSearchKey, tenantUsageKey } from './redis.js';
import { pacificBillingMonth } from './billingMonth.js';

export const SESSION_TTL_SECONDS = 120;
export const MAX_SESSION_REQUESTS = 50;

/** Atomic claim: verify lease + ownership + cap; INCR attempts + usage; renew TTL. */
export const CLAIM_SCRIPT = `
local lease = redis.call('GET', KEYS[1])
if not lease then return {0, 'no_session'} end
local d = cjson.decode(lease)
if d.sessionId ~= ARGV[1] then return {0, 'ownership'} end
if tonumber(d.attempts) >= tonumber(ARGV[2]) then return {0, 'cap'} end
d.attempts = d.attempts + 1
redis.call('SET', KEYS[1], cjson.encode(d), 'EX', ARGV[3])
redis.call('INCRBY', KEYS[2], 1)
return {1, d.attempts, redis.call('GET', KEYS[2])}
`;

/** Compare-and-release: only the owning session may release the lease. */
export const RELEASE_SCRIPT = `
local lease = redis.call('GET', KEYS[1])
if not lease then return {0, 'no_session'} end
local d = cjson.decode(lease)
if d.sessionId ~= ARGV[1] then return {0, 'ownership'} end
redis.call('DEL', KEYS[1])
return {1}
`;

/** Status: lease presence + usage bridge (Redis only — NOT a Monitoring query). */
export const STATUS_SCRIPT = `
local lease = redis.call('GET', KEYS[1])
local usage = redis.call('GET', KEYS[2])
return {lease, usage}
`;

export function createSessionHandler(deps = {}) {
  const { redis = redisClient(), tenantId = process.env.CUSTOMER_TENANT_ID || '', now = () => new Date() } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!tenantId) return res.status(503).json({ error: 'not_configured' });
    if (!redis.configured()) return res.status(503).json({ error: 'not_configured' });
    const mode = req.query && req.query.mode;
    const sessionId = req.query && req.query.sessionId ? String(req.query.sessionId) : '';
    const leaseKey = tenantActiveSearchKey(tenantId);
    // Server-authoritative Pacific billing month, resolved PER REQUEST — a
    // session crossing the Pacific midnight boundary attributes each request
    // to the month it actually lands in (never client-supplied).
    const usageKey = tenantUsageKey(tenantId, pacificBillingMonth(now()));

    try {
      switch (mode) {
        case 'claim': {
          if (!sessionId) return res.status(400).json({ ok: false, reason: 'missing session' });
          const r = await redis.eval(CLAIM_SCRIPT, [leaseKey, usageKey], [sessionId, String(MAX_SESSION_REQUESTS), String(SESSION_TTL_SECONDS)]);
          // r = [okFlag, attempts?, used?] (or [0, reason])
          if (Number(r[0]) === 1) {
            return res.json({ ok: true, attempts: Number(r[1]), used: Number(r[2] ?? 0) });
          }
          return res.status(409).json({ ok: false, reason: String(r[1] ?? 'claim_failed') });
        }
        case 'release': {
          if (!sessionId) return res.status(400).json({ ok: false, reason: 'missing session' });
          const r = await redis.eval(RELEASE_SCRIPT, [leaseKey], [sessionId]);
          if (Number(r[0]) === 1) return res.json({ ok: true });
          return res.status(409).json({ ok: false, reason: String(r[1] ?? 'release_failed') });
        }
        case 'status': {
          const r = await redis.eval(STATUS_SCRIPT, [leaseKey, usageKey], []);
          // r = [leaseJson|null, usage|null]
          const lease = r[0] ? JSON.parse(String(r[0])) : null;
          return res.json({ active: Boolean(lease), sessionId: lease ? lease.sessionId : null, used: Number(r[1] ?? 0) });
        }
        default:
          return res.status(400).json({ error: 'unknown mode' });
      }
    } catch (e) {
      // FAIL CLOSED: any Redis failure blocks the claim — the Google request
      // must NOT be issued by the caller.
      return res.status(503).json({ ok: false, error: 'redis_unavailable', reason: 'redis_unavailable' });
    }
  };
}

export default createSessionHandler();
