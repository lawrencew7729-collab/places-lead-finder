import { describe, expect, it } from 'vitest';
import { configureOwnerThresholds, createWizardState, resumeBlockedWizard, transitionWizard, WIZARD_STEPS, type WizardOutcome } from './wizardWorkflow';

const tenantId = '11111111-1111-4111-8111-111111111111';
const at = '2026-08-24T10:00:00.000Z';

describe('approved 0–21 wizard state machine', () => {
  it('represents every approved plan step exactly once', () => {
    expect(WIZARD_STEPS.map((item) => item.id)).toEqual(Array.from({ length: 22 }, (_, index) => index));
  });

  it('prevents invalid skip and requires explicit resume after STOP/BLOCKED', () => {
    const initial = createWizardState(tenantId);
    expect(() => transitionWizard(initial, 1, { outcome: 'pass', at })).toThrow(/skip/i);
    const blocked = transitionWizard(initial, 0, { outcome: 'unknown', at });
    expect(blocked.status).toBe('blocked');
    expect(() => transitionWizard(blocked, 0, { outcome: 'pass', at })).toThrow(/explicitly resumed/i);
    expect(resumeBlockedWizard(blocked).status).toBe('in_progress');
  });

  it('validates owner-configured thresholds and requires them before activation review', () => {
    const state = createWizardState(tenantId);
    expect(() => configureOwnerThresholds(state, 95, 90)).toThrow();
    expect(configureOwnerThresholds(state, 70, 90).ownerThresholds).toEqual({ amberPercent: 70, redPercent: 90 });
    const review = { ...state, currentStep: 20, completedSteps: Array.from({ length: 20 }, (_, index) => index) };
    expect(() => transitionWizard(review, 20, { outcome: 'pass', at })).toThrow(/owner-configured/i);
  });


  it.each(['pass', 'fail', 'warning', 'unknown'] as WizardOutcome[])('keeps every P0 step 21 %s attempt fixed BLOCKED_BY_P0_GATE and never LIVE', (outcome) => {
    const state = { ...configureOwnerThresholds(createWizardState(tenantId), 70, 90), currentStep: 21, completedSteps: Array.from({ length: 21 }, (_, index) => index) };
    const result = transitionWizard(state, 21, { outcome, at, liveConfirmedBy: 'op-admin' });
    expect(result.status).toBe('blocked');
    expect(result.blockReason).toBe('BLOCKED_BY_P0_GATE');
    expect(result.evidence[21]?.outcome).toBe(outcome);
  });

  it('does not accept a caller-asserted Step 20 pass without an issued readiness decision', () => {
    const state = { ...configureOwnerThresholds(createWizardState(tenantId), 70, 90), currentStep: 20, completedSteps: Array.from({ length: 20 }, (_, index) => index) };
    const result = transitionWizard(state, 20, { outcome: 'pass', at });
    expect(result.status).toBe('blocked');
    expect(result.blockReason).toBe('AUTHORITATIVE_READINESS_BOUNDARY_NOT_CONNECTED');
  });
});
