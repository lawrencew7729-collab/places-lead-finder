import { describe, expect, it } from 'vitest';
import {
  DEVICE_LOCK_CONTRACT,
  DEVICE_LOCK_ENV_KEYS,
  deviceLockNamespaceFor,
  devicePolicyFor,
  kvStoreFingerprint,
  normalizeKvStoreUrl,
  verifyDeviceLockPolicy,
  verifyDeviceLockProbe,
  verifyDeviceLockSecrets,
  type DeviceLockProbe,
  type DeviceLockSecretsInput,
  type DevicePolicy,
} from './deviceLockContract';

const VALID_SECRETS: DeviceLockSecretsInput = {
  kvRestApiUrl: 'https://store-abc.upstash.io',
  kvRestApiToken: 'tok_abcdefghijkl',
  appPass: 'accesscode123456', // 16 chars
};

const VALID_PROBE: DeviceLockProbe = {
  mode: 'locked',
  maxDevices: 2,
  kvConfigured: true,
  appPassConfigured: true,
  tenantIdConfigured: true,
};

describe('R1 TWO-DEVICE CONTRACT — contract constants', () => {
  it('MAX_DEVICES is exactly 2', () => {
    expect(DEVICE_LOCK_CONTRACT.maxDevices).toBe(2);
    expect(DEVICE_LOCK_CONTRACT.maxDevices).not.toBe(1);
    expect(DEVICE_LOCK_CONTRACT.maxDevices).not.toBe(3);
  });

  it('hard_lock mode, no auto eviction, tenant-scoped namespace', () => {
    expect(DEVICE_LOCK_CONTRACT.mode).toBe('hard_lock');
    expect(DEVICE_LOCK_CONTRACT.autoEviction).toBe(false);
    expect(DEVICE_LOCK_CONTRACT.kvKeyNamespace).toBe('lf_dev');
  });

  it('env contract: dedicated store (either naming) + access code + tenant id; NO DEVICE_ADMIN_SECRET', () => {
    expect(DEVICE_LOCK_ENV_KEYS).toEqual([
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'APP_PASS',
      'CUSTOMER_TENANT_ID',
    ]);
    expect(DEVICE_LOCK_ENV_KEYS).not.toContain('DEVICE_ADMIN_SECRET');
  });

  it('access code length is 16', () => {
    expect(DEVICE_LOCK_CONTRACT.accessCodeLength).toBe(16);
  });
});

describe('R1 TWO-DEVICE CONTRACT — tenant-scoped registry namespace', () => {
  it('namespace derives from the IMMUTABLE tenant id, never the hostname', () => {
    expect(deviceLockNamespaceFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('lf_dev:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    // different tenants → different namespaces
    expect(deviceLockNamespaceFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).not.toBe(deviceLockNamespaceFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  });

  it('devicePolicyFor carries only non-secret metadata', () => {
    const fp = 'A'.repeat(64);
    const policy = devicePolicyFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fp);
    expect(policy.maxDevices).toBe(2);
    expect(policy.mode).toBe('hard_lock');
    expect(policy.kvNamespace).toBe('lf_dev:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(policy.appPassConfigured).toBe(true);
    expect(policy.tenantIdConfigured).toBe(true);
    expect(policy.autoEviction).toBe(false);
    expect(policy.storeFingerprint).toBe(fp);
    expect(JSON.stringify(policy)).not.toContain('https://');
    expect(JSON.stringify(policy)).not.toContain('token');
  });
});

describe('R1 TWO-DEVICE CONTRACT — dedicated-store fingerprint', () => {
  it('fingerprint is a full 64-hex uppercase SHA-256 of the normalized store URL', () => {
    const fp = kvStoreFingerprint('https://store-abc.upstash.io');
    expect(fp).toMatch(/^[A-F0-9]{64}$/);
    expect(fp.length).toBe(64);
  });

  it('normalization: scheme, case, trailing slashes do not change the fingerprint', () => {
    const a = kvStoreFingerprint('https://STORE-ABC.upstash.io/');
    const b = kvStoreFingerprint('http://store-abc.upstash.io');
    const c = kvStoreFingerprint('store-abc.upstash.io///');
    expect(a).toBe(b);
    expect(b).toBe(c);
    // different stores → different fingerprints
    expect(kvStoreFingerprint('https://store-abc.upstash.io')).not.toBe(kvStoreFingerprint('https://store-xyz.upstash.io'));
  });

  it('normalizeKvStoreUrl produces the canonical form', () => {
    expect(normalizeKvStoreUrl('  HTTPS://ABC.example.com// ')).toBe('abc.example.com');
  });
});

describe('R1 TWO-DEVICE CONTRACT — probe verification (fail-closed)', () => {
  it('accepts an exactly-locked probe', () => {
    expect(verifyDeviceLockProbe(VALID_PROBE).consistent).toBe(true);
  });

  it('rejects open mode (KV missing at runtime)', () => {
    const r = verifyDeviceLockProbe({ ...VALID_PROBE, mode: 'open', kvConfigured: false });
    expect(r.consistent).toBe(false);
    expect(r.reasons.join()).toContain('device lock not active');
  });

  it('rejects unconfigured mode (tenant id missing)', () => {
    const r = verifyDeviceLockProbe({ ...VALID_PROBE, mode: 'unconfigured', tenantIdConfigured: false });
    expect(r.consistent).toBe(false);
    expect(r.reasons.join()).toContain('device lock not active');
  });

  it('rejects maxDevices ≠ 2', () => {
    const r = verifyDeviceLockProbe({ ...VALID_PROBE, maxDevices: 1 });
    expect(r.consistent).toBe(false);
    expect(r.reasons.join()).toContain('maxDevices must be exactly 2');
  });

  it('rejects missing access code / tenant id / KV booleans', () => {
    expect(verifyDeviceLockProbe({ ...VALID_PROBE, appPassConfigured: false }).consistent).toBe(false);
    expect(verifyDeviceLockProbe({ ...VALID_PROBE, tenantIdConfigured: false }).consistent).toBe(false);
    expect(verifyDeviceLockProbe({ ...VALID_PROBE, kvConfigured: false }).consistent).toBe(false);
    expect(verifyDeviceLockProbe(null).consistent).toBe(false);
  });
});

describe('R1 TWO-DEVICE CONTRACT — persisted policy verification (fail-closed)', () => {
  it('accepts an exact contract policy', () => {
    expect(verifyDeviceLockPolicy(devicePolicyFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'B'.repeat(64))).consistent).toBe(true);
  });

  it('rejects max ≠ 2, open/soft modes, eviction, missing fingerprint, non-tenant namespace', () => {
    const base = devicePolicyFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'B'.repeat(64));
    expect(verifyDeviceLockPolicy({ ...base, maxDevices: 3 }).consistent).toBe(false);
    expect(verifyDeviceLockPolicy({ ...base, mode: 'warn_only' } as unknown as DevicePolicy).consistent).toBe(false);
    expect(verifyDeviceLockPolicy({ ...base, autoEviction: true }).consistent).toBe(false);
    expect(verifyDeviceLockPolicy({ ...base, storeFingerprint: 'short' }).consistent).toBe(false);
    expect(verifyDeviceLockPolicy({ ...base, kvNamespace: 'hostname-keyed' }).consistent).toBe(false);
    expect(verifyDeviceLockPolicy(null).consistent).toBe(false);
  });

  it('never persists secret-shaped values', () => {
    const policy = devicePolicyFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'B'.repeat(64));
    const s = JSON.stringify(policy);
    expect(s).not.toMatch(/https?:\/\//);
    expect(s).not.toContain('upstash');
    expect(s).not.toContain('tok_');
  });
});

describe('R1 TWO-DEVICE CONTRACT — handoff secrets verification (fail-closed)', () => {
  it('accepts complete well-formed secrets', () => {
    expect(verifyDeviceLockSecrets(VALID_SECRETS).consistent).toBe(true);
  });

  it('rejects missing/invalid dedicated store URL (https required)', () => {
    expect(verifyDeviceLockSecrets({ ...VALID_SECRETS, kvRestApiUrl: '' }).consistent).toBe(false);
    expect(verifyDeviceLockSecrets({ ...VALID_SECRETS, kvRestApiUrl: 'http://store.upstash.io' }).consistent).toBe(false);
  });

  it('rejects short KV token and short access code (< 16 chars)', () => {
    expect(verifyDeviceLockSecrets({ ...VALID_SECRETS, kvRestApiToken: 'short' }).consistent).toBe(false);
    expect(verifyDeviceLockSecrets({ ...VALID_SECRETS, appPass: 'tooshort' }).consistent).toBe(false);
    expect(verifyDeviceLockSecrets(null).consistent).toBe(false);
    expect(verifyDeviceLockSecrets(undefined).consistent).toBe(false);
  });
});
