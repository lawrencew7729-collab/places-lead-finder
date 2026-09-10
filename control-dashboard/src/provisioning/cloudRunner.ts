/**
 * Phase 2C Segment 2 — CLOUD RUNNER (durable provisioning orchestration).
 *
 * Pure, testable orchestration of the proven executor across the bounded
 * phases a Vercel Workflow executes. Each phase is idempotent and safe to
 * re-enter (executor find-before-create semantics) — a Workflow step retry or
 * a post-crash replay simply re-runs the phase.
 *
 * Phases:
 *   infra    — executor run stopBefore:'deploy' (stages 1–6) → READY_FOR_DEPLOY
 *   deploy   — trigger + poll deployment readiness → DEPLOYED
 *   validate — executor run (deploy now found READY; restriction flag already
 *              confirmed in the wizard) → smoke gate → WAITING_SMOKE or VALIDATED
 *   finalize — executor run with realPortalSmokeConfirmed=true → ACTIVE
 *
 * The actual Workflow file (Vercel Workflows SDK) is a thin shell over these
 * phases; SDK integration details were not resolvable from static docs in this
 * segment, so the shell ships with Segment 2b once the SDK contract is pinned.
 */
import type { ProvisioningInput, ProvisioningResult, ProvisioningTransientInput } from './executor.js';
import { runProvisioning } from './executor.js';
import type { ProvisioningProviders } from './provisioningProviders.js';

export type CloudPhaseId = 'infra' | 'deploy' | 'validate' | 'finalize';

export type CloudRunnerStatus =
  | 'READY_FOR_DEPLOY'
  | 'STILL_DEPLOYING'
  | 'DEPLOYED'
  | 'WAITING_SMOKE'
  | 'VALIDATED'
  | 'ACTIVE'
  | 'FAILED';

export interface CloudRunnerOutcome {
  phase: CloudPhaseId;
  status: CloudRunnerStatus;
  result?: ProvisioningResult;
  reason?: string;
}

export interface CloudRunContext {
  /** Authenticated operator identity (session sub) — attribution for writes. */
  operatorUserId?: string;
  /** S2e FINAL: atomic reservation token acquired BEFORE start() — workflow self-links its runId against it. */
  reservationToken?: string;
  tenantId: string;
  projectId: string;
  hostname: string;
  /** deployment id returned by the deploy phase (persisted by the caller/workflow state). */
  deploymentId?: string;
  websiteRestrictionConfirmed: boolean;
  realPortalSmokeConfirmed: boolean;
}

export interface CloudRunnerDeps {
  providers: ProvisioningProviders;
  input: ProvisioningInput;
  /** transient raw secrets — normally absent on the cloud path (env pre-written). */
  transient?: ProvisioningTransientInput;
  deployPoll?: { intervalMs?: number; timeoutMs?: number };
}

/** Phase 1 — infrastructure stages 1–6 (bounded run; stops BEFORE deploy). */
export async function runInfraPhase(deps: CloudRunnerDeps): Promise<CloudRunnerOutcome> {
  const result = await runProvisioning(deps.providers, deps.input, deps.transient ?? {}, { stopBefore: 'deploy' });
  if (result.outcome === 'PAUSED') return { phase: 'infra', status: 'READY_FOR_DEPLOY', result };
  return { phase: 'infra', status: 'FAILED', result };
}

/** Phase 2 — trigger deployment and probe readiness once (Workflow sleeps between probes). */
export async function runDeployPhase(deps: CloudRunnerDeps, projectId: string, deploymentId?: string): Promise<CloudRunnerOutcome> {
  const providers = deps.providers;
  let id = deploymentId;
  if (!id) {
    const triggered = await providers.vercel.deployGolden(projectId, deps.input.goldenRelease);
    if (!triggered.ok || !triggered.resourceId) return { phase: 'deploy', status: 'FAILED', reason: triggered.ok ? 'missing deployment id' : `deploy trigger failed: ${'reason' in triggered ? triggered.reason : 'unknown'}` };
    id = triggered.resourceId;
  }
  if (!providers.vercel.getDeploymentStatus) return { phase: 'deploy', status: 'DEPLOYED', reason: 'provider without probe — assumed ready' };
  const probe = await providers.vercel.getDeploymentStatus(id);
  if (!probe.ok) return { phase: 'deploy', status: 'FAILED', reason: `deployment probe failed: ${'reason' in probe ? probe.reason : 'unknown'}` };
  const state = (probe.readyState ?? '').toUpperCase();
  if (state === 'READY') return { phase: 'deploy', status: 'DEPLOYED', reason: id };
  if (state === 'ERROR' || state === 'CANCELED') return { phase: 'deploy', status: 'FAILED', reason: `vercel deployment ${state}` };
  return { phase: 'deploy', status: 'STILL_DEPLOYING', reason: id };
}

/** Phase 3 — validation run: deploy found READY (idempotent skip) → smoke gate. */
export async function runValidatePhase(deps: CloudRunnerDeps, ctx: CloudRunContext): Promise<CloudRunnerOutcome> {
  const input: ProvisioningInput = {
    ...deps.input,
    websiteRestrictionConfirmed: ctx.websiteRestrictionConfirmed,
    realPortalSmokeConfirmed: ctx.realPortalSmokeConfirmed,
    // Verify 5: reuse the deploy-phase READY deployment — NEVER retrigger.
    existingDeploymentId: ctx.deploymentId,
  };
  const result = await runProvisioning(deps.providers, input, deps.transient ?? {}, { deployPoll: deps.deployPoll });
  if (result.outcome === 'CUSTOMER_READY') return { phase: 'validate', status: 'VALIDATED', result };
  const failed = result.stages.find((s) => s.status === 'FAILED');
  // usage_smoke OWNER ACTION (real smoke pending) is the EXPECTED hold → WAITING_SMOKE
  if (failed?.id === 'usage_smoke' && String(failed.detail).includes('OWNER ACTION REQUIRED')) {
    return { phase: 'validate', status: 'WAITING_SMOKE', result };
  }
  return { phase: 'validate', status: 'FAILED', result, reason: failed?.detail };
}

/**
 * Phase 4 — finalize run with real smoke confirmed → ACTIVE (executor finalize
 * The executor now performs bootstrap_cleanup BEFORE finalize (authoritative
 * handover ordering) — tenant ACTIVE can never precede cleanup success.
 */
export async function runFinalizePhase(deps: CloudRunnerDeps, ctx: CloudRunContext): Promise<CloudRunnerOutcome> {
  const input: ProvisioningInput = { ...deps.input, websiteRestrictionConfirmed: ctx.websiteRestrictionConfirmed, realPortalSmokeConfirmed: true, existingDeploymentId: ctx.deploymentId };
  const result = await runProvisioning(deps.providers, input, deps.transient ?? {}, { deployPoll: deps.deployPoll });
  if (result.outcome === 'CUSTOMER_READY') return { phase: 'finalize', status: 'ACTIVE', result };
  return { phase: 'finalize', status: 'FAILED', result, reason: result.stages.find((s) => s.status === 'FAILED')?.detail };
}
