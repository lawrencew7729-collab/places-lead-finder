/**
 * CANONICAL Dashboard production release (2026-09-08 hardening).
 *
 * WHY: DUMMY3 incident — a manual extra `vercel build --prod` ran AFTER
 * `workflow build` regenerated .vercel/output and CLOBBERED the injected
 * Workflow runtime (`.well-known/workflow/v1/webhook/[token]`), so the
 * deployed artifact had no Workflow registration → "Deployment Unhealthy" →
 * runs stayed Pending forever.
 *
 * This script is the ONLY supported production release path. Operators must
 * NOT manually re-order / repeat steps. RULE: after `workflow build` injects
 * the runtime, NO second `vercel build --prod` may occur before deploy.
 *
 * Sequence (fail-closed):
 *   1. vercel build --prod
 *   2. workflow build --target vercel-build-output-api   (injects runtime)
 *   3. node scripts/verify-workflow-link.mjs              (workflow-ID drift)
 *   4. HARD GATE: .vercel/output MUST contain the Workflow webhook runtime
 *   5. workflow validate -d . --strict
 *   6. vercel deploy --prebuilt --prod                    (skipped with --check)
 *
 * Usage:
 *   npm run release:dashboard -- --check   # full local gate run, NO deploy
 *   npm run release:dashboard              # canonical production deploy
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WEBHOOK_MARKER = 'well-known';
const WEBHOOK_REQUIRED = 'webhook';

function run(cmd, args, label, opts = {}) {
  console.log(`\n▶ [${label}] ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32', // .cmd shims (vercel/npx) need a shell on Windows
    ...opts,
  });
  if (res.error) {
    console.error(`✗ [${label}] spawn failed: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✗ [${label}] FAILED (exit ${res.status}) — release aborted.`);
    process.exit(res.status ?? 1);
  }
  console.log(`✓ [${label}] PASS`);
}

/** Recursively search output functions dir for the Workflow webhook runtime. */
function findWebhookRuntime(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      const rel = full.slice(root.length).replace(/\\/g, '/');
      if (isDir) {
        walk(full);
      } else if (rel.includes(WEBHOOK_MARKER) && rel.toLowerCase().includes(WEBHOOK_REQUIRED)) {
        hits.push(rel);
      }
    }
  };
  walk(root);
  return hits;
}

function hardGateWebhookRuntime() {
  const base = join(ROOT, '.vercel', 'output', 'functions');
  if (!existsSync(base)) {
    console.error(`✗ HARD GATE: ${base} does not exist — run steps in order (vercel build --prod first). FAIL CLOSED.`);
    process.exit(1);
  }
  const hits = findWebhookRuntime(base);
  if (hits.length === 0) {
    console.error(
      '✗ HARD GATE FAILED (FAIL CLOSED — DO NOT DEPLOY):\n' +
      '  Workflow runtime artifact `.vercel/output/functions/.well-known/workflow/v1/webhook/[token]` is MISSING.\n' +
      '  Cause guard: `workflow build` must be the LAST step that writes .vercel/output.\n' +
      '  NEVER run `vercel build --prod` after `workflow build`.\n' +
      '  Re-run the canonical sequence from step 1 (this script) — do NOT hand-patch.',
    );
    process.exit(1);
  }
  console.log(`✓ HARD GATE PASS — Workflow webhook runtime present (${hits.length}):`);
  for (const h of hits.slice(0, 5)) console.log(`    ${h}`);
}

const checkOnly = process.argv.includes('--check');

run('vercel', ['build', '--prod'], 'vercel build --prod');
run('npx', ['--no-install', 'workflow', 'build', '--target', 'vercel-build-output-api'], 'workflow build (runtime injection)');
run('node', ['scripts/verify-workflow-link.mjs'], 'workflow-ID drift gate');
hardGateWebhookRuntime();
run('npx', ['--no-install', 'workflow', 'validate', '-d', '.', '--strict'], 'workflow strict validate');

if (checkOnly) {
  console.log('\n✔ PREFLIGHT COMPLETE (--check): all local release gates PASS, Workflow runtime present. NO DEPLOY PERFORMED.');
  process.exit(0);
}

console.log('\n▶ FINAL STEP: vercel deploy --prebuilt --prod (canonical artifact is verified complete)');
run('vercel', ['deploy', '--prebuilt', '--prod'], 'vercel deploy --prebuilt --prod');
console.log('\n✔ RELEASE COMPLETE. Verify: deploymentId / alias / deployed functions (webhook present).');
