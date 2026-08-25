import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = join(process.cwd(), 'dist');

function hasDist() {
  return existsSync(join(DIST, 'index.html'));
}

describe('customer-app production build structure (Part P)', () => {
  it.runIf(hasDist())('index.html is a small bootstrap shell without large inline application JS', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    // pre-paint auth gate bootstrap is allowed (<1KB); application logic must be external
    const inlineBlocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
    for (const block of inlineBlocks) {
      expect(block[1].length).toBeLessThan(1024);
    }
    expect(html).toContain('/assets/index-');
  });

  it.runIf(hasDist())('JS and CSS are emitted as hashed, minified assets', () => {
    const assets = readdirSync(join(DIST, 'assets'));
    const js = assets.filter((name) => name.endsWith('.js'));
    const css = assets.filter((name) => name.endsWith('.css'));
    expect(js.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
    for (const name of [...js, ...css]) {
      expect(name).toMatch(/-[A-Za-z0-9_-]{8}\.(js|css)$/);
    }
  });

  it.runIf(hasDist())('source maps are OFF — zero public .map artifacts', () => {
    const walk = (dir) => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const files = walk(DIST);
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
  });

  it.runIf(hasDist())('static assets (logo, icons, manifest) are copied to dist', () => {
    for (const asset of ['logo.png', 'favicon.png', 'apple-touch-icon.png', 'icons-192.png', 'icons-512.png', 'manifest.webmanifest']) {
      expect(existsSync(join(DIST, asset)), asset).toBe(true);
    }
  });

  it.runIf(hasDist())('bundle keeps the STOP fix and does not contain P0 disabled-login strings', () => {
    const assets = readdirSync(join(DIST, 'assets'));
    const js = assets.find((name) => name.endsWith('.js'));
    const bundle = readFileSync(join(DIST, 'assets', js), 'utf8');
    expect(bundle).toContain('RESULTS PRESERVED');
    expect(bundle).not.toContain('SIGN IN DISABLED IN P0');
  });
});
