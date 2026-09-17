/**
 * Customer package + service control contract (customer-app v1.0.12).
 *
 * TWO commercial packages ONLY — STARTER_500 and FULL_900. The internal Google
 * monthly ceiling (1000) is an operational safety limit and is NEVER a
 * customer/staff-facing package name; there is no 1000-credit package and no
 * mid-tier warning tier either.
 *
 * MONTHLY PACKAGE SELECTION (owner decision 2026-09-17)
 * ----------------------------------------------------
 * Staff select the customer's package ONCE PER MONTH, at the start of the
 * month. Inside a month the ONLY package change is 500 -> 900. There is NO
 * 900 -> 500 path at all: that is not a "downgrade button", it is the
 * month-start selection of the new month's package.
 *
 *   this month               500                  900
 *   ----------------------  -------------------  -------------------
 *   new month, not chosen   selectable           selectable (or leave as is)
 *   already chose 500       current (grey)       upgrade allowed
 *   already chose 900       NOT possible         current (grey)
 *
 * The month is the SAME Pacific billing month the customer runtime already uses
 * (`pacificBillingMonth` -> 'YYYY-MM', the value STATUS reports as `month`).
 * No second month algorithm exists.
 *
 * Authoritative state for a customer lives in that customer's OWN Redis
 * (`tenant:<TENANT_ID>:config`) and is written ONLY by this deployment's
 * authenticated control endpoint. The customer runtime reads it during search —
 * it never depends on the Control Dashboard being available.
 */

export const PORTAL_VERSION = '1.0.12';

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

/** The exact month format STATUS already reports (`month`). */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeMonth(value) {
  return typeof value === 'string' && MONTH_PATTERN.test(value.trim()) ? value.trim() : null;
}

/**
 * Mutation actions the control endpoint accepts. STATUS is read-only.
 *
 *   STOP / RESUME              service control — completely independent of the
 *                              package and NEVER clears the month selection
 *   UPGRADE_TO_FULL_900        FULL_900 for this month: the mid-month upgrade
 *                              from 500, or the month-start selection/confirmation
 *                              of 900
 *   SELECT_STARTER_500         STARTER_500 for this month — allowed ONLY while
 *                              this month's package has not been chosen yet
 *
 * There is still NO delete, NO limit editing, NO arbitrary package setter and
 * NO 900 -> 500 change inside a month.
 */
export const CONTROL_ACTIONS = Object.freeze(['STOP', 'RESUME', 'UPGRADE_TO_FULL_900', 'SELECT_STARTER_500', 'CLEAR_DEVICE']);

/** Actions that (re)select this month's package. They stamp `packageMonth`. */
export const PACKAGE_ACTIONS = Object.freeze(['UPGRADE_TO_FULL_900', 'SELECT_STARTER_500']);

/**
 * Device-slot action (v1.0.12). NOT a package action: it clears ONE device slot
 * so a new device can register, and — because /api/usage validates the device on
 * every run — the cleared device is revoked on its very next search.
 */
export const DEVICE_ACTIONS = Object.freeze(['CLEAR_DEVICE']);

export function defaultTenantConfig() {
  return {
    package: DEFAULT_PACKAGE,
    serviceStatus: DEFAULT_SERVICE_STATUS,
    packageMonth: null,
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
    packageMonth: normalizeMonth(parsed.packageMonth),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
  };
}

export function serializeTenantConfig(config) {
  return JSON.stringify({
    package: normalizePackage(config.package),
    serviceStatus: normalizeServiceStatus(config.serviceStatus),
    packageMonth: normalizeMonth(config.packageMonth),
    updatedAt: config.updatedAt ?? null,
    updatedBy: config.updatedBy ?? null,
  });
}

/**
 * THE month-selection facts for ONE customer at ONE month.
 *
 * `fallbackMonth` is the month of the config's last state change, derived by the
 * caller from `updatedAt` (this module stays free of date parsing and of its own
 * month algorithm). It only exists for configs written BEFORE v1.0.12, which
 * have no `packageMonth`: such a package counts as chosen in that month, which
 * is the SAFE direction — a customer already upgraded to 900 can never be
 * switched to 500 in the same month. The fallback self-heals at the next month
 * boundary, and any package action after v1.0.12 stamps the explicit month.
 *
 * A config that was never written at all (fresh customer) has no fallback and
 * no month: both packages are freely selectable, which is exactly the new-customer
 * onboarding choice.
 */
export function packageSelectionFacts({ package: packageId, packageMonth, fallbackMonth, currentMonth }) {
  const month = normalizeMonth(currentMonth);
  const selectedMonth = normalizeMonth(packageMonth) ?? normalizeMonth(fallbackMonth);
  const pkg = normalizePackage(packageId);
  const isNewMonth = selectedMonth === null || (month !== null && selectedMonth !== month);
  return {
    package: pkg,
    currentMonth: month,
    selectedMonth,
    /** true => this month's package has NOT been chosen yet (both buttons open) */
    isNewMonth,
    canSelectStarter500: isNewMonth,
    canSelectFull900: isNewMonth || pkg === PACKAGE_STARTER,
  };
}

/**
 * Applies one control action to a config. Unknown action -> null (caller 400s).
 * `meta.month` = the month a PACKAGE selection is FOR (authoritative Pacific month).
 * `meta.legacyMonth` = the month derived from the config's PRE-WRITE `updatedAt`.
 */
export function applyControlAction(config, action, meta = {}) {
  const current = parseTenantConfig(config);
  // LEGACY FREEZE (owner 2026-09-17). A pre-v1.0.12 config has no `packageMonth`,
  // so the month its package was chosen in is derived from `updatedAt`. That
  // derivation must be PINNED on the very first write — otherwise a STOP / RESUME
  // on the 1st of a month would move `updatedAt` into the new month, the derived
  // month would look like "already chosen", and the 500/900 selection would be
  // wrongly locked for that whole month. Freezing keeps every later write honest.
  const frozenMonth = current.packageMonth ?? normalizeMonth(meta.legacyMonth);
  const stamp = {
    package: current.package,
    serviceStatus: current.serviceStatus,
    packageMonth: frozenMonth,
    updatedAt: meta.updatedAt ?? null,
    updatedBy: meta.updatedBy ?? null,
  };
  switch (action) {
    case 'STOP':
      // service control only — the month selection is untouched
      return { ...stamp, serviceStatus: SERVICE_STOPPED };
    case 'RESUME':
      return { ...stamp, serviceStatus: SERVICE_ACTIVE };
    case 'UPGRADE_TO_FULL_900':
      return { ...stamp, package: PACKAGE_FULL, packageMonth: normalizeMonth(meta.month) };
    case 'SELECT_STARTER_500':
      return { ...stamp, package: PACKAGE_STARTER, packageMonth: normalizeMonth(meta.month) };
    default:
      return null;
  }
}

/**
 * Server-side gate for one package action. Returns null when the action is not
 * a package action, otherwise { allowed, reason }.
 *   SELECT_STARTER_500 : only while this month has no selection yet
 *   UPGRADE_TO_FULL_900: month selection, or the mid-month 500 -> 900 upgrade
 */
export function packageActionGate(facts, action) {
  if (!PACKAGE_ACTIONS.includes(action)) return null;
  if (action === 'SELECT_STARTER_500') {
    return facts.canSelectStarter500
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' };
  }
  return facts.canSelectFull900
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'PACKAGE_ALREADY_SELECTED_THIS_MONTH' };
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

/**
 * STATUS payload — non-secret fields only. `month` is the authoritative Pacific
 * billing month; `packageMonth` is the month the current package was selected
 * for; `packageSelectableThisMonth` is the authority for whether staff may pick
 * a package for this month (the Dashboard renders 500/900 from THIS flag, so the
 * rule is never duplicated in the UI).
 */
export function publicState({
  package: packageId, serviceStatus, used, month, ceiling,
  packageMonth = null, packageSelectableThisMonth = false,
}) {
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
    packageMonth: normalizeMonth(packageMonth),
    packageSelectableThisMonth: packageSelectableThisMonth === true,
  };
}
