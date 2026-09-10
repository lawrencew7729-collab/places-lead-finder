/**
 * S2e FINAL FIX (VERDICT A) — workflowRuntime source-level start tests.
 * Proves workflowStart passes the EXACT registered workflow id
 * (WorkflowMetadata form — never the raw untransformed function), and that
 * success/failure semantics stay fail-closed with the adapter contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// mock the platform SDK binding (workflowRuntime is excluded from tsc; the
// workflow/api module is resolved by the platform build — tests stub it)
const startMock = vi.fn();
const getHookByTokenMock = vi.fn();
vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => startMock(...args),
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: async () => undefined,
}));

import { workflowSmokeReady, workflowStart, workflowRunStatus, PROVISION_CUSTOMER_WORKFLOW_ID } from '../../api/lib/workflowRuntime.js';

const EXPECTED_ID = 'workflow//./workflows/provisionCustomer//provisionCustomerWorkflow';

const ARGS = {
  input: { slug: 'x', companyName: 'X' } as never,
  ctx: { tenantId: 't', reservationToken: 'res-1', operatorUserId: 'u' } as never,
};

describe('workflowRuntime source-level workflow-id start (VERDICT A fix)', () => {
  beforeEach(() => {
    startMock.mockReset();
    getHookByTokenMock.mockReset();
  });

  it('start is called with the WorkflowMetadata {workflowId} form — NOT the raw function', async () => {
    startMock.mockResolvedValue({ runId: 'run_1' });
    const res = await workflowStart(ARGS);
    expect(res.ok).toBe(true);
    expect(res.runId).toBe('run_1');
    const [first, second] = startMock.mock.calls[0];
    // first arg must be the metadata object with the EXACT registered id
    expect(typeof first).toBe('object');
    expect((first as { workflowId?: string }).workflowId).toBe(EXPECTED_ID);
    expect((first as { workflowId?: string }).workflowId).toBe(PROVISION_CUSTOMER_WORKFLOW_ID);
    expect(typeof second).toBe('object'); // args array [args]
    // never the raw function (no callable first arg)
    expect(typeof (first as { workflowId?: string }).workflowId).toBe('string');
  });

  it('the constant matches the id observed in the flow.func build artifact', () => {
    // drift gate scripts/verify-workflow-link.mjs re-checks against the live
    // artifact after every workflow build; here we lock the expected string.
    expect(PROVISION_CUSTOMER_WORKFLOW_ID).toBe(EXPECTED_ID);
  });

  it('start failure stays fail-closed with a reason (adapter contract)', async () => {
    startMock.mockRejectedValue(new Error('boom'));
    const res = await workflowStart(ARGS);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('boom');
  });

  it('workflowRunStatus is exported and the id constant is well-formed', async () => {
    expect(typeof workflowRunStatus).toBe('function');
    expect(PROVISION_CUSTOMER_WORKFLOW_ID.length).toBeGreaterThan(10);
  });

  it('registered hook is ready only when it belongs to the current reserved run', async () => {
    getHookByTokenMock.mockResolvedValue({ runId: 'run-current' });
    await expect(workflowSmokeReady('tenant-1', 'run-current')).resolves.toBe('ready');
    expect(getHookByTokenMock).toHaveBeenCalledWith('lf-smoke:tenant-1');
    await expect(workflowSmokeReady('tenant-1', 'run-stale')).resolves.toBe('not_ready');
  });

  it('missing hook is not ready while an unknown platform error remains fail-closed unknown', async () => {
    getHookByTokenMock.mockResolvedValueOnce(undefined);
    await expect(workflowSmokeReady('tenant-1', 'run-current')).resolves.toBe('not_ready');
    getHookByTokenMock.mockRejectedValueOnce(new Error('platform unavailable'));
    await expect(workflowSmokeReady('tenant-1', 'run-current')).resolves.toBe('unknown');
  });
});
