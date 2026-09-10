/**
 * PHASE 2C SEGMENT 2e — INTERNAL GOOGLE PHASE WORKER (production).
 *
 * Ordinary Vercel Function: server-to-server HMAC gate, then fresh
 * request-scoped OIDC (x-vercel-oidc-token) → Google STS →
 * iamcredentials.generateAccessToken → central operator-SA → executes the
 * requested GoogleProvider method (exact executor call, idempotent).
 *
 * Returns ONLY the bounded non-secret ProviderResult. No token ever leaves
 * this function.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInternalAuthV1, runGoogleWorker, type WorkerRequest } from '../lib/googleWorkerCore.js';
import { createGoogleAdapter } from '../../src/provisioning/adapters.js';
import { exchangeOperatorToken } from '../../src/provisioning/operatorGoogle.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const internalSecret = process.env.LF_INTERNAL_SECRET ?? '';
  const supplied = req.headers['x-lf-internal'];
  const suppliedStr = Array.isArray(supplied) ? supplied[0] ?? '' : (supplied ?? '');
  if (!verifyInternalAuthV1(suppliedStr, internalSecret)) {
    res.status(403).json({ ok: false, reason: 'unauthorized internal call' });
    return;
  }

  const oidcHeader = req.headers['x-vercel-oidc-token'];
  const oidcToken = Array.isArray(oidcHeader) ? oidcHeader[0] ?? '' : (oidcHeader ?? '');

  const workerReq: WorkerRequest = {
    method: String(req.body?.method ?? ''),
    args: Array.isArray(req.body?.args) ? (req.body.args as unknown[]) : [],
  };

  const saEmail = process.env.OPERATOR_SA_EMAIL ?? '';
  const projectNumber = process.env.WIF_CENTRAL_PROJECT_NUMBER ?? '';
  const pool = process.env.WIF_POOL ?? 'lf-vercel-wif';
  const provider = process.env.WIF_PROVIDER ?? 'vercel-oidc';

  const result = await runGoogleWorker(workerReq, {
    internalSecret,
    oidcToken,
    saEmail,
    projectNumber,
    pool,
    provider,
    googleAdapterFactory: (accessToken) =>
      createGoogleAdapter({
        accessTokenProvider: async () => accessToken,
      }),
    buildGoogleAdapter: async () => {
      if (!saEmail || !projectNumber) return { ok: false, reason: 'operator env missing (OPERATOR_SA_EMAIL / WIF_CENTRAL_PROJECT_NUMBER)' };
      const exchanged = await exchangeOperatorToken(
        { serviceAccountEmail: saEmail, centralProjectNumber: projectNumber, pool, provider, audience: '' },
        {
          oidcToken: async () => oidcToken ?? '',
          post: async (url, body, headers) => {
            const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers ?? {}) }, body: JSON.stringify(body) });
            return { status: r.status, json: () => r.json() as Promise<Record<string, unknown>> };
          },
        },
      );
      if (!exchanged.ok) return { ok: false, reason: exchanged.reason };
      const accessToken: string = exchanged.accessToken ?? '';
      return { ok: true, adapter: createGoogleAdapter({ accessTokenProvider: async () => accessToken }) };
    },
  });

  res.status(result.status).json(result.body);
}
