/**
 * PRE-R1 Provisioning Run Sheet — UI state model only.
 *
 * Deterministic mock states. NEVER connected to real provisioning:
 * real R1 provisioning remains separately owner-gated.
 */
export type RunSheetStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAILED' | 'SKIPPED';

export type RunSheetStageId =
  | 'tenant'
  | 'vercel'
  | 'deploy'
  | 'domain'
  | 'places_key'
  | 'restriction'
  | 'monitoring'
  | 'quota'
  | 'health'
  | 'device_lock'
  | 'finalize';

export interface RunSheetStage {
  id: RunSheetStageId;
  label: string;
  status: RunSheetStatus;
  detail: string;
}

export const RUN_SHEET_STAGES: readonly { id: RunSheetStageId; label: string }[] = Object.freeze([
  { id: 'tenant', label: 'Create tenant identity' },
  { id: 'vercel', label: 'Create isolated Vercel project' },
  { id: 'deploy', label: 'Deploy approved Lead Finder release' },
  { id: 'domain', label: 'Bind exact customer subdomain' },
  { id: 'places_key', label: 'Configure customer Places API key' },
  { id: 'restriction', label: 'Verify exact Website Restriction' },
  { id: 'monitoring', label: 'Connect Shared Monitoring' },
  { id: 'quota', label: 'Verify monthly quota policy' },
  { id: 'health', label: 'Run health / smoke checks' },
  { id: 'device_lock', label: 'Verify device access policy' },
  { id: 'finalize', label: 'Finalize Control Plane customer record' },
]);

export function createRunSheet(): RunSheetStage[] {
  return RUN_SHEET_STAGES.map((stage) => ({
    ...stage,
    status: 'PENDING',
    detail: 'Not started',
  }));
}

export type RunSheetOutcome = 'CUSTOMER_READY' | 'FAILED' | 'IN_PROGRESS';

export interface RunSheetState {
  stages: RunSheetStage[];
  outcome: RunSheetOutcome;
  failedStageId: RunSheetStageId | null;
}

export function runSheetState(stages: RunSheetStage[]): RunSheetState {
  const failed = stages.find((stage) => stage.status === 'FAILED');
  if (failed) return { stages, outcome: 'FAILED', failedStageId: failed.id };
  const allPassed = stages.every((stage) => stage.status === 'PASS');
  if (allPassed) return { stages, outcome: 'CUSTOMER_READY', failedStageId: null };
  return { stages, outcome: 'IN_PROGRESS', failedStageId: null };
}

export const RUN_SHEET_SUCCESS_DETAILS: Record<RunSheetStageId, string> = Object.freeze({
  tenant: 'Tenant identity created',
  vercel: 'Vercel project created',
  deploy: 'Deployment READY',
  domain: 'Domain connected',
  places_key: 'Places key configured',
  restriction: 'Website restriction verified',
  monitoring: 'Shared Monitoring connected',
  quota: 'Quota policy 1000 / 850 / 900 (SAFETY STOP) verified',
  health: 'Health checks passed',
  device_lock: 'DEVICE ACCESS POLICY VERIFIED — 2 DEVICE LIMIT ACTIVE',
  finalize: 'Customer record finalized',
});

/**
 * Deterministic mock advancement: runs one step at a time.
 * - `advanceOne` marks the current RUNNING stage PASS (or starts the next PENDING stage).
 * - `advanceOne({ failAt })` marks the given stage FAILED for the failure-path test.
 * No external side effects — UI mock only.
 */
export function advanceRunSheet(
  stages: RunSheetStage[],
  options?: { failAt?: RunSheetStageId; skipFrom?: RunSheetStageId },
): RunSheetStage[] {
  const next = stages.map((stage) => ({ ...stage }));
  const runningIndex = next.findIndex((stage) => stage.status === 'RUNNING');
  const targetIndex = runningIndex >= 0 ? runningIndex : next.findIndex((stage) => stage.status === 'PENDING');

  if (targetIndex < 0) return next; // everything done

  if (options?.failAt && next[targetIndex].id === options.failAt) {
    next[targetIndex] = { ...next[targetIndex], status: 'FAILED', detail: 'Stage failed — STOP forward execution' };
    return next;
  }

  if (runningIndex >= 0) {
    next[runningIndex] = {
      ...next[runningIndex],
      status: 'PASS',
      detail: RUN_SHEET_SUCCESS_DETAILS[next[runningIndex].id],
    };
    const nextPending = next.findIndex((stage) => stage.status === 'PENDING');
    if (nextPending >= 0) {
      next[nextPending] = { ...next[nextPending], status: 'RUNNING', detail: 'Running…' };
    }
    return next;
  }

  // first step: start it
  next[targetIndex] = { ...next[targetIndex], status: 'RUNNING', detail: 'Running…' };
  return next;
}

/** Skips the remaining stages from `from` onward (e.g. quota verification skipped). */
export function skipRunSheetFrom(stages: RunSheetStage[], from: RunSheetStageId): RunSheetStage[] {
  const fromIndex = stages.findIndex((stage) => stage.id === from);
  if (fromIndex < 0) return stages.map((stage) => ({ ...stage }));
  return stages.map((stage, index) =>
    index >= fromIndex ? { ...stage, status: 'SKIPPED', detail: 'Skipped' } : { ...stage },
  );
}
