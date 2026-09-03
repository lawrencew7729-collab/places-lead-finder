/**
 * R1 CENTRALIZED QUOTA/LOCK CONTRACT — browser usage telemetry (UX layer).
 *
 * Owner-approved (2026-08-26, B2 hardening 2026-08-27):
 *   - ONE centralized Upstash Redis DB; per-tenant ACL credential.
 *   - Google allowance 1000 ALL Places requests/month · AMBER 850
 *   - SAFETY STOP 900 blocks NEW top-level RUN (an authorized session may
 *     finish above 900, bounded by the HARD server-side 50-attempt cap;
 *     app-originated monthly max = 899 + 50 = 949 < 1000 Enterprise cap).
 *   - Only ONE device may hold an active search (SET NX lease, TTL 120s,
 *     renewed by every successful claim; no heartbeat polling).
 *
 * SECURITY MODEL: the browser counter is UX ONLY. The AUTHORITATIVE gate is
 * the server-side atomic claim (api/session.js): every outbound Places
 * request attempt must claim first; the Google request is issued ONLY after
 * the claim succeeds (lease owned + attempts < 50 + usage incremented).
 */
export const SESSION_CONTRACT = Object.freeze({
  maxSessionRequests: 50,
  leaseTtlSeconds: 120,
  safetyStop: 900,
  allowance: 1000,
});

export function createUsageTelemetry({ fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((url, init) => fetch(url, init));
  let sessionId = null;
  let used = null;          // last authoritative shared usage (server responses)
  let cap = SESSION_CONTRACT.allowance;
  let safetyStop = SESSION_CONTRACT.safetyStop;
  let sessionAttempts = 0;  // UX mirror — server is the authority
  let inflightPromise = null;

  /**
   * Pre-seed the UX quota display from the build-time customer quota config
   * (server /api/usage responses remain authoritative and overwrite these).
   * Accepts customerQuota() shape: { monthlyTarget, redRequests, ... }.
   */
  function setQuota(q) {
    if (!q) return;
    if (typeof q.monthlyTarget === 'number' && Number.isFinite(q.monthlyTarget) && q.monthlyTarget > 0) cap = q.monthlyTarget;
    if (typeof q.redRequests === 'number' && Number.isFinite(q.redRequests) && q.redRequests > 0) safetyStop = q.redRequests;
  }

  /** One Monitoring query max per top-level RUN (server does reconcile+lease). */
  function startRun(deviceId) {
    if (inflightPromise) return inflightPromise;
    inflightPromise = (async () => {
      try {
        const r = await doFetch('/api/usage?deviceId=' + encodeURIComponent(deviceId || ''), { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) return { ok: false, blocked: true, error: 'usage check failed' };
        cap = typeof j.cap === 'number' ? j.cap : cap;
        safetyStop = typeof j.safetyStop === 'number' ? j.safetyStop : safetyStop;
        used = typeof j.used === 'number' ? j.used : used;
        if (j.blocked) return { ok: false, blocked: true, used, cap, safetyStop };
        if (j.locked) return { ok: false, locked: true, used, cap, safetyStop };
        if (!j.sessionId) return { ok: false, blocked: true, error: 'usage check failed' };
        sessionId = j.sessionId;
        sessionAttempts = 0;
        return { ok: true, sessionId, used, cap, safetyStop, expiresAt: j.expiresAt, maxSessionRequests: j.maxSessionRequests };
      } catch (e) {
        return { ok: false, blocked: true, error: String((e && e.message) || e) };
      } finally {
        inflightPromise = null;
      }
    })();
    return inflightPromise;
  }

  /**
   * Server-authoritative atomic claim for ONE outbound Places request attempt.
   * FAIL CLOSED: any failure means the Google request must NOT be issued.
   */
  async function claimRequest() {
    if (!sessionId) return { ok: false, reason: 'no_session' };
    try {
      const r = await doFetch('/api/session?mode=claim&sessionId=' + encodeURIComponent(sessionId), { method: 'POST', cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) return { ok: false, reason: j.reason || 'claim_failed' };
      sessionAttempts = Number(j.attempts) || 0;
      if (typeof j.used === 'number') used = j.used;
      return { ok: true, attempts: sessionAttempts, used };
    } catch (e) {
      return { ok: false, reason: 'claim_failed' };
    }
  }

  /** Safe compare-and-release (STOP / normal finish). Not a Monitoring query. */
  async function releaseSession() {
    const sid = sessionId;
    sessionId = null;
    if (!sid) return { ok: true };
    try {
      const r = await doFetch('/api/session?mode=release&sessionId=' + encodeURIComponent(sid), { method: 'POST', cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok && j.ok !== false, reason: j.reason };
    } catch (e) {
      // Lease self-heals via TTL — release failure is not fatal.
      return { ok: false, reason: 'release_failed' };
    }
  }

  /** Redis-only status (page load / Device-B UX). NEVER a Monitoring query. */
  async function status() {
    try {
      const r = await doFetch('/api/session?mode=status', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false };
      return { ok: true, active: j.active === true, activeSessionId: j.sessionId || null, used: typeof j.used === 'number' ? j.used : null };
    } catch (e) {
      return { ok: false };
    }
  }

  return {
    startRun,
    claimRequest,
    releaseSession,
    status,
    setQuota,
    hasSession: () => Boolean(sessionId),
    sessionAttempts: () => sessionAttempts,
    effectiveUsage: () => used ?? 0,
    safetyStop: () => safetyStop,
    allowance: () => cap,
  };
}
