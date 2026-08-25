export type OperatorRole = 'admin' | 'operator' | 'viewer' | 'release_manager';
export type OperatorAction = 'start_onboarding' | 'manage_onboarding' | 'approve_release' | 'manage_operators' | 'read';

export interface MockOperator { id: string; role: OperatorRole; active: boolean }
export type OperatorIdentity = MockOperator;

const permissions: Record<OperatorRole, ReadonlySet<OperatorAction>> = {
  admin: new Set(['start_onboarding', 'manage_onboarding', 'approve_release', 'manage_operators', 'read']),
  operator: new Set(['start_onboarding', 'manage_onboarding', 'read']),
  viewer: new Set(['read']),
  release_manager: new Set(['approve_release', 'read']),
};

/** Local mock contract only. Real Supabase Auth remains behind Gate S0/S2. */
export function authorizeOperator(operator: MockOperator | null, action: OperatorAction): boolean {
  return Boolean(operator?.active && permissions[operator.role].has(action));
}

export function requireOperator(operator: MockOperator | null, action: OperatorAction): MockOperator {
  if (!authorizeOperator(operator, action)) throw new Error('BLOCKED: active authorized operator required');
  return operator!;
}
