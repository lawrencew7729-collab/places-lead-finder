/**
 * R1 TWO-DEVICE CONTRACT — customer access code generator (Dashboard UI).
 *
 * Owner decision: authentication for NEW Golden Standard customers is
 * CUSTOMER ACCESS CODE ONLY (no username). The Create Customer workflow
 * generates a cryptographically random 16-character access code per customer.
 *
 * Secret boundary: the raw code is TRANSIENT UI state — the operator copies
 * it and hands it to provisioning as a transient secret (injected ONLY as
 * the customer's server-side APP_PASS env, then discarded). It is NEVER
 * stored in the Control Plane DB, audit logs, Run Sheet, browser bundle,
 * or Git.
 */
import { DEVICE_LOCK_CONTRACT } from './provisioning/deviceLockContract';

/** Unambiguous charset: no 0/O, 1/I/L, 8/B confusion for manual entry. */
export const ACCESS_CODE_CHARSET = '2345679ACDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';

export const ACCESS_CODE_LENGTH = DEVICE_LOCK_CONTRACT.accessCodeLength;

/** Uniform rejection boundary: largest multiple of the charset length ≤ 256 (no modulo bias). */
const REJECT_AT = Math.floor(256 / ACCESS_CODE_CHARSET.length) * ACCESS_CODE_CHARSET.length;

export function generateAccessCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  let buf = randomBytes(ACCESS_CODE_LENGTH * 2);
  let pos = 0;
  while (out.length < ACCESS_CODE_LENGTH) {
    if (pos >= buf.length) {
      buf = randomBytes(ACCESS_CODE_LENGTH * 2);
      pos = 0; // restart the fresh buffer — otherwise bytes read as undefined
    }
    const b = buf[pos];
    pos += 1;
    if (b >= REJECT_AT) continue; // rejection sampling — uniform, no modulo bias
    out.push(ACCESS_CODE_CHARSET[b % ACCESS_CODE_CHARSET.length]);
  }
  return out.join('');
}
