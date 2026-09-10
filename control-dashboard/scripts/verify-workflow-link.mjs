/**
 * S2e FINAL FIX (VERDICT A) — workflow-ID drift gate.
 * After `workflow build`, verify the registered workflow id in the generated
 * flow.func artifact EXACTLY equals the source constant used by
 * api/lib/workflowRuntime.ts (PROVISION_CUSTOMER_WORKFLOW_ID).
 * READ-ONLY over generated artifacts — never mutates them. Exit 1 on drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const flowIndex = resolve(root, '.vercel/output/functions/.well-known/workflow/v1/flow.func/index.js');
const runtimeSource = resolve(root, 'api/lib/workflowRuntime.ts');

let failed = false;
try {
  const flowSrc = readFileSync(flowIndex, 'utf8');
  const m = flowSrc.match(/workflowId\s*=\s*"([^"]+)"/);
  if (!m) {
    console.error('DRIFT GATE FAIL: no workflowId assignment found in flow.func');
    process.exit(1);
  }
  const registeredId = m[1];

  const rtSrc = readFileSync(runtimeSource, 'utf8');
  const c = rtSrc.match(/PROVISION_CUSTOMER_WORKFLOW_ID\s*=\s*\n?\s*'([^']+)'/);
  if (!c) {
    console.error('DRIFT GATE FAIL: PROVISION_CUSTOMER_WORKFLOW_ID constant not found in', runtimeSource);
    process.exit(1);
  }
  const sourceId = c[1];

  console.log('flow.func registered :', registeredId);
  console.log('workflowRuntime const :', sourceId);
  if (registeredId !== sourceId) {
    console.error('DRIFT GATE FAIL: API start id != workflow build registered id');
    failed = true;
  } else {
    console.log('DRIFT GATE PASS: API start id == registered flow id');
  }
} catch (err) {
  console.error('DRIFT GATE FAIL:', err instanceof Error ? err.message : err);
  failed = true;
}
process.exit(failed ? 1 : 0);
