# Phase 1 Architecture Record

## Runtime boundary

```text
Operator → Control Dashboard → Dedicated Supabase control plane

Customer browser → Independent customer Vercel deployment → Customer Google Places project/billing
```

There is deliberately no arrow from customer runtime to Supabase. Dashboard or Supabase downtime does not become a customer search outage.

## Authentication

- Supabase Auth email/password.
- `operator_profiles` maps `auth.users.id` to admin/operator/viewer/release_manager.
- RLS is enabled on every control-plane table.
- A `SECURITY DEFINER` role helper has a fixed `search_path`, has PUBLIC execution revoked, and is granted only to `authenticated`.
- Local review mode is compiled only when `import.meta.env.DEV` is true.

## Tenant identity

`tenants.id` is UUID-generated and immutable. `slug` and `exact_subdomain` are also immutable after creation to prevent cross-customer remapping. A later controlled migration—not an ordinary edit—is required to change identity.

## Customer configuration

Tracks onboarding and diagnostic state without retaining raw secrets:

- exact subdomain and exact future website restriction
- Google Project ID
- Places key fingerprint/status
- billing, API enablement and restriction status
- shared-access or dedicated-credential monitoring mode/status
- dedicated credential **secret reference only**
- configurable 1,000 monthly target and AMBER/RED threshold percentages
- telemetry-delay declaration and enforcement policy
- Vercel deployment/version references
- device/login and LIVE verification states

## Release model

An approved release binds version + Git SHA + artifact SHA-256 + artifact URI. A trigger prevents artifact identity mutation after approval. Any changed artifact requires a new release identity. Deployments retain a rollback deployment reference per tenant.

## Health and alert model

Health categories cover API key, Places enablement, restriction, billing, monitoring, quota, deployment, domain/HTTPS, login/device, app version, XLSX export, external provider and control-plane faults. Alerts may target one tenant or one infrastructure pool. No alert handler is active in Phase 1.

## Infrastructure model

Limits are nullable and provider-reported. No fixed Vercel/GitHub fleet maximum is fabricated. Pool status is GREEN/AMBER/RED/UNKNOWN. RED sets `allow_new_provisioning=false`; a database constraint preserves `keep_healthy_deployments_running=true`.

## Commercial model

Default annual revenue is MYR 1,500 and generated monthly equivalent is MYR 125. Values are configurable in `commercial_settings`; they are not permanent application constants.

## Customer-facing branding decision

Future approved Golden Standard release must use header **LEAD FINDER**, replacing **PLACES // LEAD FINDER**. Phase 1 deliberately does not modify current customer apps or their visual baseline.
