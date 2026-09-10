/**
 * TEMPORARY PROJECT-SCOPED BOOTSTRAP (owner-approved 2026-08-31; reconciled
 * 2026-09-05 for the Dashboard-cloud principal) — SHARED CONTRACT for both
 * the CLI and the cloud (Workflow → Worker) execution paths.
 *
 * NORMAL DASHBOARD-CLOUD PRINCIPAL (current contract):
 * STAFF grants the temporary roles to the CENTRAL OPERATOR-SA principal
 * (`serviceAccount:OPERATOR_SA_EMAIL` — the non-secret service-account email
 * used by the Worker identity chain: Vercel OIDC → STS →
 * iamcredentials.generateAccessToken → operator-SA). The historical
 * `admin@leadfinder.business` human principal belongs to the CLI/Jacker era
 * (HISTORICAL evidence — do not grant it during NEW-DUMMY E2E).
 *
 * ROLE SET (exactly four — the real Jacker UI proved the normal conditional
 * temporary grant used these four; `roles/viewer` is deliberately NOT
 * included: it could not carry the Expiring Access IAM condition in the real
 * Google UI, and `roles/resourcemanager.projectIamAdmin` already carries
 * `resourcemanager.projects.get` which `projects.getBillingInfo` requires).
 */
export const BOOTSTRAP_MEMBER = 'admin@leadfinder.business'; // HISTORICAL CLI member — do NOT use for Dashboard-cloud grants

/** The current Dashboard-cloud bootstrap member (non-secret SA email — value
 * arrives via the OPERATOR_SA_EMAIL server env at runtime). */
export const BOOTSTRAP_MEMBER_OPERATOR_SA = 'operator-sa@leadfinder-shared-monitoring.iam.gserviceaccount.com';

export const BOOTSTRAP_ROLES = [
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountViewer',
  'roles/monitoring.viewer',
  // projectIamAdmin LAST: removing it revokes the ability to read the project
  // policy — every earlier removal + the readback must complete before it goes.
  'roles/resourcemanager.projectIamAdmin',
] as const;

export const BOOTSTRAP_ADMIN_ROLE = 'roles/resourcemanager.projectIamAdmin';
