/**
 * R1 REVISED QUOTA SAFETY CONTRACT — event-driven usage telemetry (browser).
 *
 * Owner-approved (2026-08-26):
 *   Google monthly allowance = 1000 ALL Places API (New) requests
 *   AMBER = 900 · HARD SAFETY STOP = 950 · reserved buffer = 50
 *   No new Places request may intentionally be issued once
 *   effectiveUsage >= 950.
 *
 * Event contract (per top-level RUN SEARCH session):
 *   RUN SEARCH                  -> maximum ONE Shared Monitoring fetch
 *   CONTINUE / DEEP SEARCH      -> 0
 *   STOP                        -> 0
 *   browser refresh / page load -> 0
 *   idle                        -> 0
 *   timer / setInterval polling -> FORBIDDEN (none exists in this module)
 *
 * effectiveUsage = monitoringBase + localSessionDelta
 *   - monitoringBase : latest AVAILABLE Monitoring snapshot, fetched once at
 *     RUN SEARCH start. Fail-closed: fetch failure OR baseline >= 950 blocks
 *     RUN. The snapshot is NOT mathematically real-time (Monitoring reporting
 *     has delay); the 50-request reserve absorbs that delay.
 *   - localSessionDelta : incremented BEFORE every outbound Places API
 *     request ATTEMPT (normal search, pagination, deep search, retries, and
 *     requests that later error). Request #951 is never intentionally issued.
 *
 * The Monitoring counter counts ALL Places API (New) requests — the
 * authoritative operational safety basis. It is NEVER claimed as Text Search
 * Enterprise / billing-SKU usage.
 */
export function createUsageTelemetry({ fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((url, init) => fetch(url, init));
  let monitoringBase = null; // null = no fresh snapshot in this page life
  let localSessionDelta = 0;
  let inflightPromise = null;
  let quota = { monthlyTarget: 1000, redRequests: 950 };

  function setQuota(q) {
    quota = q || quota;
  }

  /** effectiveUsage = monitoringBase + localSessionDelta (safety basis). */
  function effectiveUsage() {
    return (monitoringBase ?? 0) + localSessionDelta;
  }

  /** True once a fresh Monitoring snapshot exists for this page life. */
  function hasLiveBase() {
    return monitoringBase !== null;
  }

  /** Fail-closed gate: no request may be issued at/after the safety stop. */
  function canIssueRequest() {
    return effectiveUsage() < quota.redRequests;
  }

  /** MUST be called BEFORE issuing every outbound Places request attempt. */
  function accountRequest() {
    localSessionDelta += 1;
  }

  /** Start of a new session: local accounting resets, base is kept. */
  function resetSession() {
    localSessionDelta = 0;
  }

  /**
   * Fetch ONE latest-available Monitoring baseline (deduped: concurrent
   * callers share the same in-flight fetch). Resets localSessionDelta on
   * success. Returns { ok:true, used, cap } or { ok:false, error } —
   * callers MUST fail closed on !ok.
   */
  function refreshMonitoringBase() {
    if (inflightPromise) return inflightPromise;
    inflightPromise = (async () => {
      try {
        const r = await doFetch('/api/usage', { cache: 'no-store' });
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        if (typeof j.used !== 'number' || !Number.isFinite(j.used)) {
          throw new Error('unexpected usage payload');
        }
        monitoringBase = Math.max(0, Math.floor(j.used));
        localSessionDelta = 0;
        return { ok: true, used: monitoringBase, cap: typeof j.cap === 'number' ? j.cap : quota.monthlyTarget };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      } finally {
        inflightPromise = null;
      }
    })();
    return inflightPromise;
  }

  return {
    setQuota,
    effectiveUsage,
    hasLiveBase,
    canIssueRequest,
    accountRequest,
    resetSession,
    refreshMonitoringBase,
  };
}
