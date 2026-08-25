import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FlaskConical, ShieldCheck, X } from 'lucide-react';
import { createQuotaPolicy, exactRestrictionFor, generateTenantId, type MonitoringMode, type ServerFingerprintMetadata } from './domain';
import type { ProviderGateway } from './providers';
import { configureOwnerThresholds, createWizardState, transitionWizard, WIZARD_STEPS } from './wizardWorkflow';
import { authorizeOperator, type MockOperator } from './authorization';
import { InMemoryOnboardingRepository, type LocalProviderEvidenceRecord, type SavedOnboardingCheckpoint } from './onboardingRepository';

export type LocalCustomerDraft = SavedOnboardingCheckpoint;

interface NewCustomerWizardProps {
  gateway: ProviderGateway;
  operator: MockOperator;
  onClose: () => void;
  onSaveDraft: (draft: LocalCustomerDraft) => void;
  repository?: InMemoryOnboardingRepository;
  resumeTenantId?: string | null;
}

const steps = ['Customer identity', 'Google architecture', 'Quota & monitoring', 'Local verification', 'Readiness review'];
const GOLDEN_RELEASE = Object.freeze({ releaseId: 'golden-root-626c0c1', gitSha: '626c0c133e7862616ec74bb53ff0ba6f934a9e04', artifactSha256: 'ADAE268878B124A2134DD11ED7CB672E7636DBFA6ADC6B1CE31B752D6F43D2DF' });
const P0_VERCEL_BINDING = Object.freeze({ projectId: 'vercel-project-p0-mock', deploymentId: 'deployment-p0-mock' });

function validExactDomain(domain: string) {
  try {
    exactRestrictionFor(domain);
    return true;
  } catch {
    return false;
  }
}

export function NewCustomerWizard({ gateway, operator, onClose, onSaveDraft, repository: injectedRepository, resumeTenantId }: NewCustomerWizardProps) {
  const repository = useMemo(() => injectedRepository ?? new InMemoryOnboardingRepository(), [injectedRepository]);
  const resumedCheckpoint = useMemo(() => resumeTenantId ? repository.resume(resumeTenantId) : null, [repository, resumeTenantId]);
  const [step, setStep] = useState(resumedCheckpoint ? 4 : 0);
  const [companyName, setCompanyName] = useState(resumedCheckpoint?.companyName ?? '');
  const [slug, setSlug] = useState(resumedCheckpoint?.slug ?? '');
  const [exactSubdomain, setExactSubdomain] = useState(resumedCheckpoint?.hostname ?? '');
  const [googleProjectId, setGoogleProjectId] = useState(resumedCheckpoint?.googleProjectId ?? '');
  const [keyFingerprint, setKeyFingerprint] = useState<ServerFingerprintMetadata | null>(resumedCheckpoint?.keyFingerprint ?? null);
  const [amberPercent, setAmberPercent] = useState(resumedCheckpoint ? String(resumedCheckpoint.quotaPolicy.amberPercent) : '');
  const [redPercent, setRedPercent] = useState(resumedCheckpoint ? String(resumedCheckpoint.quotaPolicy.redPercent) : '');
  const [monitoringMode, setMonitoringMode] = useState<MonitoringMode>(resumedCheckpoint?.monitoringMode ?? 'shared_access');
  const [checking, setChecking] = useState(false);
  const [checksPassed, setChecksPassed] = useState(Boolean(resumedCheckpoint));
  const [checkError, setCheckError] = useState('');
  const [tenantId] = useState(() => resumedCheckpoint?.tenantId ?? generateTenantId());
  const [providerEvidence, setProviderEvidence] = useState<LocalProviderEvidenceRecord[]>(resumedCheckpoint?.providerEvidence ?? []);

  const authorized = authorizeOperator(operator, 'start_onboarding');
  const identityValid = authorized && companyName.trim().length >= 2 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && validExactDomain(exactSubdomain);
  const googleValid = googleProjectId.trim().length >= 3;
  let quotaError = '';
  try {
    createQuotaPolicy({
      monthlyTarget: 1000,
      amberPercent: Number(amberPercent),
      redPercent: Number(redPercent),
      enforcementMode: 'warn_only',
    });
    if (!amberPercent || !redPercent) quotaError = 'Owner must enter both thresholds.';
  } catch (error) {
    quotaError = amberPercent && redPercent && Number(amberPercent) > Number(redPercent)
      ? 'AMBER must not exceed RED.'
      : error instanceof Error ? error.message : 'Invalid quota policy.';
  }
  const quotaValid = !quotaError;

  const canContinue = step === 0 ? identityValid : step === 1 ? googleValid : step === 2 ? quotaValid : step === 3 ? checksPassed : false;

  async function runMockChecks() {
    setChecking(true);
    setCheckError('');
    setChecksPassed(false);
    const context = { tenantId, exactDomain: exactSubdomain };
    try {
      const [places, monitoring, capacity, deployment] = await Promise.all([
        gateway.verifyPlacesConfiguration({ ...context, googleProjectId }),
        gateway.readMonitoring(context),
        gateway.readVercelCapacity(context),
        gateway.verifyDeploymentHealth(context),
      ]);
      const results = [places, monitoring, capacity, deployment];
      if (results.some((result) => result.tenantId !== tenantId || result.source !== 'mock' || result.authoritative || result.status !== 'unknown')) throw new Error('BLOCKED: mock evidence must remain tenant-bound, non-authoritative and UNKNOWN.');
      exactRestrictionFor(exactSubdomain);
      setKeyFingerprint(places.keyFingerprint);
      setProviderEvidence([
        { kind: 'google_places', tenantId, status: places.status, source: places.source, resourceId: places.googleProjectId, diagnosticReason: places.diagnosticReason, collectedAt: places.checkedAt },
        { kind: 'monitoring', tenantId, status: monitoring.status, source: monitoring.source, resourceId: `${monitoringMode}:${googleProjectId.trim()}`, diagnosticReason: monitoring.diagnosticReason, collectedAt: monitoring.collectionTimestamp },
        { kind: 'vercel_capacity', tenantId, status: capacity.status, source: capacity.source, resourceId: P0_VERCEL_BINDING.projectId, diagnosticReason: capacity.diagnosticReason, collectedAt: capacity.collectionTimestamp },
        { kind: 'deployment_health', tenantId, status: deployment.status, source: deployment.source, resourceId: P0_VERCEL_BINDING.deploymentId, diagnosticReason: deployment.diagnosticReason, collectedAt: deployment.checkedAt },
      ]);
      setChecksPassed(true);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Mock verification failed.');
    } finally {
      setChecking(false);
    }
  }

  async function saveDraft() {
    if (!quotaValid || !keyFingerprint || !checksPassed || providerEvidence.length !== 4) return;
    let workflow = configureOwnerThresholds(createWizardState(tenantId), Number(amberPercent), Number(redPercent));
    const now = new Date().toISOString();
    for (let workflowStep = 0; workflowStep < 5; workflowStep += 1) workflow = transitionWizard(workflow, workflowStep, { outcome: 'pass', at: now });
    workflow = transitionWizard(workflow, 5, { outcome: 'unknown', at: now });
    try {
      const saved = await repository.saveOnboardingCheckpointAtomic({
        tenantId, companyName: companyName.trim(), slug, hostname: exactSubdomain.toLowerCase(), googleProjectId: googleProjectId.trim(), keyFingerprint,
        runtimeArchitecture: 'browser_direct', monitoringMode,
        monitoringBinding: { projectId: googleProjectId.trim(), resourceId: `${monitoringMode}:${googleProjectId.trim()}` },
        providerEvidence,
        quotaPolicy: { monthlyTarget: 1000, amberPercent: Number(amberPercent), redPercent: Number(redPercent), status: 'owner_configured' },
        releaseIdentity: GOLDEN_RELEASE, vercelBinding: P0_VERCEL_BINDING, wizardState: workflow,
        infrastructureBinding: { status: 'unknown', evidenceVersion: 'p0-local-unknown-v1' },
        readinessState: { ready: false, reasons: ['MOCK_NON_AUTHORITATIVE', 'BLOCKED_BY_P0_GATE'] },
      });
      onSaveDraft(saved);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Atomic local checkpoint failed.');
    }
  }

  return <div className="wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
    <section className="wizard-shell">
      <header className="wizard-header">
        <div><span className="phase-tag"><FlaskConical size={14}/> LOCAL MOCK · NO EXTERNAL MUTATION</span><h1 id="wizard-title">New Customer Wizard</h1><p>Prepare one tenant-scoped draft. Real provider and database actions remain gated.</p>{resumedCheckpoint && <p className="validation-message">Resumed saved checkpoint · authoritative App-scoped memory</p>}</div>
        <button className="icon-button" onClick={onClose} aria-label="Close wizard"><X/></button>
      </header>

      <ol className="wizard-steps" aria-label="Wizard progress">{steps.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}><span>{index < step ? <CheckCircle2 size={15}/> : index + 1}</span><small>{label}</small></li>)}</ol>

      <details className="plan-step-map"><summary>Approved plan mapping · 22 steps (0–21)</summary><ol>{WIZARD_STEPS.map((item) => <li key={item.id}><strong>{item.id}</strong> {item.label}</li>)}</ol></details>

      <div className="wizard-body">
        {step === 0 && <section className="wizard-section"><span className="eyebrow">STEP 1 · IMMUTABLE IDENTITY</span><h2>Customer and tenant identity</h2><p>Local draft only. Identity becomes immutable only after a separately approved real insert.</p>
          <div className={authorized ? 'contract-card' : 'notice amber compact-notice'}><ShieldCheck/><div><strong>Mock gate: {authorized ? 'PASS' : 'BLOCKED'} · not production-authorized</strong><span>Only active admin/operator mock roles may start onboarding. Real Supabase Auth remains not connected.</span></div></div>
          <div className="form-grid">
            <label>Company name<input aria-label="Company name" value={companyName} onChange={(event) => setCompanyName(event.target.value)}/></label>
            <label>Tenant slug<input aria-label="Tenant slug" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="customer-name"/></label>
            <label className="full">Exact subdomain<input aria-label="Exact subdomain" value={exactSubdomain} onChange={(event) => setExactSubdomain(event.target.value.toLowerCase())} placeholder="test.leadfinder.business"/></label>
          </div>
          <div className="contract-card"><ShieldCheck/><div><strong>Isolation contract</strong><span>One customer domain, one independent runtime, one tenant-scoped rollback.</span></div></div>
        </section>}

        {step === 1 && <section className="wizard-section"><span className="eyebrow">STEP 2 · VERIFIED RUNTIME MODEL</span><h2>Browser-direct Places configuration</h2><div className="architecture-card"><strong>Browser → Google Places API</strong><span>Verified from Golden Standard source. The Control Dashboard accepts metadata only—never a raw Places key.</span></div>
          <div className="form-grid">
            <label>Google project ID<input aria-label="Google project ID" value={googleProjectId} onChange={(event) => setGoogleProjectId(event.target.value)} placeholder="customer-project-id"/></label>
            <div className="contract-card"><ShieldCheck/><div><strong>Fingerprint provenance: provider adapter only</strong><span>The UI neither computes nor declares server provenance.</span></div></div>
          </div>
          <div className="restriction-output"><small>EXACT WEBSITE RESTRICTION</small><code>{validExactDomain(exactSubdomain) ? exactRestrictionFor(exactSubdomain) : 'Invalid exact domain'}</code></div>
          <div className="notice amber compact-notice"><AlertTriangle/><div><strong>Raw key excluded</strong><span>Creation and restriction of a real browser key remain outside this local mock and behind Gate C1/T1.</span></div></div>
        </section>}

        {step === 2 && <section className="wizard-section"><span className="eyebrow">STEP 3 · OWNER POLICY</span><h2>Quota and monitoring</h2><p>Monthly target is approved at 1,000. AMBER and RED have no defaults and must be entered by the owner.</p>
          <div className="form-grid three-fields">
            <label>Monthly target<input aria-label="Monthly target" type="number" value={1000} readOnly/></label>
            <label>AMBER threshold (%)<input aria-label="AMBER threshold" type="number" min="0" max="100" value={amberPercent} onChange={(event) => setAmberPercent(event.target.value)}/></label>
            <label>RED threshold (%)<input aria-label="RED threshold" type="number" min="0" max="100" value={redPercent} onChange={(event) => setRedPercent(event.target.value)}/></label>
          </div>
          {quotaError && <p className="validation-message">{quotaError}</p>}
          <fieldset className="monitoring-choice"><legend>Monitoring mode</legend><label><input type="radio" name="monitoring" checked={monitoringMode === 'shared_access'} onChange={() => setMonitoringMode('shared_access')}/> Shared Monitoring Access <small>DEFAULT</small></label><label><input type="radio" name="monitoring" checked={monitoringMode === 'dedicated_credential'} onChange={() => setMonitoringMode('dedicated_credential')}/> Dedicated Credential <small>OPTIONAL · GATED</small></label></fieldset>
          <p className="panel-footnote">Telemetry is delayed. Unavailable provider data must display UNKNOWN, never a fabricated zero.</p>
        </section>}

        {step === 3 && <section className="wizard-section"><span className="eyebrow">STEP 4 · TENANT-SCOPED SIMULATION</span><h2>Local provider verification</h2><p>These checks use deterministic mock evidence only. No network request or external mutation occurs.</p>
          <div className="mock-check-list"><span><CheckCircle2/> Exact domain restriction contract</span><span><CheckCircle2/> Browser-direct metadata contract</span><span><CheckCircle2/> Shared monitoring evidence shape</span><span><CheckCircle2/> Nullable Vercel capacity limits</span><span><CheckCircle2/> Tenant-scoped deployment health</span></div>
          <button className="primary-button inline-action" onClick={runMockChecks} disabled={checking}>{checking ? 'RUNNING…' : 'RUN LOCAL MOCK CHECKS'}</button>
          {checksPassed && <div className="mock-success"><CheckCircle2/><strong>5 local contract checks complete</strong><span>Evidence source: MOCK · authoritative readiness remains UNKNOWN</span></div>}
          {checkError && <div className="form-message">{checkError}</div>}
        </section>}

        {step === 4 && <section className="wizard-section"><span className="eyebrow">STEP 5 · READINESS ONLY</span><h2>Draft ready for gated review</h2><div className="review-summary"><div><small>CUSTOMER</small><strong>{companyName}</strong><span>{exactSubdomain}</span></div><div><small>GOOGLE PROJECT</small><strong>{googleProjectId}</strong><span>Browser-direct metadata · MOCK UNKNOWN</span></div><div><small>QUOTA POLICY</small><strong>1,000 requests</strong><span>AMBER {amberPercent}% · RED {redPercent}%</span></div><div><small>MONITORING</small><strong>{monitoringMode === 'shared_access' ? 'Shared Monitoring Access' : 'Dedicated Credential'}</strong><span>Phase 2 on-demand verification · not a continuous scheduler</span></div><div><small>RELEASE</small><strong>{GOLDEN_RELEASE.releaseId}</strong><span>No deployment created</span></div></div>
          <div className="gate-grid"><span>Gate S0 · BLOCKED</span><span>Gate S1 · BLOCKED</span><span>Gate C1 · BLOCKED</span><span>Gate T1 · BLOCKED</span><span>Gate D1 · BLOCKED</span><span>Gate R1 · BLOCKED</span></div>
          <div className="notice compact-notice"><ShieldCheck/><div><strong>BLOCKED_BY_P0_GATE</strong><span>Saving creates an audited in-memory draft and stops at step 5 because real Google project verification is not authorized. Step 20 rejects MOCK as non-authoritative; step 21 cannot create LIVE.</span></div></div>
        </section>}
      </div>

      <footer className="wizard-footer">
        <button className="secondary-button" onClick={step === 0 ? onClose : () => setStep((current) => current - 1)}>{step === 0 ? 'CANCEL' : <><ChevronLeft size={16}/> BACK</>}</button>
        {step < 3 && <button className="primary-button inline-action" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>CONTINUE <ChevronRight size={16}/></button>}
        {step === 3 && <button className="primary-button inline-action" disabled={!checksPassed} onClick={() => setStep(4)}>CONTINUE TO READINESS REVIEW <ChevronRight size={16}/></button>}
        {step === 4 && <button className="primary-button inline-action" onClick={saveDraft}>SAVE LOCAL DRAFT <CheckCircle2 size={16}/></button>}
      </footer>
    </section>
  </div>;
}
