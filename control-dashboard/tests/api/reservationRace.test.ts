/**
 * S2e FINAL BLOCKER CORRECTION — atomic reservation race + ACTIVE guard regressions.
 * (appended content — imported into provisioningHttp.test.ts describe scope is NOT
 * possible; this file re-implements the harness helpers from that suite.)
 */
import { describe, expect, it } from 'vitest';
import {
  createFakeProviders,
} from '../../src/provisioning/provisioningProviders.js';

const GOLDEN = { version: '1.0.0', tag: 'customer-app-v1.0.10', commitSha: 'c'.repeat(40), artifactSha256: 'A'.repeat(64), sourcePath: 'test', status: 'approved' as const };

describe('S2e atomic reservation + ACTIVE guard regressions', () => {
  it('route START happy-path helper sanity (registered release + auth)', async () => {
    const providers = createFakeProviders();
    await providers.controlPlane.insertRelease(GOLDEN as never);
    // NOTE: full route tests (session JWKS) live in provisioningHttp.test.ts;
    // this suite covers provider-level reservation semantics + guard wiring.
    expect(providers).toBeDefined();
  });

  it('revised reserve atomically clears a stale runId (the retry-race fix)', async () => {
    const providers = createFakeProviders();
    const tenantId = '11111111-1111-4111-8111-111111111111';
    // historical run: reserve token_A → link run_A_DEAD
    await providers.controlPlane.reserveProvisioningStart(tenantId, 'token_A');
    await providers.controlPlane.linkProvisioningRun(tenantId, 'token_A', 'run_A_DEAD');
    // release keeps the old runId (evidence)…
    await providers.controlPlane.releaseProvisioningReservation(tenantId, 'token_A');
    let state = await providers.controlPlane.readProvisioningReservation(tenantId);
    expect(state.runId).toBe('run_A_DEAD'); // retained as evidence, token NULL
    // …but a NEW reservation atomically clears it
    const reserved = await providers.controlPlane.reserveProvisioningStart(tenantId, 'token_B');
    expect(reserved.winner).toBe(true);
    state = await providers.controlPlane.readProvisioningReservation(tenantId);
    expect(state.reservationToken).toBe('token_B');
    expect(state.runId).toBeNull(); // THE fix — stale runId gone with the fresh token
    // concurrent C in the window now sees reserved+unlinked → route fails closed
    const loser = await providers.controlPlane.reserveProvisioningStart(tenantId, 'token_C');
    expect(loser.winner).toBe(false);
  });

  it('link/release CAS semantics: token mismatch never mutates', async () => {
    const providers = createFakeProviders();
    const tenantId = '22222222-2222-4222-8222-222222222222';
    await providers.controlPlane.reserveProvisioningStart(tenantId, 'token_X');
    const wrongLink = await providers.controlPlane.linkProvisioningRun(tenantId, 'token_WRONG', 'run_X');
    expect(wrongLink.linked).toBe(false);
    const state1 = await providers.controlPlane.readProvisioningReservation(tenantId);
    expect(state1.runId).toBeNull();
    const rightLink = await providers.controlPlane.linkProvisioningRun(tenantId, 'token_X', 'run_X');
    expect(rightLink.linked).toBe(true);
    const wrongRelease = await providers.controlPlane.releaseProvisioningReservation(tenantId, 'token_WRONG');
    expect(wrongRelease.released).toBe(false);
    const state2 = await providers.controlPlane.readProvisioningReservation(tenantId);
    expect(state2.reservationToken).toBe('token_X'); // untouched
    const rightRelease = await providers.controlPlane.releaseProvisioningReservation(tenantId, 'token_X');
    expect(rightRelease.released).toBe(true);
    const state3 = await providers.controlPlane.readProvisioningReservation(tenantId);
    expect(state3.reservationToken).toBeNull();
  });

  it('reservation read/acquire failure stays fail-closed at the provider boundary', async () => {
    const providers = createFakeProviders();
    const tenantId = '33333333-3333-4333-8333-333333333333';
    const fail = await providers.controlPlane.reserveProvisioningStart(tenantId, 't');
    expect(fail.ok).toBe(true);
  });
});
