/**
 * Phase 2C Segment 2b/2c — PROVISION CUSTOMER WORKFLOW (Vercel Workflows SDK).
 *
 * Thin durable shell over the fully-tested cloudRunner phases. All business
 * logic lives in cloudRunner/executor — this file only provides durability.
 *
 * SDK constraints honored here (proven by `workflow build` + `validate` +
 * `transform`):
 *   - workflow arguments are FULLY SERIALIZABLE (providers are constructed
 *     INSIDE steps from the deployment env, never passed as arguments)
 *   - every executor/phase invocation runs inside a `'use step'` function —
 *     workflow-top-level code may not touch Node modules (node:crypto etc.);
 *     steps may (proven by the workflow-node-module-error diagnostic)
 *   - suspension uses createHook (private server-side resume); the deploy
 *     probe loop sleeps durably between probes (no compute while waiting)
 */
import { createHook, sleep } from 'workflow';
import type { ProvisioningInput } from '../src/provisioning/executor.js';
import { runInfraPhase, runDeployPhase, runValidatePhase, runFinalizePhase, type CloudRunnerOutcome, type CloudRunContext } from '../src/provisioning/cloudRunner.js';

/** Serializable workflow arguments — NO providers, NO raw secrets. */
export interface ProvisionWorkflowArgs {
  input: ProvisioningInput;
  ctx: CloudRunContext;
}

export interface ProvisionWorkflowResult { status: 'ACTIVE' | 'FAILED'; reason?: string }

/** Deterministic hook token — binds the suspension to exactly ONE tenant/run. */
export function smokeHookToken(tenantId: string): string {
  return `lf-smoke:${tenantId}`;
}

async function selfLinkStep(args: ProvisionWorkflowArgs): Promise<void> {
  'use step';
  // S2e FINAL: the workflow links its OWN authoritative runId to the
  // pre-start reservation as early as possible. This closes the gap where
  // start() succeeded but the HTTP function crashed before recording runId —
  // the workflow itself establishes the linkage. Non-fatal on failure (route
  // link is the primary path; this is the durability fallback).
  try {
    const { getWorkflowMetadata } = await import('@workflow/core');
    const meta = getWorkflowMetadata();
    if (meta?.workflowRunId && args.ctx.reservationToken) {
      const { createCloudProvidersFromEnv } = await import('../src/provisioning/cloudProvidersEnv.js');
      const providers = await createCloudProvidersFromEnv(undefined, args.ctx.operatorUserId);
      await providers.controlPlane.linkProvisioningRun(args.ctx.tenantId, args.ctx.reservationToken, meta.workflowRunId);
    }
  } catch {
    // self-link is best-effort; the route link + audit remain as evidence
  }
}

async function infraStep(args: ProvisionWorkflowArgs): Promise<CloudRunnerOutcome> {
  'use step';
  const { createCloudProvidersFromEnv } = await import('../src/provisioning/cloudProvidersEnv.js');
  const providers = await createCloudProvidersFromEnv(undefined, args.ctx.operatorUserId);
  return runInfraPhase({ providers, input: args.input });
}

async function deployStep(args: ProvisionWorkflowArgs, projectId: string, deploymentId?: string): Promise<CloudRunnerOutcome> {
  'use step';
  const { createCloudProvidersFromEnv } = await import('../src/provisioning/cloudProvidersEnv.js');
  const providers = await createCloudProvidersFromEnv(undefined, args.ctx.operatorUserId);
  return runDeployPhase({ providers, input: args.input }, projectId, deploymentId);
}

async function validateStep(args: ProvisionWorkflowArgs, ctx: CloudRunContext): Promise<CloudRunnerOutcome> {
  'use step';
  const { createCloudProvidersFromEnv } = await import('../src/provisioning/cloudProvidersEnv.js');
  const providers = await createCloudProvidersFromEnv(undefined, args.ctx.operatorUserId);
  return runValidatePhase({ providers, input: args.input }, ctx);
}

async function finalizeStep(args: ProvisionWorkflowArgs, ctx: CloudRunContext): Promise<CloudRunnerOutcome> {
  'use step';
  const { createCloudProvidersFromEnv } = await import('../src/provisioning/cloudProvidersEnv.js');
  const providers = await createCloudProvidersFromEnv(undefined, args.ctx.operatorUserId);
  return runFinalizePhase({ providers, input: args.input }, ctx);
}

/**
 * Durable provisioning workflow:
 *   infra step (stages 1–6) → deploy trigger + durable probe loop →
 *   validate step (smoke gate) → SUSPEND on smoke hook → finalize step → ACTIVE
 */
export async function provisionCustomerWorkflow(args: ProvisionWorkflowArgs): Promise<ProvisionWorkflowResult> {
  'use workflow';

  await selfLinkStep(args);

  const infra = await infraStep(args);
  if (infra.status !== 'READY_FOR_DEPLOY') return { status: 'FAILED', reason: infra.reason ?? 'infra phase failed' };

  let deployProbe = await deployStep(args, args.ctx.projectId, args.ctx.deploymentId);
  while (deployProbe.status === 'STILL_DEPLOYING') {
    await sleep('30s');
    deployProbe = await deployStep(args, args.ctx.projectId, deployProbe.reason);
  }
  if (deployProbe.status !== 'DEPLOYED') return { status: 'FAILED', reason: deployProbe.reason ?? 'deploy phase failed' };
  const deploymentId = deployProbe.reason;

  const ctxWithDeploy: CloudRunContext = { ...args.ctx, deploymentId, realPortalSmokeConfirmed: false };
  const validate = await validateStep(args, ctxWithDeploy);

  if (validate.status === 'WAITING_SMOKE') {
    // SUSPENSION: zero compute while waiting. Staff confirms through our
    // authenticated server route → server-side resumeHook(token) resumes THIS
    // run only (token = smoke:<tenantId>). No raw Places key / APP_PASS needed.
    using smokeHook = createHook<{ confirmedBy: string; at: string }>({ token: smokeHookToken(args.ctx.tenantId) });
    const confirmation = await smokeHook;
    if (!confirmation) return { status: 'FAILED', reason: 'smoke confirmation rejected' };
  }

  const finalize = await finalizeStep(args, { ...ctxWithDeploy, realPortalSmokeConfirmed: true });
  if (finalize.status !== 'ACTIVE') return { status: 'FAILED', reason: finalize.reason ?? 'finalize failed' };
  return { status: 'ACTIVE' };
}
