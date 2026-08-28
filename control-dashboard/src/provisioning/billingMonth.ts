/**
 * control-dashboard/src/provisioning/billingMonth.ts — Pacific (America/Los_Angeles)
 * Google Maps billing-month helpers. Byte-equivalent algorithm to the customer-app's
 * api/billingMonth.js (single source of truth for the RUNTIME); this copy exists so
 * the provisioning billing stage can compute the activation month and Monitoring
 * interval WITHOUT importing across package roots.
 *
 * Google Maps monthly usage resets on the America/Los_Angeles calendar month —
 * DST-aware. NEVER use the UTC month. Server-authoritative only.
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

interface LaWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** LA wall-clock components of `now` (DST-aware via the IANA timezone db). */
function laWallParts(now: Date): LaWallParts {
  const parts: Record<string, string> = {};
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
export function pacificBillingMonth(now: Date = new Date()): string {
  const { year, month } = laWallParts(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Absolute UTC instant at which the LA wall clock read y-m-d h:m:s (iterative, DST-aware). */
function utcInstantOfLaWall(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
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
export function pacificBillingMonthStartUtc(now: Date = new Date()): Date {
  const { year, month } = laWallParts(now);
  return new Date(utcInstantOfLaWall(year, month, 1, 0, 0, 0));
}
