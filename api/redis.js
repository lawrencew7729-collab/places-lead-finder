// api/redis.js — shared server-side Redis REST client (Upstash-compatible).
// CENTRALIZED architecture (owner-approved 2026-08-26): every customer holds
// its OWN restricted ACL REST credential — NEVER a shared full-access token.
//
// Upstash REST protocol (verified live on the T1 PAYG store, 2026-08-27):
//   POST /<command>/<arg1>/<arg2>/...   — ALL arguments in the URL path,
//   each URL-encoded; NO request body. The response is {"result": <reply>}.
//   (The array-body form works only for GET-by-literal-key and silently
//   misbehaves for SET/INCRBY/EXPIRE; EVAL requires the script as the first
//   path segment.)
//
// Keys are always tenant-scoped: tenant:<TENANT_ID>:{devices,active_search,
// usage:<YYYY-MM>} — enforced server-side AND by the per-tenant Redis ACL
// keyspace (~tenant:<TENANT_ID>:* +get +set +del +incrby +expire +eval).

export function tenantDevicesKey(tenantId) {
  return `tenant:${tenantId}:devices`;
}

export function tenantActiveSearchKey(tenantId) {
  return `tenant:${tenantId}:active_search`;
}

export function tenantUsageKey(tenantId, month) {
  return `tenant:${tenantId}:usage:${month}`;
}

export function redisClient({ url, token, fetchImpl } = {}) {
  // Lazy fetch + env reads: the client may be constructed at module load, but
  // fetch/env are only meaningful at request time (serverless cold-start).
  const baseOf = () => url || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const keyOf = () => token || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  const doFetch = (u, i) => (fetchImpl || globalThis.fetch)(u, i);

  function configured() {
    return Boolean(baseOf() && keyOf());
  }

  async function cmd(command, args) {
    if (!configured()) throw new Error('redis not configured');
    const path = [command, ...args.map((a) => encodeURIComponent(String(a)))].join('/');
    const r = await doFetch(`${baseOf()}/${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + keyOf(), 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`redis ${command}: ${j.error || r.status}`);
    return j.result;
  }

  return {
    configured,
    get: (k) => cmd('get', [k]),
    set: (k, v) => cmd('set', [k, v]),
    del: (...ks) => cmd('del', ks),
    incrby: (k, n) => cmd('incrby', [k, n]),
    expire: (k, s) => cmd('expire', [k, s]),
    eval: (script, keys, args) => cmd('eval', [script, String(keys.length), ...keys, ...args]),
  };
}
