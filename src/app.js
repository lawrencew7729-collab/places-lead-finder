/* ================= config ================= */
import { applyControlsToElements, controlsFor } from './searchControls.js';
import { customerQuota } from './config.js';
import { createUsageTelemetry } from './usageTelemetry.js';
const API_URL = 'https://places.googleapis.com/v1/places:searchText';
const EMBEDDED_KEY = '«redacted:AIza…»';
const EXPECTED_ORIGINS = ['https://places-lead-finder-site.vercel.app', 'https://leadfinder.business'];
const FIELDS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.businessStatus,places.location,nextPageToken';

/* R1 REVISED QUOTA SAFETY — event-driven telemetry (owner-approved 2026-08-26):
   ONE Monitoring fetch per top-level RUN SEARCH; DEEP/STOP/refresh/idle = 0;
   effectiveUsage = monitoringBase + localSessionDelta; safety stop at 950. */
const telemetry = createUsageTelemetry();
telemetry.setQuota(customerQuota());

const SUGGESTION_DICT = {
  'restaurant': ['cafe', 'kopitiam', 'kedai makan', 'mamak restaurant', 'seafood restaurant', 'dim sum', 'noodle house', 'bistro'],
  'cafe': ['coffee shop', 'kopitiam', 'bakery', 'dessert cafe', 'bubble tea', 'brunch place', 'roastery', 'teahouse'],
  'flooring': ['tiles supplier', 'parquet', 'vinyl flooring', 'carpet supplier', 'laminate flooring', 'wood floor', 'floor contractor'],
  'clinic': ['dental clinic', 'pharmacy', 'medical centre', 'specialist clinic', 'skin clinic', 'eye clinic', 'physiotherapy clinic'],
  'gym': ['fitness centre', 'yoga studio', 'crossfit', 'personal trainer', 'sports centre', 'pilates studio', '24 hour gym'],
  'school': ['tuition centre', 'kindergarten', 'international school', 'nursery', 'music academy', 'language school', 'art class'],
  'salon': ['hair salon', 'barber', 'nail salon', 'beauty salon', 'spa', 'eyelash studio', 'massage'],
  'car': ['car workshop', 'car wash', 'car accessories', 'tyre shop', 'car detailing', 'used car dealer', 'auto repair'],
  'hotel': ['boutique hotel', 'guesthouse', 'homestay', 'resort', 'serviced apartment', 'hostel', 'motel'],
  'supermarket': ['grocery store', 'mini market', 'wholesale market', 'convenience store', 'wet market', 'organic store'],
};
const SUFFIX_FALLBACK = ['supplier', 'shop', 'service', 'company', 'store', 'wholesale', 'contractor', 'dealer'];

let rows = [], seen = new Set(), running = false, stopFlag = false, sugTimer = null;
let liveUsage = null;
let gridCenters = []; /* [{name, lat, lng, bbox}] */
let deepPairs = [];   /* (keyword × area) combos that hit the 60 cap — need the deep sweep */
let deepEstimate = 0; /* est req for the deep sweep (mirrors the CONTINUE button text) */
let advanced = false;
let curKw = '', curRegion = 'my', curMobile = false;
let fetched = 0, dup = 0, closed = 0, nonmobile = 0, outRange = 0, req = 0;

/* ================= access gate (server-enforced — password validated by /api/device
   against server-side APP_PASS env; NO credentials live in this bundle) ================= */

/* ===== device lock (server-enforced — 1 account = max 2 devices, e.g. phone + computer) ===== */
function getDeviceId() {
  try {
    let id = localStorage.getItem('plf_dev');
    if (!id) {
      id = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('plf_dev', id);
    }
    return id;
  } catch (e) {
    return 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
}
const DEVICE_ID = getDeviceId();

function deviceLabel() {
  const ua = navigator.userAgent;
  let os = 'Other';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = 'Browser';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Safari\//.test(ua)) br = 'Safari';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  return br + ' · ' + os;
}

function enterApp() {
  try { sessionStorage.setItem('plf_ok', '1'); } catch (e) {}
  document.documentElement.classList.remove('plf-out');
  document.documentElement.classList.add('plf-in');
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('login-err').classList.add('hidden');
}

function showLogin(reason) {
  document.getElementById('login-overlay').classList.remove('hidden');
  const dev = document.getElementById('login-device');
  if (dev) dev.textContent = 'THIS DEVICE · ' + deviceLabel();
  const err = document.getElementById('login-err');
  if (reason === 'limit') {
    err.textContent = '✖ DEVICE LIMIT REACHED — 此账号已达 2 设备上限，更换设备请联系卖家';
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

async function doLogin() {
  const p = document.getElementById('login-pass').value;
  const logo = document.querySelector('#login-overlay .login-spin');
  const btn = document.querySelector('#login-overlay button');
  if (logo) logo.classList.replace('login-spin', 'login-spin-fast');
  if (btn) btn.textContent = 'UNLOCKING…';
  try {
    const r = await fetch('/api/device?mode=register&id=' + encodeURIComponent(DEVICE_ID), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: DEVICE_ID, label: deviceLabel(), pass: p })
    });
    const j = await r.json();
    if (j.allowed) {
      setTimeout(enterApp, 400);
    } else if (j.reason === 'limit') {
      if (btn) btn.textContent = 'UNLOCK ▶';
      showLogin('limit');
    } else {
      if (btn) btn.textContent = 'UNLOCK ▶';
      document.getElementById('login-err').textContent = '✖ INVALID CREDENTIALS';
      document.getElementById('login-err').classList.remove('hidden');
    }
  } catch (e) {
    /* server unreachable — stay locked (fail-closed). NO auto-enter: the only
       auth path is the server-side register check, which never ran. */
    if (btn) btn.textContent = 'UNLOCK ▶';
    document.getElementById('login-err').textContent = '✖ SERVER UNREACHABLE — TRY AGAIN';
    document.getElementById('login-err').classList.remove('hidden');
  }
}
let plfAuthed = false;
try { plfAuthed = sessionStorage.getItem('plf_ok') === '1'; } catch (e) {}

/* boot: check this device against the server whitelist */
(async function boot() {
  if (plfAuthed) { enterApp(); return; }
  showLogin();
  try {
    const r = await fetch('/api/device?mode=check&id=' + encodeURIComponent(DEVICE_ID), { cache: 'no-store' });
    const j = await r.json();
    if (j.allowed) enterApp();
    else if (j.reason === 'limit') showLogin('limit');
  } catch (e) { /* keep login visible on network failure */ }
})();

/* ================= splash → reveal ================= */
window.addEventListener('load', () => {
  setTimeout(() => {
    const s = document.getElementById('splash');
    if (s) { s.classList.add('splash-fade'); setTimeout(() => { s.style.display = 'none'; }, 500); }
  }, 1400);
});

/* ================= domain check ================= */
const onOfficialDomain = EXPECTED_ORIGINS.includes(location.origin);
if (!onOfficialDomain) {
  document.getElementById('domain-warn').classList.remove('hidden');
  document.getElementById('run-btn').disabled = true;
}

/* ================= suggestions ================= */
function localSuggestions(kw) {
  const k = kw.toLowerCase().trim();
  if (SUGGESTION_DICT[k]) return SUGGESTION_DICT[k];
  return SUFFIX_FALLBACK.slice(0, 6).map(s => `${kw} ${s}`);
}
function renderChips(list, dim) {
  document.getElementById('kw-chips').innerHTML = list.map(k =>
    `<button onclick="useKeyword('${k.replace(/'/g, "\\'")}')" class="${dim ? 'chip-dim' : 'chip'}">${esc(k)}</button>`).join('');
}
function useKeyword(k) {
  const input = document.getElementById('grid-kw');
  const parts = input.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.includes(k)) parts.push(k);
  input.value = parts.join(', ');
  input.focus();
}
function debounceSuggest() {
  const kw = document.getElementById('grid-kw').value.trim();
  clearTimeout(sugTimer);
  const label = document.getElementById('sug-label');
  const spinner = document.getElementById('sug-spinner');
  if (!kw) {
    let recent = []; try { recent = JSON.parse(localStorage.getItem('places_recent_kw') || '[]'); } catch (e) {}
    label.textContent = recent.length ? 'RECENT — CLICK TO FILL' : '—';
    renderChips(recent, true);
    return;
  }
  const base = kw.includes(',') ? kw.split(',').pop().trim() : kw;
  label.textContent = 'SUGGESTIONS — CLICK TO FILL';
  spinner.classList.remove('hidden');
  renderChips([]);
  sugTimer = setTimeout(() => {
    renderChips(localSuggestions(base), true);
    spinner.classList.add('hidden');
  }, 300);
}

/* ================= area locating ================= */
async function locateAreaName(name) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=my&q=' + encodeURIComponent(name));
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (j && j[0]) return {
      name,
      lat: parseFloat(j[0].lat),
      lng: parseFloat(j[0].lon),
      bbox: (j[0].boundingbox || []).map(parseFloat)
    };
  } catch (e) { console.warn('locate failed:', name, e.message); }
  return null;
}
async function locateArea() {
  const names = document.getElementById('grid-area').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) { alert('Enter area name(s) first.'); return; }
  const readout = document.getElementById('grid-center');
  readout.textContent = '▸ LOCATING…';
  const found = [];
  for (const n of names) {
    const c = await locateAreaName(n);
    if (c) found.push(c);
  }
  gridCenters = found;
  readout.innerHTML = found.length
    ? found.map(c => '● ' + esc(c.name) + ' → ' + c.lat.toFixed(4) + ', ' + c.lng.toFixed(4)).join('<br>')
    : '✖ NOT FOUND — TRY ANOTHER NAME';
}
function toggleAdv() {
  advanced = !advanced;
  document.getElementById('adv-panel').classList.toggle('hidden', !advanced);
}
function autoGridFromBBox(bbox, clat) {
  if (!bbox || bbox.length < 4) return { radiusKm: 5, cellKm: 3 };
  const latSpan = Math.abs(bbox[1] - bbox[0]) * 111;
  const lngSpan = Math.abs(bbox[3] - bbox[2]) * 111 * Math.cos(clat * Math.PI / 180);
  const size = Math.max(latSpan, lngSpan);
  const radiusKm = Math.min(10, Math.max(2, Math.round(size * 0.75)));
  const cellKm = 3; /* preset cell size 3km (temporary) */
  return { radiusKm, cellKm };
}
function gridParamsFor(a) {
  if (advanced) {
    return {
      radiusKm: parseFloat(document.getElementById('grid-radius').value) || 5,
      cellKm: parseInt(document.getElementById('grid-cell').value) || 2
    };
  }
  return autoGridFromBBox(a.bbox, a.lat);
}

/* ================= budget UI ================= */
function currentUsage() {
  // Server-authoritative shared usage (last claim/RUN response); falls back to
  // the browser-local estimate only for display before any session exists.
  return telemetry.hasSession() || liveUsage !== null ? telemetry.effectiveUsage() : getUsage();
}
function monthKey() { return new Date().toISOString().slice(0, 7); }
function getUsage() {
  try { return JSON.parse(localStorage.getItem('places_usage') || '{}')[monthKey()] || 0; }
  catch (e) { return 0; }
}
function addUsage(n) {
  let d = {}; try { d = JSON.parse(localStorage.getItem('places_usage') || '{}'); } catch (e) {}
  d[monthKey()] = (d[monthKey()] || 0) + n;
  localStorage.setItem('places_usage', JSON.stringify(d));
  updateBudgetUI();
}
function updateBudgetUI() {
  const quota = customerQuota();
  const used = currentUsage(), pct = Math.min(100, Math.round(used / quota.monthlyTarget * 100));
  document.getElementById('budget-used').textContent = used.toLocaleString();
  document.getElementById('header-budget').textContent = used.toLocaleString() + '/' + quota.monthlyTarget.toLocaleString();
  document.getElementById('budget-pct').textContent = pct + '% · SAFETY STOP AT ' + quota.redRequests.toLocaleString() + ' · 50/SEARCH SESSION';
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.ceil((next - now) / 86400000);
  document.getElementById('reset-info').textContent = 'PLACES REQUESTS USED · GOOGLE ALLOWANCE ' + quota.monthlyTarget.toLocaleString() + ' · SAFETY STOP AT ' + quota.redRequests.toLocaleString() + ' · RESETS IN ' + daysLeft + 'D (UTC · 8AM MYT)';
  const bar = document.getElementById('budget-bar');
  bar.style.width = pct + '%';
  bar.style.background = pct >= quota.redPercent ? 'linear-gradient(90deg,#dc2626,#ef4444)' : pct >= quota.amberPercent ? 'linear-gradient(90deg,#f4b942,#fbbf24)' : 'linear-gradient(90deg,#0ABAB5,#67E8F9)';
  const src = document.getElementById('quota-src');
  if (src) {
    const live = telemetry.hasSession() || liveUsage !== null;
    src.textContent = live ? '● LIVE SNAPSHOT' : 'APP-LOCAL EST';
    src.className = 'mono text-[10px] font-bold px-2 py-0.5 rounded-md ' + (live ? 'bg-emerald-400/10 border border-emerald-400/30 text-emerald-400' : 'bg-white/5 border border-white/10 text-slate-500');
  }
}
function rememberKeyword(k) {
  if (!k) return;
  let recent = []; try { recent = JSON.parse(localStorage.getItem('places_recent_kw') || '[]'); } catch (e) {}
  recent = [k, ...recent.filter(x => x !== k)].slice(0, 8);
  localStorage.setItem('places_recent_kw', JSON.stringify(recent));
}

/* ================= phone / geo helpers ================= */
function phoneOf(p) { return p.nationalPhoneNumber || p.internationalPhoneNumber || ''; }
function isMobile(ph) {
  if (!ph) return false;
  let d = ph.replace(/\D/g, '');
  if (d.startsWith('60') && d.length >= 10) d = '0' + d.slice(2);
  return d.startsWith('01');
}
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ================= search ================= */
function showRunStatus(t) { document.getElementById('run-status').textContent = t; }
function syncStats() {
  document.getElementById('st-req').textContent = req;
  document.getElementById('st-fetched').textContent = fetched;
  document.getElementById('st-unique').textContent = rows.length;
  document.getElementById('st-dup').textContent = dup;
  document.getElementById('st-closed').textContent = closed;
  document.getElementById('st-nonmobile').textContent = nonmobile;
  document.getElementById('st-outrange').textContent = outRange;
  updateExportState();
}
function processPlaces(places, a, radiusM, doFilter) {
  let added = 0;
  for (const p of places || []) {
    fetched++;
    if (p.businessStatus === 'CLOSED_PERMANENTLY') { closed++; continue; }
    if (seen.has(p.id)) { dup++; continue; }
    seen.add(p.id);
    if (curMobile && !isMobile(phoneOf(p))) { nonmobile++; continue; }
    if (doFilter && p.location && distM(a.lat, a.lng, p.location.latitude, p.location.longitude) > radiusM) { outRange++; continue; }
    rows.push(p); appendRow(p, rows.length); added++;
  }
  return added;
}
async function apiFetch(payload) {
  // R1 CENTRALIZED CONTRACT: EVERY outbound Places request attempt must first
  // win a server-side atomic claim (api/session.js) — lease owned + attempts
  // < 50 + usage bridge incremented. The Google request is issued ONLY after
  // the claim succeeds. FAIL CLOSED: no claim -> no request (#51 never issued,
  // lost lease -> stop, Redis down -> stop).
  const claim = await telemetry.claimRequest();
  if (!claim.ok) {
    stopFlag = true;
    const reason = claim.reason;
    showRunStatus(reason === 'cap'
      ? '🛑 SESSION LIMIT (50) REACHED — START A NEW RUN'
      : reason === 'no_session'
        ? '⏳ SESSION EXPIRED — ANOTHER DEVICE MAY SEARCH — START A NEW RUN'
        : reason === 'ownership'
          ? '✖ SESSION OWNERSHIP LOST — START A NEW RUN'
          : '✖ REQUEST CLAIM FAILED — SEARCH STOPPED (REDIS UNAVAILABLE)');
    return null;
  }
  liveUsage = typeof claim.used === 'number' ? claim.used : liveUsage;
  try {
    return await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': EMBEDDED_KEY, 'X-Goog-FieldMask': FIELDS }, body: JSON.stringify(payload) });
  } catch (e) {
    // already claimed (conservative over-count is acceptable; under-count is not)
    throw e;
  }
}

async function runSearch() {
  if (!onOfficialDomain) { showRunStatus('✖ SEARCH DISABLED — OPEN THE OFFICIAL URL'); return; }
  const quota = customerQuota();
  // R1 CENTRALIZED CONTRACT: one Monitoring query max at RUN start; the
  // server reconciles Monitoring vs tenant Redis bridge (max, never backward),
  // blocks at >= 950, and atomically acquires the single active-search lease.
  const start = await telemetry.startRun(getDeviceId());
  if (!start.ok) {
    if (start.locked) {
      showRunStatus('🔒 ANOTHER AUTHORIZED DEVICE IS CURRENTLY SEARCHING. PLEASE CLOSE THE OTHER DEVICE TO CONTINUE.');
    } else if (start.blocked) {
      showRunStatus('🛑 SAFETY STOP AT ' + quota.redRequests.toLocaleString() + ' — NEW SEARCHES DISABLED (USED ' + (typeof start.used === 'number' ? start.used.toLocaleString() : '?') + '/' + quota.monthlyTarget.toLocaleString() + ')');
    } else {
      showRunStatus('✖ USAGE CHECK FAILED — SEARCH BLOCKED (MONITORING/REDIS UNAVAILABLE)');
    }
    return;
  }
  liveUsage = start.used;
  updateBudgetUI();

  const kwInput = document.getElementById('grid-kw').value.trim();
  const kws = kwInput.split(',').map(s => s.trim()).filter(Boolean);
  if (!kws.length) { alert('Enter a keyword first.'); return; }
  const names = document.getElementById('grid-area').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!gridCenters.length) {
    if (!names.length) { alert('Enter area name(s), e.g. "Desa Petaling, Shah Alam".'); return; }
    showRunStatus('▸ LOCATING AREAS…');
    await locateArea();
  }
  if (!gridCenters.length) { alert('Could not locate any area — try a different name.'); return; }

  curKw = kwInput; curRegion = document.getElementById('region').value; curMobile = document.getElementById('mobile-only').checked;
  rows = []; seen = new Set(); deepPairs = [];
  fetched = 0; dup = 0; closed = 0; nonmobile = 0; outRange = 0; req = 0;
  document.getElementById('tbody').innerHTML = '';
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('deep-btn').classList.add('hidden');
  syncStats();
  for (const k of kws) rememberKeyword(k);

  running = true; stopFlag = false;
  applyControlsToElements(controlsFor('running'), {
    runBtn: document.getElementById('run-btn'),
    stopBtn: document.getElementById('stop-btn'),
    deepBtn: document.getElementById('deep-btn'),
  });

  /* ===== PASS 1: plain "kw in area" for every keyword × area (up to 60 each) ===== */
  const combos = [];
  for (const a of gridCenters) for (const kw of kws) combos.push({ kw, a });
  outer:
  for (let ci2 = 0; ci2 < combos.length; ci2++) {
    const combo = combos[ci2];
    const a = combo.a, kw = combo.kw;
    let pageToken = null, pages = 0;
    showRunStatus('▸ FIND ' + (ci2 + 1) + '/' + combos.length + ' · ' + kw + ' @ ' + a.name + ' · PASS 1');
    while (pages < 3 && running && !stopFlag) {
      const payload = { textQuery: kw + ' in ' + a.name, pageSize: 20, languageCode: 'en', regionCode: curRegion };
      if (pageToken) payload.pageToken = pageToken;
      let resp;
      try { resp = await apiFetch(payload); }
      catch (e) { showRunStatus('✖ NETWORK/CORS ERROR: ' + e.message); break outer; }
      if (!resp) break outer; // safety stop reached — apiFetch already messaged
      if (resp.status === 403 || resp.status === 404) { showRunStatus('✖ API REJECTED KEY (' + resp.status + ') — PLACES API ENABLED? KEY RESTRICTED?'); break outer; }
      if (!resp.ok) { showRunStatus('✖ HTTP ' + resp.status); break outer; }
      req++; addUsage(1);
      const data = await resp.json();
      processPlaces(data.places, null, null, false);
      pages++;
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }
    if (pages === 3) deepPairs.push(combo); /* hit the 60 wall — more may exist */
  }
  syncStats();

  if (!running || stopFlag) { finishSearch('■ STOPPED BY USER'); return; }

  if (deepPairs.length) {
    /* prompt the user to continue — transparency on usage */
    let estReq = 0;
    for (const pair of deepPairs) {
      const a = pair.a;
      const { radiusKm, cellKm } = gridParamsFor(a);
      const radiusM = radiusKm * 1000, step = cellKm * 2000 * 0.9;
      let cells = 1;
      for (let dy = -radiusM; dy <= radiusM; dy += step)
        for (let dx = -radiusM; dx <= radiusM; dx += step)
          if (!(dx === 0 && dy === 0) && Math.hypot(dx, dy) <= radiusM) cells++;
      estReq += 3 + Math.max(0, cells - 1) * 3;
    }
    deepEstimate = estReq;
    document.getElementById('deep-btn').textContent = '▶ CONTINUE DEEP SEARCH · ' + deepPairs.length + ' COMBO(S) · ~' + estReq + ' REQ';
    document.getElementById('deep-btn').classList.remove('hidden');
    showRunStatus('⚠ ' + deepPairs.length + ' COMBO(S) HIT THE 60 CAP — MORE MAY EXIST · CLICK CONTINUE TO SWEEP THEM ALL');
  } else {
    finishSearch('✓ COMPLETE — ' + rows.length + ' COMPANIES · ' + gridCenters.length + ' AREAS · ' + req + ' REQ · ALL RESULTS');
  }
}

/* ===== PASS 2: deep grid sweep for capped areas (auto radius/cell) ===== */
async function deepSearch() {
  if (!deepPairs.length || !running) return;
  applyControlsToElements(controlsFor('running'), {
    runBtn: document.getElementById('run-btn'),
    stopBtn: document.getElementById('stop-btn'),
    deepBtn: document.getElementById('deep-btn'),
  });
  const reqStart = req;
  let exhausted = 0; /* areas whose cells were all empty — stopped early to save credit */
  outer:
  for (let i = 0; i < deepPairs.length; i++) {
    if (!running || stopFlag) break outer;
    const pair = deepPairs[i];
    const a = pair.a, kw = pair.kw;
    const { radiusKm, cellKm } = gridParamsFor(a);
    const radiusM = radiusKm * 1000;
    showRunStatus('▸ DEEP ' + (i + 1) + '/' + deepPairs.length + ' · ' + kw + ' @ ' + a.name + ' · r=' + radiusKm + 'km · c=' + cellKm + 'km');

    /* probe = center zone (paginated when dense) */
    let probeData;
    const probePayload = { textQuery: kw + ' in ' + a.name, pageSize: 20, languageCode: 'en', regionCode: curRegion,
      locationBias: { circle: { center: { latitude: a.lat, longitude: a.lng }, radius: radiusM } } };
    try {
      const r = await apiFetch(probePayload);
      if (!r) break outer; // safety stop reached
      if (r.status === 403 || r.status === 404) { showRunStatus('✖ API REJECTED KEY (' + r.status + ')'); break outer; }
      if (!r.ok) { showRunStatus('✖ HTTP ' + r.status); break outer; }
      req++; addUsage(1);
      probeData = await r.json();
    } catch (e) { showRunStatus('✖ NETWORK/CORS ERROR: ' + e.message); break outer; }
    processPlaces(probeData.places, a, radiusM, true);

    if (probeData.nextPageToken) {
      while (probeData.nextPageToken && running && !stopFlag) {
        const pagePayload = { textQuery: kw + ' in ' + a.name, pageSize: 20, languageCode: 'en', regionCode: curRegion,
          locationBias: { circle: { center: { latitude: a.lat, longitude: a.lng }, radius: radiusM } }, pageToken: probeData.nextPageToken };
        let r2;
        try {
          r2 = await apiFetch(pagePayload);
          if (!r2) break outer; // safety stop reached
          if (!r2.ok) { showRunStatus('✖ HTTP ' + r2.status); break outer; }
          req++; addUsage(1);
          probeData = await r2.json();
        } catch (e) { showRunStatus('✖ NETWORK/CORS ERROR: ' + e.message); break outer; }
        const added = processPlaces(probeData.places, a, radiusM, true);
        if (added === 0) break;
      }
    }

    /* edge cells (center zone covered by probe when cellKm <= radiusKm) */
    const latPerM = 1 / 111320;
    const lngPerM = 1 / (111320 * Math.cos(a.lat * Math.PI / 180));
    const step = cellKm * 2000 * 0.9;
    const cells = [];
    if (cellKm * 1000 > radiusM) cells.push({ lat: a.lat, lng: a.lng });
    for (let dy = -radiusM; dy <= radiusM; dy += step)
      for (let dx = -radiusM; dx <= radiusM; dx += step)
        if (!(dx === 0 && dy === 0) && Math.hypot(dx, dy) <= radiusM)
          cells.push({ lat: a.lat + dy * latPerM, lng: a.lng + dx * lngPerM });

    let stale = 0;
    for (let ci = 0; ci < cells.length; ci++) {
      if (!running || stopFlag) break outer;
      const c = cells[ci];
      let pageToken = null, pageNo = 0;
      showRunStatus('▸ DEEP ' + (i + 1) + '/' + deepPairs.length + ' · ' + a.name + ' · CELL ' + (ci + 1) + '/' + cells.length + ' · ' + fetched + ' FETCHED · ' + rows.length + ' KEPT');
      let cellAdded = 0;
      while (running && !stopFlag) {
        pageNo++;
        const payload = { textQuery: kw + ' in ' + a.name, pageSize: 20, languageCode: 'en', regionCode: curRegion,
          locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: cellKm * 1000 } } };
        if (pageToken) payload.pageToken = pageToken;
        let r3;
        try {
          r3 = await apiFetch(payload);
          if (!r3) break outer; // safety stop reached
          if (!r3.ok) { showRunStatus('✖ HTTP ' + r3.status); break outer; }
          req++; addUsage(1);
          const data = await r3.json();
          const added = processPlaces(data.places, a, radiusM, true);
          cellAdded += added;
          pageToken = data.nextPageToken || null;
          if (!pageToken) break;
          if (pageNo > 1 && added === 0) break;
        } catch (e) { showRunStatus('✖ NETWORK/CORS ERROR: ' + e.message); break outer; }
      }
      /* anti-waste: 3 consecutive empty cells → this area is fully mined; skip its remaining cells */
      if (cellAdded === 0) {
        if (++stale >= 3) { exhausted++; break; }
      } else {
        stale = 0;
      }
    }
  }
  syncStats();
  const used = req - reqStart, saved = Math.max(0, deepEstimate - used);
  let msg;
  if (!running || stopFlag) {
    msg = '■ STOPPED BY USER — ' + rows.length + ' COMPANIES · +' + used + ' REQ OF ~' + deepEstimate + ' · SAVED ~' + saved;
  } else if (exhausted > 0) {
    msg = '✓ COMPLETE — ' + rows.length + ' COMPANIES · +' + used + ' REQ (OF ~' + deepEstimate + ') · ' + exhausted + ' AREA(S) FULLY MINED — NO MORE RESULTS, STOPPED EARLY TO SAVE CREDIT';
  } else {
    msg = '✓ COMPLETE — ' + rows.length + ' COMPANIES · ' + gridCenters.length + ' AREAS · +' + used + ' REQ (OF ~' + deepEstimate + ')';
  }
  finishSearch(msg);
}

function finishSearch(msg) {
  running = false;
  applyControlsToElements(controlsFor('idle'), {
    runBtn: document.getElementById('run-btn'),
    stopBtn: document.getElementById('stop-btn'),
    deepBtn: document.getElementById('deep-btn'),
  });
  syncStats();
  // R1 CENTRALIZED CONTRACT: finishSearch must NOT trigger a Monitoring fetch
  // (DEEP/CONTINUE completion and STOP -> 0 Monitoring queries). The active
  // lease is released safely (compare-and-release, not a Monitoring query).
  telemetry.releaseSession();
  if (!msg.includes('✖') && !msg.includes('CAP')) showRunStatus(msg);
  if (rows.length === 0) document.getElementById('empty-state').classList.remove('hidden');
}

/**
 * PRE-R1 STOP UX fix: STOP at the continuation (60-cap) state must restore
 * RUN SEARCH as the primary CTA and clear the continuation buttons WITHOUT a
 * browser refresh, preserving all already-found results.
 */
function stopSearch() {
  stopFlag = true; running = false;
  applyControlsToElements(controlsFor('idle'), {
    runBtn: document.getElementById('run-btn'),
    stopBtn: document.getElementById('stop-btn'),
    deepBtn: document.getElementById('deep-btn'),
  });
  syncStats();
  // R1 CENTRALIZED CONTRACT: STOP -> 0 Monitoring queries. Release the lease.
  telemetry.releaseSession();
  showRunStatus('■ STOPPED BY USER — ' + rows.length + ' COMPANIES · ' + req + ' REQ · RESULTS PRESERVED — READY FOR A NEW SEARCH');
}

function resetStats() {
  ['st-fetched','st-unique','st-dup','st-closed','st-nonmobile','st-outrange','st-req'].forEach(id =>
    document.getElementById(id).textContent = '0');
}

function appendRow(p, n) {
  const ph = phoneOf(p);
  const mob = isMobile(ph);
  const tr = document.createElement('tr');
  tr.className = 'border-t border-white/5 hover:bg-[#0ABAB5]/[0.05] transition-colors row-in';
  tr.innerHTML =
    '<td class="px-4 py-2.5 text-slate-600 mono text-xs">' + n + '</td>' +
    '<td class="px-4 py-2.5 font-semibold text-white">' + esc((p.displayName || {}).text || '') + '</td>' +
    '<td class="px-4 py-2.5 text-slate-400 text-[13px]">' + esc(p.formattedAddress || '') + '</td>' +
    '<td class="px-4 py-2.5 whitespace-nowrap text-[13px] mono text-slate-300">' +
      (ph ? (mob ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-2 align-middle shadow-[0_0_7px_rgba(52,211,153,0.9)]"></span>' : '') + esc(ph) : '<span class="text-slate-600">—</span>') +
    '</td>' +
    '<td class="px-4 py-2.5 text-[13px]">' +
      (p.websiteUri ? '<a href="' + esc(p.websiteUri) + '" target="_blank" rel="noopener" class="text-[#22D3EE] hover:text-[#67e8f9] hover:underline">↗ LINK</a>' : '<span class="text-slate-600">—</span>') +
    '</td>';
  document.getElementById('tbody').appendChild(tr);
  const box = document.getElementById('tbody').parentElement;
  box.scrollTop = box.scrollHeight;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function updateExportState() {
  document.getElementById('export-btn').disabled = rows.length === 0;
}

/* ================= export ================= */
function exportExcel() {
  if (!rows.length) return;
  const headers = ['Company Name', 'Address', 'Phone', 'Website'];
  const data = [headers, ...rows.map(p => [
    (p.displayName || {}).text || '',
    p.formattedAddress || '',
    phoneOf(p),
    p.websiteUri || ''
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 32 }, { wch: 60 }, { wch: 20 }, { wch: 45 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Places');
  const kw = (document.getElementById('grid-kw').value.trim() || 'search').replace(/[^a-z0-9]+/gi, '_');
  const area = (gridCenters[0] ? gridCenters[0].name : document.getElementById('grid-area').value.trim() || 'all').replace(/[^a-z0-9]+/gi, '_');
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${kw}_${area}_${date}.xlsx`);
  showRunStatus('✓ EXPORTED ' + rows.length + ' COMPANIES');
}

function clearTable() {
  if (!rows.length) return;
  rows = []; seen = new Set();
  document.getElementById('tbody').innerHTML = '';
  resetStats();
  updateExportState();
  document.getElementById('empty-state').classList.remove('hidden');
}

/* ================= init ================= */
// R1 CENTRALIZED CONTRACT: page load / refresh -> 0 Monitoring queries.
// A Redis-only status check gives Device-B UX (another device searching ->
// RUN disabled). No recurring polling.
updateBudgetUI();
telemetry.status().then((st) => {
  if (st.ok && st.active) {
    const runBtn = document.getElementById('run-btn');
    if (runBtn) runBtn.disabled = true;
    showRunStatus('🔒 ANOTHER AUTHORIZED DEVICE IS CURRENTLY SEARCHING. PLEASE CLOSE THE OTHER DEVICE TO CONTINUE.');
  }
});
document.getElementById('grid-kw').addEventListener('input', debounceSuggest);
debounceSuggest();

/* expose handlers referenced by inline HTML attributes (Vite module scope is not global) */
Object.assign(window, { clearTable, deepSearch, doLogin, exportExcel, locateArea, runSearch, stopSearch, toggleAdv, useKeyword });
