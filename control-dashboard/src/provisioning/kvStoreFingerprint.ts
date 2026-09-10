import { createHash } from 'node:crypto';
import { normalizeKvStoreUrl } from './deviceLockContract.js';

/**
 * R1 TWO-DEVICE CONTRACT — dedicated-store fingerprint (SERVER-ONLY).
 *
 * Isolated from deviceLockContract.ts on purpose: this module imports
 * node:crypto, which must NEVER be reachable from the browser bundle (Vite
 * dev externalizes node builtins with a throwing proxy). Only server-side
 * provisioning (executor/operator path) and Node tests import this module.
 *
 * Non-secret full 64-hex uppercase SHA-256 of the normalized dedicated KV
 * store URL — provisioning persists ONLY this fingerprint (never the raw
 * URL/token) so retries and readbacks can reconcile identity fail-closed.
 */

/** FULL 64-hex uppercase SHA-256 of the normalized dedicated store URL. */
export function kvStoreFingerprint(kvRestApiUrl: string): string {
  return createHash('sha256').update(normalizeKvStoreUrl(kvRestApiUrl)).digest('hex').toUpperCase();
}
