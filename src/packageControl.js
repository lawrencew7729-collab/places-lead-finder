/**
 * Customer package + service control contract (customer-app v1.0.11).
 *
 * TWO commercial packages ONLY — STARTER_500 and FULL_900. The internal Google
 * monthly ceiling (1000) is an operational safety limit and is NEVER a
 * customer/staff-facing package name; there is no 1000-credit package and no
 * mid-tier warning tier either.
 *
 * Authoritative state for a customer lives in that customer's OWN Redis
 * (`tenant:<TENANT_ID>:config`) and is written ONLY by this deployment's
 * authenticated control endpoint. The customer runtime reads it during search —
 * it never depends on the Control Dashboard being available.
 */

export const PORTAL_VERSION = '1.0.11';

/** Internal Google monthly ceiling — operational, never a commercial package. */
export const GOOGLE_CEILING = 1000;

export const PACKAGE_STARTER = 'STARTER_500';
export const PACKAGE_FULL = 'FULL_900';
export const SERVICE_ACTIVE = 'ACTIVE';
export const SERVICE_STOPPED = 'STOPPED';

/** Search stop per package (credits) — one stop per package, no extra tier. */
export const PACKAGE_STOPS = Object.freeze({
  STARTER_500: 500,
  FULL_900: 900,
});

export const DEFAULT_PACKAGE = PACKAGE_STARTER;
export const DEFAULT_SERVICE_STATUS = SERVICE_ACTIVE;

/** Mutation actions the control endpoint accepts. STATUS is read-only. */
export const CONTROL_ACTIONS = Object.freeze(['STOP', 'RESUME', 'UPGRADE_TO_FULL_900']);

export function defaultTenantConfig() {
  return {
    package: DEFAULT_PACKAGE,
    serviceStatus: DEFAULT_SERVICE_STATUS,
    updatedAt: null,
    updatedBy: null,
  };
}

export function normalizePackage(value) {
  return value === PACKAGE_FULL ? PACKAGE_FULL : PACKAGE_STARTER;
}

export function normalizeServiceStatus(value) {
  return value === SERVICE_STOPPED ? SERVICE_STOPPED : SERVICE_ACTIVE;
}

/** Missing / malformed config falls back to the new-customer default (fail-safe). */
export function parseTenantConfig(raw) {
  if (!raw) return defaultTenantConfig();
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return defaultTenantConfig();
  }
  if (!parsed || typeof parsed !== 'object') return defaultTenantConfig();
  return {
    package: normalizePackage(parsed.package),
    serviceStatus: normalizeServiceStatus(parsed.serviceStatus),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
  };
}

export function serializeTenantConfig(config) {
  return JSON.stringify({
    package: normalizePackage(config.package),
    serviceStatus: normalizeServiceStatus(config.serviceStatus),
    updatedAt: config.updatedAt ?? null,
    updatedBy: config.updatedBy ?? null,
  });
}

/** Applies one control action to a config. Unknown action → null (caller 400s). */
export function applyControlAction(config, action, meta = {}) {
  const current = parseTenantConfig(config);
  const stamp = {
    package: current.package,
    serviceStatus: current.serviceStatus,
    updatedAt: meta.updatedAt ?? null,
    updatedBy: meta.updatedBy ?? null,
  };
  switch (action) {
    case 'STOP':
      return { ...stamp, serviceStatus: SERVICE_STOPPED };
    case 'RESUME':
      return { ...stamp, serviceStatus: SERVICE_ACTIVE };
    case 'UPGRADE_TO_FULL_900':
      // one-way by design: no downgrade path is exposed to staff
      return { ...stamp, package: PACKAGE_FULL };
    default:
      return null;
  }
}

export function packageStop(packageId) {
  return PACKAGE_STOPS[normalizePackage(packageId)];
}

/**
 * THE authoritative search gate. Server-side only — a hidden/disabled UI button
 * is never sufficient.
 */
export function searchGate({ package: packageId, serviceStatus, used }) {
  const pkg = normalizePackage(packageId);
  const status = normalizeServiceStatus(serviceStatus);
  const limit = packageStop(pkg);
  const usage = Number.isFinite(Number(used)) ? Number(used) : 0;
  if (status === SERVICE_STOPPED) {
    return { allowed: false, reason: 'SERVICE_STOPPED', package: pkg, serviceStatus: status, limit, used: usage };
  }
  if (usage >= limit) {
    return { allowed: false, reason: 'PACKAGE_LIMIT_REACHED', package: pkg, serviceStatus: status, limit, used: usage };
  }
  return { allowed: true, reason: null, package: pkg, serviceStatus: status, limit, used: usage };
}

/** STATUS payload — non-secret fields only (package/serviceStatus/usage/version). */
export function publicState({ package: packageId, serviceStatus, used, month, ceiling }) {
  const pkg = normalizePackage(packageId);
  return {
    portalVersion: PORTAL_VERSION,
    package: pkg,
    packageLabel: pkg === PACKAGE_FULL ? 'Full 900' : 'Starter 500',
    serviceStatus: normalizeServiceStatus(serviceStatus),
    usage: Number.isFinite(Number(used)) ? Number(used) : 0,
    searchStop: packageStop(pkg),
    ceiling: Number.isFinite(Number(ceiling)) ? Number(ceiling) : GOOGLE_CEILING,
    month: month ?? null,
  };
}
