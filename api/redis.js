// api/redis.js — shared server-side Redis REST client (Upstash-compatible).
// CENTRALIZED architecture (owner-approved 2026-08-26): every customer holds
// its OWN restricted ACL REST credential — NEVER a shared/full-access token.
// Env precedence (same as api/device.js): KV_REST_API_URL / KV_REST_API_TOKEN
// preferred, UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN fallback.
export function redisClient({ url, token, fetchImpl } = {}) {
  // Lazy fetch + env reads: the client may be constructed at module load, but
  // fetch/env are only meaningful at request time (serverless cold start /
  // test stubs).
  const doFetch = fetchImpl || ((u, i) => globalThis.fetch(u, i));
  const baseOf = () => url || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const keyOf = () => token || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

  function configured() {
    return Boolean(baseOf() && keyOf());
  }

  async function cmd(command, args) {
    if (!configured()) throw new Error('redis not configured');
    const r = await doFetch(`${baseOf()}/${command}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + keyOf(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`redis ${command}: ${j.error || r.status}`);
    return j.result;
  }

  return {
    configured,
    get: (k) => cmd('get', [k]),
    set: (k, v, ...opts) => cmd('set', [k, v, ...opts]),
    del: (...ks) => cmd('del', ks),
    incrby: (k, n) => cmd('incrby', [k, n]),
    expire: (k, seconds) => cmd('expire', [k, seconds]),
    eval: (script, keys, args) => cmd('eval', [script, String(keys.length), ...keys, ...args]),
  };
}

/** Immutable tenant-scoped key helpers (namespace authority = tenants.id UUID). */
export function tenantDevicesKey(tenantId) {
  return `tenant:${tenantId}:devices`;
}
export function tenantActiveSearchKey(tenantId) {
  return `tenant:${tenantId}:active_search`;
}
export function tenantUsageKey(tenantId, month) {
  return `tenant:${tenantId}:usage:${month}`;
}
export function currentMonthUtc(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
