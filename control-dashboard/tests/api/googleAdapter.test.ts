/**
 * Google IAM verifyUserManagedKeys — bounded 404 retry (2026-09-09).
 *
 * Real DUMMY3 + DUMMY4 first-run failures: a freshly created monitoring SA can
 * briefly 404 in IAM (propagation lag), so the immediately-following
 * listSaKeys failed and the whole Workflow died. Fix: HTTP 404 ONLY gets a
 * bounded retry (1.5s → 3s → 5s, 4 attempts max, ~9.5s). All other statuses
 * fail immediately; after the final 404 the stage FAIL CLOSES as before. The
 * SA is NEVER recreated and USER_MANAGED=0 protection is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleAdapter } from '../../src/provisioning/adapters.js';

const EMAIL = 'lf-customer-monitoring@cust-proj.iam.gserviceaccount.com';
const KEYS_URL = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(EMAIL)}/keys`;

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}
const keys = (keyType = 'SYSTEM_MANAGED') => jsonResponse({ keys: [{ keyType }] });

function makeGoogle(handlers: Array<() => Response>) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(String(url));
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected transport call #${calls.length}: ${url}`);
    return handler();
  });
  const google = createGoogleAdapter({
    accessTokenProvider: async () => 'test-token',
    transport: transport as never,
  });
  return { google, calls };
}

describe('google verifyUserManagedKeys 404 bounded retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('1. fresh SA: first listSaKeys 404 → second attempt success (0 USER_MANAGED) → PASS', async () => {
    const { google, calls } = makeGoogle([() => jsonResponse({}, 404), () => keys('SYSTEM_MANAGED')]);
    const p = google.verifyUserManagedKeys(EMAIL);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toMatchObject({ ok: true, userManagedCount: 0 });
    expect(calls.length).toBe(2);
  });

  it('2. two temporary 404s then success → PASS', async () => {
    const { google, calls } = makeGoogle([() => jsonResponse({}, 404), () => jsonResponse({}, 404), () => keys()]);
    const p = google.verifyUserManagedKeys(EMAIL);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toMatchObject({ ok: true, userManagedCount: 0 });
    expect(calls.length).toBe(3);
  });

  it('3. all bounded attempts return 404 → FAIL CLOSED (wif listSaKeys 404)', async () => {
    const { google, calls } = makeGoogle([() => jsonResponse({}, 404), () => jsonResponse({}, 404), () => jsonResponse({}, 404), () => jsonResponse({}, 404)]);
    const p = google.verifyUserManagedKeys(EMAIL);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toMatchObject({ ok: false, reason: 'wif listSaKeys 404' });
    expect(calls.length).toBe(4);
  });

  it('4. 403 → immediate FAIL, no propagation retry (single transport call)', async () => {
    const { google, calls } = makeGoogle([() => jsonResponse({}, 403)]);
    await expect(google.verifyUserManagedKeys(EMAIL)).resolves.toMatchObject({ ok: false, reason: 'wif listSaKeys 403' });
    expect(calls.length).toBe(1);
  });

  it('5. USER_MANAGED key exists → controlled FAIL (USER_MANAGED must be 0 — policy unchanged)', async () => {
    const { google, calls } = makeGoogle([() => keys('USER_MANAGED')]);
    const res = await google.verifyUserManagedKeys(EMAIL);
    expect(res.ok).toBe(false);
    expect(String((res as { reason?: string }).reason)).toContain('USER_MANAGED');
    expect(calls.length).toBe(1);
  });

  it('6. existing SA + immediate success → existing behavior unchanged (single call, 0 keys PASS)', async () => {
    const { google, calls } = makeGoogle([() => keys()]);
    await expect(google.verifyUserManagedKeys(EMAIL)).resolves.toMatchObject({ ok: true, userManagedCount: 0 });
    expect(calls.length).toBe(1);
  });

  it('7. retry never creates/recreates the SA (all calls are GET list-keys on the SAME url)', async () => {
    const { google, calls } = makeGoogle([() => jsonResponse({}, 404), () => jsonResponse({}, 404), () => jsonResponse({}, 404), () => jsonResponse({}, 404)]);
    const p = google.verifyUserManagedKeys(EMAIL);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c === KEYS_URL)).toBe(true);
  });
});
