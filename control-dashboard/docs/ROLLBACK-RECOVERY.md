# Dashboard Rollback and Recovery

> Phase 2 P0 status: local preparation only. Gate S0/S1 are not approved and no real Supabase project has been modified.

## Before any deployment

Phase 1 is currently an isolated folder and has not been deployed. Existing production app rollback material remains in `_guide_build/backups/pre-dashboard-20260823-102258/` and must not be removed.

## Dashboard application rollback

A Dashboard release should be an immutable artifact tied to a Git SHA. Roll back only the Dashboard Vercel project to its previous deployment. Never roll customer Vercel projects as part of a Dashboard rollback.

For the current local Phase 1 working copy, recovery is:

1. Preserve this folder as an archive/checksum if needed.
2. Remove or revert only `control-dashboard/` changes.
3. Do not reset the repository working tree globally because pre-existing `.gitignore`, `_fields.html`, and `_pricing.html` state belongs outside this Phase.

## Database recovery

Phase 2 may begin on Supabase Free. PITR is **optional**, must not be activated under P0, and requires separate owner approval plus cost review.

Before any Gate S1 migration to the exact dedicated `lead-finder-control-plane` project:

1. Pass Gate S0 identity, clean-state, billing-tier and backup/export capability verification.
2. Preserve the ordered Git migration bundle and SHA-256 manifest.
3. Execute the complete bundle against local PostgreSQL/PGlite. An additional remote disposable/test project is optional, never mandatory, and must not contain useful data.
4. Capture a logical pre-change export if the verified target is not empty; unexpected useful data is a STOP condition.
5. Record migration checksum, operator, project ref, start/end time and redacted result in the append-only change record.

Recovery baseline under Supabase Free is Git migrations + local PostgreSQL/PGlite verification + logical exports + restore/recreate. The Phase 1 foundation and Phase 2 quota correction are additive on a clean dedicated project. Do not apply either migration to an unrelated Supabase project. If migration execution fails on a clean target, stop writes, retain redacted logs, recreate the empty dedicated project or restore the verified export, and re-run only after a new Gate S1 approval decision.

If the project later moves to Supabase Pro, provider daily backups may be reviewed as an additional recovery layer. That future upgrade does not retroactively authorize PITR.

## Control-plane outage behavior

Do not redirect customer traffic through the Dashboard and do not add customer runtime dependencies on these tables. Dashboard/Supabase recovery may proceed independently while healthy customer applications continue operating.
