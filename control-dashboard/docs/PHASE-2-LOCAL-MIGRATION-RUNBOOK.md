# Phase 2 Local Migration Runbook

> Status: prepared and tested locally under Gate P0. **Do not apply to any remote Supabase project until Gate S0 and Gate S1 are separately approved.**

## Ordered bundle

| Order | Migration | Purpose | SHA-256 |
|---:|---|---|---|
| 1 | `001_phase1_foundation.sql` | Additive clean control-plane foundation | `ca91df0379296f8138d6d357324f4aa7cf4a497fdcb478052da65a3cdcb7c7da` |
| 2 | `002_phase2_quota_policy.sql` | Remove unapproved AMBER/RED database defaults | `92fd759a50a4590b0cb09259a4fff2b71b4e74ccac6d33aa8fe85d45c05b5311` |

`002` preserves the approved monthly target of 1,000 and requires each tenant insert to supply owner-configured AMBER and RED percentages. It does not select threshold values.

## Local verification

Run from `control-dashboard/`:

```bash
(cd supabase/migrations && sha256sum -c SHA256SUMS)
npx vitest run src/schema.test.ts src/schema.integration.test.ts --maxWorkers=1 --fileParallelism=false
```

The PGlite integration test creates a local PostgreSQL-compatible database, applies `001` then `002`, verifies the tables, and confirms both threshold column defaults are `NULL`.

## Gate S0 prerequisites

Before the target can be treated as verified, independently capture the exact `lead-finder-control-plane` project name, ref, organization/account, region, health, schema, Auth, Storage, Edge Functions, billing tier and backup/export capability. PITR remains optional and must not be activated.

## Gate S1 prerequisites

Before any remote migration:

1. Obtain explicit Gate S1 approval naming the verified project ref.
2. Re-run SHA-256 and local tests against the exact reviewed bundle.
3. Capture a logical pre-change export if the target is not completely empty; unexpected useful data is a STOP condition.
4. Confirm no production customer database or runtime is in scope.
5. Apply the ordered bundle once, then perform read-back verification and record redacted evidence.

## Recovery baseline

Supabase Free is permitted. Recovery is Git migrations + local PostgreSQL/PGlite tests + logical exports + restore/recreate. A separate remote staging project is optional. Supabase Pro daily backups may be reviewed later. PITR requires separate owner approval and cost review.
