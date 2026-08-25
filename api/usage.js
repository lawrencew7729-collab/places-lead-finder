// Vercel serverless function: /api/usage
// Queries Google Cloud Monitoring for the real Places API (New) request count
// this calendar month, using a service account (Monitoring Viewer).
// Env var: SERVICE_ACCOUNT_JSON = the full service-account JSON key.
// ESM format (matches root package.json "type": "module" and api/device.js).
// Quota contract: monthly limit from CUSTOMER_MONTHLY_TARGET env, default 1000 (approved contract).
import crypto from 'node:crypto';

const CUSTOMER_MONTHLY_TARGET = (() => {
  const n = Number(process.env.CUSTOMER_MONTHLY_TARGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
})();

const SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MON_URL = 'https://monitoring.googleapis.com/v3/projects/';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signingInput = header + '.' + claims;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key);
  const jwt = signingInput + '.' + b64url(sig);

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token exchange failed: ' + (j.error_description || j.error));
  return j.access_token;
}

async function getPlacesUsage(token, projectId) {
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

  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const saJson = process.env.SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    return res.status(503).json({ error: 'not_configured', used: null, cap: CUSTOMER_MONTHLY_TARGET });
  }
  try {
    const sa = JSON.parse(saJson);
    const token = await getAccessToken(sa);
    const used = await getPlacesUsage(token, sa.project_id);
    res.json({ used, cap: CUSTOMER_MONTHLY_TARGET, month: new Date().toISOString().slice(0, 7), source: 'monitoring' });
  } catch (e) {
    res.status(500).json({ error: e.message, used: null, cap: CUSTOMER_MONTHLY_TARGET });
  }
};
