import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  ClipboardCopy,
  CloudCog,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react';
import {
  customerUrlFor,
  isValidSlug,
  suggestSlug,
  validateCreateCustomerForm,
  websiteRestrictionFor,
} from './createCustomerDomain';
import { getSupabaseClient } from './supabase';
import { confirmSmoke, fetchPortalHealth, fetchProvisionStatus, startProvision } from './provisioningClient';
import { generateAccessCode } from './accessCode';


/** S2e pre-E2E durable recovery — localStorage survives refresh AND browser
 *  close/reopen. Holds ONLY non-secret reattach context (slug/tenantId/runId).
 *  Never raw keys / credentials. */
const RECOVERY_KEY = 'lf_provision_recovery';
interface ProvisionRecovery { slug: string; tenantId: string; runId?: string }

function saveRecovery(r: ProvisionRecovery): void {
  try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(r)); } catch { /* private mode — non-fatal */ }
}
function loadRecovery(): ProvisionRecovery | null {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProvisionRecovery;
    if (!parsed || typeof parsed.slug !== 'string' || typeof parsed.tenantId !== 'string') return null;
    return parsed;
  } catch { return null; }
}
function clearRecovery(): void {
  try { localStorage.removeItem(RECOVERY_KEY); } catch { /* non-fatal */ }
}

interface CreateCustomerPageProps {
  /** admin only — the INTERNAL dashboard entry is never rendered for operators */
  onEnterInternal?: () => void;
  /** true when the authenticated operator is admin */
  isAdmin: boolean;
  /** when true, the form shows the PRE-R1 fail-closed state (always true until R1) */
  provisioningAuthorized: false;
  /** authenticated operator label shown in the session bar (no internal data) */
  operatorLabel?: string;
  /** role + auth label, e.g. "admin · authenticated" */
  operatorRoleLabel?: string;
  onLogout?: () => void;
}

interface DuplicateSlugCheck {
  status: 'checked' | 'unavailable';
  available: boolean;
  /** Same-slug tenant state — recovery vs real collision distinction. */
  existingStatus?: string;
  existingTenantId?: string;
}

async function checkDuplicateSlug(slug: string): Promise<DuplicateSlugCheck> {
  const client = getSupabaseClient();
  if (!client) return { status: 'unavailable', available: false };
  const { data, error } = await client
    .from('tenants')
    .select('slug, status, id')
    .eq('slug', slug.toLowerCase());
  if (error) return { status: 'unavailable', available: false };
  const existing = (data ?? [])[0] as { slug: string; status?: string; id?: string } | undefined;
  if (!existing) return { status: 'checked', available: true };
  return {
    status: 'checked',
    available: false,
    existingStatus: existing.status,
    existingTenantId: existing.id,
  };
}

export function CreateCustomerPage({
  onEnterInternal,
  isAdmin,
  operatorLabel,
  operatorRoleLabel,
  onLogout,
}: CreateCustomerPageProps) {
  const [companyName, setCompanyName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [googleProjectId, setGoogleProjectId] = useState('');
  const [placesApiKey, setPlacesApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [googleProjectUnlocked, setGoogleProjectUnlocked] = useState(false);
  const [placesKeyUnlocked, setPlacesKeyUnlocked] = useState(false);
  const [copied, setCopied] = useState(false);
  // OWNER FINAL DECISION 1/A — authenticated operator confirms the EXACT
  // generated website restriction after configuring it face-to-face in the
  // customer's own Google Console. UI-state only: real provisioning runs via
  // the operator CLI, which enforces the same checkpoint independently.
  const [restrictionConfirmed, setRestrictionConfirmed] = useState(false);
  const [verification, setVerification] = useState<ReturnType<typeof validateCreateCustomerForm> | null>(null);
  const [duplicateSlug, setDuplicateSlug] = useState<DuplicateSlugCheck | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // R1 TWO-DEVICE CONTRACT — customer access code (TRANSIENT UI state only)
  const [accessCode, setAccessCode] = useState('');
  const [accessCodeCopied, setAccessCodeCopied] = useState(false);
  // Once a locally-valid request crosses the startProvision boundary, the
  // displayed code may already be the server-adopted APP_PASS. Keep this
  // latched across ordinary failures/retries so no replacement-looking Code B
  // can be generated in the browser.
  const [provisionAttempted, setProvisionAttempted] = useState(false);
  // Access Code recovery contract: when the server retained an EXISTING
  // APP_PASS (retry/resume), a freshly generated code is NOT valid — never
  // show it as such. UI shows an explicit "already configured" state instead.
  const [accessCodeRetained, setAccessCodeRetained] = useState(false);
  const [recoveryTenantId, setRecoveryTenantId] = useState<string | null>(null);
  const [recoveryNeedsAccessCode, setRecoveryNeedsAccessCode] = useState(false);

  const slugValid = isValidSlug(slug);
  let url = '';
  let restriction = '';
  try {
    url = slugValid ? customerUrlFor(slug) : '';
    restriction = slugValid ? websiteRestrictionFor(slug) : '';
  } catch {
    url = '';
    restriction = '';
  }

  // Auto-suggest subdomain from company name until the owner edits it.
  useEffect(() => {
    if (slugEdited) return;
    setSlug(suggestSlug(companyName));
  }, [companyName, slugEdited]);

  async function handleVerifyDetails() {
    setVerifying(true);
    setVerifyError('');
    const result = validateCreateCustomerForm({ companyName, slug, googleProjectId, placesApiKey });
    setVerification(result);
    if (result.slugValid) {
      const duplicate = await checkDuplicateSlug(slug);
      setDuplicateSlug(duplicate);
      setRecoveryTenantId(null);
      setRecoveryNeedsAccessCode(false);
      if (duplicate.status === 'checked' && !duplicate.available) {
        if (duplicate.existingStatus === 'setup_pending') {
          const saved = loadRecovery();
          const normalizedSlug = slug.trim().toLowerCase();
          if (saved?.slug === normalizedSlug && saved.tenantId === duplicate.existingTenantId) {
            // A code generated before recovery verification is not proof that
            // the runtime adopted it. Remove it before allowing resume.
            setAccessCode('');
            setAccessCodeCopied(false);
            setAccessCodeRetained(false);
            setRecoveryTenantId(saved.tenantId);
            setVerifyError('Recovery identity confirmed. The runtime will verify the ORIGINAL Access Code.');
          } else {
            setVerifyError('Recovery re-attachment required — this setup_pending subdomain is not linked to this browser.');
          }
        } else if (duplicate.existingStatus === 'active') {
          setVerifyError('This customer is already ACTIVE — do not provision again.');
        } else {
          setVerifyError('Duplicate subdomain already exists in the Control Plane.');
        }
      }
    } else {
      setDuplicateSlug(null);
    }
    setVerifying(false);
  }

  async function handleCopy() {
    if (!restriction) return;
    try {
      await navigator.clipboard.writeText(restriction);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setVerifyError('Clipboard unavailable — copy the restriction manually.');
    }
  }

  async function handleCopyPortal() {
    if (!portalReady || !provisionResult.slug) return;
    try {
      await navigator.clipboard.writeText(customerUrlFor(provisionResult.slug));
      setPortalCopied(true);
      setTimeout(() => setPortalCopied(false), 2000);
    } catch {
      setProvisionError('Clipboard unavailable — copy the customer portal URL manually.');
    }
  }

  function handleGenerateAccessCode() {
    if (provisionAttempted && !recoveryNeedsAccessCode) return;
    setAccessCode(generateAccessCode());
    setAccessCodeCopied(false);
    setAccessCodeRetained(false);
  }

  async function handleCopyAccessCode() {
    if (!accessCode) return;
    try {
      await navigator.clipboard.writeText(accessCode);
      setAccessCodeCopied(true);
      setTimeout(() => setAccessCodeCopied(false), 2000);
    } catch {
      setVerifyError('Clipboard unavailable — copy the access code manually.');
    }
  }

  // PHASE 2C SEGMENT 2c — minimal real PROVISION wiring. Calls the
  // authenticated cloud start API; the server derives operator identity and
  // the golden release. Failures are shown inline (never crash the wizard).
  const [provisionState, setProvisionState] = useState<'idle' | 'starting' | 'running' | 'waiting_smoke' | 'finalizing' | 'active' | 'failed'>('idle');
  const [completingOnboarding, setCompletingOnboarding] = useState(false);
  const [provisionResult, setProvisionResult] = useState<{ runId?: string; tenantId?: string; slug?: string; reason?: string }>({});
  const [provisionError, setProvisionError] = useState('');
  const [progress, setProgress] = useState(0);
  const [portalReady, setPortalReady] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);

  // S2e pre-E2E: durable recovery — restore ONLY non-secret context after a
  // refresh/browser close; query authoritative status; NEVER auto-start a
  // workflow.
  useEffect(() => {
    const saved = loadRecovery();
    if (!saved) return;
    let cancelled = false;
    (async () => {
      const client = getSupabaseClient();
      const { data: sessionData } = await client?.auth.getSession() ?? { data: null };
      if (!client || !sessionData?.session || cancelled) {
        // Staff auth expired — PRESERVE the non-secret recovery context (never
        // discard an in-progress customer); signpost re-login. After re-login
        // the effect re-runs (page reload) and re-queries authoritative STATUS.
        if (!cancelled) setProvisionError('Sign in required to re-attach the in-progress customer — your saved context is preserved.');
        return;
      }
      try {
        const st = await fetchProvisionStatus(saved.slug);
        if (cancelled) return;
        if (st.ok && st.status === 'active') {
          clearRecovery();
          setProvisionState('active');
        } else if (st.ok && st.status === 'failed' && st.restartable) {
          // TERMINAL-RUN RECOVERY (2026-09-08): the reserved Workflow run ended
          // before customer activation. Do NOT show it as endlessly running and
          // do NOT auto-restart. Restore the non-secret context, surface the
          // terminal state, and let staff re-verify the exact customer before
          // one fresh PROVISION becomes available again.
          setSlug(saved.slug);
          setProvisionResult({ tenantId: saved.tenantId, runId: saved.runId, slug: saved.slug });
          setProgress(0);
          setPortalReady(false);
          setProvisionState('failed');
          setProvisionError(st.reason ?? 'Previous setup did not finish. Verify this customer\u2019s details to safely continue.');
        } else if (st.ok) {
          // still in progress — restore safe in-progress state (PROVISION stays
          // disabled; CONFIRM SMOKE remains available once waiting)
          setSlug(saved.slug);
          setProvisionResult({ tenantId: saved.tenantId, runId: saved.runId, slug: saved.slug });
          setProgress(0);
          setPortalReady(false);
          setProvisionState(st.status === 'waiting_smoke' && st.confirmationReady === true ? 'waiting_smoke' : 'running');
          setProvisionError('');
        } else {
          // Clear ONLY on authoritative staleness (tenant genuinely not found /
          // server proves invalid). Transient failures (401/403/5xx/network/
          // control-plane read errors) PRESERVE the non-secret recovery context
          // with a safe retry/re-login prompt.
          const authoritativeStale = /tenant not found|not found|unknown slug/i.test(st.reason ?? '');
          if (authoritativeStale) {
            clearRecovery();
            setProvisionError(st.reason ?? 'Saved customer context is no longer valid — re-verify before provisioning.');
          } else {
            setProvisionError('Could not verify the saved customer state right now — context preserved. Re-login or retry shortly.');
          }
        }
      } catch {
        if (!cancelled) setProvisionError('Could not verify recovery state — refresh to retry.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProvisioningStatus = useCallback(async (slugOverride?: string) => {
    const currentSlug = slugOverride ?? provisionResult.slug;
    if (!currentSlug) return;
    try {
      const status = await fetchProvisionStatus(currentSlug);
      if (!status.ok) return;
      if (status.status === 'active' && status.tenantStatus === 'active') {
        clearRecovery();
        setProvisionState('active');
        return;
      }
      if (status.status === 'failed' && status.restartable) {
        // Terminal old run surfaced while polling — stop the run-loop, unlock
        // re-verification (PROVISION re-enabled only after exact recovery
        // Verify). Never auto-restart.
        setProvisionError(status.reason ?? 'Previous setup did not finish. Verify this customer\u2019s details to safely continue.');
        setProvisionState('failed');
        return;
      }
      setProvisionState((current) => {
        if (current === 'active' || current === 'finalizing') return current;
        return status.status === 'waiting_smoke' && status.confirmationReady === true ? 'waiting_smoke' : 'running';
      });
    } catch {
      // A transient status read can never unlock confirmation or claim ACTIVE.
    }
  }, [provisionResult.slug]);

  const refreshPortalHealth = useCallback(async (slugOverride?: string) => {
    const currentSlug = slugOverride ?? provisionResult.slug;
    if (!currentSlug || portalReady) return;
    try {
      const health = await fetchPortalHealth(currentSlug);
      if (health.ok && health.ready) {
        setPortalReady(true);
        setProgress(100);
      }
    } catch {
      // Server probe unavailable/not-ready stays fail-closed at estimated <=95.
    }
  }, [portalReady, provisionResult.slug]);

  useEffect(() => {
    if (!['running', 'waiting_smoke', 'finalizing', 'failed'].includes(provisionState) || !provisionResult.slug) return;
    void refreshProvisioningStatus();
    const timer = window.setInterval(() => void refreshProvisioningStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [provisionResult.slug, provisionState, refreshProvisioningStatus]);

  useEffect(() => {
    if (!['running', 'waiting_smoke', 'finalizing', 'active', 'failed'].includes(provisionState) || !provisionResult.slug || portalReady) return;
    void refreshPortalHealth();
    const timer = window.setInterval(() => void refreshPortalHealth(), 3000);
    return () => window.clearInterval(timer);
  }, [portalReady, provisionResult.slug, provisionState, refreshPortalHealth]);

  useEffect(() => {
    if (portalReady) {
      setProgress(100);
      return;
    }
    if (provisionState !== 'running' && provisionState !== 'waiting_smoke') return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 95) return 95;
        if (current < 20) return Math.min(20, current + 4);
        if (current < 55) return Math.min(55, current + 3);
        if (current < 80) return Math.min(80, current + 2);
        return Math.min(95, current + 1);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [portalReady, provisionState]);

  async function handleProvision() {
    setProvisionError('');
    if (!verification?.companyNamePresent || !verification?.slugValid || !verification?.googleProjectIdPresent || !verification?.placesApiKeyPresent) {
      setProvisionError('VERIFY DETAILS first — all required fields must pass.');
      return;
    }
    if (!restrictionConfirmed) {
      setProvisionError('Confirm the website restriction (face-to-face with the customer) before PROVISION.');
      return;
    }
    if (duplicateSlug?.status === 'checked' && !duplicateSlug.available && !recoveryTenantId) {
      setProvisionError('Subdomain collision is not attached to this browser recovery — refusing to provision.');
      return;
    }
    if ((!accessCode || accessCode.length < 16) && !recoveryTenantId) {
      setProvisionError('Generate the customer access code (APP_PASS) before PROVISION.');
      return;
    }
    // All local validation has passed. Latch BEFORE invoking the remote start
    // boundary; from this point Code A may be the adopted APP_PASS even if the
    // response is delayed, lost, or reports an ordinary failure.
    setProvisionAttempted(true);
    setRecoveryNeedsAccessCode(false);
    setProgress(0);
    setPortalReady(false);
    setPortalCopied(false);
    setProvisionState('starting');
    try {
      const res = await startProvision({
        companyName,
        slug,
        googleProjectId: googleProjectId.trim(),
        websiteRestrictionConfirmed: restrictionConfirmed,
        placesApiKey: placesApiKey.trim(),
        appPass: accessCode || undefined,
        recoveryTenantId: recoveryTenantId ?? undefined,
      });
      if (!res.ok) {
        setProvisionState('failed');
        setProvisionError(res.reason ?? 'PROVISION failed');
        if (recoveryTenantId && /OWNER ACTION REQUIRED.*APP_PASS/i.test(res.reason ?? '')) {
          setRecoveryNeedsAccessCode(true);
        }
        return;
      }
      if (res.alreadyActive) {
        clearRecovery();
        setAccessCode('');
        setProvisionResult({ tenantId: res.tenantId, slug: slug.trim().toLowerCase() });
        setProvisionState('active');
        return;
      }
      if (res.appPassState !== 'created' && res.appPassState !== 'retained') {
        setProvisionState('failed');
        setProvisionError('APP_PASS handoff contract error: missing or unknown appPassState.');
        return;
      }
      const normalizedSlug = slug.trim().toLowerCase();
      setProvisionResult({ runId: res.runId, tenantId: res.tenantId, slug: normalizedSlug });
      setProvisionState('running');
      void refreshProvisioningStatus(normalizedSlug);
      void refreshPortalHealth(normalizedSlug);
      if (res.appPassState === 'retained') {
        // The runtime kept the ORIGINAL APP_PASS — the submitted code was NOT
        // adopted. Clear it so staff can never treat it as valid.
        setAccessCode('');
        setAccessCodeCopied(false);
        setAccessCodeRetained(true);
      } else {
        setAccessCodeRetained(false);
      }
      if (res.tenantId) saveRecovery({ slug: slug.trim().toLowerCase(), tenantId: res.tenantId, runId: res.runId });
    } catch (err) {
      setProvisionState('failed');
      setProvisionError(err instanceof Error ? err.message : 'PROVISION failed (is the backend deployed?)');
    }
  }

  async function handleConfirmSmoke() {
    // COMPLETE ONBOARDING — PLAN B (2026-09-08): the staff click IS the
    // completion authority. Backend re-checks operator, exact tenant and
    // server-side portal readiness, then activates the customer directly.
    if (!provisionResult.tenantId || !portalReady) return;
    if (provisionState !== 'running' && provisionState !== 'waiting_smoke' && provisionState !== 'failed') return;
    if (completingOnboarding) return;
    setCompletingOnboarding(true);
    setProvisionError('');
    try {
      const res = await confirmSmoke(provisionResult.tenantId);
      if (!res.ok) {
        // Controlled staff copy only — never surface hook/workflow internals.
        const safeReason = ['customer portal is not ready yet', 'portal readiness check unavailable', 'failed to activate customer', 'tenant not found', 'invalid tenant id', 'forbidden'].find((s) => (res.reason ?? '').startsWith(s));
        setProvisionError(safeReason ?? 'Setup is still finishing. Try Complete Onboarding again shortly.');
        return;
      }
      // Direct authoritative completion — ACTIVE immediately (no Workflow
      // finalize wait). ACTIVE tenant wins over any historical run state.
      clearRecovery();
      setProvisionState('active');
      setProvisionError('');
    } catch {
      setProvisionError('Setup is still finishing. Try Complete Onboarding again shortly.');
    } finally {
      setCompletingOnboarding(false);
    }
  }

  const provisionLocked = provisionState !== 'idle' && provisionState !== 'failed';
  const showProgress = provisionState === 'running' || provisionState === 'waiting_smoke' || provisionState === 'finalizing';
  const progressLabel = progress >= 100
    ? 'PORTAL READY TO TEST'
    : progress >= 95
      ? 'Waiting for customer portal…'
      : progress >= 80
        ? 'Final checks'
        : progress >= 55
          ? 'Connecting services'
          : progress >= 20
            ? 'Building customer portal'
            : 'Preparing customer';
  const provisionedPortalUrl = provisionResult.slug ? customerUrlFor(provisionResult.slug) : '';

  return (
    <div className="create-page">
      {(operatorLabel || onLogout) && (
        <div className="create-session-bar">
          <span className="create-session-identity">
            <span className="create-session-dot" /> OPERATOR SESSION · {operatorLabel ?? 'Operator'}
          </span>
          <span className="create-session-role">{operatorRoleLabel ?? 'authenticated'}</span>
          {onLogout && (
            <button className="create-logout" onClick={onLogout} aria-label="Log out">
              <LogOut size={14} /> LOG OUT
            </button>
          )}
        </div>
      )}
      <section className="page-heading">
        <div>
          <span className="eyebrow">CUSTOMER ONBOARDING</span>
          <h1>Create New Customer</h1>
          <p>Set up a new Lead Finder customer during face-to-face onboarding.</p>
        </div>
        {isAdmin && onEnterInternal && (
          <button className="internal-entry" onClick={onEnterInternal} aria-label="INTERNAL ADMIN">
            <LayoutDashboard size={16} /> INTERNAL
          </button>
        )}
      </section>

      <div className="notice">
        <ShieldCheck size={20} />
        <div>
          <strong>Customer-safe screen</strong>
          <span>This screen only shows information needed for customer onboarding. Safe to use while the customer is present.</span>
        </div>
      </div>

      <form
        className="create-form"
        autoComplete="off"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
        }}
      >
        <section className="panel">
          <header className="panel-header">
            <div>
              <span>1 · COMPANY</span>
              <h2>Company identity</h2>
            </div>
            <BuildingIcon />
          </header>
          <div className="form-grid">
            <label>
              Company name
              <input
                aria-label="Company name"
                placeholder="ABC Trading Sdn Bhd"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
              />
            </label>
            <label>
              Subdomain (editable)
              <input
                aria-label="Subdomain"
                placeholder="abc"
                value={slug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                }}
              />
            </label>
          </div>
          <div className="url-readout">
            <small>CUSTOMER URL</small>
            <code data-testid="customer-url">{url || '—'}</code>
          </div>
          <div className="url-readout">
            <small>WEBSITE RESTRICTION (for Google Console)</small>
            <code data-testid="website-restriction">{restriction || '—'}</code>
            <button type="button" className="copy-button" onClick={handleCopy} disabled={!restriction} data-testid="copy-restriction">
              <ClipboardCopy size={14} /> {copied ? 'COPIED' : 'COPY'}
            </button>
          </div>
          <label className="restriction-checkpoint" data-testid="restriction-confirm-label">
            <input
              type="checkbox"
              data-testid="restriction-confirm"
              checked={restrictionConfirmed}
              disabled={!restriction}
              onChange={(event) => setRestrictionConfirmed(event.target.checked)}
            />
            <span>
              I have configured this exact Website Restriction in the customer&apos;s Google Console.
              {restrictionConfirmed && <BadgeCheck size={14} className="inline-ok" />}
            </span>
          </label>
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <span>2 · GOOGLE</span>
              <h2>Customer Google Cloud project</h2>
            </div>
            <CloudIcon />
          </header>
          <p className="panel-footnote">
            Enter the customer&apos;s Google Cloud Project ID and Places API key after completing the Google Console setup.
          </p>
          <div className="form-grid">
            <label>
              Google Cloud Project ID
              <input
                aria-label="Google Cloud Project ID"
                name="lf-customer-cloud-project"
                placeholder="abc-leadfinder-1234"
                value={googleProjectId}
                autoComplete="off"
                readOnly={!googleProjectUnlocked}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                spellCheck={false}
                onFocus={() => setGoogleProjectUnlocked(true)}
                onChange={(event) => setGoogleProjectId(event.target.value)}
              />
            </label>
            <label>
              Google Places API key (masked)
              <div className="masked-field">
                <input
                  aria-label="Google Places API key"
                  name="lf-customer-places-key"
                  type={keyVisible ? 'text' : 'password'}
                  placeholder="AIza…"
                  value={placesApiKey}
                  autoComplete="new-password"
                  readOnly={!placesKeyUnlocked}
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  spellCheck={false}
                  onFocus={() => setPlacesKeyUnlocked(true)}
                  onChange={(event) => setPlacesApiKey(event.target.value)}
                />
                <button
                  type="button"
                  className="icon-button-inline"
                  aria-label={keyVisible ? 'Hide API key' : 'Reveal API key'}
                  onClick={() => setKeyVisible((current) => !current)}
                >
                  {keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
          </div>
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <span>3 · ACCESS</span>
              <h2>Customer access code</h2>
            </div>
            <KeyRound />
          </header>
          <p className="panel-footnote">
            Generate one access code for this customer. Give the code to the customer and ask them to keep it safely — they will use it
            to sign in to Lead Finder.
          </p>
          <div className="access-code-row">
            {((!recoveryTenantId && !provisionAttempted) || recoveryNeedsAccessCode) && (
              <button type="button" className="primary-button inline-action" onClick={handleGenerateAccessCode} data-testid="generate-access-code">
                GENERATE ACCESS CODE
              </button>
            )}
            {accessCode && (
              <>
                <code className="access-code-value" data-testid="access-code-value">{accessCode}</code>
                <button type="button" className="copy-button" onClick={handleCopyAccessCode} data-testid="copy-access-code">
                  <ClipboardCopy size={14} /> {accessCodeCopied ? 'COPIED' : 'COPY'}
                </button>
              </>
            )}
          </div>
          {accessCodeRetained && (
            <p className="recovery-note" data-testid="access-code-retained" role="status">
              Existing Access Code already configured. Use the ORIGINAL Access Code from the first provisioning.
            </p>
          )}
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <span>4 · VERIFY</span>
              <h2>Verify details</h2>
            </div>
            <CheckIcon />
          </header>
          <button type="button" className="primary-button inline-action" onClick={handleVerifyDetails} disabled={verifying}>
            {verifying ? 'VERIFYING…' : 'VERIFY DETAILS'}
          </button>
          {verification && (
            <ul className="verify-list" data-testid="verify-results">
              <li className={verification.companyNamePresent ? 'ok' : 'bad'}>
                {verification.companyNamePresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Company name
              </li>
              <li className={verification.slugValid ? 'ok' : 'bad'}>
                {verification.slugValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Subdomain
              </li>
              <li className={verification.urlValid ? 'ok' : 'bad'}>
                {verification.urlValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Customer URL
              </li>
              <li className={verification.restrictionValid ? 'ok' : 'bad'}>
                {verification.restrictionValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Website Restriction
              </li>
              <li className={verification.googleProjectIdPresent ? 'ok' : 'bad'}>
                {verification.googleProjectIdPresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Google Project
              </li>
              <li className={verification.placesApiKeyPresent ? 'ok' : 'bad'}>
                {verification.placesApiKeyPresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} API Key
              </li>
              {duplicateSlug && (
                <li className={duplicateSlug.status === 'checked' && !duplicateSlug.available && !recoveryTenantId ? 'bad' : 'ok'}>
                  {duplicateSlug.status === 'checked' && !duplicateSlug.available && !recoveryTenantId ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                  {duplicateSlug.status === 'checked'
                    ? duplicateSlug.available
                      ? 'Customer setup available'
                      : recoveryTenantId
                        ? 'Existing setup found — resume provisioning'
                        : 'Customer subdomain already exists'
                    : 'Duplicate check unavailable (local mode)'}
                </li>
              )}
            </ul>
          )}
          {verifyError && <p className="validation-message">{verifyError}</p>}
        </section>

        <section className="panel fail-closed-panel">
          <header className="panel-header">
            <div>
              <span>5 · PROVISION</span>
              <h2>Provision Customer</h2>
            </div>
            <Rocket />
          </header>
          <p className="panel-footnote">Creates the customer&apos;s Lead Finder portal. Make sure verification is complete before continuing.</p>
          {/* PHASE 2C — real cloud provisioning (authenticated API).
              Server derives operator identity + golden release; raw secrets go
              straight to the customer encrypted env via the start boundary. */}
          <div className="cloud-provision-zone" data-testid="cloud-provision-zone">
            <button
              type="button"
              className="primary-button inline-action"
              onClick={handleProvision}
              disabled={provisionLocked}
              data-testid="cloud-provision"
            >
              {provisionState === 'starting' ? 'STARTING…' : provisionLocked ? 'PROVISIONING…' : 'PROVISION CUSTOMER'}
            </button>
            {showProgress && (
              <div className="staff-progress-card" data-testid="provision-running">
                <div className="staff-progress-heading">
                  <span>{progressLabel}</span>
                  <strong>{progress}%</strong>
                </div>
                <div
                  className="staff-progress-track"
                  role="progressbar"
                  aria-label="Customer portal provisioning progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  data-testid="provision-progress"
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{progress < 100 ? 'Estimated staff progress — real portal proof controls 100%.' : 'Real server-side portal readiness verified.'}</p>
              </div>
            )}
            {portalReady && provisionedPortalUrl && (
              <div className="customer-portal-card" data-testid="portal-ready">
                <small>CUSTOMER PORTAL</small>
                <code data-testid="customer-portal-url">{provisionedPortalUrl}</code>
                <div className="customer-portal-actions">
                  <button type="button" className="copy-button" onClick={handleCopyPortal} data-testid="copy-customer-portal">
                    <ClipboardCopy size={14} /> {portalCopied ? 'COPIED' : 'COPY'}
                  </button>
                  <a className="copy-button" href={provisionedPortalUrl} target="_blank" rel="noreferrer" data-testid="open-customer-portal">
                    OPEN
                  </a>
                </div>
              </div>
            )}
            {provisionResult.tenantId && portalReady && (provisionState === 'running' || provisionState === 'waiting_smoke' || provisionState === 'failed') && (
              <div className="smoke-confirm-row">
                <button
                  type="button"
                  className="primary-button inline-action"
                  onClick={handleConfirmSmoke}
                  disabled={completingOnboarding}
                  data-testid="complete-onboarding"
                >
                  {completingOnboarding ? 'COMPLETING…' : 'COMPLETE ONBOARDING'}
                </button>
                <span className="confirm-hint">After the customer can sign in and complete a search, finish onboarding.</span>
              </div>
            )}
            {provisionState === 'finalizing' && (
              <div className="finalizing-card" data-testid="provision-finalizing" role="status">
                <strong>FINALIZING CUSTOMER</strong>
                <span>Confirmation accepted. Waiting for authoritative ACTIVE status…</span>
                <button type="button" className="status-refresh-button" onClick={() => void refreshProvisioningStatus()} data-testid="refresh-finalizing-status">
                  CHECK ACTIVE STATUS
                </button>
              </div>
            )}
            {provisionState === 'active' && (
              <div className="verify-list" data-testid="provision-active">
                <li className="ok">
                  <CheckCircle2 size={14} /> Customer ACTIVE — onboarding complete
                </li>
              </div>
            )}
            {provisionError && (
              <p className="error-text" data-testid="provision-error">
                {provisionError}
              </p>
            )}
          </div>
        </section>

        {isAdmin && (
          <section className="panel system-defaults-panel" data-testid="system-defaults">
            <header className="panel-header">
              <div>
                <span>SYSTEM DEFAULTS</span>
                <h2>Monitoring &amp; usage</h2>
              </div>
              <SlidersHorizontal />
            </header>
            <p className="panel-footnote">Monitoring and usage limits are managed by Lead Finder.</p>
            <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((current) => !current)}>
              ADVANCED {showAdvanced ? '▾' : '▸'}
            </button>
            {showAdvanced && (
              <>
                <div className="defaults-grid">
                  <div>
                    <small>MONTHLY LIMIT</small>
                    <strong data-testid="default-monthly-limit">1,000</strong>
                    <span>Approved monthly cap</span>
                  </div>
                  <div>
                    <small>AMBER</small>
                    <strong data-testid="default-amber">850</strong>
                    <span>85% of limit</span>
                  </div>
                  <div>
                    <small>RED · SAFETY STOP</small>
                    <strong data-testid="default-red">900</strong>
                    <span>90% of limit — 100-request reserve</span>
                  </div>
                </div>
                <div className="advanced-panel">
                  <p>
                    <strong>Monitoring</strong> — Shared Monitoring (Central Lead Finder service account) is the standard for every
                    customer.
                  </p>
                  <p>
                    <strong>Dedicated JSON Credential</strong> — optional and gated. Standard onboarding always uses Shared Monitoring.
                  </p>
                </div>
              </>
            )}
          </section>
        )}
      </form>

    </div>
  );
}

function BuildingIcon() {
  return <Building2 size={21} className="panel-header-icon" />;
}
function CloudIcon() {
  return <CloudCog size={21} className="panel-header-icon" />;
}
function CheckIcon() {
  return <BadgeCheck size={21} className="panel-header-icon" />;
}
