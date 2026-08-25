import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  BellRing,
  Boxes,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  CloudCog,
  Database,
  FileClock,
  Fingerprint,
  FlaskConical,
  Gauge,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  PackageCheck,
  Search,
  ServerCog,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { DEFAULT_COMMERCIAL_MODEL, exactRestrictionFor, selectInfrastructureStatus, type Signal } from './domain';
import { sampleTenants } from './mockData';
import { NewCustomerWizard, type LocalCustomerDraft } from './NewCustomerWizard';
import { createMockProviderGateway } from './providers';
import { InMemoryOnboardingRepository } from './onboardingRepository';
import { useControlPlaneData, type RealAlertRow, type RealAuditRow, type RealReleaseRow, type RealTenantRow } from './controlPlaneData';
import { CreateCustomerPage } from './CreateCustomerPage';
import {
  resolveAuthorizedProfile,
  signInOperator,
  signOutOperator,
  subscribeToAuthChanges,
  type OperatorProfile,
} from './supabase';

type Page = 'overview' | 'customers' | 'releases' | 'health' | 'infrastructure' | 'audit';

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'customers', label: 'Customers', icon: UsersRound },
  { id: 'releases', label: 'Releases', icon: PackageCheck },
  { id: 'health', label: 'Health & Alerts', icon: HeartPulse },
  { id: 'infrastructure', label: 'Infrastructure', icon: ServerCog },
  { id: 'audit', label: 'Audit Log', icon: FileClock },
];

const statusLabels: Record<Signal, string> = { green: 'Healthy', amber: 'Review', red: 'Blocked', unknown: 'Not checked' };
const AUTHORITATIVE_INFRASTRUCTURE_STATUS = selectInfrastructureStatus(['unknown', 'amber', 'green']);

type AuthState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'denied' }
  | { status: 'authorized'; profile: OperatorProfile };

function SignalPill({ signal, children }: { signal: Signal; children?: ReactNode }) {
  return <span className={`signal signal-${signal}`}><span className="signal-dot" />{children ?? statusLabels[signal]}</span>;
}

function Metric({ label, value, detail, signal, icon: Icon, testId }: { label: string; value: string; detail: string; signal?: Signal; icon: typeof Activity; testId?: string }) {
  return <article className="metric-card">
    <div className="metric-top"><span className="metric-icon"><Icon size={19} /></span>{signal && <SignalPill signal={signal} />}</div>
    <p>{label}</p><strong data-testid={testId}>{value}</strong><small>{detail}</small>
  </article>;
}

function BrandMark() {
  return (
    <span className="brand-mark">
      <span className="logo-box"><img src="/logo.png" alt="Lead Finder" className="brand-logo" /></span>
      <span>LEAD FINDER</span>
    </span>
  );
}

function Login({ onSignIn, onPreview, submitting, message }: {
  onSignIn: (email: string, password: string) => void;
  onPreview: () => void;
  submitting: boolean;
  message: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    onSignIn(email, password);
  }

  return <main className="login-shell">
    <section className="login-brand">
      <BrandMark />
      <div className="login-copy">
        <span className="eyebrow">CUSTOMER CONTROL PLANE</span>
        <h1>One standard.<br />Every customer isolated.</h1>
        <p>Centralize management—not customer failure. Independent deployments, billing, secrets and rollback remain protected by design.</p>
      </div>
      <div className="architecture-strip">
        <span><ShieldCheck size={18} /> Isolated runtime</span><span><PackageCheck size={18} /> Immutable releases</span><span><FileClock size={18} /> Full audit trail</span>
      </div>
    </section>
    <section className="login-panel">
      <div className="login-card">
        <span className="phase-tag">OPERATOR ACCESS</span>
        <h2>Control Dashboard</h2>
        <p>Authorized operator access only.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Operator email</label>
          <div className="field"><Fingerprint size={18} /><input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@company.com" required /></div>
          <label htmlFor="password">Password</label>
          <div className="field"><LockKeyhole size={18} /><input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required /></div>
          <button className="primary-button" disabled={submitting}>{submitting ? 'SIGNING IN…' : 'SIGN IN'}</button>
        </form>
        {message && <div className="form-message">{message}</div>}
        {import.meta.env.DEV && <><div className="divider"><span>FOUNDATION PREVIEW</span></div>
        <button className="review-button" onClick={onPreview}>OPEN FOUNDATION REVIEW</button>
        <p className="review-note"><Database size={14} /> Preview mode uses sample data only. No production connection.</p></>}
        <div className="auth-status"><span className="offline" /> SECURE OPERATOR SIGN-IN · SUPABASE AUTH</div>
        <div className="auth-status"><span className="offline" /> FAIL-CLOSED ACCESS CONTROL · NO LOCAL BYPASS</div>
      </div>
    </section>
  </main>;
}

function Overview({ onNewCustomer, infrastructureStatus, tenants, productionMode }: { onNewCustomer: () => void; infrastructureStatus: Signal; tenants: RealTenantRow[]; productionMode: boolean }) {
  const monthlyRevenue = sampleTenants.length * DEFAULT_COMMERCIAL_MODEL.monthlyEquivalentMyr;
  const realTenantCount = tenants.length;
  return <>
    <section className="page-heading"><div><span className="eyebrow">OPERATIONS OVERVIEW</span><h1>Fleet control, without shared failure.</h1><p>{productionMode ? 'Live Control Plane data.' : 'Phase 2 local implementation. External and production actions remain gated.'}</p></div>{!productionMode && <button className="new-customer-button" onClick={onNewCustomer}>+ NEW CUSTOMER · LOCAL MOCK</button>}</section>
    {!productionMode && <div className="notice"><ShieldCheck size={20} /><div><strong>No production customer data imported</strong><span>Foundation Sample Data · provisioning, deployment and customer mutation are disabled.</span></div></div>}
    {productionMode && <div className="notice"><ShieldCheck size={20} /><div><strong>Live Control Plane records only</strong><span>No sample data is shown in production. Provisioning remains gated behind R1.</span></div></div>}
    <section className="metric-grid">
      <Metric label="Control Plane tenants" value={String(realTenantCount)} detail={productionMode ? 'Live registry rows' : 'Foundation sample records'} icon={Building2} />
      <Metric label="Registered customers" value={productionMode ? '0' : '3'} detail={productionMode ? 'No real customers yet' : 'Foundation sample records'} icon={Building2} />
      {!productionMode && <Metric label="Monthly revenue model" value={`RM ${monthlyRevenue}`} detail="RM1,500 yearly / customer" icon={CircleDollarSign} />}
      {productionMode && <Metric label="Monthly revenue model" value="RM 0" detail="No real customers yet" icon={CircleDollarSign} />}
      <Metric label="Infrastructure gate" value={infrastructureStatus.toUpperCase()} detail="Single fail-closed authoritative selector" signal={infrastructureStatus} icon={Gauge} testId="overview-infrastructure-status" />
    </section>
    <section className="dashboard-grid">
      <article className="panel wide"><PanelHeader eyebrow="TENANT REGISTRY" title={productionMode ? 'Control Plane tenants' : 'Isolation status'} icon={Boxes} />
        <div className="tenant-list">{tenants.map((tenant) => <div className="tenant-row" key={tenant.id}><div className="company-badge">{tenant.companyName.slice(0, 2).toUpperCase()}</div><div className="tenant-main"><strong>{tenant.companyName}</strong><span>{tenant.exactSubdomain}</span></div><div className="tenant-version">{tenant.status}</div></div>)}
        {tenants.length === 0 && <p className="panel-footnote">No tenants recorded.</p>}</div>
      </article>
      <article className="panel"><PanelHeader eyebrow="SAFETY MODEL" title="Shared control. Isolated runtime." icon={ShieldCheck} />
        <div className="safety-list"><span><CheckCircle2 /> Dedicated subdomain & project</span><span><CheckCircle2 /> Customer-owned API & billing</span><span><CheckCircle2 /> Per-customer release & rollback</span><span><CheckCircle2 /> Control plane outside search path</span></div>
      </article>
      <article className="panel"><PanelHeader eyebrow="USAGE POLICY" title="Configurable telemetry thresholds" icon={Gauge} />
        <div className="quota-visual"><div className="quota-ring"><strong>1,000</strong><span>DEFAULT TARGET</span></div><div className="quota-legend"><SignalPill signal="green">Normal</SignalPill><SignalPill signal="amber">Approaching threshold</SignalPill><SignalPill signal="red">Policy action</SignalPill></div></div>
        <p className="panel-footnote">Monitoring telemetry can be delayed. The UI never claims an exact real-time hard stop.</p>
      </article>
    </section>
  </>;
}

function PanelHeader({ eyebrow, title, icon: Icon }: { eyebrow: string; title: string; icon: typeof Activity }) {
  return <header className="panel-header"><div><span>{eyebrow}</span><h2>{title}</h2></div><Icon size={21} /></header>;
}

function Customers({ onNewCustomer, localDraft, tenants, productionMode }: { onNewCustomer: () => void; localDraft: LocalCustomerDraft | null; tenants: RealTenantRow[]; productionMode: boolean }) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => tenants.filter((t) => `${t.companyName} ${t.slug}`.toLowerCase().includes(query.toLowerCase())), [tenants, query]);
  return <><section className="page-heading compact"><div><span className="eyebrow">TENANT REGISTRY</span><h1>Customers</h1><p>{productionMode ? 'Live Control Plane records only.' : 'Immutable identity with isolated infrastructure bindings.'}</p></div>{!productionMode && <button className="new-customer-button" onClick={onNewCustomer}>{localDraft ? 'RESUME LOCAL CHECKPOINT' : '+ NEW CUSTOMER · LOCAL MOCK'}</button>}</section>
    {localDraft && !productionMode && <div className="notice local-draft-notice"><FlaskConical size={20}/><div><strong>Local checkpoint saved · {localDraft.companyName}</strong><span>{localDraft.hostname} · App-scoped memory only · not written to Supabase or any provider</span></div></div>}
    {productionMode && <div className="notice"><ShieldCheck size={20} /><div><strong>No real customers yet.</strong><span>Production shows only real Control Plane records. Sample data is confined to preview mode.</span></div></div>}
    <div className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search customers" placeholder="Search customer or domain" value={query} onChange={(e) => setQuery(e.target.value)} /></div>{!productionMode && <span className="sample-label">FOUNDATION SAMPLE DATA</span>}{productionMode && <span className="sample-label">LIVE CONTROL PLANE</span>}</div>
    {rows.length === 0 && productionMode && <article className="table-panel"><div className="empty-panel">No customer records to display.</div></article>}
    {rows.length > 0 && <article className="table-panel"><table><thead><tr><th>Customer</th><th>Tenant / domain</th><th>Status</th><th>Created</th></tr></thead><tbody>{rows.map((t) => <tr key={t.id}><td><strong>{t.companyName}</strong></td><td><code>{t.id.slice(0, 16)}…</code><small>{t.exactSubdomain}</small></td><td><strong>{t.status}</strong></td><td><small>{t.createdAt.slice(0, 10)}</small></td></tr>)}</tbody></table></article>}
    <article className="panel restriction-preview"><PanelHeader eyebrow="FUTURE ONBOARDING OUTPUT" title="Exact website restriction" icon={KeyRound} /><code>{exactRestrictionFor('customer-name.leadfinder.business')}</code><p>Generated from one exact tenant domain. Wildcard cross-customer restrictions are rejected by contract.</p></article>
  </>;
}

function Releases({ releases }: { releases: RealReleaseRow[] }) {
  return <><section className="page-heading compact"><div><span className="eyebrow">GOLDEN STANDARD</span><h1>Release manifest</h1><p>Approved Git SHA → immutable artifact → independent customer deployment.</p></div></section>
    <div className="notice amber"><Archive size={20} /><div><strong>Release actions disabled in Phase 2</strong><span>This dashboard records releases only. It cannot deploy, promote or rollback production.</span></div></div>
    {releases.length === 0 && <article className="table-panel"><div className="empty-panel">No releases yet.</div></article>}
    {releases.length > 0 && <article className="table-panel"><table><thead><tr><th>Release</th><th>Source</th><th>Artifact</th><th>Created</th></tr></thead><tbody>{releases.map((r) => <tr key={r.id}><td><strong>{r.version}</strong></td><td><code>{r.gitSha ? `${r.gitSha.slice(0, 12)}…` : '—'}</code></td><td><code>{r.artifactSha256 ? `${r.artifactSha256.slice(0, 12)}…` : '—'}</code></td><td><small>{r.createdAt.slice(0, 10)}</small></td></tr>)}</tbody></table></article>}
    <section className="three-columns"><Rule icon={PackageCheck} title="Immutable identity" text="Changed artifact requires a new version or release identity."/><Rule icon={Activity} title="Configurable rollout" text="Future stage sizes remain policy-controlled, never hard-coded."/><Rule icon={ShieldCheck} title="Pause on failure" text="Unupdated customers remain on their existing stable release."/></section>
  </>;
}

function Rule({ icon: Icon, title, text }: { icon: typeof Activity; title: string; text: string }) { return <article className="rule-card"><Icon /><strong>{title}</strong><p>{text}</p></article>; }

function Health({ alerts, productionMode }: { alerts: RealAlertRow[]; productionMode: boolean }) {
  const categories = ['API key invalid / missing','Places API not enabled','Website restriction pending / incorrect','Billing problem','Monitoring unavailable','Quota warning / policy limit','Deployment failure','Domain / HTTPS problem','Login / device problem','Wrong app version','Export / XLSX failure','External provider temporary failure'];
  return <><section className="page-heading compact"><div><span className="eyebrow">DIAGNOSTIC FOUNDATION</span><h1>Health & alerts</h1><p>Customer-specific classification without fleet-wide interruption.</p></div></section>
    <section className="health-layout"><article className="panel"><PanelHeader eyebrow="OPEN ALERTS" title="Operator attention" icon={BellRing} />
      {alerts.length === 0 && <div className="empty-panel">{productionMode ? 'No open alerts.' : 'No alerts recorded.'}</div>}
      {alerts.map((alert) => <div className="alert-item amber" key={alert.id}><AlertTriangle/><div><strong>{alert.code}</strong><span>{alert.severity}</span><small>{alert.tenantId ?? '—'}</small></div></div>)}
    </article>
    <article className="panel"><PanelHeader eyebrow="CLASSIFICATION CATALOG" title="Prepared failure categories" icon={HeartPulse}/><div className="category-grid">{categories.map((item) => <span key={item}><CheckCircle2 size={15}/>{item}</span>)}</div></article></section>
    <div className="notice"><ShieldCheck size={20}/><div><strong>Phase 2 requires on-demand sandbox monitoring verification for onboarding activation.</strong><span>Telemetry can show unavailable while a healthy customer Places runtime continues operating. Continuous fleet-scale scheduler and automated notifications are deferred to Phase 3+.</span></div></div>
  </>;
}

function Infrastructure({ infrastructureStatus }: { infrastructureStatus: Signal }) {
  return <><section className="page-heading compact"><div><span className="eyebrow">CAPACITY FOUNDATION</span><h1>Infrastructure</h1><p>Actual provider signals and configurable thresholds—never fabricated fleet limits.</p></div></section>
    <section className="metric-grid three"><Metric label="Authoritative infrastructure status" value={infrastructureStatus.toUpperCase()} detail="Shared selector · fail closed" signal={infrastructureStatus} icon={CloudCog} testId="infrastructure-authoritative-status"/><Metric label="Supabase control plane" value="REVIEW" detail="Dedicated project not verified" signal="amber" icon={Database}/><Metric label="Existing customer runtime" value="ISOLATED" detail="Unaffected by this local work" signal="green" icon={ShieldCheck}/></section>
    <article className="panel"><PanelHeader eyebrow="PROVIDER POOLS" title="Provisioning safety gates" icon={ServerCog}/><div className="infra-row"><div><span className="provider-icon">V</span><strong>Vercel · Primary Pool</strong><small>Projects, deployment health, spend and applicable limits</small></div><SignalPill signal="unknown"/><span className="gate-copy">Real provisioning blocked</span></div><div className="infra-row"><div><span className="provider-icon supa">S</span><strong>Supabase · Control Plane</strong><small>Auth, registry, audit and observability records</small></div><SignalPill signal="amber"/><span className="gate-copy">Gate S0 not approved</span></div><div className="red-rule"><AlertTriangle size={18}/><span><strong>RED or UNKNOWN blocks new provisioning only.</strong> Existing healthy customer deployments must keep running.</span></div></article>
  </>;
}

function Audit({ auditEvents, productionMode }: { auditEvents: RealAuditRow[]; productionMode: boolean }) {
  return <><section className="page-heading compact"><div><span className="eyebrow">AUDITABILITY</span><h1>Audit log</h1><p>Who changed what, for which customer, when, and between which states.</p></div></section><div className="notice"><FileClock size={20}/><div><strong>Append-only records</strong><span>Client roles cannot update or delete audit events.{productionMode ? '' : ' Sample events shown below.'}</span></div></div>
    {auditEvents.length === 0 && <article className="timeline"><div className="empty-panel">No audit events yet.</div></article>}
    {auditEvents.length > 0 && <article className="timeline">{auditEvents.map((event) => <div className="timeline-item" key={event.id}><span className="timeline-dot"/><time>{event.createdAt.slice(0, 16).replace('T', ' ')}</time><div><strong>{event.action}</strong><span>{event.entityType} · {event.entityId}</span><small>{event.actorLabel}</small></div></div>)}</article>}
  </>;
}

function Dashboard({ mode, profile, onLogout, onBackToCreate }: { mode: 'operator' | 'preview'; profile?: OperatorProfile; onLogout: () => void; onBackToCreate?: () => void }) {
  const productionMode = mode === 'operator';
  const realData = useControlPlaneData(productionMode);
  const [page, setPage] = useState<Page>('overview');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [localDraft, setLocalDraft] = useState<LocalCustomerDraft | null>(null);
  const gateway = useMemo(() => createMockProviderGateway(), []);
  const repository = useMemo(() => new InMemoryOnboardingRepository(), []);
  const openWizard = () => setWizardOpen(true);

  const tenants: RealTenantRow[] = productionMode
    ? realData.tenants
    : sampleTenants.map((tenant) => ({ id: tenant.id, companyName: tenant.companyName, slug: tenant.slug, exactSubdomain: tenant.exactSubdomain, status: tenant.status, createdAt: tenant.createdAt }));
  const pageContent: ReactNode = page === 'overview'
    ? <Overview onNewCustomer={openWizard} infrastructureStatus={AUTHORITATIVE_INFRASTRUCTURE_STATUS} tenants={tenants} productionMode={productionMode}/>
    : page === 'customers'
      ? <Customers onNewCustomer={openWizard} localDraft={localDraft} tenants={tenants} productionMode={productionMode}/>
      : page === 'releases'
        ? <Releases releases={realData.releases}/>
        : page === 'health'
          ? <Health alerts={realData.alerts} productionMode={productionMode}/>
          : page === 'infrastructure'
            ? <Infrastructure infrastructureStatus={AUTHORITATIVE_INFRASTRUCTURE_STATUS}/>
            : <Audit auditEvents={realData.auditEvents} productionMode={productionMode}/>;

  const operator = profile
    ? { id: profile.userId, role: profile.role, active: true }
    : { id: 'local-review-admin', role: 'admin' as const, active: true };

  return <><div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><span className="logo-box"><img src="/logo.png" alt="Lead Finder" className="brand-logo" /></span><div><strong>LEAD FINDER</strong><small>CONTROL PLANE</small></div></div><div className="environment"><span/> {mode === 'operator' ? 'Operator Session' : 'Foundation Review'}</div><nav>{nav.map(({id,label,icon:Icon}) => <button key={id} aria-label={label} className={page===id?'active':''} onClick={() => setPage(id)}><Icon size={19}/><span>{label}</span>{page===id && <ChevronRight size={15}/>}</button>)}</nav>{onBackToCreate && <button className="back-to-create" onClick={onBackToCreate} aria-label="Back to Create Customer"><LayoutDashboard size={17}/><span>CREATE NEW CUSTOMER</span></button>}<div className="sidebar-footer"><div className="operator-avatar">{mode === 'operator' ? 'OP' : 'PV'}</div><div><strong>{mode === 'operator' ? (profile?.displayName ?? 'Operator') : 'Preview Session'}</strong><small>{mode === 'operator' ? `${profile?.role ?? 'admin'} · authenticated` : 'Sample data only'}</small></div><button aria-label="Log out" onClick={onLogout}><LogOut size={17}/></button></div></aside><main className="content-shell"><header className="topbar"><div><span className="topbar-status"><span/> CONTROL PLANE ONLY</span></div><div className="topbar-right"><span><Database size={15}/> {productionMode ? 'SUPABASE CONNECTED' : 'SAMPLE + LOCAL MOCK'}</span><button aria-label="Notifications"><BellRing size={18}/><i>2</i></button></div></header><div className="page-content">{pageContent}</div></main></div>{wizardOpen && <NewCustomerWizard gateway={gateway} operator={operator} repository={repository} resumeTenantId={localDraft?.tenantId} onClose={() => setWizardOpen(false)} onSaveDraft={(draft) => { setLocalDraft(draft); setWizardOpen(false); setPage('customers'); }}/>}</>;
}

function OperatorWorkspace({ profile, onLogout }: { profile: OperatorProfile; onLogout: () => void }) {
  const [view, setView] = useState<'create' | 'internal'>('create');
  const isAdmin = profile.role === 'admin';
  // Fail-closed: the internal dashboard is unreachable for non-admin roles.
  const effectiveView = view === 'internal' && !isAdmin ? 'create' : view;
  if (effectiveView === 'internal') {
    return <Dashboard mode="operator" profile={profile} onLogout={onLogout} onBackToCreate={() => setView('create')} />;
  }
  return <CreateCustomerPage
    isAdmin={isAdmin}
    onEnterInternal={isAdmin ? () => setView('internal') : undefined}
    provisioningAuthorized={false}
    operatorLabel={profile.displayName ?? 'Operator'}
    operatorRoleLabel={`${profile.role} · authenticated`}
    onLogout={onLogout}
  />;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [preview, setPreview] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const resolution = await resolveAuthorizedProfile();
      if (cancelled) return;
      setAuth(resolution.ok
        ? { status: 'authorized', profile: resolution.profile }
        : { status: 'signedOut' });
    })();

    const unsubscribe = subscribeToAuthChanges(async (hasSession) => {
      if (!hasSession) {
        if (!cancelled) setAuth({ status: 'signedOut' });
        return;
      }
      const resolution = await resolveAuthorizedProfile();
      if (cancelled) return;
      setAuth(resolution.ok
        ? { status: 'authorized', profile: resolution.profile }
        : { status: 'denied' });
    });

    return () => { cancelled = true; unsubscribe(); };
  }, []);

  async function handleSignIn(email: string, password: string) {
    setSubmitting(true);
    setLoginMessage(null);
    try {
      await signInOperator(email, password);
      const resolution = await resolveAuthorizedProfile();
      if (resolution.ok) {
        setAuth({ status: 'authorized', profile: resolution.profile });
      } else {
        setAuth({ status: 'denied' });
        setLoginMessage('Access denied. Contact your administrator.');
      }
    } catch {
      setAuth({ status: 'signedOut' });
      setLoginMessage('Invalid credentials. Access denied.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    await signOutOperator().catch(() => undefined);
    setAuth({ status: 'signedOut' });
    setPreview(false);
  }

  if (preview) {
    return <Dashboard mode="preview" onLogout={() => { setPreview(false); setAuth({ status: 'signedOut' }); }} />;
  }
  if (auth.status === 'authorized') {
    return <OperatorWorkspace profile={auth.profile} onLogout={handleLogout} />;
  }
  return <Login
    submitting={submitting}
    message={loginMessage}
    onSignIn={handleSignIn}
    onPreview={() => setPreview(true)}
  />;
}
