import { describe, expect, it } from 'vitest';
import { ACCESS_CODE_CHARSET, ACCESS_CODE_LENGTH, generateAccessCode } from './accessCode';

describe('R1 TWO-DEVICE CONTRACT — customer access code', () => {
  it('generates exactly 16 characters from the unambiguous charset', () => {
    const code = generateAccessCode();
    expect(code).toHaveLength(ACCESS_CODE_LENGTH);
    expect(code).toHaveLength(16);
    for (const ch of code) expect(ACCESS_CODE_CHARSET).toContain(ch);
  });

  it('charset excludes ambiguous characters (0/O, 1/I/L, 8/B)', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L', '8', 'B']) {
      expect(ACCESS_CODE_CHARSET).not.toContain(bad);
    }
  });

  it('two generated codes differ (cryptographically random source)', () => {
    const a = generateAccessCode();
    const b = generateAccessCode();
    expect(a).not.toBe(b);
  });

  it('uses the injected random source', () => {
    const deterministic = new Uint8Array(64).fill(7); // 7 < 224 → always accepted
    const code = generateAccessCode(() => deterministic);
    expect(code).toHaveLength(16);
    expect(ACCESS_CODE_CHARSET[7 % ACCESS_CODE_CHARSET.length]).toBe(code[0]);
  });

  it('rejection sampling keeps output uniform (no modulo bias for rejected range)', () => {
    // first buffer fully in the rejected range (≥216) → refilled; second buffer valid
    let calls = 0;
    const alternating = () => {
      calls += 1;
      const buf = new Uint8Array(32);
      buf.fill(calls === 1 ? 230 : 7);
      return buf;
    };
    const code = generateAccessCode(alternating);
    expect(code).toHaveLength(16);
    expect(calls).toBeGreaterThan(1); // proves the rejected range triggered a refill
    expect(ACCESS_CODE_CHARSET[7 % ACCESS_CODE_CHARSET.length]).toBe(code[0]);
  });
});
