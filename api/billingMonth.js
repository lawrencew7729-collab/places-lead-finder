/**
 * api/billingMonth.js — Google Maps billing-month helpers (single source of
 * truth). Google Maps monthly usage resets on the America/Los_Angeles
 * calendar month — DST-aware. NEVER use the UTC month, MYT month, or a
 * hard-coded UTC-8 offset.
 *
 * Server-authoritative: the billing month is ALWAYS derived server-side from
 * the current instant; a client-supplied month is never trusted.
 */
const LA_TZ = 'America/Los_Angeles';
const wallFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: LA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** LA wall-clock components of `now` (DST-aware via the IANA timezone db). */
function laWallParts(now) {
  const parts = {};
  for (const p of wallFmt.formatToParts(now)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** YYYY-MM of the Pacific billing month containing `now`. */
export function pacificBillingMonth(now = new Date()) {
  const { year, month } = laWallParts(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Absolute UTC instant at which the Pacific wall clock read y-m-d h:m:s.
 * Iterative solve against the LA wall clock — DST-aware (handles both
 * winter and summer offsets; month-start 00:00 never falls in the 2am DST
 * transition hour, so no ambiguous/nonexistent time).
 */
function utcInstantOfLaWall(y, mo, d, h, mi, s) {
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const w = laWallParts(new Date(t));
    const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    t += target - wall;
  }
  return t;
}

/** UTC instant (Date) of 00:00:00 America/Los_Angeles on the first day of the billing month containing `now`. */
export function pacificBillingMonthStartUtc(now = new Date()) {
  const { year, month } = laWallParts(now);
  return new Date(utcInstantOfLaWall(year, month, 1, 0, 0, 0));
}
