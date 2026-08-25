begin;

-- Hosted Supabase grants new public functions explicit EXECUTE privileges to
-- anon, authenticated, and service_role. Revoking PUBLIC alone does not remove
-- those role-specific ACL entries, so establish each audit writer ACL explicitly.

-- SYSTEM audit events are a trusted backend path only.
revoke execute on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from public;
revoke execute on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from anon;
revoke execute on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from authenticated;
revoke execute on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) from service_role;
grant execute on function public.write_system_audit_event(text, uuid, text, text, text, jsonb, jsonb, uuid) to service_role;

-- USER audit identity is derived from auth.uid() and an active operator profile.
revoke execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) from public;
revoke execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) from anon;
revoke execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) from authenticated;
revoke execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) from service_role;
grant execute on function public.write_user_audit_event(uuid, text, text, text, jsonb, jsonb, uuid, text) to authenticated;

commit;
