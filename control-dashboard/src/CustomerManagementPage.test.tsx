import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerManagementPage } from './CustomerManagementPage';
import type { CustomerManagementApi, ManagedCustomer } from './customerManagementClient';

const base = (over: Partial<ManagedCustomer> = {}): ManagedCustomer => ({
  tenantId: 't-1', company: 'Alpha Sdn Bhd', subdomain: 'andrew.leadfinder.business',
  portalVersion: '1.0.11', package: 'STARTER_500', packageLabel: 'Starter 500', usage: 120,
  searchStop: 500, serviceStatus: 'ACTIVE', limitStatus: 'OK', state: 'V1_0_11', notice: null,
  actionsEnabled: true, ...over,
});

function api(rows: ManagedCustomer[], actionResult: { ok: boolean; error?: string } = { ok: true }) {
  const list = vi.fn(async () => ({ ok: true, rows }));
  const runAction = vi.fn(async () => actionResult);
  return { client: { list, runAction } as CustomerManagementApi, list, runAction };
}

describe('Customer Management UI', () => {
  it('shows package / usage / service status / portal version for a live v1.0.11 customer', async () => {
    const { client } = api([base()]);
    render(<CustomerManagementPage client={client} />);
    await waitFor(() => expect(screen.getByTestId('row-andrew.leadfinder.business')).toBeTruthy());
    expect(screen.getByTestId('pkg-andrew.leadfinder.business').textContent).toContain('Starter 500');
    expect(screen.getByTestId('usage-andrew.leadfinder.business').textContent).toContain('120');
    expect(screen.getByTestId('svc-andrew.leadfinder.business').textContent).toContain('ACTIVE');
    expect(screen.getByTestId('row-andrew.leadfinder.business').textContent).toContain('1.0.11');
  });

  it('offers EXACTLY the three approved staff actions (no delete / downgrade / limit editing)', async () => {
    const { client } = api([base()]);
    render(<CustomerManagementPage client={client} />);
    await waitFor(() => expect(screen.getByTestId('row-andrew.leadfinder.business')).toBeTruthy());
    const row = screen.getByTestId('row-andrew.leadfinder.business');
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['STOP SERVICE', 'RESUME SERVICE', 'UPGRADE TO FULL 900']);
    const all = row.textContent ?? '';
    ['DELETE', 'DOWNGRADE', 'SET LIMIT', 'CHANGE GOLDEN'].forEach((bad) => expect(all).not.toContain(bad));
  });

  it('LEGACY only for a proven v1.0.10 portal — and no action buttons there', async () => {
    const { client } = api([base({ state: 'LEGACY', notice: 'LEGACY / PACKAGE CONTROL NOT SUPPORTED', actionsEnabled: false, portalVersion: null, package: null, packageLabel: null, usage: null, serviceStatus: null, limitStatus: 'UNKNOWN' })]);
    render(<CustomerManagementPage client={client} />);
    await waitFor(() => expect(screen.getByTestId('notice-andrew.leadfinder.business')).toBeTruthy());
    expect(screen.getByTestId('notice-andrew.leadfinder.business').textContent).toContain('LEGACY / PACKAGE CONTROL NOT SUPPORTED');
    expect(screen.getByTestId('row-andrew.leadfinder.business').querySelectorAll('button')).toHaveLength(0);
  });

  it('UNAVAILABLE for connection problems (never legacy) — and no action buttons', async () => {
    const { client } = api([base({ state: 'UNAVAILABLE', notice: 'UNAVAILABLE / CHECK CONNECTION', actionsEnabled: false })]);
    render(<CustomerManagementPage client={client} />);
    await waitFor(() => expect(screen.getByTestId('notice-andrew.leadfinder.business')).toBeTruthy());
    const txt = screen.getByTestId('notice-andrew.leadfinder.business').textContent ?? '';
    expect(txt).toContain('UNAVAILABLE / CHECK CONNECTION');
    expect(txt).not.toContain('LEGACY');
    expect(screen.getByTestId('row-andrew.leadfinder.business').querySelectorAll('button')).toHaveLength(0);
  });

  it('after an action it re-reads STATUS (list called again) so the UI updates immediately', async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      return { ok: true, rows: [base({ serviceStatus: calls === 1 ? 'ACTIVE' : 'STOPPED' })] };
    });
    const runAction = vi.fn(async () => ({ ok: true }));
    render(<CustomerManagementPage client={{ list, runAction } as CustomerManagementApi} />);
    await waitFor(() => expect(screen.getByTestId('svc-andrew.leadfinder.business').textContent).toContain('ACTIVE'));
    fireEvent.click(screen.getByLabelText('STOP SERVICE Alpha Sdn Bhd'));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith('t-1', 'STOP'));
    await waitFor(() => expect(screen.getByTestId('svc-andrew.leadfinder.business').textContent).toContain('STOPPED'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a failed action is surfaced and the row is NOT silently changed', async () => {
    const { client, runAction } = api([base()], { ok: false, error: 'PORTAL_ACTION_FAILED' });
    render(<CustomerManagementPage client={client} />);
    await waitFor(() => expect(screen.getByTestId('row-andrew.leadfinder.business')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('STOP SERVICE Alpha Sdn Bhd'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('FAILED'));
    expect(screen.getByRole('status').textContent).toContain('PORTAL_ACTION_FAILED');
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('svc-andrew.leadfinder.business').textContent).toContain('ACTIVE');
  });
});
