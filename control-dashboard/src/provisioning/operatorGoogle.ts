/**
 * Phase 2C Segment 2 — KEYLESS GOOGLE OPERATOR IDENTITY (WIF/STS).
 *
 * Replaces the local `gcloud auth login admin@leadfinder.business` credential
 * with the SAME keyless pattern already proven for customer monitoring SAs:
 * the cloud backend (Vercel function / Workflow step) holds a Vercel OIDC
 * token → exchanges it via Google STS for an access token impersonating the
 * CENTRAL Lead Finder operator service account → performs the customer
 * project-scoped temporary bootstrap operations.
 *
 * No downloaded/user-managed service-account key. No local gcloud. The
 * customer-facing temporary-grant model (project-scoped 4 roles + 24h expiry
 * condition + cleanup) is UNCHANGED — only the provisioning identity changes
 * from `user:admin@…` (human OAuth) to `serviceAccount:operator-sa@…`.
 *
 * One-time central setup (NOT performed in this segment — requires OWNER live
 * authorization): create operator-sa in the central project, bind the Vercel
 * project's OIDC principalSet to it (workloadIdentityUser), and configure
 * env (OPERATOR_SA_EMAIL + central project number/audience).
 */
export interface OperatorGoogleConfig {
  /** e.g. operator-sa@leadfinder-central.iam.gserviceaccount.com */
  serviceAccountEmail: string;
  /** Central Google project number owning the WIF pool. */
  centralProjectNumber: string;
  /** Workload identity pool + provider (same pool as customer SAs). */
  pool: string;
  provider: string;
  /** STS audience for the Vercel OIDC provider. */
  audience: string;
}

export interface OperatorTokenProvider {
  /** Vercel OIDC token of the current function invocation (zero local auth). */
  oidcToken(): Promise<string>;
  /** HTTP POST helper (injected — fake in tests). */
  post(url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
}

const STS_ENDPOINT = 'https://sts.googleapis.com/v1/token';

/**
 * Exchange the Vercel OIDC token for a Google access token impersonating the
 * central operator SA. Pure logic over injected HTTP — fully unit-testable
 * without any Google credential.
 */
export async function exchangeOperatorToken(
  cfg: OperatorGoogleConfig,
  http: OperatorTokenProvider,
): Promise<{ ok: boolean; accessToken?: string; expiresIn?: number; reason?: string }> {
  const subjectToken = await http.oidcToken();
  if (!subjectToken) return { ok: false, reason: 'operator identity: no OIDC token available (not running on Vercel?)' };

  const res = await http.post(STS_ENDPOINT, {
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: subjectToken,
    audience: `//iam.googleapis.com/projects/${cfg.centralProjectNumber}/locations/global/workloadIdentityPools/${cfg.pool}/providers/${cfg.provider}`,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  });
  if (res.status !== 200) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.error_description === 'string' ? body.error_description : `STS ${res.status}`;
    return { ok: false, reason: `operator token exchange failed: ${reason}` };
  }
  const body = await res.json();
  const fedToken = typeof body.access_token === 'string' ? body.access_token : undefined;
  if (!fedToken) return { ok: false, reason: 'operator token exchange: missing access_token' };
  // STEP 2 (verified live): STS returns a FEDERATION token — the operator-SA
  // access token requires iamcredentials.generateAccessToken with the
  // federation token (workloadIdentityUser binding authorizes the pool).
  const gaRes = await http.post(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cfg.serviceAccountEmail)}:generateAccessToken`,
    { scope: ['https://www.googleapis.com/auth/cloud-platform'] },
    { authorization: `Bearer ${fedToken}` },
  );
  if (gaRes.status !== 200) {
    const gaBody = await gaRes.json().catch(() => ({})) as { error?: { message?: string } };
    const msg = gaBody.error?.message ?? `generateAccessToken ${gaRes.status}`;
    return { ok: false, reason: `operator SA access token failed: ${msg}` };
  }
  const gaBody = (await gaRes.json()) as { accessToken?: string };
  if (!gaBody.accessToken) return { ok: false, reason: 'operator SA access token failed: missing accessToken' };
  return { ok: true, accessToken: gaBody.accessToken };
}

/**
 * Build the Google adapter access-token provider used by the provisioning
 * adapters — the SAME bearer-token interface, now sourced keylessly.
 */
export function operatorAccessTokenProvider(cfg: OperatorGoogleConfig, http: OperatorTokenProvider) {
  let cached: { token: string; expiresAt: number } | null = null;
  return async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    const exchanged = await exchangeOperatorToken(cfg, http);
    if (!exchanged.ok || !exchanged.accessToken) {
      throw new Error(exchanged.reason ?? 'operator token exchange failed');
    }
    cached = { token: exchanged.accessToken, expiresAt: Date.now() + (exchanged.expiresIn ?? 3600) * 1000 };
    return exchanged.accessToken;
  };
}
