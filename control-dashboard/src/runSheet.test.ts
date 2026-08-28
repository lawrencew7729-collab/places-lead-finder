import { describe, expect, it } from 'vitest';
import { advanceRunSheet, createRunSheet, runSheetState, RUN_SHEET_STAGES, skipRunSheetFrom } from './runSheet';

const STAGE_IDS_15 = [
  'tenant', 'vercel', 'wif', 'env', 'places_key', 'acl', 'deploy', 'domain',
  'restriction', 'iam', 'quota', 'usage_smoke', 'device_lock', 'billing', 'finalize',
];

describe('runSheet — deterministic mock state model', () => {
  it('starts with all PENDING stages', () => {
    const stages = createRunSheet();
    expect(stages).toHaveLength(15);
    expect(RUN_SHEET_STAGES.map((stage) => stage.id)).toEqual(STAGE_IDS_15);
    expect(stages.every((stage) => stage.status === 'PENDING')).toBe(true);
    expect(runSheetState(stages).outcome).toBe('IN_PROGRESS');
  });

  it('advances one stage at a time deterministically', () => {
    let stages = createRunSheet();
    stages = advanceRunSheet(stages);
    expect(stages[0].status).toBe('RUNNING');
    stages = advanceRunSheet(stages);
    expect(stages[0].status).toBe('PASS');
    expect(stages[1].status).toBe('RUNNING');
    stages = advanceRunSheet(stages);
    expect(stages[1].status).toBe('PASS');
    expect(stages[2].status).toBe('RUNNING');
  });

  it('reaches CUSTOMER_READY after all fifteen stages pass', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 25; i += 1) stages = advanceRunSheet(stages);
    expect(stages.every((stage) => stage.status === 'PASS')).toBe(true);
    expect(runSheetState(stages).outcome).toBe('CUSTOMER_READY');
    expect(runSheetState(stages).failedStageId).toBeNull();
  });

  it('records the device access policy success detail (2 DEVICE LIMIT ACTIVE)', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 16; i += 1) stages = advanceRunSheet(stages);
    const device = stages.find((s) => s.id === 'device_lock');
    expect(device?.status).toBe('PASS');
    expect(device?.detail).toBe('DEVICE ACCESS POLICY VERIFIED — 2 DEVICE LIMIT ACTIVE');
  });

  it('records successful stage details', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 2; i += 1) stages = advanceRunSheet(stages);
    expect(stages[0].detail).toBe('Tenant identity created');
  });

  it('fails closed at the exact requested stage', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 9; i += 1) stages = advanceRunSheet(stages); // restriction (index 8) now RUNNING
    stages = advanceRunSheet(stages, { failAt: 'restriction' });
    const state = runSheetState(stages);
    expect(state.outcome).toBe('FAILED');
    expect(state.failedStageId).toBe('restriction');
    expect(stages[8].status).toBe('FAILED');
    expect(stages[8].detail).toBe('Stage failed — STOP forward execution');
  });

  it('supports skipping remaining stages', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 4; i += 1) stages = advanceRunSheet(stages);
    stages = skipRunSheetFrom(stages, 'iam');
    expect(stages[9].status).toBe('SKIPPED');
    expect(stages[14].status).toBe('SKIPPED');
    expect(stages[0].status).toBe('PASS');
    expect(runSheetState(stages).outcome).toBe('IN_PROGRESS');
  });

  it('never mutates the original stages array', () => {
    const original = createRunSheet();
    const advanced = advanceRunSheet(original);
    expect(original[0].status).toBe('PENDING');
    expect(advanced).not.toBe(original);
  });
});
