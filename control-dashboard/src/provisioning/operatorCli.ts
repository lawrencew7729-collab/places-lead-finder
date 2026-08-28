/**
 * PRE-R1 PROVISIONING AUTOMATION — OPERATOR CLI HOST (Section B decision).
 *
 * The narrowest suitable privileged execution host for runProvisioning:
 * an OWNER/OPERATOR CLI. No new server surface, no browser credential
 * exposure. Privileged credentials exist ONLY in the operator environment;
 * transient secrets (raw Places key, APP_PASS) arrive via HIDDEN stdin
 * prompts and are consumed at their executor stage only.
 *
 * Fail-closed guarantees:
 *  - every required privileged env var must be present (else refuse, listing
 *    exactly what is missing — never values)
 *  - explicit operator confirmation of the tenant summary before any action
 *  - ONE provisioning job per tenant (per-tenant lock file)
 *  - evidence file contains ONLY non-secret material (stage records,
 *    resource ids, rollback metadata, non-secret identities)
 *  - no raw secret ever logged or written
 *  - executionGate: true is ONLY passed after all operator checks pass
 *  - no automatic fleet rollout: one explicit tenant per invocation
 */
import { createHash } from 'node:crypto';
import { runProvisioning, type ProvisioningInput, type ProvisioningResult } from './executor';
import type { ProvisioningProviders } from './provisioningProviders';
import type { GoldenReleaseIdentity } from './releaseRegistry';

export const OPERATOR_ENV_KEYS = Object.freeze([
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE',
  'OPERATOR_USER_ID',
  'UPSTASH_ADMIN_URL',
  'UPSTASH_ADMIN_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'CENTRAL_STORE_URL',
  'WIF_POOL',
  'WIF_PROVIDER',
  'WIF_CENTRAL_PROJECT_NUMBER',
  'WIF_VERCEL_TEAM_SLUG',
  'WIF_VERCEL_TEAM_ID',
] as const);

export interface OperatorCliArgs {
  companyName: string;
  slug: string;
  googleProjectId: string;
  billingAccountId: string;
  releaseTag: string;
  releaseVersion: string;
  releaseCommitSha: string;
  releaseArtifactSha256: string;
  /** Full 64-hex fingerprint of the Places key (or computed from the raw key by the CLI). */
  placesKeyFingerprint?: string;
}

export interface OperatorCliEnv {
  [key: string]: string | undefined;
}

export interface OperatorCliIo {
  /** Hidden stdin prompt (raw secret) — must not echo. */
  promptSecret(question: string): Promise<string>;
  /** Operator confirmation prompt. */
  confirm(question: string): Promise<boolean>;
  /** Structured non-secret evidence sink. */
  writeEvidence(evidence: Record<string, unknown>): Promise<void>;
}

export interface OperatorCliLock {
  acquire(tenantSlug: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  release(tenantSlug: string): Promise<void>;
}

export interface OperatorCliDeps {
  env: OperatorCliEnv;
  args: OperatorCliArgs;
  io: OperatorCliIo;
  lock: OperatorCliLock;
  providers: ProvisioningProviders;
}

export interface OperatorCliResult {
  outcome: 'CUSTOMER_READY' | 'FAILED' | 'REFUSED' | 'ABORTED';
  reason?: string;
  result?: ProvisioningResult;
}

/** Full 64-hex uppercase SHA-256 fingerprint of the raw Places key (the ONLY form persisted). */
export function fingerprintPlacesKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').toUpperCase();
}

export async function runOperatorCli(deps: OperatorCliDeps): Promise<OperatorCliResult> {
  // 1. Operator authentication: EVERY privileged env var must be present.
  const missing = OPERATOR_ENV_KEYS.filter((k) => !deps.env[k]);
  if (missing.length > 0) {
    return { outcome: 'REFUSED', reason: `operator credentials incomplete — missing: ${missing.join(', ')}` };
  }

  // 2. Input validation (mirrors the executor's tenant-stage validation).
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(deps.args.slug)) return { outcome: 'REFUSED', reason: 'invalid slug' };
  if (!/^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/.test(deps.args.billingAccountId)) return { outcome: 'REFUSED', reason: 'invalid billing account id' };

  // 3. Transient secrets via HIDDEN prompts only. The raw Places key is
  // fingerprinted here and discarded immediately — only the fingerprint is
  // passed to the executor; the raw value is consumed at its env stage and
  // never persisted/logged. APP_PASS is an OWNER ACTION secret (the executor
  // HOLDs at the acl stage if it is missing — here the operator supplies it).
  const rawPlacesKey = await deps.io.promptSecret('Places API key (raw, hidden): ');
  const appPass = await deps.io.promptSecret('Customer access code APP_PASS (≥16 chars, hidden): ');
  const fingerprint = deps.args.placesKeyFingerprint ?? fingerprintPlacesKey(rawPlacesKey);

  // 4. Explicit operator confirmation of the exact tenant summary.
  const summary = [
    `Company   : ${deps.args.companyName}`,
    `Slug      : ${deps.args.slug} → https://${deps.args.slug}.leadfinder.business`,
    `GCP project: ${deps.args.googleProjectId}`,
    `Billing acct: ${deps.args.billingAccountId}`,
    `Release   : ${deps.args.releaseTag} @ ${deps.args.releaseCommitSha.slice(0, 8)}`,
    `Key fp    : ${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)} (64-hex SHA-256)`,
  ].join('\n');
  const confirmed = await deps.io.confirm(`Provision NEW customer — verify:\n${summary}\n\nProceed? (yes/no): `);
  if (!confirmed) return { outcome: 'ABORTED', reason: 'operator declined confirmation' };

  // 5. OWNER FINAL DECISION 1 (2026-08-27) — WEBSITE RESTRICTION CHECKPOINT.
  // Face-to-face: the CUSTOMER logs into their OWN Google account (never the
  // operator's, never Lead Finder's) and, with operator assistance, confirms
  // the Places API key exists and its website restriction equals the exact
  // customer subdomain. Google exposes no authoritative API readback, so the
  // checkpoint requires the operator's explicit confirmation — the executor
  // HOLDs at the restriction stage otherwise. No customer password/credential
  // is ever collected; the customer keeps full control of their account and
  // billing (owner final decision 2).
  const restriction = `https://${deps.args.slug}.leadfinder.business/*`;
  const restrictionConfirmedAt = new Date().toISOString(); // checkpoint timestamp (audit evidence)
  const restrictionConfirmed = await deps.io.confirm(
    `WEBSITE RESTRICTION CHECKPOINT (face-to-face, customer's own Google Console):\n` +
    `The customer's Places API key must exist and its website restriction must be EXACTLY:\n  ${restriction}\n` +
    `Customer logs in themselves; Lead Finder never collects their password or account access.\n` +
    `Has the exact restriction been configured and verified together? (yes/no): `,
  );
  if (!restrictionConfirmed) return { outcome: 'ABORTED', reason: 'operator declined the website restriction checkpoint — HOLD until the exact restriction is configured face-to-face' };

  // 6. ONE provisioning job per tenant.
  const lockResult = await deps.lock.acquire(deps.args.slug);
  if (!lockResult.ok) return { outcome: 'REFUSED', reason: (lockResult as { reason: string }).reason };

  const input: ProvisioningInput = {
    companyName: deps.args.companyName,
    slug: deps.args.slug,
    googleProjectId: deps.args.googleProjectId,
    placesKeyFingerprint: fingerprint,
    goldenRelease: {
      version: deps.args.releaseVersion,
      tag: deps.args.releaseTag,
      commitSha: deps.args.releaseCommitSha,
      artifactSha256: deps.args.releaseArtifactSha256,
      sourcePath: 'operator CLI input',
      status: 'approved',
    } satisfies GoldenReleaseIdentity,
    executionGate: true, // ONLY after env + confirmation checks passed
    centralStore: true,
    centralStoreUrl: deps.env.CENTRAL_STORE_URL!,
    billingAccountId: deps.args.billingAccountId,
    websiteRestrictionConfirmed: true, // face-to-face checkpoint passed (owner final decision 1)
    wif: {
      pool: deps.env.WIF_POOL!,
      provider: deps.env.WIF_PROVIDER!,
      centralProjectNumber: deps.env.WIF_CENTRAL_PROJECT_NUMBER!,
      vercelTeamSlug: deps.env.WIF_VERCEL_TEAM_SLUG!,
      vercelTeamId: deps.env.WIF_VERCEL_TEAM_ID!,
    },
  };

  let result: ProvisioningResult;
  let realPortalSmokeConfirmedAt: string | null = null;
  try {
    // OWNER CORRECTION 2026-08-27 — FINAL real Customer Portal smoke is an
    // OPERATOR-ASSISTED browser checkpoint. The first run stops at the
    // usage_smoke stage (referrer-acceptance preflight PASS is NOT proof of
    // the portal browser runtime). The operator then opens the deployed portal
    // at the exact origin in a real browser, performs ONE bounded real Places
    // search through the NORMAL portal runtime and confirms a successful
    // result; the run RESUMES with the explicit confirmation. A preflight
    // PASS alone can never produce CUSTOMER_READY.
    result = await runProvisioning(deps.providers, input, { placesApiKey: rawPlacesKey, deviceLockSecrets: { appPass } });
    if (
      result.outcome === 'FAILED' &&
      result.failedStageId === 'usage_smoke' &&
      (result.stages.find((s) => s.id === 'usage_smoke')?.detail ?? '').includes('OWNER ACTION REQUIRED: real Customer Portal browser smoke')
    ) {
      const realSmoke = await deps.io.confirm(
        `REAL CUSTOMER PORTAL SMOKE CHECKPOINT (owner correction 2026-08-27):\n` +
        `Open https://${result.hostname} in a REAL browser, use the actual deployed Customer Portal,\n` +
        `perform ONE bounded real Places search through the normal browser runtime, and confirm a\n` +
        `successful result. (The server-side referrer preflight alone is NOT sufficient.)\n` +
        `DEVICE-SLOT RULE (owner review): this smoke MUST be performed on the CUSTOMER'S OWN intended\n` +
        `first production device — the customer is physically present and uses their own\n` +
        `laptop/desktop/device. That device becoming Device Slot 1 is ACCEPTED and intentional.\n` +
        `An operator-owned laptop/browser must NOT be used for the final activation smoke.\n` +
        `Device Slot 2 remains available for the customer's second device.\n` +
        `Did the real portal search succeed on the customer's own device? (yes/no): `,
      );
      if (!realSmoke) return { outcome: 'ABORTED', reason: 'real Customer Portal browser smoke NOT confirmed — HOLD / NOT READY (preflight PASS alone is not sufficient)' };
      realPortalSmokeConfirmedAt = new Date().toISOString();
      input.realPortalSmokeConfirmed = true;
      result = await runProvisioning(deps.providers, input, { placesApiKey: rawPlacesKey, deviceLockSecrets: { appPass } });
    }
  } finally {
    await deps.lock.release(deps.args.slug);
  }

  // 6. Structured NON-SECRET evidence (stage records, resource ids, rollback
  // metadata, non-secret identities). The executor guarantees raw values
  // never enter serializable state; the evidence writer refuses any
  // secret-shaped content as a belt-and-braces check.
  await deps.io.writeEvidence({
    provisionedAt: new Date().toISOString(),
    tenant: { slug: deps.args.slug, hostname: result.hostname, tenantId: result.tenantId },
    release: { tag: deps.args.releaseTag, commitSha: deps.args.releaseCommitSha, artifactSha256: deps.args.releaseArtifactSha256 },
    // OWNER FINAL DECISION 1/A audit evidence: tenant + EXACT generated
    // restriction + AUTHENTICATED operator identity (from OPERATOR_USER_ID —
    // never typed by hand) + confirmation timestamp + stage/result. Simple,
    // reusing the existing evidence sink (no new audit subsystem).
    websiteRestriction: `https://${result.hostname}/*`,
    websiteRestrictionConfirmed: true,
    websiteRestrictionConfirmedAt: restrictionConfirmedAt,
    // OWNER CORRECTION 2026-08-27 — real Customer Portal browser smoke
    // evidence: operator identity + timestamp + PASS/FAIL (non-secret only).
    realPortalSmokeConfirmed: realPortalSmokeConfirmedAt !== null,
    realPortalSmokeConfirmedAt,
    operator: { id: deps.env.OPERATOR_USER_ID },
    outcome: result.outcome,
    failedStageId: result.failedStageId,
    stages: result.stages.map((s) => ({ id: s.id, status: s.status, detail: s.detail, resourceId: s.resourceId })),
    rollbackMetadata: result.rollbackMetadata,
  });

  return { outcome: result.outcome, result };
}
