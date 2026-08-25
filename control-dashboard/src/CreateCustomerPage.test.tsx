import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateCustomerPage } from './CreateCustomerPage';

vi.mock('./supabase', () => ({
  getSupabaseClient: vi.fn(() => null),
  isSupabaseConfigured: false,
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

describe('PRE-R1 Create Customer page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('12. Shared Monitoring default is displayed', () => {
    renderPage();
    expect(screen.getByText('Shared Monitoring')).toBeVisible();
  });

  it('13. 1000 / 900 / 1000 defaults are displayed', () => {
    renderPage();
    expect(screen.getByTestId('default-monthly-limit')).toHaveTextContent('1,000');
    expect(screen.getByTestId('default-amber')).toHaveTextContent('900');
    expect(screen.getByTestId('default-red')).toHaveTextContent('1,000');
  });

  it('15. CREATE CUSTOMER remains fail-closed PRE-R1', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/company name/i), 'ABC Trading Sdn Bhd');
    await user.type(screen.getByLabelText(/google cloud project id/i), 'abc-leadfinder-1234');
    await user.type(screen.getByLabelText(/google places api key/i), PLAUSIBLE_KEY);
    await waitFor(() => {
      expect(screen.getByTestId('create-customer')).toBeEnabled();
    });
    expect(screen.getByText('CUSTOMER_PROVISIONING_NOT_AUTHORIZED')).toBeVisible();
    // no mutation path: click does nothing (form submit is prevented; no repo/provider called)
    await user.click(screen.getByTestId('create-customer'));
    expect(screen.queryByText('CUSTOMER READY')).not.toBeInTheDocument();
  });

  it('16. Run Sheet UI works with deterministic mocked stages', async () => {
    const user = userEvent.setup();
    renderPage();
    const list = screen.getByTestId('run-sheet-list');
    expect(list.children).toHaveLength(10);
    expect(screen.getAllByText('PENDING').length).toBe(10);
    await user.click(screen.getByRole('button', { name: /preview run sheet/i }));
    // first stage flips to RUNNING synchronously
    expect(await screen.findByText('Running…')).toBeVisible();
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
