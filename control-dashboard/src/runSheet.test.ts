import { describe, expect, it } from 'vitest';
import { advanceRunSheet, createRunSheet, runSheetState, RUN_SHEET_STAGES, skipRunSheetFrom } from './runSheet';

describe('runSheet — deterministic mock state model', () => {
  it('starts with all PENDING stages', () => {
    const stages = createRunSheet();
    expect(stages).toHaveLength(11);
    expect(RUN_SHEET_STAGES.map((stage) => stage.id)).toEqual([
      'tenant', 'vercel', 'deploy', 'domain', 'places_key', 'restriction', 'monitoring', 'quota', 'health', 'device_lock', 'finalize',
    ]);
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

  it('reaches CUSTOMER_READY after all eleven stages pass', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 20; i += 1) stages = advanceRunSheet(stages);
    expect(stages.every((stage) => stage.status === 'PASS')).toBe(true);
    expect(runSheetState(stages).outcome).toBe('CUSTOMER_READY');
    expect(runSheetState(stages).failedStageId).toBeNull();
  });

  it('records the device access policy success detail (2 DEVICE LIMIT ACTIVE)', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 12; i += 1) stages = advanceRunSheet(stages);
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
    for (let i = 0; i < 6; i += 1) stages = advanceRunSheet(stages); // restriction now RUNNING
    stages = advanceRunSheet(stages, { failAt: 'restriction' });
    const state = runSheetState(stages);
    expect(state.outcome).toBe('FAILED');
    expect(state.failedStageId).toBe('restriction');
    expect(stages[5].status).toBe('FAILED');
    expect(stages[5].detail).toBe('Stage failed — STOP forward execution');
  });

  it('supports skipping remaining stages', () => {
    let stages = createRunSheet();
    for (let i = 0; i < 4; i += 1) stages = advanceRunSheet(stages);
    stages = skipRunSheetFrom(stages, 'monitoring');
    expect(stages[6].status).toBe('SKIPPED');
    expect(stages[10].status).toBe('SKIPPED');
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
