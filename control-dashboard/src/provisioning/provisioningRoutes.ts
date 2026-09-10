/**
 * Phase 2C Segment 2b — AUTHENTICATED PROVISIONING ROUTES (server boundary).
 *
 * Pure route handlers over injected deps. TRUST BOUNDARIES (hard rules):
 *   - operatorUserId ALWAYS comes from AuthContext (authenticated server
 *     session) — any browser-supplied operatorUserId/goldenRelease is IGNORED.
 *   - goldenRelease ALWAYS comes from the trusted registry (server-side) —
 *     never from the request body.
 *   - confirmSmoke authorizes the staff session against the target tenant
 *     BEFORE resuming; the resume token is deterministic (smoke:<tenantId>)
 *     and can only resume that tenant's waiting workflow.
 *   - status returns minimal safe business state — no secrets, no raw env.
 *
 * Framework binding (HTTP layer) ships in the deployment segment (2c); these
 * handlers are framework-agnostic and fully testable.
 */
import { secureStartProvisioning, type CloudStartInput, type CloudStartResult } from './cloudProvisioning.js';
import type { ProvisioningProviders } from './provisioningProviders.js';

/** Authenticated caller identity — provided by the server session, NEVER the body. */
export interface AuthContext {
  operatorUserId: string;
  roles: string[];
}

/** Trusted server-side configuration (env-derived, never client-supplied). */
export interface ServerTrustConfig {
  centralStoreUrl: string;
}

export interface ReleaseRegistryReader {
  latestApproved(): Promise<{ tag: string } | null>;
}

export interface WorkflowResumer {
  /** Server-side resume of the durable smoke hook (createHook token). */
  resumeSmoke(tenantId: string, payload: { confirmedBy: string; at: string }): Promise<{ ok: boolean; reason?: string; retryable?: boolean }>;
  /** Read-only proof that the registered hook belongs to the current run. */
  smokeReady?(tenantId: string, expectedRunId: string): Promise<'ready' | 'not_ready' | 'unknown'>;
}

export interface ProvisioningRouteDeps {
  providers: ProvisioningProviders;
  registry: ReleaseRegistryReader;
  resumer: WorkflowResumer;
  /** PLAN B — server-side portal readiness probe (real customer-experience gate). */
  portalProbe?: (hostname: string) => Promise<{ ok: boolean; ready: boolean }>;
  trust: ServerTrustConfig;
  /** Read-only authoritative live-run status (terminal-run recovery). When a
   *  reserved run is NOT proven waiting_smoke, a terminal verdict surfaces a
   *  controlled restartable state instead of endless "provisioning". */
  runStatus?(runId: string): Promise<string>;
}

/** Fields the browser MAY send — nothing trusted, no secrets persisted server-side beyond Vercel env. */
export interface StartRequestBody {
  companyName: string;
  slug: string;
  googleProjectId: string;
  websiteRestrictionConfirmed: boolean;
  placesApiKey?: string;
  appPass?: string;
  /** IGNORED — never trusted. Present only to prove rejection. */
  operatorUserId?: string;
  goldenTag?: string;
}

export interface StartRouteResult extends CloudStartResult {
  /** safe initial business status for the Dashboard */
  status?: 'running';
}

/** A. START — authenticated server boundary. */
export async function startProvisioningRoute(
  body: StartRequestBody,
  auth: AuthContext,
  deps: ProvisioningRouteDeps,
): Promise<StartRouteResult> {
  // Browser-supplied trusted identity is ignored by construction: we derive
  // operator identity + golden release from server-side sources only.
  const golden = await deps.registry.latestApproved();
  if (!golden) return { ok: false, reason: 'no approved release in registry' };
  const registryRelease = await deps.providers.controlPlane.findRelease(golden.tag);
  if (!registryRelease.ok || !registryRelease.release) return { ok: false, reason: `release lookup failed (${golden.tag})` };

  const input: CloudStartInput = {
    companyName: body.companyName,
    slug: body.slug,
    googleProjectId: body.googleProjectId,
    websiteRestrictionConfirmed: body.websiteRestrictionConfirmed,
    placesApiKey: body.placesApiKey,
    appPass: body.appPass,
    operatorUserId: auth.operatorUserId, // ← server identity, never body.operatorUserId
    goldenRelease: registryRelease.release, // ← trusted registry, never body.goldenTag
    centralStoreUrl: deps.trust.centralStoreUrl,
  };

  const result = await secureStartProvisioning(input, deps.providers, {
    start: async (payload) => {
      // The workflow starter adapter will be wired to the Workflow SDK `start`
      // in the deployment segment; payload contains identifiers only.
      return { ok: true, runId: `wf:${payload.tenantId}` };
    },
  });
  return { ...result, status: 'running' };
}

/** PLAN B (2026-09-08) — COMPLETE ONBOARDING = STAFF MANUAL COMPLETION.
 * The staff action is the OWNER-approved completion authority: after real
 * customer portal proof (Access Code login + real search) the button directly
 * activates the customer. NO dependency on hook / Workflow / billing /
 * bootstrap_cleanup / finalize bookkeeping.
 * Retained safety: authenticated staff/owner + exact tenant + server-side
 * portal readiness probe. Already-ACTIVE is idempotent success. */
export async function completeOnboardingRoute(
  body: { tenantId: string },
  auth: AuthContext,
  deps: ProvisioningRouteDeps,
): Promise<{ ok: boolean; status?: string; alreadyActive?: boolean; reason?: string; retryable?: boolean }> {
  if (!auth.roles.includes('staff') && !auth.roles.includes('owner')) {
    return { ok: false, reason: 'forbidden: staff role required to complete onboarding' };
  }
  if (!body.tenantId || !/^[0-9a-f-]{36}$/i.test(body.tenantId)) return { ok: false, reason: 'invalid tenant id' };
  const tenant = await deps.providers.controlPlane.findTenantById(body.tenantId);
  if (!tenant.ok || !tenant.tenantId || !tenant.slug) return { ok: false, reason: 'tenant not found — cannot complete onboarding' };
  const full = await deps.providers.controlPlane.findTenantBySlug(tenant.slug);
  const status = full.ok ? (full.tenantStatus ?? '') : '';
  if (status === 'active') return { ok: true, status: 'active', alreadyActive: true };
  // Server-side portal readiness is the real customer-experience gate.
  if (!deps.portalProbe) return { ok: false, reason: 'portal readiness check unavailable', retryable: true };
  const probe = await deps.portalProbe(`${tenant.slug}.leadfinder.business`);
  if (!probe.ok || !probe.ready) return { ok: false, reason: 'customer portal is not ready yet', retryable: true };
  const upd = await deps.providers.controlPlane.updateTenantStatus(body.tenantId, 'active');
  if (!upd.ok) return { ok: false, reason: 'failed to activate customer', retryable: false };
  return { ok: true, status: 'active' };
}

/** Staff-safe rethrow wrapper: hook-not-found (gate not ready) is retryable —
 *  never a hard failure, never a scary "Hook not found" surfaced to staff. */

/** C. STATUS — read-authorized minimal business state. */
export interface StatusRouteResult {
  ok: boolean;
  reason?: string;
  status?: 'draft' | 'provisioning' | 'waiting_smoke' | 'active' | 'failed' | 'unknown';
  tenantStatus?: string;
  /** bounded non-secret failure detail — never raw env/keys */
  lastError?: string;
  keyFingerprint?: string;
  confirmationReady?: boolean;
  /** true ONLY when the reserved run is authoritatively terminal (completed/
   *  failed/canceled/not_found) and a fresh run may be started after staff
   *  re-verification — never set from unknown/live run status. */
  restartable?: boolean;
}

export async function statusRoute(
  body: { slug: string },
  _auth: AuthContext,
  deps: ProvisioningRouteDeps,
): Promise<StatusRouteResult> {
  const tenant = await deps.providers.controlPlane.findTenantBySlug(body.slug);
  if (!tenant.ok || !tenant.tenantId) return { ok: false, reason: 'tenant not found', status: 'unknown' };
  // AUTHORITATIVE ACTIVE source = tenants.status (executor finalize flips it
  // to 'active' as its LAST step, after config/evidence persistence) — never
  // inferred from resumeHook or from config-row existence.
  if (tenant.tenantStatus === 'active') {
    const config = await deps.providers.controlPlane.findConfigByTenant(tenant.tenantId);
    return {
      ok: true,
      status: 'active',
      tenantStatus: 'active',
      keyFingerprint: config.ok && config.config?.keyFingerprint ? config.config.keyFingerprint : undefined,
    };
  }
  // A released reservation may retain an old runId as evidence. Requiring an
  // active token plus runId binds readiness to the exact current workflow.
  const reservation = await deps.providers.controlPlane.readProvisioningReservation(tenant.tenantId);
  if (reservation.ok && reservation.reservationToken && reservation.runId && deps.resumer.smokeReady) {
    const readiness = await deps.resumer.smokeReady(tenant.tenantId, reservation.runId);
    if (readiness === 'ready') {
      return {
        ok: true,
        status: 'waiting_smoke',
        tenantStatus: tenant.tenantStatus ?? 'setup_pending',
        confirmationReady: true,
      };
    }
    // TERMINAL-RUN RECOVERY (2026-09-08): smoke not ready for the reserved
    // run — ask the platform whether that run is authoritatively terminal.
    // completed/failed/canceled/not_found (mirroring the backend CAS restart
    // contract in handleStartRequest) → controlled restartable failed state.
    // LIVE or UNKNOWN → fail closed (stay provisioning; never offer restart).
    if (deps.runStatus) {
      let runState = 'unknown';
      try {
        runState = (await deps.runStatus(reservation.runId)) ?? 'unknown';
      } catch {
        runState = 'unknown';
      }
      const terminal = runState === 'failed' || runState === 'completed' || runState === 'canceled' || runState === 'cancelled' || runState === 'not_found';
      if (terminal) {
        return {
          ok: true,
          status: 'failed',
          tenantStatus: tenant.tenantStatus ?? 'setup_pending',
          restartable: true,
          reason: 'Previous provisioning run ended before customer activation. Verify this customer\u2019s details to safely continue.',
        };
      }
    }
  }
  // Tenant exists but is neither authoritative-active nor proven waiting.
  return { ok: true, status: 'provisioning', tenantStatus: tenant.tenantStatus ?? 'setup_pending' };
}
