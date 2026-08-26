/**
 * R1 readiness — Golden Standard release registry model.
 *
 * The ONLY eligible Golden Standard for real R1 provisioning is the exact
 * customer-app-v1.0.1 release (tag/commit/artifact all matching). The stale
 * P0-era mock (`golden-root-626c0c1`) is retired and refused.
 *
 * Registration path: Control Plane `releases` table insert via a service layer
 * that respects existing RLS/roles (admin / release_manager). The dashboard
 * itself only reads; writes happen through the provisioning service layer
 * (browser never holds privileged Supabase credentials).
 */

export interface GoldenReleaseIdentity {
  version: string;
  tag: string;
  commitSha: string;
  artifactSha256: string;
  sourcePath: string;
  status: 'candidate' | 'approved';
  createdAt?: string;
  approvedBy?: string;
  approvedAt?: string;
}

/** The stale P0 mock — explicitly ineligible for real provisioning. */
export const RETIRED_MOCK_RELEASE = Object.freeze({
  releaseId: 'golden-root-626c0c1',
  gitSha: '626c0c133e7862616ec74bb53ff0ba6f934a9e04',
  artifactSha256: 'ADAE268878B124A2134DD11ED7CB672E7636DBFA6ADC6B1CE31B752D6F43D2DF',
});

export interface ReleaseMatchResult {
  match: boolean;
  reasons: string[];
}

/** Fail-closed full match: version, tag, commit and artifact must ALL match. */
export function verifyGoldenRelease(identity: GoldenReleaseIdentity, expected: GoldenReleaseIdentity): ReleaseMatchResult {
  const reasons: string[] = [];
  if (identity.version !== expected.version) reasons.push(`version mismatch (${identity.version} ≠ ${expected.version})`);
  if (identity.tag !== expected.tag) reasons.push(`tag mismatch (${identity.tag} ≠ ${expected.tag})`);
  if (identity.commitSha !== expected.commitSha) reasons.push(`commit mismatch (${identity.commitSha.slice(0, 8)}… ≠ ${expected.commitSha.slice(0, 8)}…)`);
  if (identity.artifactSha256 !== expected.artifactSha256) reasons.push('artifact manifest mismatch');
  if (identity.status !== 'approved') reasons.push(`release not approved (${identity.status})`);
  if (identity.version === RETIRED_MOCK_RELEASE.releaseId || identity.commitSha === RETIRED_MOCK_RELEASE.gitSha) reasons.push('stale mock release refused');
  return { match: reasons.length === 0, reasons };
}

/** Missing/unknown/empty record → refuse. */
export function refuseMissingRelease(record: GoldenReleaseIdentity | null): ReleaseMatchResult {
  if (!record) return { match: false, reasons: ['missing release record'] };
  return { match: false, reasons: [`unapproved release (${record.version ?? 'unknown'})`] };
}

/**
 * Service-layer registration (RLS-compatible): inserts the approved release
 * record into `releases`. Executed server-side / via service role on the
 * provisioning path — never with browser-side privileged credentials.
 * Local verification uses an injected repository (test/local only).
 */
export interface ReleaseRepository {
  insert(identity: GoldenReleaseIdentity): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  find(tag: string): Promise<GoldenReleaseIdentity | null>;
}

export async function registerGoldenRelease(repo: ReleaseRepository, identity: GoldenReleaseIdentity): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (identity.status !== 'approved') return { ok: false, reason: 'CUSTOMER_PROVISIONING_NOT_AUTHORIZED: release not approved' };
  if (identity.version === RETIRED_MOCK_RELEASE.releaseId || identity.commitSha === RETIRED_MOCK_RELEASE.gitSha) {
    return { ok: false, reason: 'stale mock release refused' };
  }
  return repo.insert(identity);
}
