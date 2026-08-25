import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewCustomerWizard } from './NewCustomerWizard';
import { InMemoryOnboardingRepository } from './onboardingRepository';
import { createMockProviderGateway } from './providers';

function renderWizard(repository = new InMemoryOnboardingRepository(), onSaveDraft = vi.fn()) {
  render(<NewCustomerWizard gateway={createMockProviderGateway()} operator={{ id: 'test-admin', role: 'admin', active: true }} repository={repository} onClose={() => undefined} onSaveDraft={onSaveDraft} />);
  return { repository, onSaveDraft };
}

async function reachGoogleStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/company name/i), 'Phase Two Sandbox');
  await user.type(screen.getByLabelText(/tenant slug/i), 'phase-two-sandbox');
  await user.type(screen.getByLabelText(/exact subdomain/i), 'test.leadfinder.business');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  await user.type(screen.getByLabelText(/google project id/i), 'phase-two-sandbox-project');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

describe('Phase 2 New Customer Wizard — local mock boundary', () => {
  it('gets fingerprint provenance from the mock provider and atomically saves/audits/checkpoints through the repository', async () => {
    const user = userEvent.setup();
    const { repository, onSaveDraft } = renderWizard();
    expect(screen.getByText(/local mock · no external mutation/i)).toBeVisible();
    await reachGoogleStep(user);

    expect(screen.queryByLabelText(/fingerprint metadata/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/monthly target/i)).toHaveValue(1000);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/amber threshold/i), '70');
    await user.type(screen.getByLabelText(/red threshold/i), '90');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /run local mock checks/i }));
    expect(await screen.findByText(/5 local contract checks complete/i)).toBeVisible();
    expect(screen.getByText(/authoritative readiness remains unknown/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /continue to readiness review/i }));

    expect(screen.getByText(/gate s1 · blocked/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save local draft/i }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Phase Two Sandbox', hostname: 'test.leadfinder.business', monitoringMode: 'shared_access', tenantId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      keyFingerprint: expect.objectContaining({ algorithm: 'sha256', computedBy: 'mock_provider_adapter' }),
      quotaPolicy: { monthlyTarget: 1000, amberPercent: 70, redPercent: 90, status: 'owner_configured' },
      releaseIdentity: expect.objectContaining({ releaseId: 'golden-root-626c0c1', gitSha: expect.stringMatching(/^[0-9a-f]{40}$/), artifactSha256: expect.stringMatching(/^[A-F0-9]{64}$/) }),
      readinessState: { ready: false, reasons: expect.arrayContaining(['MOCK_NON_AUTHORITATIVE', 'BLOCKED_BY_P0_GATE']) },
    })));
    expect(repository.exportRedacted().audits).toHaveLength(1);
    expect(repository.exportRedacted().checkpoints[0].wizardState.currentStep).toBe(5);
    expect(repository.exportRedacted().checkpoints[0].wizardState.status).toBe('blocked');
    expect(repository.exportRedacted().checkpoints[0].wizardState.blockReason).toMatch(/step 5.*UNKNOWN/i);
  }, 15000);

  it('does not create any raw credential field or browser-storage entry', () => {
    localStorage.clear(); sessionStorage.clear(); renderWizard();
    expect(screen.queryByLabelText(/raw.*key|api key|secret/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('AIza');
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it('rejects reversed quota thresholds without inventing replacements', async () => {
    const user = userEvent.setup(); renderWizard(); await reachGoogleStep(user);
    await user.type(screen.getByLabelText(/amber threshold/i), '95');
    await user.type(screen.getByLabelText(/red threshold/i), '90');
    expect(screen.getByText(/amber must not exceed red/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  }, 15000);
});
