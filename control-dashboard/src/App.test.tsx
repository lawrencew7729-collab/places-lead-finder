import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('Phase 1 dashboard foundation', () => {
  it('shows an enabled Supabase-auth gate before the control plane', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /control dashboard/i })).toBeVisible();
    expect(screen.getByLabelText(/operator email/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
    expect(screen.queryByText(/sign in disabled in p0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/supabase auth not connected in p0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/blocked_by_p0_gate/i)).not.toBeInTheDocument();
  });

  it('enters review mode and exposes all Phase 1 foundation areas', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    expect(screen.getByText('Foundation Review')).toBeVisible();
    expect(screen.getByRole('button', { name: /customers/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /releases/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /health & alerts/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /infrastructure/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /audit log/i })).toBeVisible();
  });

  it('labels mock information so it cannot be mistaken for production data', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    expect(screen.getAllByText(/sample data/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no production customer data imported/i)).toBeVisible();
  });

  it('opens the Phase 2 local-only wizard without exposing an activation action', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    await user.click(screen.getByRole('button', { name: /new customer · local mock/i }));

    expect(screen.getByRole('dialog', { name: /new customer wizard/i })).toBeVisible();
    expect(screen.getByText(/local mock · no external mutation/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
  });

  it('derives Overview and Infrastructure status from the same authoritative selector', async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    const overviewStatus = screen.getByTestId('overview-infrastructure-status').textContent;
    await user.click(screen.getByRole('button', { name: /^infrastructure$/i }));
    expect(screen.getByTestId('infrastructure-authoritative-status').textContent).toBe(overviewStatus);
  });

  it('states the Phase 2 on-demand monitoring boundary without claiming a continuous scheduler', async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    await user.click(screen.getByRole('button', { name: /health & alerts/i }));
    expect(screen.getByText(/phase 2 requires on-demand sandbox monitoring verification for onboarding activation/i)).toBeVisible();
    expect(screen.getByText(/continuous fleet-scale scheduler and automated notifications are deferred to phase 3\+/i)).toBeVisible();
  });

  it('saves, closes, then resumes the same authoritative App-scoped local checkpoint', async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /open foundation review/i }));
    await user.click(screen.getByRole('button', { name: /new customer · local mock/i }));
    await user.type(screen.getByLabelText(/company name/i), 'Resume Customer');
    await user.type(screen.getByLabelText(/tenant slug/i), 'resume-customer');
    await user.type(screen.getByLabelText(/exact subdomain/i), 'resume-customer.leadfinder.business');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByLabelText(/google project id/i), 'resume-google-project');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByLabelText(/amber threshold/i), '70');
    await user.type(screen.getByLabelText(/red threshold/i), '90');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /run local mock checks/i }));
    expect(await screen.findByText(/5 local contract checks complete/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /continue to readiness review/i }));
    await user.click(screen.getByRole('button', { name: /save local draft/i }));
    expect(await screen.findByText(/local checkpoint saved · resume customer/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /resume local checkpoint/i }));
    expect(screen.getByRole('dialog', { name: /new customer wizard/i })).toBeVisible();
    expect(screen.getByText(/resumed saved checkpoint/i)).toBeVisible();
    expect(screen.getByText('Resume Customer')).toBeVisible();
    expect(screen.getByText('resume-customer.leadfinder.business')).toBeVisible();
    expect(screen.getByText('resume-google-project')).toBeVisible();
    expect(screen.getByText(/amber 70% · red 90%/i)).toBeVisible();
  }, 20000);
});
