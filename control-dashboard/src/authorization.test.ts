import { describe, expect, it } from 'vitest';
import { authorizeOperator, type OperatorIdentity } from './authorization';

const admin: OperatorIdentity = { id: 'op-admin', role: 'admin', active: true };
const operator: OperatorIdentity = { id: 'op-operator', role: 'operator', active: true };

describe('local operator authorization contract', () => {
  it('allows active admin/operator to start onboarding', () => {
    expect(authorizeOperator(admin, 'start_onboarding')).toBe(true);
    expect(authorizeOperator(operator, 'start_onboarding')).toBe(true);
  });

  it('denies inactive, viewer, missing identity, and operator-management escalation', () => {
    expect(authorizeOperator({ ...admin, active: false }, 'start_onboarding')).toBe(false);
    expect(authorizeOperator({ id: 'viewer', role: 'viewer', active: true }, 'start_onboarding')).toBe(false);
    expect(authorizeOperator(null, 'start_onboarding')).toBe(false);
    expect(authorizeOperator(operator, 'manage_operators')).toBe(false);
    expect(authorizeOperator(admin, 'manage_operators')).toBe(true);
  });
});
