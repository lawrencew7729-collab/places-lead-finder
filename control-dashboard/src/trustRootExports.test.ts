import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const productionSourceFiles = readdirSync(srcDir)
  .filter((name) => ['.ts', '.tsx'].includes(extname(name)) && !name.includes('.test.') && !name.endsWith('.d.ts'))
  .map((name) => resolve(srcDir, name));

const forbiddenCapabilityNames = [
  'createTrustedLocalP0HarnessForTests',
  'createTrustedMockAuthenticationForTests',
  'getLocalP0OperatorSession',
  'issueAmberApproval',
  'issueReadinessApproval',
  'issueCompleteEvidence',
];

function productionImportGraph(entry: string) {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), match[1]);
      const candidate = ['.ts', '.tsx'].map((suffix) => `${base}${suffix}`).find((path) => productionSourceFiles.includes(path));
      if (candidate) visit(candidate);
    }
  };
  visit(entry);
  return [...visited];
}

describe('production trust-root export boundary', () => {
  it('exports no trusted test harness, issuer factory, authentication bootstrap or AMBER issuer from any production module', () => {
    const exportedCapabilities = productionSourceFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenCapabilityNames
        .filter((name) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).test(source))
        .map((name) => `${file}:${name}`);
    });
    expect(exportedCapabilities).toEqual([]);
  });

  it('keeps the complete production import graph free of trusted issuer and approval-issuer capabilities', () => {
    const graph = productionImportGraph(resolve(srcDir, 'main.tsx'));
    const findings = graph.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenCapabilityNames.filter((name) => source.includes(name)).map((name) => `${file}:${name}`);
    });
    expect(graph.some((file) => /test-support|\.test\./.test(file))).toBe(false);
    expect(findings).toEqual([]);
  });

  it('contains no production module that can bootstrap a trusted repository, operator set and clock into genuine issuers', () => {
    const findings = productionSourceFiles.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /operators\s*:\s*TrustedMockOperatorBootstrap\[\]/.test(source)
        || (/clock\s*:\s*\{\s*now/.test(source) && /issueEvidence|issueAuthorization/.test(source));
    });
    expect(findings).toEqual([]);
  });
});
