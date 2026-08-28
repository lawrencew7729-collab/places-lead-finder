/**
 * PRE-R1 OPERATOR CLI — REAL execution entry (Section B).
 *
 * Run (from control-dashboard/, after `npm install` — no runtime deps beyond
 * Node 22+ type stripping):
 *   node --experimental-strip-types scripts/provision-cli.ts \
 *     --company "ABC Trading Sdn Bhd" --slug abc \
 *     --project abc-leadfinder-1234 --billing-account 01B61E-759031-B494E4 \
 *     --release-tag customer-app-v1.0.1 --release-version 1.0.1 \
 *     --release-commit <sha> --release-artifact <sha256>
 *
 * Operator env (fail-closed — ALL required):
 *   VERCEL_TOKEN VERCEL_TEAM_ID SUPABASE_URL SUPABASE_SERVICE_ROLE
 *   OPERATOR_USER_ID UPSTASH_ADMIN_URL UPSTASH_ADMIN_TOKEN GOOGLE_ACCESS_TOKEN
 *   CENTRAL_STORE_URL WIF_POOL WIF_PROVIDER WIF_CENTRAL_PROJECT_NUMBER
 *   WIF_VERCEL_TEAM_SLUG WIF_VERCEL_TEAM_ID
 *
 * A3b: the customer's dedicated monitoring SA is PROVISIONED by the executor
 * (created in the customer's own Google project) — no SA identity is ever
 * caller-supplied.
 *
 * Transient secrets (Places key, APP_PASS) are prompted HIDDEN — never in
 * argv, never logged, never written to the evidence file.
 *
 * One tenant per invocation. NO automatic fleet rollout.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname as osHostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { runOperatorCli, type OperatorCliArgs, type OperatorCliEnv, type OperatorCliIo, type OperatorCliLock } from '../src/provisioning/operatorCli';
import { createVercelAdapter, createDeviceLockAdapter, createPlacesKeyAdapter, createControlPlaneAdapter, createGoogleAdapter, createUpstashRedisAclAdmin, createHealthAdapter, createUsageSmokeAdapter, nodeFetchTransport } from '../src/provisioning/adapters';

function parseArgs(argv: string[]): Partial<OperatorCliArgs> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1] ?? '';
      if (!value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return {
    companyName: args.company,
    slug: args.slug,
    googleProjectId: args.project,
    billingAccountId: args['billing-account'],
    releaseTag: args['release-tag'],
    releaseVersion: args['release-version'],
    releaseCommitSha: args['release-commit'],
    releaseArtifactSha256: args['release-artifact'],
    placesKeyFingerprint: args.fingerprint,
  };
}

/** Hidden stdin prompt (no echo). */
async function promptSecret(question: string): Promise<string> {
  const muted = { isMuted: false };
  const rl = createInterface({
    input,
    output,
    terminal: true,
  });
  const originalWrite = output.write.bind(output);
  (output as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    if (!muted.isMuted) return originalWrite(chunk);
    return true; // swallow echoed secret
  };
  muted.isMuted = true;
  const answer = await rl.question(question);
  muted.isMuted = false;
  (output as unknown as { write: (chunk: string) => boolean }).write = originalWrite;
  rl.close();
  output.write('\n');
  return answer;
}

/** Per-tenant job lock: refuse while a LIVE provisioning process holds it. */
function createFileLock(): OperatorCliLock {
  const lockPath = (slug: string) => join(tmpdir(), `lf-provision-${slug}.lock`);
  return {
    async acquire(slug) {
      const path = lockPath(slug);
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf8');
        const pid = Number(content.split('|')[0]);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0); // throws if no such process
            return { ok: false, reason: `provisioning job already running for tenant '${slug}' (pid ${pid})` };
          } catch {
            // stale lock from a dead process — reclaim below
          }
        }
      }
      writeFileSync(path, `${process.pid}|${osHostname()}|${new Date().toISOString()}`, { flag: 'w' });
      return { ok: true };
    },
    async release(slug) {
      try {
        unlinkSync(lockPath(slug));
      } catch {
        // best-effort
      }
    },
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const missing = (['companyName', 'slug', 'googleProjectId', 'billingAccountId', 'releaseTag', 'releaseVersion', 'releaseCommitSha', 'releaseArtifactSha256'] as const)
    .filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required arguments: ${missing.join(', ')}`);
    return 2;
  }

  const env: OperatorCliEnv = process.env as OperatorCliEnv;
  const evidenceDir = env.EVIDENCE_DIR ?? process.cwd();

  const io: OperatorCliIo = {
    promptSecret,
    confirm: async (question) => {
      const rl = createInterface({ input, output });
      const answer = (await rl.question(question)).trim().toLowerCase();
      rl.close();
      return answer === 'yes' || answer === 'y';
    },
    writeEvidence: async (evidence) => {
      const serialized = JSON.stringify(evidence, null, 2);
      // belt-and-braces: refuse to persist any secret-shaped content
      if (/AIza|rest_tok_|APP_PASS|>/.test(serialized.replace(/[^A-Za-z0-9_\-./:{}", ]/g, ''))) {
        throw new Error('refusing to write evidence containing secret-shaped content');
      }
      mkdirSync(evidenceDir, { recursive: true });
      const path = join(evidenceDir, `provisioning-${args.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(path, serialized);
      console.log(`Evidence: ${path}`);
    },
  };

  // REAL adapters (operator-side credentials from env). The google adapter
  // uses the operator's short-lived access token (GOOGLE_ACCESS_TOKEN) —
  // never a service-account JSON key.
  const transport = nodeFetchTransport();
  const vercelOptions = { token: env.VERCEL_TOKEN!, teamId: env.VERCEL_TEAM_ID!, storeMode: 'central' as const, transport };
  const providers: import('../src/provisioning/provisioningProviders').ProvisioningProviders = {
    vercel: createVercelAdapter(vercelOptions),
    google: createGoogleAdapter({ accessTokenProvider: async () => env.GOOGLE_ACCESS_TOKEN!, transport }),
    controlPlane: createControlPlaneAdapter({ baseUrl: env.SUPABASE_URL!, serviceRoleKey: env.SUPABASE_SERVICE_ROLE!, operatorUserId: env.OPERATOR_USER_ID!, transport }),
    health: createHealthAdapter({ transport }),
    secrets: createPlacesKeyAdapter(vercelOptions), // VITE_PLACES_API_KEY env handoff
    deviceLock: createDeviceLockAdapter(vercelOptions),
    redisAcl: createUpstashRedisAclAdmin({ adminUrl: env.UPSTASH_ADMIN_URL!, adminToken: env.UPSTASH_ADMIN_TOKEN!, transport }),
    usageSmoke: createUsageSmokeAdapter({ transport }),
  };

  const result = await runOperatorCli({ env, args: args as OperatorCliArgs, io, lock: createFileLock(), providers });

  if (result.outcome === 'CUSTOMER_READY' && result.result) {
    console.log(`\nCUSTOMER READY: https://${result.result.hostname} (tenant ${result.result.tenantId})`);
    return 0;
  }
  console.error(`\nOUTCOME: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  if (result.result?.failedStageId) {
    const failed = result.result.stages.find((s) => s.id === result.result!.failedStageId);
    console.error(`FAILED stage: ${result.result.failedStageId} — ${failed?.detail ?? ''}`);
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`provision-cli: ${(e as Error).message ?? String(e)}`);
    process.exit(1);
  });
