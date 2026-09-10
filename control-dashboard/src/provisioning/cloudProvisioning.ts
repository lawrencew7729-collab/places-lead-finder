/**
 * Phase 2C Segment 1 — CLOUD PROVISIONING FOUNDATION.
 *
 * Secure start/bootstrap + bounded-run orchestration for the Vercel Workflow
 * path. Pure logic over injected providers (fake in tests). RAW SECRETS
 * (Places API key, APP_PASS) exist ONLY inside the start call stack — they are
 * written straight into the customer Vercel encrypted env and discarded before
 * any workflow is started. The workflow payload carries NON-SECRET identifiers
 * only (tenantId/slug/projectId).
 *
 * Ordering contract (owner-approved 2026-09-04):
 *   1. validate ordinary fields + restriction confirmation
 *   2. create/reuse tenant business record
 *   3. create/reuse the customer Vercel project
 *   4. write Places key + APP_PASS into that project's encrypted env
 *   5. persist ONLY non-secret evidence (fingerprints via audit)
 *   6. discard raw secret variables
 *   7. start the Workflow with identifiers only
 * If env write fails: DO NOT start the workflow; return a safe actionable
 * failure; raw secrets are never persisted anywhere.
 */
import { createHash } from 'node:crypto';
import type { ProvisioningInput } from './executor.js';
import type { ProviderResult, ProvisioningProviders } from './provisioningProviders.js';

type GoldenReleaseIdentity = ProvisioningInput['goldenRelease'];

/** NON-SECRET workflow start payload — never contains raw key/APP_PASS. */
export interface ProvisionWorkflowPayload {
  tenantId: string;
  companyName: string;
  slug: string;
  hostname: string;
  projectId: string;
  googleProjectId: string;
  websiteRestrictionConfirmed: boolean;
  websiteRestriction: string;
  centralStoreUrl: string;
  operatorUserId: string;
}

export interface WorkflowStarter {
  start(payload: ProvisionWorkflowPayload): Promise<{ ok: boolean; runId?: string; reason?: string }>;
}

export interface CloudStartInput {
  companyName: string;
  slug: string;
  googleProjectId: string;
  websiteRestrictionConfirmed: boolean;
  /** Transient — never persisted/logged/serialized. */
  placesApiKey?: string;
  /** Transient — never persisted/logged/serialized. */
  appPass?: string;
  /** Non-secret browser recovery identity; server compares it with the authoritative tenant UUID. */
  recoveryTenantId?: string;
  /** Segment 2: MUST come from the authenticated server identity, not the browser body. */
  operatorUserId: string;
  /** Segment 2: MUST come from the trusted approved release registry, not the browser body. */
  goldenRelease: GoldenReleaseIdentity;
  centralStoreUrl: string;
}

export interface CloudStartResult {
  ok: boolean;
  reason?: string;
  /** 'created' = this start wrote a new APP_PASS; 'retained' = an existing
   *  APP_PASS was kept (retry/recovery) — the UI must not show a fresh code. */
  appPassState?: 'created' | 'retained';
  tenantId?: string;
  companyName?: string;
  projectId?: string;
  workflowRunId?: string;
}

export function fingerprintPlacesKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').toUpperCase();
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^AIza[0-9A-Za-z_-]{30,}$/;

function reasonOf(r: ProviderResult): string {
  return 'reason' in r && r.reason ? r.reason : 'failed';
}

export async function secureStartProvisioning(
  input: CloudStartInput,
  providers: ProvisioningProviders,
  workflowStarter: WorkflowStarter,
): Promise<CloudStartResult> {
  // 1. validate ordinary fields + restriction confirmation (fail-closed).
  if (!input.companyName.trim()) return { ok: false, reason: 'company name required' };
  if (!SLUG_RE.test(input.slug)) return { ok: false, reason: 'invalid slug' };
  if (!input.googleProjectId.trim()) return { ok: false, reason: 'google project id required' };
  if (input.websiteRestrictionConfirmed !== true) {
    return { ok: false, reason: 'website restriction must be confirmed before PROVISION' };
  }
  if (!input.placesApiKey) return { ok: false, reason: 'Places API key required' };
  if (!KEY_RE.test(input.placesApiKey)) return { ok: false, reason: 'invalid Places browser key' };
  if (input.appPass && input.appPass.length < 16) return { ok: false, reason: 'APP_PASS must be at least 16 chars' };

  const hostname = `${input.slug}.leadfinder.business`;
  const restriction = `https://${hostname}/*`;
  const keyFingerprint = fingerprintPlacesKey(input.placesApiKey); // non-secret evidence

  // 2. create/reuse the tenant business record (idempotent) — with an
  //    authoritative identity collision check BEFORE any secret env mutation.
  //    customer_configurations.google_project_id is the ONLY persisted
  //    authoritative customer project identity available from the ControlPlane
  //    data model; a provisioned tenant whose project differs from the
  //    incoming request MUST fail closed (no cross-wiring of customer A's
  //    slug/project with customer B's identity).
  const existingTenant = await providers.controlPlane.findTenantBySlug(input.slug);
  let tenantId = '';
  if (existingTenant.ok && existingTenant.tenantId) {
    const cfg = await providers.controlPlane.findConfigByTenant(existingTenant.tenantId);
    if (cfg.ok && cfg.config?.tenantId) {
      // config exists ⇒ provisioned tenant. The persisted google project id is
      // the ONLY authoritative customer identity — an empty/read failure must
      // FAIL CLOSED, never silently skip the collision comparison.
      if (!cfg.config.googleProjectId) {
        return { ok: false, reason: `slug collision check unavailable: persisted config for '${input.slug}' lacks google_project_id — refusing to continue` };
      }
      if (cfg.config.googleProjectId !== input.googleProjectId.trim()) {
        return { ok: false, reason: `slug collision: slug '${input.slug}' belongs to google project ${cfg.config.googleProjectId} — refusing cross-wire with ${input.googleProjectId.trim()}` };
      }
    } else if (!cfg.ok && (cfg as { reason?: string }).reason !== 'not found') {
      // operational config-read failure must NOT silently become permission to
      // continue (e.g. DB error, permission error) — fail closed.
      return { ok: false, reason: `slug collision check failed: ${(cfg as { reason?: string }).reason ?? 'config read error'} — refusing to continue` };
    }
    // Config genuinely not found ⇒ unfinished setup. The browser must possess
    // the saved non-secret tenant UUID and prove it matches this authoritative
    // row before the slug can be resumed. Slug + setup_pending alone is never
    // treated as same-customer identity.
    if (!cfg.ok && (cfg as { reason?: string }).reason === 'not found') {
      if (!input.recoveryTenantId) {
        return { ok: false, reason: `recovery identity required for unfinished setup '${input.slug}' — refusing to continue` };
      }
      if (input.recoveryTenantId !== existingTenant.tenantId) {
        return { ok: false, reason: `recovery identity mismatch for unfinished setup '${input.slug}' — refusing to continue` };
      }
    }
    tenantId = existingTenant.tenantId; // same identity/retry — reuse
  }
  if (!tenantId) {
    const created = await providers.controlPlane.insertTenant({
      companyName: input.companyName,
      slug: input.slug,
      hostname,
      googleProjectId: input.googleProjectId,
      keyFingerprint,
    });
    if (!created.ok || !created.resourceId) return { ok: false, reason: `tenant create failed: ${reasonOf(created)}` };
    tenantId = created.resourceId;
  }

  // 3. create/reuse the customer Vercel project (idempotent — never duplicates).
  const project = await providers.vercel.createProject(tenantId, input.slug);
  if (!project.ok || !project.resourceId) return { ok: false, reason: `vercel project bootstrap failed: ${reasonOf(project)}` };
  const projectId = project.resourceId;

  // 4. write raw secrets into THAT project's encrypted env (idempotent — an
  //    existing env is reused and never overwritten). Failures stop here: the
  //    workflow MUST NOT start when secrets did not reach the encrypted env.
  if (!providers.secrets) return { ok: false, reason: 'secrets handoff provider unavailable' };
  const keyWrite = await providers.secrets.configurePlacesKey(projectId, input.placesApiKey);
  if (!keyWrite.ok) return { ok: false, reason: `places key env write failed: ${reasonOf(keyWrite)}` };
  const passWrite = await providers.secrets.configureAppPass(projectId, input.appPass);
  if (!passWrite.ok) return { ok: false, reason: `APP_PASS env write failed: ${reasonOf(passWrite)}` };
  if (passWrite.appPassState !== 'created' && passWrite.appPassState !== 'retained') {
    return { ok: false, reason: 'APP_PASS handoff contract error: missing or unknown appPassState' };
  }

  // 5. persist ONLY non-secret evidence (fingerprint + intent) — never raw.
  await providers.controlPlane.insertAudit({
    tenantId,
    action: 'CUSTOMER_ONBOARDING_STARTED',
    detail: `slug=${input.slug} project=${input.googleProjectId} keyFingerprint=${keyFingerprint} restriction=${restriction}`,
  });

  // 6/7. raw variables discarded on return; start the workflow with
  //      NON-SECRET identifiers only.
  const started = await workflowStarter.start({
    tenantId,
    companyName: input.companyName,
    slug: input.slug,
    hostname,
    projectId,
    googleProjectId: input.googleProjectId,
    websiteRestrictionConfirmed: input.websiteRestrictionConfirmed,
    websiteRestriction: restriction,
    centralStoreUrl: input.centralStoreUrl,
    operatorUserId: input.operatorUserId,
  });
  if (!started.ok) return { ok: false, reason: `workflow start failed: ${started.reason ?? 'unknown'}`, tenantId, projectId };

  return {
    ok: true,
    tenantId,
    companyName: input.companyName,
    projectId,
    workflowRunId: started.runId,
    appPassState: passWrite.appPassState,
  } as CloudStartResult;
}
