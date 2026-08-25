import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && publishableKey);
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export function getSupabaseClient(): SupabaseClient | null {
  return supabase;
}

export async function signInOperator(email: string, password: string) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOutOperator() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export type OperatorRole = 'admin' | 'operator' | 'viewer' | 'release_manager';

export interface OperatorProfile {
  userId: string;
  role: OperatorRole;
  active: boolean;
  displayName: string | null;
}

export type AuthResolution =
  | { ok: true; profile: OperatorProfile }
  | { ok: false; reason: 'UNAUTHENTICATED' | 'PROFILE_NOT_FOUND' | 'INACTIVE' | 'UNAUTHORIZED_ROLE' | 'RLS_ERROR' };

/**
 * Dashboard-authorized roles mirror the approved audit contract
 * (migration 003 write_user_audit_event): active admin or operator only.
 * Fail-closed: any other state is denied.
 */
const DASHBOARD_ROLES: ReadonlyArray<OperatorRole> = ['admin', 'operator'];

export async function resolveAuthorizedProfile(): Promise<AuthResolution> {
  if (!supabase) return { ok: false, reason: 'UNAUTHENTICATED' };
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return { ok: false, reason: 'UNAUTHENTICATED' };
  const user = userData.user;

  const { data, error } = await supabase
    .from('operator_profiles')
    .select('user_id, role, active, display_name')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return { ok: false, reason: 'RLS_ERROR' };
  if (!data) return { ok: false, reason: 'PROFILE_NOT_FOUND' };
  if (!data.active) return { ok: false, reason: 'INACTIVE' };
  if (!DASHBOARD_ROLES.includes(data.role as OperatorRole)) return { ok: false, reason: 'UNAUTHORIZED_ROLE' };

  return {
    ok: true,
    profile: {
      userId: data.user_id as string,
      role: data.role as OperatorRole,
      active: Boolean(data.active),
      displayName: (data.display_name as string | null) ?? null,
    },
  };
}

/** Subscribes to Supabase auth state changes; returns an unsubscribe function. */
export function subscribeToAuthChanges(listener: (hasSession: boolean) => void): () => void {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    listener(Boolean(session?.user));
  });
  return () => data.subscription.unsubscribe();
}
