# Phase 2 Gate P0 Task List

## 已完成 — local functional

- [x] Read-only Git baseline / production HTTP+bytes+SHA-256 before snapshot
- [x] PGlite ordered migration execution (`001` then `002`)
- [x] Migration checksum verification and no unapproved 80/95 defaults
- [x] RED + UNKNOWN infrastructure blocking contract
- [x] Exact Lead Finder customer hostname/restriction contract
- [x] UUID v4 immutable Tenant ID contract
- [x] Provider/server adapter fingerprint provenance contract；UI 无 provenance 输入/声明
- [x] Active admin/operator mock authorization contract
- [x] Mock provider timeout / permission / failure / timestamp / UNKNOWN behavior
- [x] Local atomic-shaped repository, idempotency, isolation, rollback, checkpoint save/resume
- [x] Wizard 0–21 state model, invalid-skip prevention, BLOCKED/resume, owner thresholds；step 20 fail-closed，P0 step 21 固定 BLOCKED_BY_P0_GATE / never LIVE
- [x] No raw secret in DOM, browser storage, repository, logs or screenshots
- [x] Desktop/mobile local visual evidence with Wizard DOM verification
- [x] Standard tests, typecheck, lint, build, npm audit, checksum and secret scan
- [x] Read-only production after snapshot and non-regression comparison
- [x] Independent local code/security review and P0 remediation
- [x] Standalone owner review package（`PHASE-2-GATE-S1-REVIEW-PACKAGE.md`，名称保留但 **不请求 S1**）

## Sample / mock / not connected

- [x] Provider responses：**MOCK sample**，无 Google/Vercel network connection
- [x] Operator：**MOCK active admin**，无 real Supabase Auth
- [x] Repository：**in-memory only**，无 browser storage、database 或 external persistence
- [x] Wizard save：**local draft only**，不会 provision、activate、deploy 或 bind domain

## BLOCKED / later gate

- [ ] Gate S0：authenticated read-only verification of exact Supabase project name/ref/org/region/clean state/backup capability
- [ ] Gate S1：first real migration（S0 通过且另行批准后）
- [ ] Gate S2：first real operator
- [ ] Gate C1：privileged credentials
- [ ] Gate T1：real sandbox provider mutation
- [ ] Gate D1：production Dashboard deployment/domain
- [ ] Gate R1：first real customer
- [ ] Gate E1：any existing production customer change
- [ ] PITR：optional paid feature，须单独 cost approval；本轮未启用

## Exact next action

仅执行 **Gate S0 authenticated read-only identity verification**。由于 S0 identity 未验证，**S1 unavailable，不请求 S1 approval**。
