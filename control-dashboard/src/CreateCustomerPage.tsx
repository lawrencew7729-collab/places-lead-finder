import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ClipboardCopy,
  CloudCog,
  Eye,
  EyeOff,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PlayCircle,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  customerUrlFor,
  isPlausiblePlacesKey,
  isValidSlug,
  sha256Fingerprint,
  suggestSlug,
  validateCreateCustomerForm,
  websiteRestrictionFor,
} from './createCustomerDomain';
import {
  advanceRunSheet,
  createRunSheet,
  runSheetState,
  type RunSheetStage,
} from './runSheet';
import { getSupabaseClient } from './supabase';
import { generateAccessCode, ACCESS_CODE_LENGTH } from './accessCode';

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
}

async function checkDuplicateSlug(slug: string): Promise<DuplicateSlugCheck> {
  const client = getSupabaseClient();
  if (!client) return { status: 'unavailable', available: false };
  const { data, error } = await client.from('tenants').select('slug').eq('slug', slug.toLowerCase());
  if (error) return { status: 'unavailable', available: false };
  return { status: 'checked', available: (data ?? []).length === 0 };
}

export function CreateCustomerPage({
  onEnterInternal,
  isAdmin,
  provisioningAuthorized,
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
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verification, setVerification] = useState<ReturnType<typeof validateCreateCustomerForm> | null>(null);
  const [duplicateSlug, setDuplicateSlug] = useState<DuplicateSlugCheck | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [runSheet, setRunSheet] = useState<RunSheetStage[]>(() => createRunSheet());
  const [runSheetPreviewing, setRunSheetPreviewing] = useState(false);
  const runSheetTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // R1 TWO-DEVICE CONTRACT — customer access code (TRANSIENT UI state only)
  const [accessCode, setAccessCode] = useState('');
  const [accessCodeCopied, setAccessCodeCopied] = useState(false);

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

  // Refresh fingerprint when the masked key changes.
  useEffect(() => {
    let cancelled = false;
    if (!isPlausiblePlacesKey(placesApiKey)) {
      setFingerprint(null);
      return () => {
        cancelled = true;
      };
    }
    sha256Fingerprint(placesApiKey.trim()).then((digest) => {
      if (!cancelled) setFingerprint(digest.slice(0, 8));
    });
    return () => {
      cancelled = true;
    };
  }, [placesApiKey]);

  useEffect(() => () => {
    if (runSheetTimer.current) clearInterval(runSheetTimer.current);
  }, []);

  async function handleVerifyDetails() {
    setVerifying(true);
    setVerifyError('');
    const result = validateCreateCustomerForm({ companyName, slug, googleProjectId, placesApiKey });
    setVerification(result);
    if (result.slugValid) {
      const duplicate = await checkDuplicateSlug(slug);
      setDuplicateSlug(duplicate);
      if (duplicate.status === 'checked' && !duplicate.available) {
        setVerifyError('Duplicate subdomain already exists in the Control Plane.');
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

  function handleGenerateAccessCode() {
    setAccessCode(generateAccessCode());
    setAccessCodeCopied(false);
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

  function stopRunSheetTimer() {
    if (runSheetTimer.current) {
      clearInterval(runSheetTimer.current);
      runSheetTimer.current = null;
    }
  }

  function handlePreviewRunSheet() {
    stopRunSheetTimer();
    setRunSheetPreviewing(true);
    setRunSheet((current) => advanceRunSheet(current));
    runSheetTimer.current = setInterval(() => {
      setRunSheet((current) => {
        const next = advanceRunSheet(current);
        if (runSheetState(next).outcome !== 'IN_PROGRESS') {
          stopRunSheetTimer();
          setRunSheetPreviewing(false);
        }
        return next;
      });
    }, 400);
  }

  function handlePreviewFailure() {
    stopRunSheetTimer();
    setRunSheetPreviewing(true);
    setRunSheet((current) => {
      const failed = advanceRunSheet(current, { failAt: 'restriction' });
      return failed;
    });
    setRunSheetPreviewing(false);
  }

  function handleResetRunSheet() {
    stopRunSheetTimer();
    setRunSheetPreviewing(false);
    setRunSheet(createRunSheet());
  }

  const runSheetView = runSheetState(runSheet);
  const form = validateCreateCustomerForm({ companyName, slug, googleProjectId, placesApiKey });
  const createDisabled = !form.allPresent || runSheetView.outcome === 'CUSTOMER_READY';

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
          <p>Prepare one customer record. Provisioning is not connected — R1 remains separately gated.</p>
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
          <strong>Privacy barrier — no internal system information is shown on this screen.</strong>
          <span>No customer counts, revenue, infrastructure or audit data. This page is safe to operate in front of a customer.</span>
        </div>
      </div>

      <form
        className="create-form"
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
            The owner or Wingo operator prepares the customer&apos;s Google Cloud project and Places browser API key manually in
            Google Cloud Console <strong>before</strong> pressing Create Customer — including applying the Website Restriction above.
          </p>
          <div className="form-grid">
            <label>
              Google Cloud Project ID
              <input
                aria-label="Google Cloud Project ID"
                placeholder="abc-leadfinder-1234"
                value={googleProjectId}
                onChange={(event) => setGoogleProjectId(event.target.value)}
              />
            </label>
            <label>
              Google Places API key (masked)
              <div className="masked-field">
                <input
                  aria-label="Google Places API key"
                  type={keyVisible ? 'text' : 'password'}
                  placeholder="AIza…"
                  value={placesApiKey}
                  autoComplete="off"
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
          <div className="fingerprint-row">
            <KeyRound size={15} />
            {fingerprint ? (
              <span>
                SHA-256 fingerprint <code>{fingerprint}…</code> — raw key is never stored or logged
              </span>
            ) : (
              <span>Enter a valid AIza… key to preview its fingerprint.</span>
            )}
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
            Authentication for new customers is a {ACCESS_CODE_LENGTH}-character access code (no username). Generate one code per
            customer, copy it, and deliver it OUT-OF-BAND (manual). The code is transient only — it reaches provisioning as a
            secret, is injected as the customer&apos;s server-side <code>APP_PASS</code>, and is never persisted to any system of
            record.
          </p>
          <div className="access-code-row">
            <button type="button" className="primary-button inline-action" onClick={handleGenerateAccessCode} data-testid="generate-access-code">
              GENERATE ACCESS CODE
            </button>
            {accessCode && (
              <>
                <code className="access-code-value" data-testid="access-code-value">{accessCode}</code>
                <button type="button" className="copy-button" onClick={handleCopyAccessCode} data-testid="copy-access-code">
                  <ClipboardCopy size={14} /> {accessCodeCopied ? 'COPIED' : 'COPY'}
                </button>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <span>4 · DEFAULTS</span>
              <h2>Monitoring & quota</h2>
            </div>
            <GaugeIcon />
          </header>
          <div className="defaults-grid">
            <div>
              <small>MONITORING</small>
              <strong>Shared Monitoring</strong>
              <span>Central Lead Finder service account · DEFAULT</span>
            </div>
            <div>
              <small>MONTHLY LIMIT</small>
              <strong data-testid="default-monthly-limit">1,000</strong>
              <span>Approved target</span>
            </div>
            <div>
              <small>AMBER</small>
              <strong data-testid="default-amber">900</strong>
              <span>90% of limit</span>
            </div>
            <div>
              <small>RED · SAFETY STOP</small>
              <strong data-testid="default-red">950</strong>
              <span>95% of limit — 50-request reserve</span>
            </div>
          </div>
          <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((current) => !current)}>
            ADVANCED {showAdvanced ? '▾' : '▸'}
          </button>
          {showAdvanced && (
            <div className="advanced-panel">
              <p>
                <strong>Dedicated JSON Credential</strong> — OPTIONAL only, gated. Standard onboarding always uses Shared Monitoring.
              </p>
            </div>
          )}
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <span>5 · VERIFY</span>
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
                {verification.companyNamePresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Company name present
              </li>
              <li className={verification.slugValid ? 'ok' : 'bad'}>
                {verification.slugValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Subdomain format valid
              </li>
              <li className={verification.urlValid ? 'ok' : 'bad'}>
                {verification.urlValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Customer URL valid
              </li>
              <li className={verification.restrictionValid ? 'ok' : 'bad'}>
                {verification.restrictionValid ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Website Restriction valid
              </li>
              <li className={verification.googleProjectIdPresent ? 'ok' : 'bad'}>
                {verification.googleProjectIdPresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Google Project ID present
              </li>
              <li className={verification.placesApiKeyPresent ? 'ok' : 'bad'}>
                {verification.placesApiKeyPresent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} Places API key present
              </li>
              {duplicateSlug && (
                <li className={duplicateSlug.status === 'checked' && !duplicateSlug.available ? 'bad' : 'ok'}>
                  {duplicateSlug.status === 'checked' && !duplicateSlug.available ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                  {duplicateSlug.status === 'checked'
                    ? duplicateSlug.available
                      ? 'Subdomain available (read-only check)'
                      : 'Subdomain already exists'
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
              <span>6 · PROVISION</span>
              <h2>Create Customer</h2>
            </div>
            <ShieldCheck />
          </header>
          <button
            type="button"
            className="primary-button create-customer-button"
            disabled={createDisabled || provisioningAuthorized !== false}
            data-testid="create-customer"
          >
            CREATE CUSTOMER
          </button>
          <div className="notice compact-notice">
            <AlertTriangle size={18} />
            <div>
              <strong>CUSTOMER_PROVISIONING_NOT_AUTHORIZED</strong>
              <span>R1 is not approved. This action is disconnected from tenant creation, Vercel, Google, API keys, domains and monitoring grants.</span>
            </div>
          </div>
        </section>
      </form>

      <section className="panel run-sheet-panel">
        <header className="panel-header">
          <div>
            <span>PROVISIONING RUN SHEET</span>
            <h2>Step-by-step provisioning preview</h2>
          </div>
          <FlaskConical />
        </header>
        <p className="panel-footnote">
          Mock preview only — deterministic stages. Never connected to real provisioning until R1 is separately approved.
        </p>
        <div className="run-sheet-actions">
          <button type="button" className="primary-button inline-action" onClick={handlePreviewRunSheet} disabled={runSheetPreviewing}>
            <PlayCircle size={15} /> PREVIEW RUN SHEET (MOCK)
          </button>
          <button type="button" className="secondary-button" onClick={handlePreviewFailure} disabled={runSheetPreviewing}>
            PREVIEW FAILURE (STEP 6)
          </button>
          <button type="button" className="secondary-button" onClick={handleResetRunSheet}>
            <RotateCcw size={14} /> RESET
          </button>
        </div>
        <ol className="run-sheet-list" data-testid="run-sheet-list">
          {runSheet.map((stage) => (
            <li key={stage.id} className={`run-sheet-${stage.status.toLowerCase()}`}>
              <span className="run-sheet-status">{stage.status === 'PASS' ? '✓' : stage.status === 'FAILED' ? '✖' : stage.status === 'SKIPPED' ? '–' : stage.status === 'RUNNING' ? '●' : '○'}</span>
              <div>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </div>
              <em>{stage.status}</em>
            </li>
          ))}
        </ol>
        {runSheetView.outcome === 'CUSTOMER_READY' && (
          <div className="mock-success">
            <CheckCircle2 size={18} />
            <strong>CUSTOMER READY</strong>
            <span>Mock preview only — no real provisioning occurred.</span>
          </div>
        )}
        {runSheetView.outcome === 'FAILED' && (
          <div className="notice amber compact-notice">
            <AlertTriangle size={18} />
            <div>
              <strong>FAILED at {runSheetView.failedStageId ? runSheetView.failedStageId.toUpperCase() : 'unknown'} — STOP forward execution</strong>
              <span>Preserve already-created resource identities. No duplicate replacement resources. Retry/resume only when authorized.</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function BuildingIcon() {
  return <Building2 size={21} className="panel-header-icon" />;
}
function CloudIcon() {
  return <CloudCog size={21} className="panel-header-icon" />;
}
function GaugeIcon() {
  return <Gauge size={21} className="panel-header-icon" />;
}
function CheckIcon() {
  return <BadgeCheck size={21} className="panel-header-icon" />;
}
