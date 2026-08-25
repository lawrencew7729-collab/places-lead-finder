import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import {
  resolveAuthorizedProfile,
  signInOperator,
  subscribeToAuthChanges,
} from './supabase';

vi.mock('./supabase', () => ({
  isSupabaseConfigured: true,
  signInOperator: vi.fn(),
  signOutOperator: vi.fn(),
  resolveAuthorizedProfile: vi.fn(),
  subscribeToAuthChanges: vi.fn(() => () => undefined),
}));

const mockedSignIn = vi.mocked(signInOperator);
const mockedResolve = vi.mocked(resolveAuthorizedProfile);
const mockedSubscribe = vi.mocked(subscribeToAuthChanges);

const adminProfile = { userId: 'u-admin-1', role: 'admin' as const, active: true, displayName: 'Test Admin' };
const operatorProfile = { userId: 'u-op-1', role: 'operator' as const, active: true, displayName: 'Test Operator' };

function lastListener(): (hasSession: boolean) => void {
  const calls = mockedSubscribe.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSubscribe.mockImplementation(() => () => undefined);
});

describe('D1 auth remediation — production UI auth flow', () => {
  it('1. login UI is enabled in production composition', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'UNAUTHENTICATED' });
    render(<App />);
    const button = await screen.findByRole('button', { name: /^sign in$/i });
    expect(button).toBeEnabled();
  });

  it('2. valid sign-in calls the real Supabase auth adapter', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'UNAUTHENTICATED' });
    mockedSignIn.mockResolvedValue({} as never);
    render(<App />);
    await userEvent.setup().type(screen.getByLabelText(/operator email/i), 'admin@leadfinder.business');
    await userEvent.setup().type(screen.getByLabelText(/password/i), 'correct-password');
    await userEvent.setup().click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(mockedSignIn).toHaveBeenCalledWith('admin@leadfinder.business', 'correct-password');
  });

  it('3. invalid sign-in remains unauthenticated', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'UNAUTHENTICATED' });
    mockedSignIn.mockRejectedValue(new Error('invalid_credentials'));
    render(<App />);
    await userEvent.setup().type(screen.getByLabelText(/operator email/i), 'admin@leadfinder.business');
    await userEvent.setup().type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.setup().click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/invalid credentials/i)).toBeVisible();
    expect(screen.getByRole('heading', { name: /control dashboard/i })).toBeVisible();
    expect(screen.queryByText('Operator Session')).not.toBeInTheDocument();
  });

  it('4. existing session restores authenticated state on startup', async () => {
    mockedResolve.mockResolvedValue({ ok: true, profile: adminProfile });
    render(<App />);
    expect(await screen.findByText('Operator Session')).toBeVisible();
    expect(screen.getByText('Test Admin')).toBeVisible();
    expect(screen.getByText('admin · authenticated')).toBeVisible();
  });

  it('5. onAuthStateChange SIGNED_IN updates state to authorized', async () => {
    mockedResolve
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ ok: true, profile: operatorProfile });
    render(<App />);
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeVisible();
    lastListener()(true);
    expect(await screen.findByText('Operator Session')).toBeVisible();
  });

  it('6. onAuthStateChange SIGNED_OUT clears authenticated state', async () => {
    mockedResolve
      .mockResolvedValueOnce({ ok: true, profile: adminProfile })
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHENTICATED' });
    render(<App />);
    expect(await screen.findByText('Operator Session')).toBeVisible();
    lastListener()(false);
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeVisible();
    expect(screen.queryByText('Operator Session')).not.toBeInTheDocument();
  });

  it('7. missing operator profile fails closed', async () => {
    mockedSignIn.mockResolvedValue({} as never);
    mockedResolve
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ ok: false, reason: 'PROFILE_NOT_FOUND' });
    render(<App />);
    await userEvent.setup().type(screen.getByLabelText(/operator email/i), 'ghost@leadfinder.business');
    await userEvent.setup().type(screen.getByLabelText(/password/i), 'whatever');
    await userEvent.setup().click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/access denied/i)).toBeVisible();
    expect(screen.queryByText('Operator Session')).not.toBeInTheDocument();
  });

  it('8. inactive operator fails closed', async () => {
    mockedSignIn.mockResolvedValue({} as never);
    mockedResolve
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ ok: false, reason: 'INACTIVE' });
    render(<App />);
    await userEvent.setup().type(screen.getByLabelText(/operator email/i), 'inactive@leadfinder.business');
    await userEvent.setup().type(screen.getByLabelText(/password/i), 'whatever');
    await userEvent.setup().click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/access denied/i)).toBeVisible();
    expect(screen.queryByText('Operator Session')).not.toBeInTheDocument();
  });

  it('9. unauthorized role fails closed', async () => {
    mockedSignIn.mockResolvedValue({} as never);
    mockedResolve
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ ok: false, reason: 'UNAUTHORIZED_ROLE' });
    render(<App />);
    await userEvent.setup().type(screen.getByLabelText(/operator email/i), 'viewer@leadfinder.business');
    await userEvent.setup().type(screen.getByLabelText(/password/i), 'whatever');
    await userEvent.setup().click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/access denied/i)).toBeVisible();
    expect(screen.queryByText('Operator Session')).not.toBeInTheDocument();
  });

  it('10. no P0 disabled-login strings remain in production UI', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'UNAUTHENTICATED' });
    render(<App />);
    await screen.findByRole('button', { name: /^sign in$/i });
    expect(screen.queryByText(/sign in disabled in p0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/blocked_by_p0_gate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/supabase auth not connected in p0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/local mock · read-only · no external mutation/i)).not.toBeInTheDocument();
  });

  it('11. preview mode is not an authentication bypass', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'UNAUTHENTICATED' });
    render(<App />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /open foundation review/i }));
    // Preview shows sample-only dashboard, explicitly labelled, and never claims operator auth.
    expect(await screen.findByText('Foundation Review')).toBeVisible();
    expect(screen.getByText(/preview session/i)).toBeVisible();
    expect(screen.getByText(/sample data only/i)).toBeVisible();
    expect(screen.queryByText(/authenticated/i)).not.toBeInTheDocument();
  });
});
