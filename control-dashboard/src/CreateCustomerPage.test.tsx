import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateCustomerPage } from './CreateCustomerPage';

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn<() => unknown>(() => null),
  startProvision: vi.fn(),
  fetchProvisionStatus: vi.fn(),
  confirmSmoke: vi.fn(),
  fetchPortalHealth: vi.fn(),
}));

vi.mock('./supabase', () => ({
  getSupabaseClient: mocks.getSupabaseClient,
  isSupabaseConfigured: false,
}));

vi.mock('./provisioningClient', () => ({
  startProvision: mocks.startProvision,
  fetchProvisionStatus: mocks.fetchProvisionStatus,
  confirmSmoke: mocks.confirmSmoke,
  fetchPortalHealth: mocks.fetchPortalHealth,
}));

const PLAUSIBLE_KEY = 'AIzaSyBR_pqYgLQ8qVvz1O3cB4Wx7yZ123456789abcdefg';

function renderPage(overrides: { isAdmin?: boolean; onEnterInternal?: () => void } = {}) {
  const props = {
    isAdmin: true,
    onEnterInternal: overrides.onEnterInternal ?? (() => undefined),
    provisioningAuthorized: false as const,
    operatorLabel: 'Test Admin',
    operatorRoleLabel: 'admin · authenticated',
    onLogout: () => undefined,
    ...overrides,
  };
  return render(<CreateCustomerPage {...props} />);
}

async function prepareProvisioning(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/company name/i), 'Portal Test Company');
  await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'portal-test-project');
  await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
  await user.click(screen.getByTestId('restriction-confirm'));
  await user.click(screen.getByRole('button', { name: /verify details/i }));
  await screen.findByTestId('verify-results');
  await user.click(screen.getByTestId('generate-access-code'));
  await screen.findByTestId('access-code-value');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PRE-R1 Create Customer page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getSupabaseClient.mockReturnValue(null);
    mocks.startProvision.mockResolvedValue({ ok: true, tenantId: '11111111-1111-4111-8111-111111111111', runId: 'wf-staff-ux', status: 'running', appPassState: 'created' });
    mocks.fetchProvisionStatus.mockResolvedValue({ ok: true, status: 'provisioning', tenantStatus: 'setup_pending' });
    mocks.confirmSmoke.mockResolvedValue({ ok: true });
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: false });
  });

  it('4. renders as a one-page form (no multi-step wizard)', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /create new customer/i })).toBeVisible();
    expect(screen.queryByLabelText(/wizard progress/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('5. company name produces a subdomain suggestion', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await waitFor(() => {
      expect(screen.getByLabelText(/^subdomain/i)).toHaveValue('abc');
    });
  });

  it('6. owner can edit the suggested subdomain', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await waitFor(() => {
      expect(screen.getByLabelText(/^subdomain/i)).toHaveValue('abc');
    });
    const subdomain = screen.getByLabelText(/^subdomain/i);
    await user.clear(subdomain);
    await user.type(subdomain, 'abc-kl');
    expect(screen.getByTestId('customer-url')).toHaveTextContent('https://abc-kl.leadfinder.business');
  });

  it('7. customer URL generates correctly', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Meridian Industrial');
    await waitFor(() => {
      expect(screen.getByTestId('customer-url')).toHaveTextContent('https://meridian.leadfinder.business');
    });
  });

  it('8. website restriction generates correctly', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Atlas Commerce');
    await waitFor(() => {
      expect(screen.getByTestId('website-restriction')).toHaveTextContent('https://atlas.leadfinder.business/*');
    });
  });

  it('9. COPY action produces the exact restriction', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPage();
    fireEvent.change(screen.getByLabelText(/company name/i), { target: { value: 'ABC Trading Sdn Bhd' } });
    await waitFor(() => {
      expect(screen.getByTestId('copy-restriction')).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId('copy-restriction'));
    expect(writeText).toHaveBeenCalledWith('https://abc.leadfinder.business/*');
    expect(await screen.findByText(/copied/i)).toBeVisible();
  });

  it('10. Google Project ID field exists', () => {
    renderPage();
    expect(screen.getByLabelText(/google cloud project id/i)).toBeVisible();
  });

  it('11. Places API key is a masked input', () => {
    renderPage();
    const input = screen.getByLabelText(/google places api key/i);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('fresh Google fields are empty and hardened against browser/password-manager autofill while reveal still works', async () => {
    const user = userEvent.setup();
    renderPage();
    const project = screen.getByLabelText(/google cloud project id/i);
    const key = screen.getByLabelText(/google places api key/i);
    expect(project).toHaveValue('');
    expect(key).toHaveValue('');
    expect(project).toHaveAttribute('autocomplete', 'off');
    expect(key).toHaveAttribute('autocomplete', 'new-password');
    expect(project).toHaveAttribute('readonly');
    expect(key).toHaveAttribute('readonly');
    expect(project).toHaveAttribute('data-1p-ignore');
    expect(key).toHaveAttribute('data-lpignore', 'true');
    await user.click(key);
    expect(key).not.toHaveAttribute('readonly');
    await user.type(key, PLAUSIBLE_KEY);
    await user.click(screen.getByRole('button', { name: /reveal api key/i }));
    expect(key).toHaveAttribute('type', 'text');
    expect(key).toHaveValue(PLAUSIBLE_KEY);
  });

  it('has no legacy/mock customer mutation and PROVISION CUSTOMER is the only provisioning-start CTA', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /^CREATE CUSTOMER$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PREVIEW RUN SHEET|PREVIEW FAILURE|^RESET$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/provisioning not connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText('PROVISION (CLOUD)')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^PROVISION CUSTOMER$/i })).toHaveLength(1);
  });

  it('12. SYSTEM DEFAULTS panel starts collapsed for admin — values hidden until ADVANCED', () => {
    renderPage();
    const panel = screen.getByTestId('system-defaults');
    expect(panel).toBeVisible();
    expect(screen.getByText(/Monitoring and usage limits are managed by Lead Finder/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /^ADVANCED/i })).toBeVisible();
    expect(screen.queryByTestId('default-monthly-limit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-amber')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-red')).not.toBeInTheDocument();
    expect(screen.queryByText(/Central Lead Finder service account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dedicated JSON Credential/i)).not.toBeInTheDocument();
  });

  it('13. ADVANCED reveals then re-collapses the 1000 / 850 / 900 defaults (SAFETY STOP)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^ADVANCED/i }));
    expect(screen.getByTestId('default-monthly-limit')).toHaveTextContent('1,000');
    expect(screen.getByTestId('default-amber')).toHaveTextContent('850');
    expect(screen.getByTestId('default-red')).toHaveTextContent('900');
    await user.click(screen.getByRole('button', { name: /^ADVANCED/i }));
    expect(screen.queryByTestId('default-monthly-limit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-amber')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-red')).not.toBeInTheDocument();
  });

  it('website restriction checkpoint UX: exact generated value + COPY + authenticated operator confirmation checkbox', async () => {
    const user = userEvent.setup();
    renderPage();
    // fill the form so a slug exists
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'abc-leadfinder-1234');
    // exact generated restriction (never manually typed)
    expect(screen.getByTestId('website-restriction').textContent).toBe('https://abc.leadfinder.business/*');
    // COPY control enabled
    expect(screen.getByTestId('copy-restriction')).toBeEnabled();
    // confirmation checkbox disabled until a valid restriction exists, then
    // toggles with the owner-final exact wording
    const checkbox = screen.getByTestId('restriction-confirm');
    expect(checkbox).toBeEnabled();
    expect(screen.getByText(/I have configured this exact Website Restriction in the customer's Google Console/i)).toBeVisible();
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('16b. access code: available before provisioning, generated per customer, copyable, transient UI state only', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderPage();
    expect(screen.getByTestId('generate-access-code')).toBeEnabled();
    expect(screen.queryByTestId('access-code-value')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('generate-access-code'));
    const firstCode = screen.getByTestId('access-code-value').textContent ?? '';
    expect(firstCode).toHaveLength(16);
    expect(screen.getByTestId('copy-access-code')).toBeVisible();
    await user.click(screen.getByTestId('copy-access-code'));
    expect(writeText).toHaveBeenCalledWith(firstCode);
    // two generations differ (capture the value BEFORE re-render mutates the node)
    await user.click(screen.getByTestId('generate-access-code'));
    const secondCode = screen.getByTestId('access-code-value').textContent ?? '';
    expect(secondCode).not.toBe(firstCode);
  });

  it('locks generation as soon as startProvision is initiated and created keeps only Code A', async () => {
    let resolveStart!: (value: unknown) => void;
    mocks.startProvision.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    const codeA = screen.getByTestId('access-code-value').textContent;

    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.startProvision).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-code-value')).toHaveTextContent(codeA ?? '');

    resolveStart({ ok: true, tenantId: 'guard-created', runId: 'wf-guard-created', status: 'running', appPassState: 'created' });
    await waitFor(() => expect(screen.getByTestId('provision-running')).toBeVisible());
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-code-value')).toHaveTextContent(codeA ?? '');
  });

  it('retained clears transient Code A, shows ORIGINAL message, and provides no ordinary regenerate path', async () => {
    mocks.startProvision.mockResolvedValueOnce({ ok: true, tenantId: 'guard-retained', runId: 'wf-guard-retained', status: 'running', appPassState: 'retained' });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));

    expect(await screen.findByTestId('access-code-retained')).toHaveTextContent(/Use the ORIGINAL Access Code from the first provisioning/i);
    expect(screen.queryByTestId('access-code-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-access-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
  });

  it('ordinary retry stays locked and reuses exact Code A after a remote start failure', async () => {
    mocks.startProvision
      .mockResolvedValueOnce({ ok: false, reason: 'temporary start failure' })
      .mockResolvedValueOnce({ ok: true, tenantId: 'guard-retry', runId: 'wf-guard-retry', status: 'running', appPassState: 'created' });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    const codeA = screen.getByTestId('access-code-value').textContent;

    await user.click(screen.getByTestId('cloud-provision'));
    expect(await screen.findByTestId('provision-error')).toHaveTextContent(/temporary start failure/i);
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-code-value')).toHaveTextContent(codeA ?? '');

    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.startProvision).toHaveBeenCalledTimes(2));
    expect(mocks.startProvision).toHaveBeenLastCalledWith(expect.objectContaining({ appPass: codeA }));
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-code-value')).toHaveTextContent(codeA ?? '');
  });

  it('local validation failure before startProvision does not latch the guard', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('generate-access-code'));
    const codeA = screen.getByTestId('access-code-value').textContent;
    await user.click(screen.getByTestId('cloud-provision'));

    expect(mocks.startProvision).not.toHaveBeenCalled();
    expect(screen.getByTestId('provision-error')).toHaveTextContent(/VERIFY DETAILS first/i);
    expect(screen.getByTestId('generate-access-code')).toBeEnabled();
    await user.click(screen.getByTestId('generate-access-code'));
    expect(screen.getByTestId('access-code-value').textContent).not.toBe(codeA);
  });

  it('re-enables generation only for explicit recoveryNeedsAccessCode and re-locks on retry request', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'retrycode', tenantId }));
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
      from: vi.fn(() => ({ select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: [{ slug: 'retrycode', status: 'setup_pending', id: tenantId }], error: null })),
      })) })),
    });
    mocks.startProvision.mockResolvedValueOnce({ ok: false, reason: 'OWNER ACTION REQUIRED: APP_PASS is missing' });
    let resolveRetry!: (value: unknown) => void;
    mocks.startProvision.mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Retry Code Company');
    await user.clear(screen.getByLabelText(/^subdomain/i));
    await user.type(screen.getByLabelText(/^subdomain/i), 'retrycode');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'retry-code-project');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByTestId('restriction-confirm'));
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    expect(await screen.findByText(/Existing setup found — resume provisioning/i)).toBeVisible();
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('cloud-provision'));
    expect(await screen.findByTestId('generate-access-code')).toBeEnabled();
    await user.click(screen.getByTestId('generate-access-code'));
    const recoveryCode = screen.getByTestId('access-code-value').textContent;
    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.startProvision).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-code-value')).toHaveTextContent(recoveryCode ?? '');

    resolveRetry({ ok: true, tenantId, runId: 'wf-retry-code', status: 'running', appPassState: 'created' });
  });

  it('matching setup_pending recovery resumes without red duplicate or a fake replacement access code', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'retryco', tenantId }));
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
      from: vi.fn(() => ({ select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: [{ slug: 'retryco', status: 'setup_pending', id: tenantId }], error: null })),
      })) })),
    });
    mocks.startProvision.mockResolvedValue({ ok: true, tenantId, runId: 'wf-retry', status: 'running', appPassState: 'retained' });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Retry Company');
    await user.clear(screen.getByLabelText(/^subdomain/i));
    await user.type(screen.getByLabelText(/^subdomain/i), 'retryco');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'retry-project-1');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByTestId('restriction-confirm'));
    // Even a replacement-looking code generated before recovery detection is
    // cleared as soon as authoritative recovery identity is confirmed.
    await user.click(screen.getByTestId('generate-access-code'));
    expect(screen.getByTestId('access-code-value')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    expect(await screen.findByText(/Existing setup found — resume provisioning/i)).toBeVisible();
    expect(screen.queryByText(/Customer subdomain already exists/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('generate-access-code')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.startProvision).toHaveBeenCalledWith(expect.objectContaining({ recoveryTenantId: tenantId, appPass: undefined })));
    expect(screen.queryByTestId('access-code-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-access-code')).not.toBeInTheDocument();
    expect(await screen.findByTestId('access-code-retained')).toHaveTextContent(/Use the ORIGINAL Access Code from the first provisioning/i);
  });

  it('setup_pending without matching recovery identity remains a fail-closed duplicate', async () => {
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
      from: vi.fn(() => ({ select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: [{ slug: 'collision', status: 'setup_pending', id: 'authoritative-tenant' }], error: null })),
      })) })),
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Collision Company');
    await user.clear(screen.getByLabelText(/^subdomain/i));
    await user.type(screen.getByLabelText(/^subdomain/i), 'collision');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'collision-project-1');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    expect(await screen.findByText(/Customer subdomain already exists/i)).toBeVisible();
    expect(screen.getByText(/Recovery re-attachment required/i)).toBeVisible();
  });

  it('alreadyActive start response enters ACTIVE state and never renders provisioning', async () => {
    mocks.startProvision.mockResolvedValue({ ok: true, alreadyActive: true, tenantId: 'active-tenant', status: 'active' });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'Active Company');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'active-project-1');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByTestId('restriction-confirm'));
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    await user.click(screen.getByTestId('generate-access-code'));
    await user.click(screen.getByTestId('cloud-provision'));
    expect(await screen.findByTestId('provision-active')).toBeVisible();
    expect(screen.queryByTestId('provision-running')).not.toBeInTheDocument();
  });

  it('starts estimated progress after accepted cloud start, remains monotonic, and timer caps at 95 waiting for portal', async () => {
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('cloud-provision'));
    await act(async () => { await Promise.resolve(); });
    const progress = screen.getByTestId('provision-progress');
    expect(progress).toHaveAttribute('aria-valuenow', '0');
    act(() => { vi.advanceTimersByTime(180_000); });
    expect(progress).toHaveAttribute('aria-valuenow', '95');
    expect(screen.getByText(/Waiting for customer portal/i)).toBeVisible();
    act(() => { vi.advanceTimersByTime(180_000); });
    expect(progress).toHaveAttribute('aria-valuenow', '95');
  });

  it('real portal-ready response moves to 100 and reveals exact HTTPS COPY/OPEN card', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: true, status: 200 });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.fetchPortalHealth).toHaveBeenCalledWith('portal'));
    expect(await screen.findByTestId('portal-ready')).toBeVisible();
    expect(screen.getByTestId('provision-progress')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByTestId('customer-portal-url')).toHaveTextContent('https://portal.leadfinder.business');
    await user.click(screen.getByTestId('copy-customer-portal'));
    expect(writeText).toHaveBeenCalledWith('https://portal.leadfinder.business');
    expect(screen.getByTestId('copy-customer-portal')).toHaveTextContent('COPIED');
    expect(screen.getByTestId('open-customer-portal')).toHaveAttribute('href', 'https://portal.leadfinder.business');
  });

  it('COMPLETE ONBOARDING appears once Portal Ready + current context — no waiting_smoke/gate pre-check required', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: true, status: 200 });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));
    expect(await screen.findByTestId('portal-ready')).toBeVisible();
    // Portal Ready + running context ⇒ the single final action is available
    // even while authoritative status is still plain "provisioning".
    const complete = await screen.findByTestId('complete-onboarding');
    expect(complete).toBeEnabled();
    expect(complete).toHaveTextContent('COMPLETE ONBOARDING');
    // no engineering gate buttons or wording in the staff flow
    expect(screen.queryByText(/confirmation gate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for confirmation gate/i)).not.toBeInTheDocument();
  });

  it('accepted COMPLETE ONBOARDING → immediate CUSTOMER ACTIVE (no Workflow finalize wait)', async () => {
    mocks.fetchProvisionStatus.mockResolvedValue({ ok: true, status: 'waiting_smoke', tenantStatus: 'setup_pending', confirmationReady: true });
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: true, status: 200 });
    mocks.confirmSmoke.mockResolvedValue({ ok: true, status: 'active' });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));
    const complete = await screen.findByTestId('complete-onboarding');
    await user.click(complete);
    // PLAN B: the manual action itself is completion authority — ACTIVE
    // appears immediately, with no FINALIZING intermediate and no manual
    // ACTIVE-status refresh.
    expect(await screen.findByTestId('provision-active')).toHaveTextContent(/Customer ACTIVE/i);
    expect(screen.queryByTestId('provision-finalizing')).not.toBeInTheDocument();
    expect(mocks.confirmSmoke).toHaveBeenCalledTimes(1);
  });

  it('hook not ready → controlled retry copy, no fake ACTIVE, and no additional Workflow started', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: true, status: 200 });
    mocks.confirmSmoke.mockResolvedValue({ ok: false, retryable: true, reason: 'Hook not found for token smoke:abc — workflow not yet suspended' });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));
    const complete = await screen.findByTestId('complete-onboarding');
    await user.click(complete);
    expect(await screen.findByText(/Setup is still finishing\. Try Complete Onboarding again shortly\./i)).toBeVisible();
    expect(screen.queryByTestId('provision-finalizing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provision-active')).not.toBeInTheDocument();
    // the raw hook/platform reason is never shown to staff
    expect(screen.queryByText(/hook not found/i)).not.toBeInTheDocument();
  });

  it('portal NOT ready → COMPLETE ONBOARDING is not actionable', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: false });
    const user = userEvent.setup();
    renderPage();
    await prepareProvisioning(user);
    await user.click(screen.getByTestId('cloud-provision'));
    // provisioning running but portal probe not ready ⇒ no complete button yet
    expect(screen.getByTestId('provision-running')).toBeVisible();
    expect(screen.queryByTestId('complete-onboarding')).not.toBeInTheDocument();
    expect(mocks.confirmSmoke).not.toHaveBeenCalled();
  });

  it('FAILED state + Portal Ready → COMPLETE ONBOARDING visible, enabled, completes directly (Plan B)', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: true, status: 200 });
    mocks.fetchProvisionStatus.mockResolvedValue({
      ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true,
      reason: 'Previous provisioning run ended before customer activation. Verify this customer\u2019s details to safely continue.',
    });
    mocks.confirmSmoke.mockResolvedValue({ ok: true, status: 'active' });
    const user = userEvent.setup();
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId: '11111111-1111-4111-8111-111111111111', runId: 'wf-old' }));
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'op-token' } } })) },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ data: [{ slug: 'termco', status: 'setup_pending', id: '11111111-1111-4111-8111-111111111111' }], error: null })),
        })),
      })),
    });
    renderPage();
    // failed state is surfaced (recoverable message)
    expect(await screen.findByText(/Previous provisioning run ended/i)).toBeVisible();
    // Portal Ready + failed + exact tenant context ⇒ COMPLETE ONBOARDING IS
    // visible and enabled — Workflow state must NOT block manual completion.
    await waitFor(() => expect(screen.getByTestId('portal-ready')).toBeVisible());
    const complete = await screen.findByTestId('complete-onboarding');
    expect(complete).toBeEnabled();
    await user.click(complete);
    // existing manual completion request → immediate ACTIVE
    expect(mocks.confirmSmoke).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('provision-active')).toHaveTextContent(/Customer ACTIVE/i);
  });

  it('FAILED state + portal NOT ready → COMPLETE ONBOARDING unavailable', async () => {
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: false });
    mocks.fetchProvisionStatus.mockResolvedValue({
      ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true,
      reason: 'Previous provisioning run ended before customer activation. Verify this customer\u2019s details to safely continue.',
    });
    const user = userEvent.setup();
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId: '11111111-1111-4111-8111-111111111111', runId: 'wf-old' }));
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'op-token' } } })) },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ data: [{ slug: 'termco', status: 'setup_pending', id: '11111111-1111-4111-8111-111111111111' }], error: null })),
        })),
      })),
    });
    renderPage();
    expect(await screen.findByText(/Previous provisioning run ended/i)).toBeVisible();
    // portal probe stays not-ready → no completion affordance
    expect(screen.queryByTestId('complete-onboarding')).not.toBeInTheDocument();
    expect(mocks.confirmSmoke).not.toHaveBeenCalled();
  });

  it('17. no real provisioning mutation is possible', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    // duplicate-slug check uses the client only for read — here unconfigured → unavailable, never a write
    expect(await screen.findByText(/duplicate check unavailable/i)).toBeVisible();
  });

  it('privacy barrier: internal system data is not rendered', () => {
    renderPage();
    expect(screen.queryByText(/registered customers/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/monthly revenue/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/audit log/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/releases/i)).not.toBeInTheDocument();
  });

  it('INTERNAL entry is rendered for admin', () => {
    const onEnterInternal = vi.fn();
    renderPage({ isAdmin: true, onEnterInternal });
    expect(screen.getByRole('button', { name: /INTERNAL ADMIN/i })).toBeVisible();
  });

  it('INTERNAL entry is absent for non-admin operators', () => {
    renderPage({ isAdmin: false, onEnterInternal: undefined });
    expect(screen.queryByRole('button', { name: /INTERNAL ADMIN/i })).not.toBeInTheDocument();
  });
});

describe('STAFF COPY SIMPLIFICATION', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getSupabaseClient.mockReturnValue(null);
    mocks.startProvision.mockResolvedValue({ ok: true, tenantId: '11111111-1111-4111-8111-111111111111', runId: 'wf-staff-ux', status: 'running', appPassState: 'created' });
    mocks.fetchProvisionStatus.mockResolvedValue({ ok: true, status: 'provisioning', tenantStatus: 'setup_pending' });
    mocks.confirmSmoke.mockResolvedValue({ ok: true });
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: false });
  });

  it('shows the simplified onboarding subtitle', () => {
    renderPage();
    expect(screen.getByText(/Set up a new Lead Finder customer during face-to-face onboarding/i)).toBeVisible();
    expect(screen.queryByText(/provision real customer infrastructure/i)).not.toBeInTheDocument();
  });

  it('shows the customer-safe screen notice without the old privacy barrier wording', () => {
    renderPage();
    expect(screen.getByText('Customer-safe screen')).toBeVisible();
    expect(screen.getByText(/This screen only shows information needed for customer onboarding/i)).toBeVisible();
    expect(screen.queryByText(/Privacy barrier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal system information/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/audit data/i)).not.toBeInTheDocument();
  });

  it('shows the simplified Google instruction and hides the fingerprint staff UI', () => {
    renderPage();
    expect(screen.getByText(/Enter the customer's Google Cloud Project ID and Places API key after completing the Google Console setup/i)).toBeVisible();
    expect(screen.queryByText(/SHA-256 fingerprint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preview its fingerprint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw key is never stored or logged/i)).not.toBeInTheDocument();
  });

  it('shows the simplified Access Code explanation without internal terms', () => {
    renderPage();
    expect(screen.getByText(/Generate one access code for this customer/i)).toBeVisible();
    expect(screen.queryByText(/APP_PASS/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/OUT-OF-BAND/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/system of record/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-side/i)).not.toBeInTheDocument();
  });

  it('admin SYSTEM DEFAULTS: collapsed initially, ADVANCED reveals details, second click collapses again', async () => {
    const user = userEvent.setup();
    renderPage();
    const panel = screen.getByTestId('system-defaults');
    expect(panel).toBeVisible();
    expect(within(panel).getByText('SYSTEM DEFAULTS')).toBeVisible();
    expect(within(panel).getByText(/Monitoring and usage limits are managed by Lead Finder/i)).toBeVisible();
    // collapsed: no technical details rendered
    expect(within(panel).queryByTestId('default-monthly-limit')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('default-amber')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('default-red')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Central Lead Finder service account/i)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Dedicated JSON Credential/i)).not.toBeInTheDocument();
    // expand
    await user.click(within(panel).getByRole('button', { name: /^ADVANCED/i }));
    expect(screen.getByTestId('default-monthly-limit')).toHaveTextContent('1,000');
    expect(screen.getByTestId('default-amber')).toHaveTextContent('850');
    expect(screen.getByTestId('default-red')).toHaveTextContent('900');
    expect(screen.getByText(/Central Lead Finder service account/i)).toBeVisible();
    expect(screen.getByText(/Dedicated JSON Credential/i)).toBeVisible();
    // collapse again
    await user.click(within(panel).getByRole('button', { name: /^ADVANCED/i }));
    expect(screen.queryByTestId('default-monthly-limit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-amber')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-red')).not.toBeInTheDocument();
    expect(screen.queryByText(/Central Lead Finder service account/i)).not.toBeInTheDocument();
  });

  it('non-admin operators do not see the Monitoring/usage technical section', () => {
    renderPage({ isAdmin: false });
    expect(screen.queryByTestId('system-defaults')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-monthly-limit')).not.toBeInTheDocument();
    expect(screen.queryByText(/Monitoring & quota/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Approved target/i)).not.toBeInTheDocument();
  });

  it('shows the numbered onboarding flow 1 COMPANY → 5 PROVISION without DEFAULTS in the sequence', () => {
    renderPage();
    const labels = ['1 · COMPANY', '2 · GOOGLE', '3 · ACCESS', '4 · VERIFY', '5 · PROVISION'];
    const els = labels.map((label) => screen.getByText(label));
    // verify ascending document order: each element precedes the next
    for (let i = 0; i < els.length - 1; i += 1) {
      const rel = els[i].compareDocumentPosition(els[i + 1]);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.queryByText('4 · DEFAULTS')).not.toBeInTheDocument();
    expect(screen.queryByText('6 · PROVISION')).not.toBeInTheDocument();
  });

  it('VERIFY results use simplified human labels', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'abc-leadfinder-1234');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    const results = await screen.findByTestId('verify-results');
    expect(within(results).getByText('Company name')).toBeVisible();
    expect(within(results).getByText('Subdomain')).toBeVisible();
    expect(within(results).getByText('Customer URL')).toBeVisible();
    expect(within(results).getByText('Website Restriction')).toBeVisible();
    expect(within(results).getByText('Google Project')).toBeVisible();
    expect(within(results).getByText('API Key')).toBeVisible();
    expect(within(results).queryByText(/format valid/i)).not.toBeInTheDocument();
  });
});

describe('TERMINAL-RUN RECOVERY (2026-09-08)', () => {
  const tenantId = '9281cc3e-eb87-40f7-83a6-0d91322bb538';
  const runId = 'wrun_01M1VB5D1VFXDWR874FE2B0WEV';

  function supabaseWithSessionAndTenant(status: string) {
    return {
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'op-token' } } })) },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ data: [{ slug: 'termco', status, id: tenantId }], error: null })),
        })),
      })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getSupabaseClient.mockReturnValue(null);
    mocks.startProvision.mockResolvedValue({ ok: true, tenantId, runId: 'wf-fresh-run', status: 'running', appPassState: 'retained' });
    mocks.confirmSmoke.mockResolvedValue({ ok: true });
    mocks.fetchPortalHealth.mockResolvedValue({ ok: true, ready: false });
  });

  it('terminal completed old run surfaces as recoverable — not endless PROVISIONING, no auto-restart', async () => {
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId, runId }));
    mocks.getSupabaseClient.mockReturnValue(supabaseWithSessionAndTenant('setup_pending'));
    mocks.fetchProvisionStatus.mockResolvedValue({
      ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true,
      reason: 'Previous provisioning run ended before customer activation. Verify this customer\u2019s details to safely continue.',
    });
    const user = userEvent.setup();
    renderPage();
    // recovery effect surfaces the terminal state instead of a running card
    expect(await screen.findByText(/Previous provisioning run ended/i)).toBeVisible();
    expect(screen.queryByTestId('provision-running')).not.toBeInTheDocument();
    expect(mocks.startProvision).not.toHaveBeenCalled();
  });

  it('after re-entering details + exact VERIFY, ONE fresh PROVISION is allowed with recoveryTenantId and no appPass', async () => {
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId, runId }));
    mocks.getSupabaseClient.mockReturnValue(supabaseWithSessionAndTenant('setup_pending'));
    mocks.fetchProvisionStatus.mockResolvedValue({
      ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: true,
      reason: 'Previous provisioning run ended before customer activation. Verify this customer\u2019s details to safely continue.',
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Previous provisioning run ended/i)).toBeVisible();
    // staff re-enters the required customer fields
    await user.type(screen.getByLabelText(/company name/i), 'New Dummy Recovery');
    await user.clear(screen.getByLabelText(/^subdomain/i));
    await user.type(screen.getByLabelText(/^subdomain/i), 'termco');
    await user.type(screen.getByLabelText(/Google Cloud Project ID/i), 'new-dummy-507712');
    await user.type(screen.getByLabelText(/Google Places API key/i), PLAUSIBLE_KEY);
    await user.click(screen.getByTestId('restriction-confirm'));
    await user.click(screen.getByRole('button', { name: /verify details/i }));
    expect(await screen.findByText(/Recovery identity confirmed/i)).toBeVisible();
    // exact recovery identity verified → ONE new start, retained APP_PASS (no code)
    await user.click(screen.getByTestId('cloud-provision'));
    await waitFor(() => expect(mocks.startProvision).toHaveBeenCalledTimes(1));
    expect(mocks.startProvision).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'termco',
      googleProjectId: 'new-dummy-507712',
      recoveryTenantId: tenantId,
      appPass: undefined,
    }));
  });

  it('live/provisioning run status keeps PROVISION locked (no terminal unlock)', async () => {
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId, runId }));
    mocks.getSupabaseClient.mockReturnValue(supabaseWithSessionAndTenant('setup_pending'));
    mocks.fetchProvisionStatus.mockResolvedValue({ ok: true, status: 'provisioning', tenantStatus: 'setup_pending' });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('provision-running')).toBeVisible();
    expect(screen.getByTestId('cloud-provision')).toBeDisabled();
    expect(mocks.startProvision).not.toHaveBeenCalled();
  });

  it('non-restartable unknown state fails closed (no restart affordance)', async () => {
    localStorage.setItem('lf_provision_recovery', JSON.stringify({ slug: 'termco', tenantId, runId }));
    mocks.getSupabaseClient.mockReturnValue(supabaseWithSessionAndTenant('setup_pending'));
    mocks.fetchProvisionStatus.mockResolvedValue({ ok: true, status: 'failed', tenantStatus: 'setup_pending', restartable: false });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('provision-running')).toBeVisible();
    expect(screen.getByTestId('cloud-provision')).toBeDisabled();
    expect(screen.queryByText(/Previous provisioning run ended/i)).not.toBeInTheDocument();
  });
});
