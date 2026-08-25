import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
  RadioTower,
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

function SignalPill({ signal, children }: { signal: Signal; children?: ReactNode }) {
  return <span className={`signal signal-${signal}`}><span className="signal-dot" />{children ?? statusLabels[signal]}</span>;
}

function Metric({ label, value, detail, signal, icon: Icon, testId }: { label: string; value: string; detail: string; signal?: Signal; icon: typeof Activity; testId?: string }) {
  return <article className="metric-card">
    <div className="metric-top"><span className="metric-icon"><Icon size={19} /></span>{signal && <SignalPill signal={signal} />}</div>
    <p>{label}</p><strong data-testid={testId}>{value}</strong><small>{detail}</small>
  </article>;
}

function Login({ onReview }: { onReview: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');


  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage('BLOCKED_BY_P0_GATE: Supabase Auth not connected in P0 local-only composition.');
  }

  return <main className="login-shell">
    <section className="login-brand">
      <div className="brand-mark"><RadioTower size={25} /><span>LEAD FINDER</span></div>
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
        <span className="phase-tag">PHASE 1 · FOUNDATION</span>
        <h2>Control Dashboard</h2>
        <p>Authorized operator access only.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Operator email</label>
          <div className="field"><Fingerprint size={18} /><input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@company.com" required /></div>
          <label htmlFor="password">Password</label>
          <div className="field"><LockKeyhole size={18} /><input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required /></div>
          <button className="primary-button" disabled>SIGN IN DISABLED IN P0</button>
        </form>
        {message && <div className="form-message">{message}</div>}
        {import.meta.env.DEV && <><div className="divider"><span>FOUNDATION PREVIEW</span></div>
        <button className="review-button" onClick={onReview}>OPEN FOUNDATION REVIEW</button>
        <p className="review-note"><Database size={14} /> Review mode uses sample data only. No production connection.</p></>}
        <div className="auth-status"><span className="offline" /> LOCAL MOCK · READ-ONLY · NO EXTERNAL MUTATION</div>
        <div className="auth-status"><span className="offline" /> Supabase Auth not connected in P0 · Gate S0 BLOCKED</div>
      </div>
    </section>
  </main>;
}

function Overview({ onNewCustomer, infrastructureStatus }: { onNewCustomer: () => void; infrastructureStatus: Signal }) {
  const monthlyRevenue = sampleTenants.length * DEFAULT_COMMERCIAL_MODEL.monthlyEquivalentMyr;
  return <>
    <section className="page-heading"><div><span className="eyebrow">OPERATIONS OVERVIEW</span><h1>Fleet control, without shared failure.</h1><p>Phase 2 local implementation. External and production actions remain gated.</p></div><button className="new-customer-button" onClick={onNewCustomer}>+ NEW CUSTOMER · LOCAL MOCK</button></section>
    <div className="notice"><ShieldCheck size={20} /><div><strong>No production customer data imported</strong><span>Foundation Sample Data · provisioning, deployment and customer mutation are disabled.</span></div></div>
    <section className="metric-grid">
      <Metric label="Registered customers" value="3" detail="Foundation sample records" icon={Building2} />
      <Metric label="Healthy foundation records" value="1" detail="1 pending · 1 not checked" signal="green" icon={HeartPulse} />
      <Metric label="Monthly revenue model" value={`RM ${monthlyRevenue}`} detail="RM1,500 yearly / customer" icon={CircleDollarSign} />
      <Metric label="Infrastructure gate" value={infrastructureStatus.toUpperCase()} detail="Single fail-closed authoritative selector" signal={infrastructureStatus} icon={Gauge} testId="overview-infrastructure-status" />
    </section>
    <section className="dashboard-grid">
      <article className="panel wide"><PanelHeader eyebrow="CUSTOMER READINESS" title="Isolation status" icon={Boxes} />
        <div className="tenant-list">{sampleTenants.map((tenant) => <div className="tenant-row" key={tenant.id}><div className="company-badge">{tenant.companyName.slice(0, 2).toUpperCase()}</div><div className="tenant-main"><strong>{tenant.companyName}</strong><span>{tenant.exactSubdomain}</span></div><div className="tenant-version">{tenant.releaseVersion ?? 'Not deployed'}</div><SignalPill signal={tenant.lastHealthStatus} /></div>)}</div>
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

function Customers({ onNewCustomer, localDraft }: { onNewCustomer: () => void; localDraft: LocalCustomerDraft | null }) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => sampleTenants.filter((t) => `${t.companyName} ${t.exactSubdomain}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return <><section className="page-heading compact"><div><span className="eyebrow">TENANT REGISTRY</span><h1>Customers</h1><p>Immutable identity with isolated infrastructure bindings.</p></div><button className="new-customer-button" onClick={onNewCustomer}>{localDraft ? 'RESUME LOCAL CHECKPOINT' : '+ NEW CUSTOMER · LOCAL MOCK'}</button></section>
    {localDraft && <div className="notice local-draft-notice"><FlaskConical size={20}/><div><strong>Local checkpoint saved · {localDraft.companyName}</strong><span>{localDraft.hostname} · App-scoped memory only · not written to Supabase or any provider</span></div></div>}
    <div className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search customers" placeholder="Search customer, domain or Tenant ID" value={query} onChange={(e) => setQuery(e.target.value)} /></div><span className="sample-label">FOUNDATION SAMPLE DATA</span></div>
    <article className="table-panel"><table><thead><tr><th>Customer</th><th>Tenant / domain</th><th>Monitoring</th><th>Release</th><th>Status</th></tr></thead><tbody>{rows.map((t) => <tr key={t.id}><td><strong>{t.companyName}</strong><small>RM {t.annualRevenueMyr.toLocaleString()} / year</small></td><td><code>{t.id.slice(0, 16)}…</code><small>{t.exactSubdomain}</small></td><td><strong>{t.monitoringMode.replaceAll('_', ' ')}</strong><small>{t.monitoringStatus}</small></td><td><strong>{t.releaseVersion ?? '—'}</strong><small>{t.vercelProjectId ?? 'No deployment record'}</small></td><td><SignalPill signal={t.lastHealthStatus} /></td></tr>)}</tbody></table></article>
    <article className="panel restriction-preview"><PanelHeader eyebrow="FUTURE ONBOARDING OUTPUT" title="Exact website restriction" icon={KeyRound} /><code>{exactRestrictionFor('customer-name.leadfinder.business')}</code><p>Generated from one exact tenant domain. Wildcard cross-customer restrictions are rejected by contract.</p></article>
  </>;
}

function Releases() {
  return <><section className="page-heading compact"><div><span className="eyebrow">GOLDEN STANDARD</span><h1>Release manifest</h1><p>Approved Git SHA → immutable artifact → independent customer deployment.</p></div></section>
    <div className="notice amber"><Archive size={20} /><div><strong>Release actions disabled in Phase 1</strong><span>This foundation records releases only. It cannot deploy, promote or rollback production.</span></div></div>
    <article className="table-panel"><table><thead><tr><th>Release</th><th>Source</th><th>Artifact</th><th>Approval</th><th>Fleet</th></tr></thead><tbody><tr><td><strong>v1.0.0-sample</strong><small>Foundation sample record</small></td><td><code>626c0c1…</code><small>Authoritative source</small></td><td><code>sha256: 9F13…A821</code><small>Immutable checksum</small></td><td><SignalPill signal="green">Approved sample</SignalPill></td><td><strong>1 sample tenant</strong><small>Independent rollback retained</small></td></tr></tbody></table></article>
    <section className="three-columns"><Rule icon={PackageCheck} title="Immutable identity" text="Changed artifact requires a new version or release identity."/><Rule icon={Activity} title="Configurable rollout" text="Future stage sizes remain policy-controlled, never hard-coded."/><Rule icon={ShieldCheck} title="Pause on failure" text="Unupdated customers remain on their existing stable release."/></section>
  </>;
}

function Rule({ icon: Icon, title, text }: { icon: typeof Activity; title: string; text: string }) { return <article className="rule-card"><Icon /><strong>{title}</strong><p>{text}</p></article>; }

function Health() {
  const categories = ['API key invalid / missing','Places API not enabled','Website restriction pending / incorrect','Billing problem','Monitoring unavailable','Quota warning / policy limit','Deployment failure','Domain / HTTPS problem','Login / device problem','Wrong app version','Export / XLSX failure','External provider temporary failure'];
  return <><section className="page-heading compact"><div><span className="eyebrow">DIAGNOSTIC FOUNDATION</span><h1>Health & alerts</h1><p>Customer-specific classification without fleet-wide interruption.</p></div></section>
    <section className="health-layout"><article className="panel"><PanelHeader eyebrow="OPEN ALERTS" title="Operator attention" icon={BellRing} /><div className="alert-item amber"><AlertTriangle/><div><strong>Meridian Industrial</strong><span>WEBSITE_RESTRICTION_PROPAGATION_PENDING</span><small>Retry state · not classified as deployment failure</small></div></div><div className="alert-item neutral"><Activity/><div><strong>Atlas Commerce</strong><span>ONBOARDING_NOT_STARTED</span><small>Informational sample record</small></div></div></article>
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

function Audit() {
  const events = [{time:'23 Aug · 09:42',actor:'operator@sample.local',action:'TENANT_CREATED',subject:'Northstar Supplies',change:'— → draft'},{time:'23 Aug · 09:48',actor:'operator@sample.local',action:'MONITORING_MODE_CHANGED',subject:'Northstar Supplies',change:'not_configured → shared_access'},{time:'23 Aug · 10:06',actor:'release-manager@sample.local',action:'RELEASE_APPROVED',subject:'v1.0.0-sample',change:'candidate → approved'}];
  return <><section className="page-heading compact"><div><span className="eyebrow">AUDITABILITY</span><h1>Audit log</h1><p>Who changed what, for which customer, when, and between which states.</p></div></section><div className="notice"><FileClock size={20}/><div><strong>Append-only records</strong><span>Client roles cannot update or delete audit events. Sample events shown below.</span></div></div><article className="timeline">{events.map((event) => <div className="timeline-item" key={event.time+event.action}><span className="timeline-dot"/><time>{event.time}</time><div><strong>{event.action}</strong><span>{event.subject}</span><small>{event.actor} · {event.change}</small></div></div>)}</article></>;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>('overview');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [localDraft, setLocalDraft] = useState<LocalCustomerDraft | null>(null);
  const gateway = useMemo(() => createMockProviderGateway(), []);
  const repository = useMemo(() => new InMemoryOnboardingRepository(), []);
  const openWizard = () => setWizardOpen(true);
  const pageContent: ReactNode = page === 'overview'
    ? <Overview onNewCustomer={openWizard} infrastructureStatus={AUTHORITATIVE_INFRASTRUCTURE_STATUS}/>
    : page === 'customers'
      ? <Customers onNewCustomer={openWizard} localDraft={localDraft}/>
      : page === 'releases'
        ? <Releases/>
        : page === 'health'
          ? <Health/>
          : page === 'infrastructure'
            ? <Infrastructure infrastructureStatus={AUTHORITATIVE_INFRASTRUCTURE_STATUS}/>
            : <Audit/>;

  return <><div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><span className="logo-box"><RadioTower size={21}/></span><div><strong>LEAD FINDER</strong><small>CONTROL PLANE</small></div></div><div className="environment"><span/> Foundation Review</div><nav>{nav.map(({id,label,icon:Icon}) => <button key={id} aria-label={label} className={page===id?'active':''} onClick={() => setPage(id)}><Icon size={19}/><span>{label}</span>{page===id && <ChevronRight size={15}/>}</button>)}</nav><div className="sidebar-footer"><div className="operator-avatar">LF</div><div><strong>Review Operator</strong><small>Sample session</small></div><button aria-label="Log out" onClick={onLogout}><LogOut size={17}/></button></div></aside><main className="content-shell"><header className="topbar"><div><span className="topbar-status"><span/> CONTROL PLANE ONLY</span></div><div className="topbar-right"><span><Database size={15}/> SAMPLE + LOCAL MOCK</span><button aria-label="Notifications"><BellRing size={18}/><i>2</i></button></div></header><div className="page-content">{pageContent}</div></main></div>{wizardOpen && <NewCustomerWizard gateway={gateway} operator={{ id: 'local-review-admin', role: 'admin', active: true }} repository={repository} resumeTenantId={localDraft?.tenantId} onClose={() => setWizardOpen(false)} onSaveDraft={(draft) => { setLocalDraft(draft); setWizardOpen(false); setPage('customers'); }}/>}</>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const logout = async () => setAuthenticated(false);

  return authenticated ? <Dashboard onLogout={logout} /> : <Login onReview={() => setAuthenticated(true)} />;
}
