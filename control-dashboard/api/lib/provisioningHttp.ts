import { randomUUID } from 'node:crypto';
/**
 * Phase 2C Segment 2c — PROVISIONING HTTP HANDLERS (testable route logic).
 *
 * Request → Response layer with injected deps (auth secret, providers,
 * workflow starter/resumer, registry reader, server env). api/provisioning/*
 * glue files bind these handlers to the platform runtime with production deps;
 * tests exercise this exact layer with fakes.
 *
 * Hard rules enforced here:
 *   - every route authenticates the session JWT first (fail-closed)
 *   - operatorUserId comes from the verified session — never the body
 *   - golden release comes from the trusted registry — never the body
 *   - confirm requires staff/owner role and an existing tenant
 *   - responses contain no secrets
 */
import { authenticateRequest } from './session.js';
import { completeOnboardingRoute, statusRoute } from '../../src/provisioning/provisioningRoutes.js';
import { secureStartProvisioning, type CloudStartInput } from '../../src/provisioning/cloudProvisioning.js';
import { buildProvisionWorkflowArgs, readProvisionServerEnv, type SecureStartOutcome } from './provisionServer.js';
import type { ProvisioningProviders } from '../../src/provisioning/provisioningProviders.js';
import type { GoldenReleaseIdentity } from '../../src/provisioning/releaseRegistry.js';

export interface HttpDeps {
  supabaseUrl: string;
  providers: ProvisioningProviders;
  /**
   * S2e Verify 4: production glue MAY supply a factory that builds providers
   * bound to the AUTHENTICATED session operator (session.operatorUserId) —
   * every customer write (tenant created_by, config, audit attribution) is
   * then attributable to the real staff member. Without it (tests), the
   * pre-built deps.providers is used unchanged.
   */
  createProviders?(operatorUserId: string): Promise<ProvisioningProviders>;
  /** server-side workflow start (platform binding). */
  workflowStart(args: ReturnType<typeof buildProvisionWorkflowArgs>): Promise<{ ok: boolean; runId?: string; reason?: string }>;
  /** server-side smoke resume (platform binding → resumeHook). */
  workflowResumeSmoke(tenantId: string, payload: { confirmedBy: string; at: string }): Promise<{ ok: boolean; reason?: string; retryable?: boolean }>;
  /** read-only registered-hook proof, bound to the current reservation runId */
  workflowSmokeReady?: (tenantId: string, expectedRunId: string) => Promise<'ready' | 'not_ready' | 'unknown'>;
  /** PLAN B manual completion — server-side portal readiness probe. */
  portalProbe?: (hostname: string) => Promise<{ ok: boolean; ready: boolean }>;
  workflowRunStatus?(runId: string): Promise<string>;
  registry: { latestApproved(): Promise<{ tag: string } | null> };
  /** env overrides for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** Resolve staff/owner roles from operator_profiles (authoritative server side). */
async function resolveOperatorRoles(
  deps: HttpDeps,
  operatorUserId: string,
): Promise<{ ok: boolean; roles?: string[]; reason?: string }> {
  const profile = await deps.providers.controlPlane.getOperatorProfile(operatorUserId);
  if (!profile.ok || !profile.profile || !profile.profile.active) {
    return { ok: false, reason: 'operator profile not found or inactive' };
  }
  const role = profile.profile.role;
  const roles = role === 'admin' ? ['owner', 'staff'] : role === 'operator' ? ['staff'] : [];
  if (roles.length === 0) return { ok: false, reason: 'unauthorized role' };
  return { ok: true, roles };
}

async function authenticated(req: Request, deps: HttpDeps): Promise<{ ok: boolean; session?: import('./sessionTypes.js').VerifiedSession; roles?: string[]; reason?: string }> {
  const auth = await authenticateRequest(req, deps.supabaseUrl);
  if (!auth.ok || !auth.session) return { ok: false, reason: auth.reason ?? 'invalid session' };
  const session = auth.session;
  // claim-level roles are 'authenticated' — resolve staff/owner from the DB profile
  const resolved = await resolveOperatorRoles(deps, session.operatorUserId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason ?? 'unauthorized' };
  return { ok: true, session, roles: resolved.roles };
}

/** Browser-supplied trusted fields are stripped: only customer data is read. */
interface SafeStartBody {
  companyName?: string;
  slug?: string;
  googleProjectId?: string;
  websiteRestrictionConfirmed?: boolean;
  placesApiKey?: string;
  appPass?: string;
  recoveryTenantId?: string;
}

export async function handleStartRequest(req: Request, deps: HttpDeps): Promise<Response> {
  const auth = await authenticated(req, deps);
  if (!auth.ok || !auth.session) return json({ ok: false, reason: auth.reason ?? 'invalid session' }, 401);
  const session = auth.session;

  let body: SafeStartBody;
  try {
    body = (await req.json()) as SafeStartBody;
  } catch {
    return json({ ok: false, reason: 'invalid json body' }, 400);
  }

  // Trusted release lookup — server-side only.
  const goldenTag = await deps.registry.latestApproved();
  if (!goldenTag) return json({ ok: false, reason: 'no approved release in registry' }, 503);
  const releaseResult = await deps.providers.controlPlane.findRelease(goldenTag.tag); // read-only registry lookup — bound above when factory used
  if (!releaseResult.ok || !releaseResult.release) return json({ ok: false, reason: `release lookup failed (${goldenTag.tag})` }, 503);
  const goldenRelease: GoldenReleaseIdentity = releaseResult.release;

  const env = readProvisionServerEnv(deps.env);
  // S2e Verify 4: ALL pre-workflow customer writes (tenant created_by,
  // CUSTOMER_ONBOARDING_STARTED audit, secrets-env bootstrap) go through
  // providers bound to the AUTHENTICATED operator — never a static env id.
  const providers = deps.createProviders ? await deps.createProviders(session.operatorUserId) : deps.providers;
  const cloudInput: CloudStartInput = {
    companyName: body.companyName ?? '',
    slug: body.slug ?? '',
    googleProjectId: body.googleProjectId ?? '',
    websiteRestrictionConfirmed: body.websiteRestrictionConfirmed === true,
    placesApiKey: body.placesApiKey,
    appPass: body.appPass,
    recoveryTenantId: body.recoveryTenantId,
    operatorUserId: session.operatorUserId, // server identity — body never read for this
    goldenRelease,
    centralStoreUrl: env.centralStoreUrl,
  };

  // S2e FINAL (revised) — ALREADY-ACTIVE guard executes BEFORE any
  // provisioning mutation (tenant handling, Vercel project bootstrap/reuse,
  // secret-env writes, onboarding audit). An authoritative ACTIVE tenant
  // returns alreadyActive and NEVER re-enters provisioning mutation. A
  // conflicting google project identity on an ACTIVE slug FAILS CLOSED.
  const existingTenant = await providers.controlPlane.findTenantBySlug((body.slug ?? '').trim().toLowerCase());
  if (existingTenant.ok && existingTenant.tenantId && existingTenant.tenantStatus === 'active') {
    const cfg = await providers.controlPlane.findConfigByTenant(existingTenant.tenantId);
    if (!cfg.ok) {
      return json({ ok: false, reason: 'active customer config unreadable — refusing (fail closed)', tenantId: existingTenant.tenantId }, 503);
    }
    const persistedProject = (cfg.config as { googleProjectId?: string } | undefined)?.googleProjectId ?? '';
    if (!persistedProject) {
      return json({ ok: false, reason: 'active customer has no persisted project identity — refusing (fail closed)', tenantId: existingTenant.tenantId }, 503);
    }
    if (persistedProject !== (body.googleProjectId ?? '').trim()) {
      return json({ ok: false, reason: 'slug collision FAIL CLOSED: this slug is already ACTIVE on a different Google project', tenantId: existingTenant.tenantId }, 409);
    }
    return json({ ok: true, alreadyActive: true, tenantId: existingTenant.tenantId, status: 'active' }, 200);
  }

  const started = await secureStartProvisioning(cloudInput, providers, {
    start: async (payload) => ({ ok: true, runId: `staged:${payload.tenantId}` }), // replaced below after env bootstrap
  });
  if (!started.ok || !started.tenantId || !started.projectId) {
    return json({ ok: false, reason: started.reason ?? 'start failed' }, 400);
  }
  if (started.appPassState !== 'created' && started.appPassState !== 'retained') {
    return json({ ok: false, reason: 'APP_PASS handoff contract error: missing or unknown appPassState' }, 500);
  }

  const outcome: SecureStartOutcome = {
    tenantId: started.tenantId,
    companyName: started.companyName ?? body.companyName ?? '',
    slug: body.slug ?? '',
    hostname: `${body.slug ?? ''}.leadfinder.business`,
    projectId: started.projectId,
    googleProjectId: body.googleProjectId ?? '',
    websiteRestrictionConfirmed: body.websiteRestrictionConfirmed === true,
    websiteRestriction: `https://${body.slug ?? ''}.leadfinder.business/*`,
    placesKeyFingerprint: fingerprintOf(body.placesApiKey ?? ''),
    operatorUserId: session.operatorUserId,
    appPassState: started.appPassState,
  };
  // S2e FINAL — ATOMIC RESERVATION before start(). The server-generated
  // non-secret reservation token exists BEFORE Vercel Workflow start() so two
  // concurrent identical requests can never both call start() — exactly one
  // wins the RPC reserve, the loser refuses without calling start().
  const reservationToken = `res-${randomUUID()}`;
  const reserved = await providers.controlPlane.reserveProvisioningStart(started.tenantId, reservationToken);
  if (!reserved.ok) {
    return json({ ok: false, reason: `reservation unavailable (${(reserved as { reason?: string }).reason ?? 'read error'}) — refusing to start`, tenantId: started.tenantId }, 503);
  }
  if (reserved.winner !== true) {
    // Loser: read the reservation state — live/uncertain → FAIL CLOSED;
    // authoritatively terminal run → CAS release then re-acquire (retry).
    const state = await providers.controlPlane.readProvisioningReservation(started.tenantId);
    if (!state.ok) {
      return json({ ok: false, reason: `reservation state unreadable — refusing to start`, tenantId: started.tenantId }, 503);
    }
    if (state.runId) {
      const status = deps.workflowRunStatus ? await deps.workflowRunStatus(state.runId) : 'unknown';
      // Authoritative terminal check — Vercel Workflow reports 'cancelled'
      // (two L); support BOTH spellings defensively (2026-09-08 fix).
      const terminal = status === 'failed' || status === 'completed' || status === 'canceled' || status === 'cancelled' || status === 'not_found';
      if (!terminal || !state.reservationToken) {
        // live run OR unknown state (crash window without authoritative proof)
        return json(
          { ok: false, reason: `provisioning already in progress for this customer (workflow ${state.runId}) — no duplicate workflow started`, tenantId: started.tenantId, runId: state.runId, duplicatePrevented: true },
          409,
        );
      }
      // authoritative terminal → CAS release of the exact reservation, then retry below
      const released = await providers.controlPlane.releaseProvisioningReservation(started.tenantId, state.reservationToken);
      if (!released.ok || released.released !== true) {
        return json({ ok: false, reason: 'previous reservation could not be released — refusing to start', tenantId: started.tenantId }, 503);
      }
      const reReserved = await providers.controlPlane.reserveProvisioningStart(started.tenantId, reservationToken);
      if (!reReserved.ok || reReserved.winner !== true) {
        return json({ ok: false, reason: 'reservation re-acquire failed — refusing to start', tenantId: started.tenantId }, 503);
      }
    } else {
      // Reserved but no runId linked — ambiguous start/crash window: FAIL CLOSED.
      // Do NOT auto-expire into permission to create Workflow B.
      return json({ ok: false, reason: 'start already reserved for this customer but not yet linked — retry shortly; no duplicate workflow started', tenantId: started.tenantId, duplicatePrevented: true }, 409);
    }
  }

  // Winner ONLY reaches here — exactly one start() per reservation.
  const args = buildProvisionWorkflowArgs(env, outcome, goldenRelease, reservationToken);
  const workflow = await deps.workflowStart(args);
  if (!workflow.ok) return json({ ok: false, reason: workflow.reason ?? 'workflow start failed', tenantId: started.tenantId }, 500);
  // Link the REAL runId to the reservation (CAS on the token). Failure here
  // does NOT make the workflow undiscoverable: the workflow self-links its own
  // runId from inside its first step (getWorkflowMetadata).
  const linked = await providers.controlPlane.linkProvisioningRun(started.tenantId, reservationToken, workflow.runId ?? '');
  if (!linked.ok || linked.linked !== true) {
    await providers.controlPlane.insertAudit({ tenantId: started.tenantId, action: 'RESERVATION_LINK_WARNING', detail: 'run started but reservation link failed — workflow self-link is the fallback' });
  }
  // evidence audit (never the locking primitive)
  await providers.controlPlane.insertAudit({
    tenantId: started.tenantId,
    action: `WORKFLOW_STARTED:${workflow.runId ?? 'unknown'}`,
    detail: `slug=${body.slug ?? ''}`,
  });
  return json({ ok: true, runId: workflow.runId, tenantId: started.tenantId, status: 'running', appPassState: outcome.appPassState });
}

import { fingerprintPlacesKey } from '../../src/provisioning/cloudProvisioning.js';
function fingerprintOf(raw: string): string {
  try {
    return fingerprintPlacesKey(raw);
  } catch {
    return 'MISSING';
  }
}

export async function handleConfirmRequest(req: Request, deps: HttpDeps): Promise<Response> {
  const auth = await authenticated(req, deps);
  if (!auth.ok || !auth.session || !auth.roles) return json({ ok: false, reason: auth.reason ?? 'invalid session' }, 401);
  const session = auth.session;

  let body: { tenantId?: string };
  try {
    body = (await req.json()) as { tenantId?: string };
  } catch {
    return json({ ok: false, reason: 'invalid json body' }, 400);
  }
  if (!body.tenantId) return json({ ok: false, reason: 'tenantId required' }, 400);

  const result = await completeOnboardingRoute({ tenantId: body.tenantId }, { operatorUserId: session.operatorUserId, roles: auth.roles }, {
    providers: deps.providers,
    registry: deps.registry,
    resumer: { resumeSmoke: deps.workflowResumeSmoke },
    portalProbe: deps.portalProbe,
    trust: { centralStoreUrl: readProvisionServerEnv(deps.env).centralStoreUrl },
  });
  if (result.ok) return json(result, 200);
  // confirmation gate not ready yet — RETRYABLE (never a scary hard error)
  if ((result as { retryable?: boolean }).retryable) return json(result, 409);
  return json(result, 403);
}

export async function handleStatusRequest(req: Request, deps: HttpDeps): Promise<Response> {
  const auth = await authenticated(req, deps);
  if (!auth.ok || !auth.session) return json({ ok: false, reason: auth.reason ?? 'invalid session' }, 401);
  const session = auth.session;

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return json({ ok: false, reason: 'slug query required' }, 400);

  const result = await statusRoute({ slug }, { operatorUserId: session.operatorUserId, roles: session.roles }, {
    providers: deps.providers,
    registry: deps.registry,
    resumer: { resumeSmoke: deps.workflowResumeSmoke, smokeReady: deps.workflowSmokeReady },
    trust: { centralStoreUrl: '' },
    runStatus: deps.workflowRunStatus,
  });
  return json(result, result.ok ? 200 : 404);
}

// ---------------------------------------------------------------------------
// PORTAL-READY PROBE (FINAL STAFF UX 2026-09-07)
// ---------------------------------------------------------------------------

export interface PortalHealthDeps {
  supabaseUrl: string;
  providers: HttpDeps['providers'];
  probe: (hostname: string) => Promise<{ ok: boolean; ready: boolean; status?: number; reason?: string }>;
}

/** Authenticated portal-ready check — non-secret { ok, ready }. */
export async function handlePortalHealthRequest(req: Request, deps: PortalHealthDeps): Promise<Response> {
  const auth = await authenticated(req, deps as unknown as HttpDeps);
  if (!auth.ok || !auth.session || !auth.roles) return json({ ok: false, reason: auth.reason ?? 'invalid session' }, 401);
  if (!auth.roles.includes('staff') && !auth.roles.includes('owner')) return json({ ok: false, reason: 'forbidden: staff role required' }, 403);
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return json({ ok: false, reason: 'invalid slug' }, 400);
  const result = await deps.probe(`${slug}.leadfinder.business`);
  if (!result.ok) return json({ ok: false, ready: false, reason: result.reason ?? 'probe failed' }, 502);
  return json({ ok: true, ready: result.ready, status: result.status });
}
