import { createQuotaPolicy, validateTenantId, type Signal } from './domain';

export type WizardOutcome = 'pass' | 'warning' | 'fail' | 'unknown';
export type WizardStatus = 'in_progress' | 'blocked' | 'ready_for_live_confirmation' | 'live';

export const WIZARD_STEPS = [
  'Authorization check', 'Company identity', 'Generate Tenant ID', 'Confirm exact hostname',
  'Save atomic draft', 'Google Project ID', 'Verify billing', 'Verify Places API',
  'Establish key securely', 'Record server fingerprint metadata', 'Generate exact restriction',
  'Verify website restriction', 'Choose monitoring mode', 'Verify monitoring access',
  'Select approved release', 'Map independent Vercel project', 'Inject environment names',
  'Deploy immutable artifact', 'Bind exact domain', 'Run readiness checks',
  'Review activation summary', 'Activate LIVE',
].map((label, id) => Object.freeze({ id, label })) as ReadonlyArray<Readonly<{ id: number; label: string }>>;

export interface StepEvidence {
  outcome: WizardOutcome;
  at: string;
  liveConfirmedBy?: string;
  diagnosticReason?: string;
  readinessDecision?: unknown;
}

export interface WizardState {
  tenantId: string;
  currentStep: number;
  completedSteps: number[];
  status: WizardStatus;
  blockReason: string | null;
  evidence: Partial<Record<number, StepEvidence>>;
  ownerThresholds: { amberPercent: number; redPercent: number } | null;
}

export interface ProviderEvidence {
  tenantId: string;
  kind: string;
  signal: Signal;
  measurementTimestamp: string;
  collectionTimestamp: string;
}

function requireTimestamp(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error('Valid provider evidence timestamp required');
  return new Date(value).toISOString();
}

export function createWizardState(tenantId: string): WizardState {
  if (!validateTenantId(tenantId)) throw new Error('Immutable UUID Tenant ID required');
  return { tenantId, currentStep: 0, completedSteps: [], status: 'in_progress', blockReason: null, evidence: {}, ownerThresholds: null };
}

export function configureOwnerThresholds(state: WizardState, amberPercent: number, redPercent: number): WizardState {
  const policy = createQuotaPolicy({ amberPercent, redPercent, enforcementMode: 'warn_only' });
  return { ...state, ownerThresholds: { amberPercent: policy.amberPercent, redPercent: policy.redPercent } };
}

export function transitionWizard(state: WizardState, step: number, evidence: StepEvidence): WizardState {
  if (state.status === 'live') throw new Error('BLOCKED: LIVE workflow is immutable');
  if (state.status === 'blocked') throw new Error('BLOCKED workflow must be explicitly resumed before transition');
  if (step !== state.currentStep) throw new Error(`Invalid skip: expected step ${state.currentStep}, received ${step}`);
  if (step < 0 || step > 21) throw new Error('Invalid wizard step');
  const at = requireTimestamp(evidence.at);
  if (step === 21) {
    const diagnosticReason = evidence.diagnosticReason ?? (evidence.outcome === 'pass' ? 'P0 activation is not authorized' : `Underlying readiness outcome: ${evidence.outcome.toUpperCase()}`);
    return { ...state, status: 'blocked', blockReason: 'BLOCKED_BY_P0_GATE', evidence: { ...state.evidence, [step]: { ...evidence, diagnosticReason, at } } };
  }
  if (step === 20) {
    if (!state.ownerThresholds) throw new Error('Owner-configured AMBER/RED thresholds required before activation review');
    return { ...state, status: 'blocked', blockReason: 'AUTHORITATIVE_READINESS_BOUNDARY_NOT_CONNECTED', evidence: { ...state.evidence, [step]: { ...evidence, diagnosticReason: 'Trusted backend readiness capability is not connected to the browser runtime', at } } };
  }
  if (evidence.outcome === 'fail' || evidence.outcome === 'unknown') {
    return { ...state, status: 'blocked', blockReason: `BLOCKED at step ${step}: ${evidence.outcome.toUpperCase()}`, evidence: { ...state.evidence, [step]: { ...evidence, at } } };
  }
  if (evidence.outcome === 'warning') {
    return { ...state, status: 'blocked', blockReason: `BLOCKED at step ${step}: operator review required`, evidence: { ...state.evidence, [step]: { ...evidence, at } } };
  }
  if (step >= 20 && !state.ownerThresholds) throw new Error('Owner-configured AMBER/RED thresholds required before activation review');
  const completedSteps = state.completedSteps.includes(step) ? state.completedSteps : [...state.completedSteps, step];
  return {
    ...state,
    currentStep: step + 1,
    completedSteps,
    status: step === 20 ? 'ready_for_live_confirmation' : 'in_progress',
    blockReason: null,
    evidence: { ...state.evidence, [step]: { ...evidence, at } },
  };
}

export function resumeBlockedWizard(state: WizardState): WizardState {
  if (state.status !== 'blocked') return state;
  return { ...state, status: 'in_progress', blockReason: null };
}

export function recordProviderEvidence(tenantId: string, kind: string, signal: Signal, measurementTimestamp: string, collectionTimestamp: string): ProviderEvidence {
  if (!validateTenantId(tenantId)) throw new Error('UUID Tenant ID required');
  const measurement = requireTimestamp(measurementTimestamp);
  const collection = requireTimestamp(collectionTimestamp);
  if (Date.parse(measurement) > Date.parse(collection)) throw new Error('Measurement cannot occur after collection');
  return { tenantId, kind, signal, measurementTimestamp: measurement, collectionTimestamp: collection };
}
