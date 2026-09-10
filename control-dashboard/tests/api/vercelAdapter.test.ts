/**
 * Vercel createProject — 409 bounded reconciliation (2026-09-08).
 *
 * Real NEW-DUMMY2 evidence: the Dashboard bootstrap created
 * `lf-customer-new-dummy2` and wrote secrets; the immediately-following
 * Workflow createProject search did NOT yet return it, so POST create hit 409
 * and the run FAILED in infra. Fix: on 409 ONLY, perform ONE authoritative
 * reconciliation read for the EXACT expected name; if it now exists, REUSE its
 * real project id (never a broad 409 swallow, never a differently-named
 * project, never a retry loop).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVercelAdapter } from '../../src/provisioning/adapters.js';

interface TransportCall {
  url: string;
  method?: string;
  body?: unknown;
}

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function makeTransport(script: Array<(url: string, init?: { method?: string }) => Response>) {
  const calls: TransportCall[] = [];
  const transport = vi.fn(async (url: string, init?: { method?: string }) => {
    const idx = calls.length;
    calls.push({ url, method: init?.method ?? 'GET' });
    const handler = script[idx];
    if (!handler) throw new Error(`unexpected transport call #${idx}: ${init?.method ?? 'GET'} ${url}`);
    return handler(url, init);
  });
  return { transport, calls };
}

const PROJ_ID = 'prj_customer123';
const BASE = 'https://api.vercel.com';

function adapter(transport: ReturnType<typeof makeTransport>['transport']) {
  return createVercelAdapter({
    token: 'test-token',
    teamId: 'team_test',
    repoId: 1319226252,
    transport: transport as never,
  });
}

const listUrl = (slug: string) => `${BASE}/v9/projects?teamId=team_test&search=${encodeURIComponent(slug)}`;
const createUrl = `${BASE}/v9/projects?teamId=team_test`;

function listResponse(projects: Array<{ id: string; name: string }>) {
  return jsonResponse({ projects });
}

describe('vercel createProject 409 reconciliation (bounded)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('A. initial search finds the exact project → reused, NO POST create', async () => {
    const { transport, calls } = makeTransport([() => listResponse([{ id: PROJ_ID, name: 'lf-customer-abc' }])]);
    const r = await adapter(transport).createProject('tid', 'abc');
    expect(r).toMatchObject({ ok: true, resourceId: PROJ_ID });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
  });

  it('B. search absent → POST create 2xx → success with created id', async () => {
    const { transport, calls } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ id: 'prj_new1' }, 200),
    ]);
    const r = await adapter(transport).createProject('tid', 'abc');
    expect(r).toMatchObject({ ok: true, resourceId: 'prj_new1' });
    expect(calls.length).toBe(2);
    expect(calls[1].method).toBe('POST');
  });

  it('C. POST create 409 → reconciliation read finds the EXACT project → reuse real id', async () => {
    const { transport, calls } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ error: { code: 'project_exists' } }, 409),
      () => listResponse([{ id: PROJ_ID, name: 'lf-customer-abc' }]),
    ]);
    const r = await adapter(transport).createProject('tid', 'abc');
    expect(r).toMatchObject({ ok: true, resourceId: PROJ_ID });
    expect(calls.length).toBe(3);
    expect(calls[2].method).toBe('GET');
    expect(calls[2].url).toBe(listUrl('abc'));
  });

  it('D. POST create 409 → reconciliation still absent → controlled 409 failure', async () => {
    const { transport, calls } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ error: { code: 'project_exists' } }, 409),
      () => listResponse([]),
    ]);
    const r = await adapter(transport).createProject('tid', 'abc');
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('409');
    expect(calls.length).toBe(3);
  });

  it('E. reconciliation finds only a SIMILAR (non-exact) project → FAIL (never broad-match)', async () => {
    const { transport } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ error: { code: 'project_exists' } }, 409),
      () => listResponse([{ id: 'prj_other', name: 'lf-customer-abc-extra' }, { id: 'prj_x', name: 'x-abc' }]),
    ]);
    const r = await adapter(transport).createProject('tid', 'abc');
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('409');
  });

  it('F. no duplicate POST retry loop after 409 (single reconciliation read, one POST total)', async () => {
    const { transport, calls } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ error: { code: 'project_exists' } }, 409),
      () => listResponse([]),
    ]);
    await adapter(transport).createProject('tid', 'abc');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(1);
  });

  it('G. never deletes or moves a project (no DELETE/PATCH transport calls)', async () => {
    const { transport, calls } = makeTransport([
      () => listResponse([]),
      () => jsonResponse({ error: { code: 'project_exists' } }, 409),
      () => listResponse([{ id: PROJ_ID, name: 'lf-customer-abc' }]),
    ]);
    await adapter(transport).createProject('tid', 'abc');
    expect(calls.every((c) => c.method === 'GET' || c.method === 'POST')).toBe(true);
  });
});
