# Lead Finder Control Dashboard — Phase 1

Independent control-plane foundation for Lead Finder. It does **not** run customer searches and does not sit in the customer runtime path.

## Phase 1 scope

- Supabase Auth login/session lifecycle
- Tenant/customer/deployment registry schema
- Immutable release manifest schema
- Health, alerts and infrastructure status schema
- Append-only audit model
- Responsive dashboard review UI
- No provisioning, verification, deployment, rollout or rollback actions are enabled

## Safety properties

- Existing customer apps do not call this dashboard or its Supabase project.
- Raw Places keys and dedicated monitoring JSON are never stored in shared tables. Only a fingerprint and opaque server-side secret reference are permitted.
- Production build excludes the local `OPEN FOUNDATION REVIEW` bypass.
- `RED` infrastructure gate blocks future provisioning only; it never stops healthy deployments.
- Monitoring failures are modelled independently from customer search runtime health.

## Local review

```bash
npm install
npm run dev
```

Open the local URL and choose **OPEN FOUNDATION REVIEW**. All records shown in review mode are labelled SAMPLE DATA and are fictional.

## Production authentication configuration

1. Create a **dedicated Supabase project** for the Lead Finder control plane.
2. Apply `supabase/migrations/001_phase1_foundation.sql`.
3. Create the first Supabase Auth user and insert its `auth.users.id` into `public.operator_profiles` as `admin` using a trusted server-side/admin session.
4. Copy `.env.example` to `.env.local` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
5. Never put service-role keys, customer Places keys, JSON credentials or admin secrets in `VITE_*` values.

Until a dedicated project is approved and configured, production Supabase authentication remains intentionally unactivated.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm audit
```

The migration integration test executes the complete SQL against embedded PostgreSQL (PGlite), including extensions, triggers, constraints, indexes and RLS policy DDL.

## Phase boundary

Phase 1 contains no Vercel project creation, customer ENV mutation, domain binding, deployment, Google API probe, monitoring grant, production import or customer app change. Those remain disabled pending explicit approval for later phases.
