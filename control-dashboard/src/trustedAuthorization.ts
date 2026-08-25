/**
 * Production authentication boundary tombstone.
 *
 * No fixed local admin session or mock authentication bootstrap is exported to
 * browser/application code. Real USER identity will be supplied by trusted
 * Supabase Auth plus the active Control Plane operator profile.
 */
export {};
