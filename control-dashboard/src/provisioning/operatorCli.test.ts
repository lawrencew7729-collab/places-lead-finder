/**
 * PRE-R1 OPERATOR CLI HOST — authentication / lock / evidence / fingerprint.
 */
import { describe, expect, it } from 'vitest';
import { runOperatorCli, fingerprintPlacesKey, OPERATOR_ENV_KEYS } from './operatorCli';
import { createFakeProviders } from './provisioningProviders';
import type { GoldenReleaseIdentity } from './releaseRegistry';

const GOLDEN: GoldenReleaseIdentity = {
  version: '1.0.1',
  tag: 'customer-app-v1.0.1',
  commitSha: 'a'.repeat(40),
  artifactSha256: 'b'.repeat(64),
  sourcePath: 'repo root (Vite)',
  status: 'approved',
};

function fullEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of OPERATOR_ENV_KEYS) env[key] = `value-${key}`;
  env.CENTRAL_STORE_URL = 'https://central.example.com';
  return env;
}

function args() {
  return {
    companyName: 'ABC Trading Sdn Bhd',
    slug: 'abc',
    googleProjectId: 'abc-leadfinder-1234',
    billingAccountId: '01B61E-759031-B494E4',
    releaseTag: GOLDEN.tag,
    releaseVersion: GOLDEN.version,
    releaseCommitSha: GOLDEN.commitSha,
    releaseArtifactSha256: GOLDEN.artifactSha256,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const providers = createFakeProviders();
  const evidence: Array<Record<string, unknown>> = [];
  const locks = new Set<string>();
  return {
    providers,
    evidence,
    locks,
    base: {
      env: fullEnv(),
      args: args(),
      io: {
        promptSecret: async () => 'AIzaSyA_TEST_KEY_0000000000000000000000',
        confirm: async () => true,
        writeEvidence: async (e: Record<string, unknown>) => { evidence.push(e); },
      },
      lock: {
        acquire: async (slug: string) => {
          if (locks.has(slug)) return { ok: false as const, reason: `provisioning job already running for tenant '${slug}'` };
          locks.add(slug);
          return { ok: true as const };
        },
        release: async (slug: string) => { locks.delete(slug); },
      },
      providers,
      ...overrides,
    },
  };
}

describe('PRE-R1 operator CLI host', () => {
  it('fingerprintPlacesKey returns the full 64-hex uppercase SHA-256', () => {
    const fp = fingerprintPlacesKey('AIzaSyB_placeholder_key_1234567890abcdef');
    expect(fp).toMatch(/^[A-F0-9]{64}$/);
    // deterministic
    expect(fingerprintPlacesKey('AIzaSyB_placeholder_key_1234567890abcdef')).toBe(fp);
    // different key → different fingerprint
    expect(fingerprintPlacesKey('AIzaSyB_placeholder_key_1234567890abcdeg')).not.toBe(fp);
  });

  it('REFUSED when ANY privileged operator env var is missing (fail-closed, lists missing names)', async () => {
    const { base } = deps();
    const { OPERATOR_ENV_KEYS: keys, ...rest } = base.env as Record<string, string>;
    void keys;
    const env = { ...rest };
    delete env.VERCEL_TOKEN;
    delete env.UPSTASH_ADMIN_TOKEN;
    const result = await runOperatorCli({ ...base, env });
    expect(result.outcome).toBe('REFUSED');
    expect(result.reason).toContain('VERCEL_TOKEN');
    expect(result.reason).toContain('UPSTASH_ADMIN_TOKEN');
  });

  it('ABORTED when the operator declines the confirmation (no run, no lock)', async () => {
    const { base, locks } = deps();
    const result = await runOperatorCli({ ...base, io: { ...base.io, confirm: async () => false } });
    expect(result.outcome).toBe('ABORTED');
    expect(locks.size).toBe(0);
  });

  it('ABORTED at the website-restriction checkpoint when the operator cannot confirm the exact restriction (owner final decision 1)', async () => {
    const { base, locks } = deps();
    // first confirm (tenant summary) = yes; second confirm (restriction checkpoint) = no
    let calls = 0;
    const confirm = async () => {
      calls += 1;
      return calls === 1;
    };
    const result = await runOperatorCli({ ...base, io: { ...base.io, confirm } });
    expect(result.outcome).toBe('ABORTED');
    expect(result.reason).toContain('website restriction checkpoint');
    expect(locks.size).toBe(0);
  });

  it('REFUSED when another provisioning job holds the tenant lock', async () => {
    const { base, locks } = deps();
    locks.add('abc');
    const result = await runOperatorCli(base);
    expect(result.outcome).toBe('REFUSED');
    expect(result.reason).toContain('already running');
  });

  it('runs the executor with executionGate and writes NON-SECRET evidence', async () => {
    const { base, evidence, providers } = deps();
    await providers.controlPlane.insertRelease(GOLDEN);
    const result = await runOperatorCli(base);
    expect(result.outcome).toBe('CUSTOMER_READY');
    expect(result.result?.outcome).toBe('CUSTOMER_READY');
    expect(evidence).toHaveLength(1);
    const serialized = JSON.stringify(evidence[0]);
    // no secret material in the evidence file
    expect(serialized).not.toContain('AIza');
    expect(serialized).not.toContain('accesscode');
    expect(serialized).not.toContain('rest_tok_');
    expect(serialized).not.toContain('value-UPSTASH_ADMIN_TOKEN');
    // but the non-secret identities ARE recorded
    expect(serialized).toContain('abc.leadfinder.business');
    expect(serialized).toContain('CUSTOMER_READY');
    expect(serialized).toContain('rollbackMetadata');
    // OWNER DECISIONS 1/A audit evidence: tenant + EXACT generated restriction
    // + AUTHENTICATED operator identity + confirmation timestamp
    expect(serialized).toContain('https://abc.leadfinder.business/*');
    expect(serialized).toContain('"operator":{"id":"value-OPERATOR_USER_ID"}');
    expect(serialized).toContain('websiteRestrictionConfirmed');
    const confirmedAt = (evidence[0] as { websiteRestrictionConfirmedAt?: string }).websiteRestrictionConfirmedAt;
    expect(typeof confirmedAt).toBe('string');
    expect(new Date(confirmedAt as string).getTime()).not.toBeNaN();
  });

  it('real Customer Portal smoke: two-stage CLI flow — probe PASS alone stops; operator browser confirmation resumes to CUSTOMER_READY', async () => {
    const { base, evidence, providers } = deps();
    await providers.controlPlane.insertRelease(GOLDEN);
    // confirm sequence: tenant summary (1) → restriction checkpoint (2) → real
    // portal smoke (3, after the first run stops at usage_smoke)
    let calls = 0;
    const confirm = async () => {
      calls += 1;
      return true; // operator confirms all three
    };
    const result = await runOperatorCli({ ...base, io: { ...base.io, confirm } });
    expect(calls).toBe(3);
    expect(result.outcome).toBe('CUSTOMER_READY');
    const serialized = JSON.stringify(evidence[0]);
    // audit evidence: real portal smoke confirmed by the AUTHENTICATED operator
    expect(serialized).toContain('"realPortalSmokeConfirmed":true');
    expect(serialized).toContain('realPortalSmokeConfirmedAt');
  });

  it('real Customer Portal smoke: operator declines the browser checkpoint → ABORTED (HOLD / NOT READY, preflight alone insufficient)', async () => {
    const { base, locks, providers } = deps();
    await providers.controlPlane.insertRelease(GOLDEN);
    let calls = 0;
    const confirm = async () => {
      calls += 1;
      return calls !== 3; // decline ONLY the real portal smoke checkpoint
    };
    const result = await runOperatorCli({ ...base, io: { ...base.io, confirm } });
    expect(result.outcome).toBe('ABORTED');
    expect(result.reason).toContain('real Customer Portal browser smoke NOT confirmed');
    expect(locks.size).toBe(0); // lock released even on abort
  });

  it('device-slot rule: the real portal smoke instruction requires the CUSTOMER OWN first production device (operator device not acceptable)', async () => {
    const { base, providers } = deps();
    await providers.controlPlane.insertRelease(GOLDEN);
    const questions: string[] = [];
    const confirm = async (q: string) => {
      questions.push(q);
      return true;
    };
    const result = await runOperatorCli({ ...base, io: { ...base.io, confirm } });
    expect(result.outcome).toBe('CUSTOMER_READY');
    const smokePrompt = questions.find((q) => q.includes('REAL CUSTOMER PORTAL SMOKE')) ?? '';
    // the operator instruction explicitly requires the customer's OWN device
    expect(smokePrompt).toContain("CUSTOMER'S OWN");
    expect(smokePrompt).toContain('first production device');
    expect(smokePrompt).toContain('operator-owned laptop/browser must NOT be used');
    expect(smokePrompt).toContain('Device Slot 2 remains available');
    expect(smokePrompt).toContain("customer's own device");
  });

  it('refuses invalid slug / billing account id before any prompt', async () => {
    const { base } = deps();
    const badSlug = await runOperatorCli({ ...base, args: { ...args(), slug: 'Bad_Slug!' } });
    expect(badSlug.outcome).toBe('REFUSED');
    const badBilling = await runOperatorCli({ ...base, args: { ...args(), billingAccountId: 'nope' } });
    expect(badBilling.outcome).toBe('REFUSED');
  });

  it('lock is released after the run (even on failure)', async () => {
    const { base, locks, providers } = deps();
    await providers.controlPlane.insertRelease(GOLDEN);
    providers.setFailures(['vercel.bindDomain']);
    const result = await runOperatorCli(base);
    expect(result.outcome).toBe('FAILED');
    expect(locks.size).toBe(0);
  });
});
