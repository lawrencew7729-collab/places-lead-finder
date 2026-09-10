/**
 * STATUS ENTRYPOINT PRODUCTION WIRING (2026-09-08).
 *
 * Regression: unit tests injected a fake runStatus directly into statusRoute,
 * so the terminal-run logic PASSED locally — but the production entrypoint
 * (api/provisioning/status.ts) only injected workflowSmokeReady, never
 * workflowRunStatus. Production therefore always returned "provisioning" for a
 * completed/failed old run. This test pins the entrypoint's dependency
 * factory to carry BOTH runtime bindings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStatusHttpDeps } from '../../api/provisioning/status.js';
import { workflowSmokeReady, workflowRunStatus } from '../../api/lib/workflowRuntime.js';

vi.mock('../../src/provisioning/cloudProvidersEnv.js', () => ({
  createCloudProvidersFromEnv: vi.fn(async () => ({
    controlPlane: {},
    vercel: {},
    google: {},
    secrets: {},
    deviceLock: {},
    redisAcl: {},
    usageSmoke: {},
  })),
}));

describe('production status entrypoint wiring (api/provisioning/status)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('injects workflowSmokeReady AND workflowRunStatus into the status HttpDeps', async () => {
    const deps = await buildStatusHttpDeps();
    // smoke proof binding preserved
    expect(deps.workflowSmokeReady).toBe(workflowSmokeReady);
    // authoritative live-run binding present — the missing piece that kept
    // production returning "provisioning" for terminal old runs
    expect(deps.workflowRunStatus).toBe(workflowRunStatus);
    expect(typeof deps.workflowRunStatus).toBe('function');
  });
});
