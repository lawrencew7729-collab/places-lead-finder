// Vercel serverless function: /api/usage
// R1 REVISED SHARED MONITORING AUTH (owner-approved 2026-08-26):
//   Vercel OIDC -> Google Workload Identity Federation -> central monitoring SA.
//   ZERO user-managed keys: no service-account JSON credential, no private key.
// Target identity:
//   leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com
// The Monitoring counter counts ALL Places API (New) requests this calendar
// month — the authoritative OPERATIONAL SAFETY basis. It is NEVER claimed as
// Text Search Enterprise / billing-SKU usage.
// ESM format (matches root package.json "type": "module").
import { getVercelOidcToken } from '@vercel/oidc';
import { redisClient, tenantActiveSearchKey, tenantUsageKey } from './redis.js';
import { pacificBillingMonth, pacificBillingMonthStartUtc } from './billingMonth.js';
import { SESSION_TTL_SECONDS, MAX_SESSION_REQUESTS } from './session.js';

const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const MON_URL = 'https://monitoring.googleapis.com/v3/projects/';

export const SAFETY_STOP = 950;
export const GOOGLE_ALLOWANCE = 1000;

/** Atomic usage-floor reconcile: tenant usage NEVER moves backward vs Monitoring. */
export const RECONCILE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local snapshot = tonumber(ARGV[1])
if current < snapshot then
  redis.call('SET', KEYS[1], ARGV[1])
  return snapshot
end
return current
`;

export const DEFAULT_MONITORING_SA = 'leadfinder-usage-monitor@leadfinder-shared-monitoring.iam.gserviceaccount.com';

function getMonthlyTarget(monthlyTarget) {
  const n = Number(monthlyTarget ?? process.env.CUSTOMER_MONTHLY_TARGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/** STS token exchange: Vercel OIDC token -> impersonated central SA token. */
async function exchangeForSaToken(oidcToken, audience, sa, fetchImpl) {
  const body = new URLSearchParams({
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: oidcToken,
    audience,
    scope: MONITORING_SCOPE,
    serviceAccount: sa,
  });
  const r = await fetchImpl(STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error('sts ' + r.status + ': ' + (j.error_description || j.error || 'exchange failed'));
  }
  return j.access_token;
}

/** Broad Places API (New) request count, calendar month to date (safety basis). */
async function getPlacesUsage(token, projectId, fetchImpl, now = new Date()) {
  // Google billing month resets at 00:00 America/Los_Angeles on the first of
  // the Pacific calendar month — the interval MUST start at that exact
  // absolute instant (DST-aware), never the UTC month start.
  const start = new Date(pacificBillingMonthStartUtc(now)).toISOString();
  const end = now.toISOString();
  const filter = encodeURIComponent(
    'metric.type="serviceruntime.googleapis.com/api/request_count"' +
    ' AND resource.labels.service="places.googleapis.com"'
  );
  const url = MON_URL + projectId + '/timeSeries' +
    '?filter=' + filter +
    '&interval.startTime=' + encodeURIComponent(start) +
    '&interval.endTime=' + encodeURIComponent(end) +
    '&aggregation.alignmentPeriod=3600s' +
    '&aggregation.perSeriesAligner=ALIGN_SUM';

  const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('monitoring ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  let total = 0;
  for (const ts of j.timeSeries || []) {
    for (const pt of ts.points || []) {
      const v = pt.value && (pt.value.doubleValue !== undefined ? pt.value.doubleValue : pt.value.int64Value);
      if (v) total += Number(v);
    }
  }
  return Math.round(total);
}

/**
 * Injectable handler factory (unit-testable). Defaults read server env:
 *   WIF_AUDIENCE                    — WIF pool provider audience (required)
 *   CUSTOMER_MONITORING_SA          — impersonated SA (default central SA)
 *   CUSTOMER_GOOGLE_PROJECT_ID | GOOGLE_CLOUD_PROJECT_ID — project to query
 *   CUSTOMER_MONTHLY_TARGET         — monthly allowance (default 1000)
 * No user-managed service-account credential anywhere in this candidate.
 */
export function createUsageHandler(deps = {}) {
  const {
    oidcTokenProvider = getVercelOidcToken,
    fetchImpl = fetch,
    monitoringSa,
    wifAudience,
    monthlyTarget,
    redis = redisClient(),
    tenantId = process.env.CUSTOMER_TENANT_ID || '',
    now = () => new Date(),
    randomUuid = () => crypto.randomUUID(),
  } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    // Env is read at REQUEST time (serverless cold-start safe, test-friendly).
    const sa = monitoringSa || process.env.CUSTOMER_MONITORING_SA || DEFAULT_MONITORING_SA;
    const audience = wifAudience || process.env.WIF_AUDIENCE || '';
    const cap = getMonthlyTarget(monthlyTarget);
    const projectId = process.env.CUSTOMER_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
    if (!audience || !projectId || !tenantId) {
      return res.status(503).json({ error: 'not_configured', used: null, cap });
    }
    if (!redis.configured()) {
      // FAIL CLOSED: no Redis bridge/lease — RUN must not start.
      return res.status(503).json({ error: 'redis_unavailable', used: null, cap });
    }
    let oidcToken;
    try {
      oidcToken = await oidcTokenProvider();
    } catch (e) {
      return res.status(503).json({ error: 'oidc_unavailable', used: null, cap });
    }
    if (!oidcToken) {
      return res.status(503).json({ error: 'not_configured', used: null, cap });
    }
    try {
      // 1. ONE latest-available Google Monitoring snapshot (broad Places count).
      const token = await exchangeForSaToken(oidcToken, audience, sa, fetchImpl);
      const monitoringUsed = await getPlacesUsage(token, projectId, fetchImpl, now());
      // 2. tenant Redis usage bridge (covers Monitoring propagation delay);
      //    server-authoritative Pacific billing month (never client-supplied).
      const month = pacificBillingMonth(now());
      const usageKey = tenantUsageKey(tenantId, month);
      const leaseKey = tenantActiveSearchKey(tenantId);
      // 3. atomic reconcile floor — usage can NEVER move backward.
      const reconciled = await redis.eval(RECONCILE_SCRIPT, [usageKey], [String(monitoringUsed)]);
      const effectiveStart = Math.max(monitoringUsed, Number(reconciled ?? monitoringUsed));
      // 4. SAFETY STOP: 950 blocks NEW top-level RUN.
      if (effectiveStart >= SAFETY_STOP) {
        return res.json({ used: effectiveStart, cap, safetyStop: SAFETY_STOP, month, blocked: true });
      }
      // 5. atomic exclusive lease acquire (NX).
      const sessionId = randomUuid();
      const lease = JSON.stringify({
        sessionId,
        deviceId: req.query && req.query.deviceId ? String(req.query.deviceId) : 'unknown',
        attempts: 0,
        acquiredAt: Date.now(),
      });
      const acquired = await redis.set(leaseKey, lease, 'EX', String(SESSION_TTL_SECONDS), 'NX');
      if (acquired !== 'OK') {
        // 6. another device holds an active search lease.
        return res.json({ used: effectiveStart, cap, safetyStop: SAFETY_STOP, month, locked: true });
      }
      // 7. return session context (server-side attempt count starts at 0).
      return res.json({
        used: effectiveStart,
        cap,
        safetyStop: SAFETY_STOP,
        month,
        sessionId,
        maxSessionRequests: MAX_SESSION_REQUESTS,
        leaseTtlSeconds: SESSION_TTL_SECONDS,
        expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
        source: 'monitoring',
      });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e), used: null, cap });
    }
  };
}

export default createUsageHandler();
