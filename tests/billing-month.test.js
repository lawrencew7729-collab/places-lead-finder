/**
 * R1 PACIFIC BILLING MONTH — DST-aware America/Los_Angeles calendar-month
 * semantics (owner pre-Phase-D check, 2026-08-26). Google Maps monthly usage
 * resets at 00:00 America/Los_Angeles on the first of the month. Never UTC /
 * MYT / hard-coded UTC-8.
 */
import { describe, expect, it } from 'vitest';
import { pacificBillingMonth, pacificBillingMonthStartUtc } from '../api/billingMonth.js';

describe('Pacific billing month (DST-aware America/Los_Angeles)', () => {
  it('normal date -> correct YYYY-MM (PDT summer)', () => {
    expect(pacificBillingMonth(new Date('2026-08-15T12:00:00Z'))).toBe('2026-08'); // LA Aug 15 05:00 PDT
  });

  it('normal date -> correct YYYY-MM (PST winter)', () => {
    expect(pacificBillingMonth(new Date('2026-01-15T08:00:00Z'))).toBe('2026-01'); // LA Jan 15 00:00 PST
  });

  it('month boundary (PDT): UTC already in the next month while LA is still in the previous month', () => {
    // LA Aug 31 17:00 PDT == UTC Sep 1 00:00 — the UTC month flips first.
    expect(pacificBillingMonth(new Date('2026-09-01T05:00:00Z'))).toBe('2026-08'); // LA Aug 31 22:00 PDT
    expect(pacificBillingMonth(new Date('2026-09-01T07:00:00Z'))).toBe('2026-09'); // LA Sep 1 00:00 PDT
  });

  it('month boundary (PST): UTC rollover happens even earlier in winter', () => {
    // LA Dec 31 23:30 PST == UTC Jan 1 07:30 — UTC flips at LA 16:00 PST.
    expect(pacificBillingMonth(new Date('2026-01-01T07:00:00Z'))).toBe('2025-12'); // LA Dec 31 23:00 PST
    expect(pacificBillingMonth(new Date('2026-01-01T08:00:00Z'))).toBe('2026-01'); // LA Jan 1 00:00 PST
  });

  it('DST transition months use the offset AT the month start (March PST, not the later PDT)', () => {
    // Mar 1 2026 is PST (DST starts Mar 8): LA Mar 1 00:00 PST = 08:00 UTC.
    expect(pacificBillingMonthStartUtc(new Date('2026-03-15T12:00:00Z')).getTime())
      .toBe(Date.UTC(2026, 2, 1, 8, 0, 0));
    // Nov 1 2026 is PDT (DST ends Nov 1): LA Nov 1 00:00 PDT = 07:00 UTC.
    expect(pacificBillingMonthStartUtc(new Date('2026-11-15T12:00:00Z')).getTime())
      .toBe(Date.UTC(2026, 10, 1, 7, 0, 0));
  });

  it('month-start UTC conversion: winter (PST, UTC-8) and summer (PDT, UTC-7)', () => {
    expect(pacificBillingMonthStartUtc(new Date('2026-01-15T12:00:00Z')).toISOString())
      .toBe('2026-01-01T08:00:00.000Z'); // LA Jan 1 00:00 PST
    expect(pacificBillingMonthStartUtc(new Date('2026-07-15T12:00:00Z')).toISOString())
      .toBe('2026-07-01T07:00:00.000Z'); // LA Jul 1 00:00 PDT
  });

  it('month key and month-start stay aligned for the same instant', () => {
    const t = new Date('2026-09-01T06:00:00Z'); // LA Aug 31 23:00 PDT
    const start = pacificBillingMonthStartUtc(t);
    expect(pacificBillingMonth(new Date(start))).toBe('2026-08'); // month-start instant is still August
  });
});
