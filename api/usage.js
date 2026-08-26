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

const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const MON_URL = 'https://monitoring.googleapis.com/v3/projects/';

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
async function getPlacesUsage(token, projectId, fetchImpl) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = now.toISOString();
  const filter = encodeURIComponent(
    'metric.type="serviceruntime.googleapis.com/api/request_count"' +
    ' AND resource.labels.service="places.googleapis.com"'
  );
  const url = MON_URL + projectId + '/timeSeries' +
    '?filter=' + filter +
    '&interval.startTime=' + start +
    '&interval.endTime=' + end +
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
  } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    // Env is read at REQUEST time (serverless cold-start safe, test-friendly).
    const sa = monitoringSa || process.env.CUSTOMER_MONITORING_SA || DEFAULT_MONITORING_SA;
    const audience = wifAudience || process.env.WIF_AUDIENCE || '';
    const cap = getMonthlyTarget(monthlyTarget);
    const projectId = process.env.CUSTOMER_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
    if (!audience || !projectId) {
      return res.status(503).json({ error: 'not_configured', used: null, cap });
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
      const token = await exchangeForSaToken(oidcToken, audience, sa, fetchImpl);
      const used = await getPlacesUsage(token, projectId, fetchImpl);
      res.json({ used, cap, month: new Date().toISOString().slice(0, 7), source: 'monitoring' });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e), used: null, cap });
    }
  };
}

export default createUsageHandler();
