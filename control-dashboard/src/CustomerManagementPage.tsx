/**
 * Staff Customer Management (package control).
 *
 * The ONLY place staff can act; the customer portal exposes no control buttons.
 *   LEGACY      -> proven v1.0.10 (deployment identity resolves to the known commit)
 *   UNAVAILABLE -> 404 without version proof, timeout, 401, 5xx, unknown SHA
 *   v1.0.11     -> live STATUS is shown as-is (package / usage / service status)
 * After every successful action the STATUS is re-read and the table updates.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { customerManagementClient, type CustomerManagementApi, type ManagedCustomer } from './customerManagementClient';
import { STAFF_ACTIONS, type StaffAction } from './staff/customerControlContract';

const ACTION_LABEL: Record<StaffAction, string> = {
  STOP: 'STOP SERVICE',
  RESUME: 'RESUME SERVICE',
  UPGRADE_TO_FULL_900: 'UPGRADE TO FULL 900',
};

export function CustomerManagementPage({ client = customerManagementClient }: { client?: CustomerManagementApi }) {
  const [rows, setRows] = useState<ManagedCustomer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await client.list();
    if (!res.ok) { setError(res.error ?? 'UNKNOWN'); setRows([]); return; }
    setError(null);
    setRows(res.rows ?? []);
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (row: ManagedCustomer, action: StaffAction) => {
    const key = row.tenantId + ':' + action;
    setBusy(key);
    setNotice(null);
    const res = await client.runAction(row.tenantId, action);
    if (!res.ok) {
      setNotice(ACTION_LABEL[action] + ' FAILED for ' + row.company + ' — ' + (res.error ?? 'unknown'));
    } else {
      setNotice(ACTION_LABEL[action] + ' applied to ' + row.company + ' · STATUS re-read');
      await load();   // immediate re-read of the authoritative STATUS
    }
    setBusy(null);
  }, [client, load]);

  const heading = useMemo(() => (
    <section className="page-heading compact">
      <div>
        <span className="eyebrow">CUSTOMER PACKAGE CONTROL</span>
        <h1>Customer Management</h1>
        <p>Staff actions are enforced by the customer portal itself (server-side). The portal stays reachable when service is stopped.</p>
      </div>
    </section>
  ), []);

  const canStop = (r: ManagedCustomer) => r.serviceStatus === 'ACTIVE';
  const canResume = (r: ManagedCustomer) => r.serviceStatus === 'STOPPED';
  const canUpgrade = (r: ManagedCustomer) => r.package === 'STARTER_500';

  return (
    <>
      {heading}
      {notice && <div className="notice" role="status"><ShieldCheck size={18} /><div><strong>{notice}</strong></div></div>}
      {error && <div className="notice amber" role="alert"><strong>COULD NOT LOAD CUSTOMERS — {error}</strong></div>}
      <article className="panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">CONTROL PLANE TENANTS · LIVE PORTAL STATUS</span>
            <h2>Customers</h2>
          </div>
          <button aria-label="Reload customer status" onClick={() => void load()}>
            <RefreshCw size={16} /><span>RELOAD</span>
          </button>
        </div>
        <table className="data-table" data-testid="customer-table">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Subdomain</th>
              <th scope="col">Portal Version</th>
              <th scope="col">Package</th>
              <th scope="col">Usage</th>
              <th scope="col">Service Status</th>
              <th scope="col">Limit Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={8}>Loading customer status…</td></tr>}
            {rows !== null && rows.length === 0 && <tr><td colSpan={8}>No customers found.</td></tr>}
            {(rows ?? []).map((r) => (
              <tr key={r.tenantId} data-testid={'row-' + r.subdomain} data-state={r.state}>
                <td>{r.company}</td>
                <td className="mono">{r.subdomain}</td>
                {r.state === 'V1_0_11' ? (
                  <>
                    <td className="mono">{r.portalVersion}</td>
                    <td data-testid={'pkg-' + r.subdomain}><strong>{r.packageLabel}</strong></td>
                    <td className="mono" data-testid={'usage-' + r.subdomain}>
                      {r.usage === null ? '—' : r.usage}{r.searchStop ? ' / ' + r.searchStop : ''}
                    </td>
                    <td data-testid={'svc-' + r.subdomain}><strong>{r.serviceStatus}</strong></td>
                    <td>{r.limitStatus}</td>
                    <td className="row-actions">
                      {STAFF_ACTIONS.map((action) => {
                        const disabled =
                          (action === 'STOP' && !canStop(r)) ||
                          (action === 'RESUME' && !canResume(r)) ||
                          (action === 'UPGRADE_TO_FULL_900' && !canUpgrade(r)) ||
                          busy === r.tenantId + ':' + action;
                        return (
                          <button
                            key={action}
                            aria-label={ACTION_LABEL[action] + ' ' + r.company}
                            disabled={disabled}
                            onClick={() => void act(r, action)}
                          >
                            {ACTION_LABEL[action]}
                          </button>
                        );
                      })}
                    </td>
                  </>
                ) : (
                  <td colSpan={5} data-testid={'notice-' + r.subdomain}><span className="signal-pill">{r.notice}</span></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
}

export default CustomerManagementPage;
