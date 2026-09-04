/**
 * TEMPORARY BOOTSTRAP CLEANUP + PROJECT-SIDE BILLING — adapter-level tests.
 * Covers: getBillingInfo verification, exact-role/member removal, etag/condition
 * preservation, idempotency, readback, and empty-binding removal.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGoogleAdapter } from './adapters';
import { BOOTSTRAP_ROLES } from './operatorCli';

type Call = { url: string; init?: { method?: string; body?: string } };

function makeAdapter(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const adapter = createGoogleAdapter({
    accessTokenProvider: async () => 'fake-token',
    transport: async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init as { method?: string; body?: string } | undefined });
      const { status, body } = handler({ url, init: init as { method?: string; body?: string } | undefined });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    },
  });
  return { adapter, calls };
}

const PROJECT = 'jacker-507201';
const MEMBER = 'admin@leadfinder.business';
const ETAG = 'BwV_ABC123==';

describe('project-side billing verification (getBillingInfo — no billing-account IAM)', () => {
  it('PASS when projectId + billingAccountName + billingEnabled=true all match', async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: { projectId: PROJECT, billingAccountName: 'billingAccounts/01B61E-759031-B494E4', billingEnabled: true },
    }));
    const r = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', PROJECT);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain(`/v1/projects/${PROJECT}/billingInfo`);
  });

  it('FAIL when the linked billing account differs', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: { projectId: PROJECT, billingAccountName: 'billingAccounts/OTHER-ACCOUNT', billingEnabled: true },
    }));
    const r = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', PROJECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('billing account mismatch');
  });

  it('FAIL when billingEnabled is false (account not open/active)', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: { projectId: PROJECT, billingAccountName: 'billingAccounts/01B61E-759031-B494E4', billingEnabled: false },
    }));
    const r = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', PROJECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('billingEnabled ≠ true');
  });

  it('FAIL when project identity differs', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: { projectId: 'wrong-project', billingAccountName: 'billingAccounts/01B61E-759031-B494E4', billingEnabled: true },
    }));
    const r = await adapter.verifyBillingIsolation('01B61E-759031-B494E4', PROJECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('project identity mismatch');
  });
});

describe('removeExactRoleBinding (exact-role/member, etag-safe, conditions preserved)', () => {
  const IAM_POLICY = {
    version: 3,
    etag: ETAG,
    bindings: [
      { role: 'roles/iam.serviceAccountAdmin', members: [MEMBER, 'serviceAccount:mon@proj.iam.gserviceaccount.com'] },
      { role: 'roles/viewer', members: ['user:other@example.com'] },
      {
        role: 'roles/monitoring.viewer',
        members: ['user:someone@example.com'],
        condition: { title: 'expiry', expression: "resource.expiry_time < timestamp('2026-09-02T00:00:00Z')" },
      },
    ],
  };

  it('removes ONLY the exact member; keeps other members, other roles and conditions; writes back the SAME etag', async () => {
    let iamState = JSON.parse(JSON.stringify(IAM_POLICY));
    const { adapter, calls } = makeAdapter((call) => {
      if (call.url.includes(':getIamPolicy')) return { status: 200, body: iamState };
      if (call.url.includes(':setIamPolicy')) {
        const sent = JSON.parse((call.init as { body: string }).body) as { policy: typeof IAM_POLICY; updateMask: string };
        iamState = sent.policy;
        return { status: 200, body: sent.policy };
      }
      return { status: 404, body: {} };
    });
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/iam.serviceAccountAdmin', MEMBER);
    expect(r.ok).toBe(true);
    const setCall = calls.find((c) => c.url.includes(':setIamPolicy'))!;
    const sent = JSON.parse((setCall.init as { body: string }).body) as { policy: typeof IAM_POLICY; updateMask: string };
    expect(sent.policy.etag).toBe(ETAG); // etag preserved (optimistic concurrency)
    expect(sent.updateMask).toBe('bindings,etag');
    const admin = sent.policy.bindings.find((b) => b.role === 'roles/iam.serviceAccountAdmin')!;
    expect(admin.members).toEqual(['serviceAccount:mon@proj.iam.gserviceaccount.com']); // exact member removed, other kept
    // untouched bindings survive byte-for-byte
    const cond = sent.policy.bindings.find((b) => b.role === 'roles/monitoring.viewer')!;
    expect(cond.condition?.expression).toContain('resource.expiry_time');
    expect(sent.policy.bindings.find((b) => b.role === 'roles/viewer')?.members).toEqual(['user:other@example.com']);
  });

  it('idempotent: member already absent → ok and NO setIamPolicy call', async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: IAM_POLICY }));
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/iam.serviceAccountAdmin', 'user:ghost@example.com');
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.url.includes(':setIamPolicy')).length).toBe(0);
  });

  it('removes an empty binding entirely (no dangling role)', async () => {
    let iamState = JSON.parse(JSON.stringify(IAM_POLICY));
    const { adapter, calls } = makeAdapter((call) => {
      if (call.url.includes(':getIamPolicy')) return { status: 200, body: iamState };
      if (call.url.includes(':setIamPolicy')) {
        const sent = JSON.parse((call.init as { body: string }).body) as { policy: typeof IAM_POLICY };
        iamState = sent.policy;
        return { status: 200, body: sent.policy };
      }
      return { status: 404, body: {} };
    });
    // role with ONLY the member → binding must disappear after removal
    iamState.bindings.push({ role: 'roles/iam.serviceAccountViewer', members: [MEMBER] });
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/iam.serviceAccountViewer', MEMBER);
    expect(r.ok).toBe(true);
    const sent = JSON.parse((calls.find((c) => c.url.includes(':setIamPolicy'))!.init as { body: string }).body) as { policy: typeof IAM_POLICY };
    expect(sent.policy.bindings.find((b) => b.role === 'roles/iam.serviceAccountViewer')).toBeUndefined();
  });
});

describe('verifyBootstrapRolesAbsent (authoritative readback)', () => {
  it('PASS when every listed role no longer contains the member', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: { version: 3, etag: ETAG, bindings: [{ role: 'roles/viewer', members: ['user:other@example.com'] }] },
    }));
    const r = await adapter.verifyBootstrapRolesAbsent(PROJECT, ['roles/iam.serviceAccountAdmin', 'roles/viewer'], MEMBER);
    expect(r.ok).toBe(true);
  });

  it('FAIL and names the exact residual role when the member is still bound', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: { version: 3, etag: ETAG, bindings: [{ role: 'roles/monitoring.viewer', members: [MEMBER] }] },
    }));
    const r = await adapter.verifyBootstrapRolesAbsent(PROJECT, ['roles/iam.serviceAccountAdmin', 'roles/monitoring.viewer'], MEMBER);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('roles/monitoring.viewer');
  });

  it('user:-prefixed member matches a BARE email argument (root cause 2026-09-04: cleanup removed nothing)', async () => {
    let iamState = {
      version: 3,
      etag: 'BwZ_live01==',
      bindings: [
        { role: 'roles/iam.serviceAccountAdmin', members: ['user:admin@leadfinder.business'] },
      ],
    };
    const { adapter } = makeAdapter((call) => {
      if (call.url.includes(':getIamPolicy')) return { status: 200, body: iamState };
      if (call.url.includes(':setIamPolicy')) {
        const sent = JSON.parse((call.init as { body: string }).body) as { policy: typeof iamState };
        iamState = sent.policy;
        return { status: 200, body: sent.policy };
      }
      return { status: 404, body: {} };
    });
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/iam.serviceAccountAdmin', 'admin@leadfinder.business');
    expect(r.ok).toBe(true);
    expect(iamState.bindings.find((b) => b.role === 'roles/iam.serviceAccountAdmin')).toBeUndefined(); // actually removed
  });

  it('same role with MULTIPLE bindings: removes ONLY the admin@ conditional binding; unrelated SA binding survives (monitoring.viewer regression)', async () => {
    let iamState = {
      version: 3,
      etag: 'BwZ_live02==',
      bindings: [
        { role: 'roles/monitoring.viewer', members: ['serviceAccount:lf-monitor-abc@jacker-507201.iam.gserviceaccount.com'] },
        { role: 'roles/monitoring.viewer', members: ['user:admin@leadfinder.business'], condition: { title: 'Lead Finder Bootstrap', expression: 'request.time < timestamp("2026-09-04T06:15:00Z")' } },
      ],
    };
    const { adapter } = makeAdapter((call) => {
      if (call.url.includes(':getIamPolicy')) return { status: 200, body: iamState };
      if (call.url.includes(':setIamPolicy')) {
        const sent = JSON.parse((call.init as { body: string }).body) as { policy: typeof iamState };
        iamState = sent.policy;
        return { status: 200, body: sent.policy };
      }
      return { status: 404, body: {} };
    });
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/monitoring.viewer', 'admin@leadfinder.business');
    expect(r.ok).toBe(true);
    const remaining = iamState.bindings.filter((b) => b.role === 'roles/monitoring.viewer');
    expect(remaining.length).toBe(1); // only the SA binding survives
    expect(remaining[0].members).toEqual(['serviceAccount:lf-monitor-abc@jacker-507201.iam.gserviceaccount.com']);
  });

  it('FAILS when the setIamPolicy RESPONSE still contains the member (false REMOVED impossible)', async () => {
    const { adapter } = makeAdapter((call) => {
      if (call.url.includes(':getIamPolicy')) {
        return { status: 200, body: { version: 3, etag: 'BwZ_live03==', bindings: [{ role: 'roles/monitoring.viewer', members: ['user:admin@leadfinder.business'] }] } };
      }
      if (call.url.includes(':setIamPolicy')) {
        // adversarial server: 200 but the member is still in the returned policy
        return { status: 200, body: { version: 3, etag: 'BwZ_live03==', bindings: [{ role: 'roles/monitoring.viewer', members: ['user:admin@leadfinder.business'] }] } };
      }
      return { status: 404, body: {} };
    });
    const r = await adapter.removeExactRoleBinding(PROJECT, 'roles/monitoring.viewer', 'admin@leadfinder.business');
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { reason: string }).reason).toContain('still bound');
  });

  it('cleanup removes projectIamAdmin LAST (revoking policy-read must be the final step)', async () => {
    const roles = [...BOOTSTRAP_ROLES];
    expect(roles[roles.length - 1]).toBe('roles/resourcemanager.projectIamAdmin');
    expect(roles).toEqual(['roles/iam.serviceAccountAdmin', 'roles/iam.serviceAccountViewer', 'roles/monitoring.viewer', 'roles/viewer', 'roles/resourcemanager.projectIamAdmin']);
  });
});
