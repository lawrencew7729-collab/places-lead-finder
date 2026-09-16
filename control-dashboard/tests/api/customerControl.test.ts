import { describe, expect, it, vi } from 'vitest';
import { createCustomerManagementHandler } from '../../api/lib/customerControl.js';
import {
  LEGACY_LABEL, UNAVAILABLE_LABEL, classifyPortalProbe, buildCustomerRow, limitStatusOf, buildAuditEvent,
} from '../../src/staff/customerControlContract.js';

const TENANTS = [
  { tenantId: 't-1111', company: 'Alpha Sdn Bhd', subdomain: 'andrew.leadfinder.business' },
  { tenantId: 't-2222', company: 'Beta Sdn Bhd', subdomain: 'radiant.leadfinder.business' },
];
const NOW = new Date('2026-09-16T05:00:00Z');

const okState = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ok: true, state: { portalVersion: '1.0.11', package: 'STARTER_500', packageLabel: 'Starter 500', serviceStatus: 'ACTIVE', usage: 10, searchStop: 500, ...over } },
});

function deps(over: Record<string, unknown> = {}) {
  const audits: unknown[] = [];
  const base = {
    authenticate: vi.fn(async () => ({ ok: true, userId: 'user-1', role: 'operator', token: 'x' })),
    listTenants: vi.fn(async () => TENANTS),
    probePortal: vi.fn(async () => okState()),
    callPortal: vi.fn(async () => ({ status: 200, body: { ok: true, state: { portalVersion: '1.0.11', package: 'FULL_900', serviceStatus: 'ACTIVE', usage: 10, searchStop: 900 } } })),
    writeAudit: vi.fn(async (p: unknown) => { audits.push(p); return { ok: true }; }),
    mintOidcToken: vi.fn(async () => 'oidc-token'),
    now: () => NOW,
  };
  const merged = { ...base, ...over };
  return { deps: merged as never, audits, spies: base };
}

const get = () => new Request('https://dashboard.leadfinder.business/api/staff/customerControl', { method: 'GET' });
const post = (body: unknown) => new Request('https://dashboard.leadfinder.business/api/staff/customerControl', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

describe('OWNER RULE 1 — LEGACY only on positive proof; faults are UNAVAILABLE', () => {
  it('404 from the control endpoint = confirmed v1.0.10 -> LEGACY', async () => {
    const { deps: d } = deps({ probePortal: vi.fn(async () => ({ status: 404, body: null })) });
    const res = await createCustomerManagementHandler(d)(get());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(res.status).toBe(200);
    expect(body.rows.every((r) => r.state === 'LEGACY' && r.notice === LEGACY_LABEL && r.actionsEnabled === false)).toBe(true);
  });

  it('timeout / offline / 5xx / OIDC error / malformed reply = UNAVAILABLE (never LEGACY)', async () => {
    const faults = [
      { probePortal: vi.fn(async () => ({ error: 'aborted' })) },
      { probePortal: vi.fn(async () => ({ error: 'fetch failed' })) },
      { probePortal: vi.fn(async () => ({ status: 500, body: null })) },
      { probePortal: vi.fn(async () => ({ status: 502, body: null })) },
      { probePortal: vi.fn(async () => ({ status: 503, body: null })) },
      { probePortal: vi.fn(async () => ({ status: 401, body: { ok: false, error: 'jwks_unavailable' } })) },
      { probePortal: vi.fn(async () => ({ status: 200, body: { ok: true } })) },
      { probePortal: vi.fn(async () => { throw new Error('socket hang up'); }) },
    ];
    for (const fault of faults) {
      const { deps: d } = deps(fault);
      const body = (await (await createCustomerManagementHandler(d)(get())).json()) as { rows: Array<Record<string, unknown>> };
      expect(body.rows.every((r) => r.state === 'UNAVAILABLE' && r.notice === UNAVAILABLE_LABEL)).toBe(true);
      expect(body.rows.some((r) => r.state === 'LEGACY')).toBe(false);
    }
  });

  it('OIDC mint failure marks rows UNAVAILABLE (a dashboard fault is not legacy)', async () => {
    const { deps: d } = deps({ mintOidcToken: vi.fn(async () => { throw new Error('no oidc'); }) });
    const body = (await (await createCustomerManagementHandler(d)(get())).json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.every((r) => r.state === 'UNAVAILABLE')).toBe(true);
  });

  it('a healthy v1.0.11 portal reports package/usage/status and enables staff actions', async () => {
    const { deps: d } = deps({ probePortal: vi.fn(async () => okState({ usage: 510, package: 'STARTER_500' })) });
    const body = (await (await createCustomerManagementHandler(d)(get())).json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toMatchObject({
      company: 'Alpha Sdn Bhd', subdomain: 'andrew.leadfinder.business', portalVersion: '1.0.11',
      package: 'STARTER_500', packageLabel: 'Starter 500', usage: 510, serviceStatus: 'ACTIVE',
      limitStatus: 'LIMIT REACHED', state: 'V1_0_11', actionsEnabled: true, notice: null,
    });
  });

  it('classification + limit status unit rules', () => {
    expect(classifyPortalProbe({ status: 404 }).state).toBe('LEGACY');
    expect(classifyPortalProbe({ error: 'x' }).state).toBe('UNAVAILABLE');
    expect(classifyPortalProbe({ status: 200, body: { ok: true } }).state).toBe('UNAVAILABLE');
    expect(limitStatusOf('STARTER_500', 'ACTIVE', 499)).toBe('OK');
    expect(limitStatusOf('STARTER_500', 'ACTIVE', 500)).toBe('LIMIT REACHED');
    expect(limitStatusOf('FULL_900', 'ACTIVE', 899)).toBe('OK');
    expect(limitStatusOf('FULL_900', 'ACTIVE', 900)).toBe('LIMIT REACHED');
    expect(limitStatusOf('FULL_900', 'STOPPED', 0)).toBe('STOPPED');
    expect(buildCustomerRow({ tenantId: 't', company: 'c', subdomain: 's', probe: { error: 'e' } }).limitStatus).toBe('UNKNOWN');
  });
});

describe('OWNER RULE 2 — every staff action is audited', () => {
  it.each([['STOP'], ['RESUME'], ['UPGRADE_TO_FULL_900']])('%s writes one audit record with staff/customer/action/time', async (action) => {
    const { deps: d, audits } = deps();
    const res = await createCustomerManagementHandler(d)(post({ tenantId: 't-1111', action }));
    expect(res.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      p_tenant_id: 't-1111',
      p_action: 'CUSTOMER_' + action,
      p_entity_type: 'customer_service_control',
      p_entity_id: 'andrew.leadfinder.business',
    });
    const rec = audits[0] as { p_new_state_redacted: { staffUserId: string; at: string; action: string } };
    expect(rec.p_new_state_redacted.staffUserId).toBe('user-1');
    expect(rec.p_new_state_redacted.action).toBe(action);
    expect(rec.p_new_state_redacted.at).toBe(NOW.toISOString());
  });

  it('an audit write failure is surfaced (never a silent mutation)', async () => {
    const { deps: d } = deps({ writeAudit: vi.fn(async () => ({ ok: false, reason: 'rpc_403' })) });
    const res = await createCustomerManagementHandler(d)(post({ tenantId: 't-1111', action: 'STOP' }));
    expect(res.status).toBe(500);
    expect((await res.json()) as unknown).toMatchObject({ ok: false, error: 'AUDIT_WRITE_FAILED', action: 'STOP' });
  });

  it('buildAuditEvent carries actor + customer + action + timestamp (ISO)', () => {
    const ev = buildAuditEvent({ actorUserId: 'u9', tenantId: 't1', subdomain: 'x.leadfinder.business', action: 'STOP', previousState: { a: 1 }, newState: { b: 2 }, at: NOW });
    expect(ev.p_previous_state_redacted).toMatchObject({ staffUserId: 'u9', at: NOW.toISOString(), state: { a: 1 } });
    expect(ev.p_new_state_redacted).toMatchObject({ staffUserId: 'u9', at: NOW.toISOString(), state: { b: 2 } });
  });
});

describe('permissions + action whitelist', () => {
  it('unauthenticated -> 401, non-staff role -> 403', async () => {
    const unauthed = deps({ authenticate: vi.fn(async () => ({ ok: false, reason: 'UNAUTHENTICATED' })) });
    expect((await createCustomerManagementHandler(unauthed.deps)(get())).status).toBe(401);
    const viewer = deps({ authenticate: vi.fn(async () => ({ ok: true, userId: 'u', role: 'viewer' })) });
    expect((await createCustomerManagementHandler(viewer.deps)(post({ tenantId: 't-1111', action: 'STOP' }))).status).toBe(403);
  });

  it('owner-only / destructive actions are rejected and never reach the portal', async () => {
    for (const action of ['DELETE_CUSTOMER', 'DOWNGRADE_TO_STARTER_500', 'SET_LIMIT', 'CHANGE_GOLDEN']) {
      const { deps: d, spies } = deps();
      const res = await createCustomerManagementHandler(d)(post({ tenantId: 't-1111', action }));
      expect(res.status).toBe(400);
      expect(spies.callPortal).not.toHaveBeenCalled();
    }
  });

  it('unknown customer / bad method / malformed body', async () => {
    const { deps: d1 } = deps();
    expect((await createCustomerManagementHandler(d1)(post({ tenantId: 'nope', action: 'STOP' }))).status).toBe(404);
    const { deps: d2 } = deps();
    expect((await createCustomerManagementHandler(d2)(new Request('https://x/api/staff/customerControl', { method: 'DELETE' }))).status).toBe(405);
    const { deps: d3 } = deps();
    const bad = new Request('https://x/api/staff/customerControl', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect((await createCustomerManagementHandler(d3)(bad)).status).toBe(400);
  });

  it('a portal that rejects the action (e.g. legacy 404) is reported, and NOT audited', async () => {
    const { deps: d, audits } = deps({ callPortal: vi.fn(async () => ({ status: 404, body: null })) });
    const res = await createCustomerManagementHandler(d)(post({ tenantId: 't-1111', action: 'STOP' }));
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({ ok: false, error: 'PORTAL_ACTION_FAILED' });
    expect(audits).toHaveLength(0);
  });
});
