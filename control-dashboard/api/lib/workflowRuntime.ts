/**
 * Phase 2C Segment 2c — WORKFLOW RUNTIME BINDING (excluded from tsc).
 *
 * The ONLY module that statically imports the `workflow` SDK packages and the
 * transformed workflow file. Excluded from the app tsconfig because the
 * workflow SDK's type exports are resolved by its own build integration
 * (Vercel platform transform); this file ships verbatim to the platform build.
 *
 * Everything else (arg assembly, route logic) lives in provisionServer.ts and
 * provisioningRoutes.ts which stay fully type-checked and unit-tested.
 */
import { getHookByToken, start, getRun } from 'workflow/api';
import { resumeHook } from 'workflow/api';
import { smokeHookToken, type ProvisionWorkflowArgs } from '../../workflows/provisionCustomer.js';

/**
 * S2e FINAL FIX (VERDICT A — owner-approved 2026-09-06):
 *
 * API functions are compiled by `vercel build` WITHOUT the Workflow SDK
 * Client-Mode transform, so the raw imported workflow function carries no
 * `.workflowId` and `start(rawFn, ...)` is rejected synchronously
 * ('invalid workflow function'). The installed SDK 4.8.5's supported
 * source-level alternative is the `WorkflowMetadata` start form —
 * `WorkflowMetadata = { workflowId: string }` (start.d.ts) — so we pass the
 * EXACT registered workflow id (emitted by `workflow build` into flow.func).
 *
 * Drift protection: scripts/verify-workflow-link.mjs compares this constant
 * against the generated flow.func artifact after every workflow build and
 * fails the gate on mismatch.
 */
export const PROVISION_CUSTOMER_WORKFLOW_ID =
  'workflow//./workflows/provisionCustomer//provisionCustomerWorkflow' as const;

export async function workflowStart(args: ProvisionWorkflowArgs): Promise<{ ok: boolean; runId?: string; reason?: string }> {
  try {
    const run = await start({ workflowId: PROVISION_CUSTOMER_WORKFLOW_ID } as never, [args]);
    return { ok: true, runId: run.runId };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'workflow start failed' };
  }
}

/** S2e pre-E2E: authoritative live-run status (duplicate-run protection).
 * 'not_found' ONLY on an authoritative run-not-found result — any other
 * error (platform/network/auth) is 'unknown' so callers FAIL CLOSED. */
export async function workflowRunStatus(runId: string): Promise<string> {
  try {
    const run = await getRun(runId);
    return await run.status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // authoritative not-found signals from the platform/queue
    if (/not found|WorkflowRunNotFound|404|not_found/i.test(msg)) return 'not_found';
    return 'unknown';
  }
}

/** Read-only proof that the deterministic smoke hook is registered for the
 * exact currently-reserved workflow run. A generic run status is insufficient:
 * hooks become queryable only after the workflow has actually suspended. */
export async function workflowSmokeReady(
  tenantId: string,
  expectedRunId: string,
): Promise<'ready' | 'not_ready' | 'unknown'> {
  try {
    const hook = await getHookByToken(smokeHookToken(tenantId));
    if (!hook) return 'not_ready';
    return (hook as { runId?: string }).runId === expectedRunId ? 'ready' : 'not_ready';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/hook not found|no hook|not found|404/i.test(msg)) return 'not_ready';
    return 'unknown';
  }
}

export async function workflowResumeSmoke(tenantId: string, payload: { confirmedBy: string; at: string }): Promise<{ ok: boolean; reason?: string; retryable?: boolean }> {
  try {
    await resumeHook(smokeHookToken(tenantId), payload);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'smoke resume failed';
    // UX contract: the confirmation gate may not exist YET (the workflow has
    // not reached WAITING_SMOKE). That is NOT a failure — the staff should
    // retry shortly. Distinguish hook-not-found (retryable) from other errors.
    const hookAbsent = /hook not found|no hook|not found|404/i.test(msg);
    return { ok: false, reason: msg, retryable: hookAbsent };
  }
}
