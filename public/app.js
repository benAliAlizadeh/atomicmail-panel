const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  csrf: null,
  authRequired: false,
  authenticated: false,
  dashboard: null,
  currentView: 'dashboard',
  selectedJobId: null,
  selectedJob: null,
  activeJob: null,
  mailboxOffset: 0,
  mailboxLimit: 50,
  mailboxSearch: '',
  mailboxTotal: 0,
  mailboxItems: [],
  selectedCloudflareMailboxIds: new Set(),
  selectedCloudflareJobId: null,
  selectedCloudflareJob: null,
  activeCloudflareJob: null,
  cloudflareStatus: null,
  cloudflareJobPassword: null,
  cloudflarePairingCommand: '',
  manualCloudflareAccount: null,
  manualCloudflarePassword: null,
  manualCloudflareVerificationUrl: null,
  manualCloudflareVerificationCode: null,
  manualCloudflareGlobalApiKey: null,
  manualCloudflareApiToken: null,
  manualCloudflareSearch: '',
  manualCloudflareStatus: '',
  manualCloudflareSignupUrl: 'https://dash.cloudflare.com/sign-up',
  selectedMailbox: null,
  inboxItems: [],
  selectedMessage: null,
  mailFolder: 'inbox',
  mailPosition: 0,
  mailLimit: 25,
  mailTotal: 0,
  mailSearch: '',
  mailSearchField: 'subject',
  mailRefreshBusy: false,
  mailAutoTimer: null,
  mailRateRetryTimer: null,
  selectedMessageId: null,
  messageLoadingId: null,
  mailActionBusy: false,
  composeBusy: false,
  composeStartedAt: null,
  composeStage: '',
  composeDetail: '',
  composeReturnFocus: null,
  jobDestinationPassword: null,
  composeMode: 'new',
  previewInitialized: false,
  requestScopes: new Map(),
  requestSequences: new Map(),
  activities: new Map(),
  pollBusy: false,
  pollTimer: null,
  clockTimer: null,
  toastTimer: null,
};

const viewMeta = {
  dashboard: ['Dashboard', 'Mailbox creation overview'],
  create: ['Create emails', 'Start a safe sequential batch'],
  jobs: ['Jobs', 'Progress and batch controls'],
  mailboxes: ['Mailboxes', 'Search, copy and export created inboxes'],
  cloudflare: ['Cloudflare Accounts', 'Simple manual signup assistant with secure saved progress'],
  webmail: ['Webmail', 'Read and send mail through Atomic Mail JMAP'],
  system: ['System', 'Circuit breaker and operational audit'],
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortId(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 12)}…${text.slice(-5)}` : text;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function secondsBetween(start, end = Date.now()) {
  const startMs = Date.parse(start || '');
  const endMs = typeof end === 'number' ? end : Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, (endMs - startMs) / 1000);
}

function phaseLabel(phase) {
  const labels = {
    queued: 'Queued',
    starting: 'Preparing',
    preparing: 'Preparing credentials',
    launching: 'Starting AgentSkill',
    provider_running: 'Registering / proof-of-work',
    challenge: 'Challenge received',
    proof_of_work: 'Solving proof-of-work',
    session: 'Creating session',
    capability: 'Creating capability token',
    validating: 'Validating credentials',
    finalizing: 'Finalizing',
    saving: 'Saving mailbox',
    recovered: 'Reusing existing credentials',
    waiting_retry: 'Waiting to retry',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    awaiting_submit: 'Awaiting your submit',
    opening_signup: 'Opening signup',
    reconciling: 'Reconciling existing account',
    waiting_for_verification: 'Waiting for verification email',
    opening_verification: 'Opening verification',
    verifying: 'Confirming verified status',
    verified: 'Verified',
    needs_action: 'Needs operator action',
    retry_waiting: 'Waiting to retry',
  };
  return labels[phase] || String(phase || 'Working').replaceAll('_', ' ');
}

function runningItem(job) {
  return (job?.items || []).find((item) => item.status === 'running') || null;
}

function activityModel(job) {
  const item = runningItem(job);
  if (!item) return null;
  const elapsed = secondsBetween(item.attempt_started_at) ?? 0;
  const heartbeatAge = secondsBetween(item.phase_updated_at) ?? 0;
  const average = Number(job?.timing?.average_success_seconds);
  const pending = (job?.items || []).filter((candidate) => candidate.status === 'pending').length;
  const delaySeconds = Number(state.dashboard?.registration?.postSuccessDelayMs || 0) / 1000;
  const timeoutSeconds = Number(state.dashboard?.registration?.registerTimeoutMs || 0) / 1000;
  const eta = Number.isFinite(average) && average > 0
    ? Math.max(0, average - elapsed) + pending * average + pending * delaySeconds
    : null;
  return { item, elapsed, heartbeatAge, average, pending, timeoutSeconds, eta };
}

function renderLiveActivity(target, job) {
  const box = $(target);
  if (!box) return;
  const model = activityModel(job);
  if (!model) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const { item, elapsed, heartbeatAge, average, timeoutSeconds, eta } = model;
  const phase = phaseLabel(item.phase);
  const message = item.phase_message || 'Atomic Mail registration is still running';
  const timeoutText = timeoutSeconds > 0 ? ` · timeout guard ${formatDuration(timeoutSeconds)}` : '';
  const etaText = eta == null
    ? 'ETA: learning from the first successful mailbox'
    : `ETA remaining: about ${formatDuration(eta)} · average ${formatDuration(average)}/mailbox`;
  box.innerHTML = `
    <span class="activity-dot" aria-hidden="true"></span>
    <div>
      <strong>Creating ${escapeHtml(item.position)}/${escapeHtml(job.requested_count)} · ${escapeHtml(item.username)}</strong>
      <span>${escapeHtml(phase)} — ${escapeHtml(message)}</span>
      <small>Elapsed ${escapeHtml(formatDuration(elapsed))} · heartbeat ${escapeHtml(formatDuration(heartbeatAge))} ago${escapeHtml(timeoutText)}<br>${escapeHtml(etaText)}</small>
    </div>`;
  box.hidden = false;
}

function updateElapsedCells() {
  $$('[data-elapsed-start]').forEach((cell) => {
    const seconds = secondsBetween(cell.dataset.elapsedStart, cell.dataset.elapsedEnd || Date.now());
    cell.textContent = seconds == null ? '—' : formatDuration(seconds);
  });
}

function refreshLiveTimers() {
  if (state.activeJob) renderLiveActivity('#currentJobActivity', state.activeJob);
  if (state.selectedJob && state.currentView === 'jobs') renderLiveActivity('#jobLiveStatus', state.selectedJob);
  updateElapsedCells();
  renderGlobalActivity();
  renderComposeProgress();
}

function statusPill(status) {
  const safe = escapeHtml(status || 'unknown');
  return `<span class="pill ${safe}">${safe}</span>`;
}

function progressOf(job) {
  const requested = Math.max(1, Number(job?.requested_count || 0));
  const done = Number(job?.success_count || 0) + Number(job?.failed_count || 0);
  return Math.min(100, Math.max(0, Math.round((done / requested) * 100)));
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function beginLatestRequest(scope, { skipIfBusy = false } = {}) {
  const current = state.requestScopes.get(scope);
  if (skipIfBusy && current) return null;
  current?.controller.abort();
  const controller = new AbortController();
  const sequence = (state.requestSequences.get(scope) || 0) + 1;
  const request = { controller, sequence };
  state.requestSequences.set(scope, sequence);
  state.requestScopes.set(scope, request);
  return {
    signal: controller.signal,
    isCurrent: () => state.requestScopes.get(scope) === request,
    finish: () => {
      if (state.requestScopes.get(scope) === request) state.requestScopes.delete(scope);
    },
  };
}

function cancelRequest(scope) {
  state.requestScopes.get(scope)?.controller.abort();
  state.requestScopes.delete(scope);
}

function setButtonBusy(button, busy, busyLabel = 'Working') {
  if (!button) return;
  if (busy) {
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    button.dataset.idleHtml = button.innerHTML;
    button.dataset.idleDisabled = button.disabled ? 'true' : 'false';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(busyLabel)}</span>`;
    return;
  }
  if (button.dataset.busy !== 'true') return;
  button.innerHTML = button.dataset.idleHtml || '';
  button.disabled = button.dataset.idleDisabled === 'true';
  button.removeAttribute('aria-busy');
  delete button.dataset.busy;
  delete button.dataset.idleHtml;
  delete button.dataset.idleDisabled;
}

function beginActivity(key, label, { immediate = false } = {}) {
  const token = `${Date.now()}-${Math.random()}`;
  const activity = { token, label, startedAt: Date.now(), visible: immediate, timer: null };
  clearTimeout(state.activities.get(key)?.timer);
  state.activities.delete(key);
  if (!immediate) {
    activity.timer = setTimeout(() => {
      const current = state.activities.get(key);
      if (current?.token === token) {
        current.visible = true;
        renderGlobalActivity();
      }
    }, 180);
  }
  state.activities.set(key, activity);
  renderGlobalActivity();
  return () => {
    const current = state.activities.get(key);
    if (current?.token !== token) return;
    clearTimeout(current.timer);
    state.activities.delete(key);
    renderGlobalActivity();
  };
}

function renderGlobalActivity() {
  const box = $('#globalActivity');
  if (!box) return;
  const active = [...state.activities.values()].filter((item) => item.visible).at(-1);
  if (!active) {
    box.hidden = true;
    return;
  }
  $('#globalActivityText').textContent = active.label;
  $('#globalActivityTime').textContent = formatDuration((Date.now() - active.startedAt) / 1000);
  box.hidden = false;
}

async function withBusyButton(button, busyLabel, activityLabel, task) {
  setButtonBusy(button, true, busyLabel);
  const endActivity = beginActivity(button?.id || busyLabel, activityLabel || busyLabel);
  try {
    return await task();
  } finally {
    endActivity();
    setButtonBusy(button, false);
  }
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  if (options.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method) && state.csrf) headers.set('x-atomicmail-csrf', state.csrf);

  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
  const raw = await response.text();
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = { error: raw }; }
  }
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    state.authenticated = false;
    showLogin();
  }
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function downloadExport(format) {
  const params = new URLSearchParams({ format });
  if (state.mailboxSearch) params.set('search', state.mailboxSearch);
  const response = await fetch(`/api/mailboxes/export?${params}`, { credentials: 'same-origin' });
  if (response.status === 401) {
    showLogin();
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Export failed (${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/i);
  const filename = match?.[1] || `atomicmail-mailboxes.${format}`;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function showLogin() {
  stopWebmailAutoRefresh();
  hideJobPassword();
  hideCloudflarePassword();
  hideManualCloudflareSecrets();
  clearInterval(state.clockTimer);
  state.clockTimer = null;
  $('#appShell').hidden = true;
  $('#authGate').hidden = false;
  $('#loginPassword').value = '';
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  for (const request of state.requestScopes.values()) request.controller.abort();
  state.requestScopes.clear();
  for (const activity of state.activities.values()) clearTimeout(activity.timer);
  state.activities.clear();
  $$('[data-busy="true"]').forEach((button) => setButtonBusy(button, false));
  renderGlobalActivity();
  setTimeout(() => $('#loginPassword').focus(), 0);
}

function showApp(authStatus) {
  state.authRequired = Boolean(authStatus.authRequired);
  state.authenticated = true;
  state.csrf = authStatus.csrf || null;
  $('#authGate').hidden = true;
  $('#appShell').hidden = false;
  $('#currentUser').textContent = authStatus.username || 'local operator';
  $('#logoutButton').hidden = !authStatus.authRequired;
}

function switchView(view, { load = true } = {}) {
  if (!viewMeta[view]) return;
  if (state.currentView === 'webmail' && view !== 'webmail') stopWebmailAutoRefresh();
  if (state.currentView === 'jobs' && view !== 'jobs') hideJobPassword();
  if (state.currentView === 'cloudflare' && view !== 'cloudflare') {
    hideCloudflarePassword();
    hideManualCloudflareSecrets();
  }
  state.currentView = view;
  $$('.view').forEach((item) => { item.hidden = item.dataset.view !== view; });
  const navView = view === 'webmail' ? 'mailboxes' : view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.viewTarget === navView));
  $('#pageTitle').textContent = viewMeta[view][0];
  $('#pageSubtitle').textContent = viewMeta[view][1];
  if (load && view === 'jobs') loadJobs().catch(handleError);
  if (load && view === 'mailboxes') loadMailboxes().catch(handleError);
  if (load && view === 'cloudflare') loadManualCloudflare().catch(handleError);
  if (load && view === 'system') loadSystem().catch(handleError);
  if (view === 'webmail') startWebmailAutoRefresh();
}

function handleError(error) {
  if (error?.status === 401) return;
  showToast(error?.message || 'Unexpected error', true);
}

function handleManualCloudflareError(error) {
  if (error?.body?.temporary || error?.body?.code === 'mail_rate_limited') {
    const message = $('#manualCloudflareFocusMessage');
    message.textContent = 'Atomic Mail is temporarily rate limiting requests. Retrying automatically; please check again shortly.';
    message.hidden = false;
    showToast('Atomic Mail is temporarily rate limiting requests');
    return;
  }
  handleError(error);
}

function normalizePrefix(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function randomChars(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += chars[byte % chars.length];
  return out;
}

function refreshNamePreview() {
  const min = Number(state.dashboard?.limits?.usernameMinLength || 10);
  const max = Number(state.dashboard?.limits?.usernameMaxLength || 14);
  const prefix = normalizePrefix($('#batchPrefix').value);
  const names = [];
  for (let index = 0; index < 5; index += 1) {
    const target = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
    let value = `${prefix}${randomChars(Math.max(1, target - prefix.length))}`.slice(0, target);
    while (value.length < 5) value += randomChars(1);
    names.push(value);
  }
  $('#namePreview').innerHTML = names.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join('');
}

function renderDashboard(data) {
  state.dashboard = data;
  state.activeCloudflareJob = data.cloudflare?.activeJob || null;
  $('#statTotal').textContent = data.totalMailboxes;
  $('#statToday').textContent = data.createdToday;
  $('#statRunning').textContent = data.jobs?.running ?? 0;
  $('#statFailed').textContent = data.failedItems;
  $('#safetyWorker').textContent = data.workerEnabled ? 'Enabled' : 'Disabled';
  $('#safetyCircuit').textContent = data.circuit?.open ? (data.circuit.permanent ? 'Permanent stop' : 'Cooling down') : 'Closed';
  $('#safetyBatchLimit').textContent = data.limits?.maxBatchSize ?? '—';
  $('#workerBadge').className = `status-dot ${data.workerEnabled ? 'ok' : 'off'}`;
  $('#workerText').textContent = data.workerEnabled ? 'Worker enabled' : 'Worker disabled';

  const maxBatch = Number(data.limits?.maxBatchSize || 100);
  $('#batchCount').max = String(maxBatch);
  if (Number($('#batchCount').value) > maxBatch) $('#batchCount').value = String(maxBatch);

  const circuit = data.circuit || { open: false };
  const banner = $('#circuitBanner');
  if (circuit.open) {
    const until = circuit.until ? ` Until ${formatDate(circuit.until)}.` : '';
    banner.textContent = `${circuit.permanent ? 'Registration stopped' : 'Registration temporarily paused'}: ${circuit.reason || 'Circuit breaker is open'}.${until}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  if ($('#createButton').dataset.busy !== 'true') $('#createButton').disabled = Boolean(circuit.open) || !data.workerEnabled;

  const job = data.activeJob;
  state.activeJob = job || null;
  $('#currentJobEmpty').hidden = Boolean(job);
  $('#currentJob').hidden = !job;
  $('#openCurrentJob').hidden = !job;
  if (job) {
    $('#currentJobId').textContent = shortId(job.id);
    $('#currentJobStatus').outerHTML = statusPill(job.status).replace('<span ', '<span id="currentJobStatus" ');
    const percent = progressOf(job);
    $('#currentJobProgress').style.width = `${percent}%`;
    const counts = itemStatusCounts(job.items);
    $('#currentJobNumbers').textContent = `${job.success_count} successful · ${job.failed_count} failed · ${counts.pending || 0} pending · ${counts.running || 0} running · ${percent}%`;
    $('#openCurrentJob').dataset.jobId = job.id;
    renderLiveActivity('#currentJobActivity', job);
  } else {
    renderLiveActivity('#currentJobActivity', null);
  }
  if (!state.previewInitialized) {
    state.previewInitialized = true;
    refreshNamePreview();
  }
}

async function loadDashboard() {
  renderDashboard(await api('/api/dashboard'));
}

function renderJobs(jobs) {
  $('#jobsEmpty').hidden = jobs.length > 0;
  $('#jobsBody').innerHTML = jobs.map((job) => {
    const done = Number(job.success_count) + Number(job.failed_count);
    return `<tr data-job-id="${escapeHtml(job.id)}">
      <td>${escapeHtml(formatDate(job.created_at))}</td>
      <td class="mono" title="${escapeHtml(job.id)}">${escapeHtml(shortId(job.id))}</td>
      <td>${statusPill(job.status)}</td>
      <td>${done}/${escapeHtml(job.requested_count)} (${progressOf(job)}%)${job.status === 'running' ? ' · working' : ''}</td>
      <td>${escapeHtml(job.prefix || '—')}</td>
    </tr>`;
  }).join('');
}

async function loadJobs({ background = false } = {}) {
  const request = beginLatestRequest('jobs', { skipIfBusy: background });
  if (!request) return;
  const endActivity = background ? () => {} : beginActivity('jobs-list', 'Loading jobs');
  if (!background) setButtonBusy($('#refreshJobs'), true, 'Refreshing');
  $('#jobsPanel').setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/jobs?limit=75', { signal: request.signal });
    if (!request.isCurrent()) return;
    renderJobs(data.jobs || []);
    if (state.selectedJobId) await loadJobDetail(state.selectedJobId, { background });
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      $('#jobsPanel').removeAttribute('aria-busy');
      if (!background) setButtonBusy($('#refreshJobs'), false);
    }
    endActivity();
  }
}

function itemStatusCounts(items) {
  const counts = {};
  for (const item of items || []) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

async function loadJobDetail(id, { background = false } = {}) {
  const nextId = String(id || '');
  if (!nextId) return;
  if (state.selectedJobId !== nextId) hideJobPassword();
  state.selectedJobId = nextId;
  const request = beginLatestRequest('job-detail', { skipIfBusy: background });
  if (!request) return;
  const endActivity = background ? () => {} : beginActivity('job-detail', 'Loading job details');
  if (!background) {
    $('#jobDetailPanel').setAttribute('aria-busy', 'true');
    $$('#jobActions button').forEach((button) => { button.disabled = true; });
  }
  let job;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(nextId)}`, { signal: request.signal });
    if (!request.isCurrent() || state.selectedJobId !== nextId) return;
  } catch (error) {
    if (!isAbortError(error)) throw error;
    return;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      if (!background) $('#jobDetailPanel').removeAttribute('aria-busy');
    }
    endActivity();
  }
  state.selectedJob = job;
  $('#jobDetailPanel').hidden = false;
  $('#jobDetailTitle').textContent = `Job ${shortId(job.id)}`;
  $('#jobDetailMeta').textContent = `Created ${formatDate(job.created_at)} · Prefix ${job.prefix || 'none'} · ${job.requested_count} requested`;
  const percent = progressOf(job);
  $('#jobDetailProgress').style.width = `${percent}%`;
  const counts = itemStatusCounts(job.items);
  $('#jobDetailNumbers').textContent = `${job.success_count} successful · ${job.failed_count} failed · ${counts.pending || 0} pending · ${counts.running || 0} running · ${counts.cancelled || 0} cancelled · ${percent}%`;
  renderLiveActivity('#jobLiveStatus', job);
  $('#jobDetailError').hidden = !job.last_error;
  $('#jobDetailError').textContent = job.last_error || '';
  $('#jobPasswordPanel').hidden = !job.has_destination_password;
  if (!job.has_destination_password) hideJobPassword();

  const actions = [];
  if (job.status === 'running') actions.push('<button class="btn ghost small-btn" data-job-action="pause">Pause</button>');
  if (job.status === 'paused') actions.push('<button class="btn primary small-btn" data-job-action="resume">Resume</button>');
  if (['running', 'paused', 'pending'].includes(job.status)) actions.push('<button class="btn danger-btn small-btn" data-job-action="cancel">Cancel</button>');
  $('#jobActions').innerHTML = actions.join('');

  $('#jobItemsBody').innerHTML = (job.items || []).map((item) => {
    const start = item.attempt_started_at || '';
    const end = item.finished_at || '';
    return `<tr>
      <td>${escapeHtml(item.position)}</td>
      <td class="mono">${escapeHtml(item.username)}</td>
      <td>${statusPill(item.status)}</td>
      <td><span class="phase-label">${escapeHtml(phaseLabel(item.phase))}</span><small class="phase-message">${escapeHtml(item.phase_message || '')}</small></td>
      <td class="mono" data-elapsed-start="${escapeHtml(start)}" data-elapsed-end="${escapeHtml(end)}">${start ? escapeHtml(formatDuration(secondsBetween(start, end || Date.now()))) : '—'}</td>
      <td>${escapeHtml(item.attempts)}</td>
      <td class="truncate" title="${escapeHtml(item.last_error || '')}">${escapeHtml(item.last_error || '—')}</td>
    </tr>`;
  }).join('');
}

async function runJobAction(action, sourceButton) {
  if (!state.selectedJobId) return;
  if (action === 'cancel' && !confirm('Cancel all pending items in this job? A registration already in progress cannot be interrupted safely.')) return;
  const jobId = state.selectedJobId;
  await withBusyButton(sourceButton, `${action[0].toUpperCase()}${action.slice(1)}…`, `Requesting job ${action}`, async () => {
    $$('#jobActions button').forEach((button) => { button.disabled = true; });
    await api(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST', body: '{}' });
    showToast(`Job ${action} requested`);
    await Promise.all([loadJobs(), loadDashboard()]);
  });
}

async function loadMailboxes({ background = false } = {}) {
  const request = beginLatestRequest('mailboxes', { skipIfBusy: background });
  if (!request) return;
  const endActivity = background ? () => {} : beginActivity('mailbox-list', 'Loading mailboxes');
  $('#mailboxesPanel').setAttribute('aria-busy', 'true');
  const params = new URLSearchParams({ limit: state.mailboxLimit, offset: state.mailboxOffset });
  if (state.mailboxSearch) params.set('search', state.mailboxSearch);
  let data;
  try {
    data = await api(`/api/mailboxes?${params}`, { signal: request.signal });
    if (!request.isCurrent()) return;
  } catch (error) {
    if (!isAbortError(error)) throw error;
    return;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      $('#mailboxesPanel').removeAttribute('aria-busy');
    }
    endActivity();
  }
  state.mailboxTotal = Number(data.total || 0);
  const items = data.items || [];
  state.mailboxItems = items;
  $('#mailboxesEmpty').hidden = items.length > 0;
  $('#mailboxCountText').textContent = `${state.mailboxTotal} mailbox${state.mailboxTotal === 1 ? '' : 'es'}${state.mailboxSearch ? ` matching “${state.mailboxSearch}”` : ''}`;
  $('#mailboxesBody').innerHTML = items.map((item) => `<tr>
    <td class="mailbox-selection-cell"><input type="checkbox" data-cloudflare-mailbox-id="${escapeHtml(item.id)}" aria-label="Select ${escapeHtml(item.email)} for Cloudflare" ${state.selectedCloudflareMailboxIds.has(item.id) ? 'checked' : ''} ${item.cloudflare_eligible ? '' : 'disabled'} /></td>
    <td class="mono">${escapeHtml(item.email)}</td>
    <td>${statusPill(item.status)}</td>
    <td>${item.cloudflare_status
      ? `<strong class="cloudflare-account-note">Already Used</strong>${statusPill(item.cloudflare_status)}${item.cloudflare_verified_at ? `<span class="cloudflare-account-note">Verified on ${escapeHtml(formatDate(item.cloudflare_verified_at))}</span>` : ''}`
      : '<span class="muted">Eligible</span>'}</td>
    <td><span class="pill">API key</span></td>
    <td>${escapeHtml(formatDate(item.created_at))}</td>
    <td class="mono" title="${escapeHtml(item.job_id || '')}">${escapeHtml(item.job_id ? shortId(item.job_id) : '—')}</td>
    <td><div class="mailbox-action-group"><button class="btn primary small-btn open-inbox-btn" data-open-inbox="${escapeHtml(item.id)}" data-mailbox-email="${escapeHtml(item.email)}">Open inbox</button><button class="copy-btn" data-copy-email="${escapeHtml(item.email)}">Copy email</button>${item.has_destination_password ? `<button class="copy-btn" data-copy-mailbox-password="${escapeHtml(item.id)}">Copy password</button>` : ''}</div></td>
  </tr>`).join('');
  const page = Math.floor(state.mailboxOffset / state.mailboxLimit) + 1;
  const pages = Math.max(1, Math.ceil(state.mailboxTotal / state.mailboxLimit));
  $('#mailboxPageText').textContent = `Page ${page} of ${pages}`;
  $('#mailboxPrev').disabled = state.mailboxOffset <= 0;
  $('#mailboxNext').disabled = state.mailboxOffset + state.mailboxLimit >= state.mailboxTotal;
  updateCloudflareSelectionUi();
}

function updateCloudflareSelectionUi() {
  const count = state.selectedCloudflareMailboxIds.size;
  $('#createCloudflareSelection').textContent = `Start Cloudflare batch (${count})`;
  $('#createCloudflareSelection').disabled = count < 1;
  $('#clearCloudflareSelection').disabled = count < 1;
  const eligible = state.mailboxItems.filter((item) => item.cloudflare_eligible);
  $('#toggleMailboxPageSelection').checked = eligible.length > 0 && eligible.every((item) => state.selectedCloudflareMailboxIds.has(item.id));
  $('#toggleMailboxPageSelection').indeterminate = eligible.some((item) => state.selectedCloudflareMailboxIds.has(item.id))
    && !eligible.every((item) => state.selectedCloudflareMailboxIds.has(item.id));
}

function selectMailboxRows(items, selected = true) {
  for (const item of items) {
    if (!item.cloudflare_eligible) continue;
    if (selected) {
      if (state.selectedCloudflareMailboxIds.size >= 100) break;
      state.selectedCloudflareMailboxIds.add(item.id);
    } else {
      state.selectedCloudflareMailboxIds.delete(item.id);
    }
  }
  $$('[data-cloudflare-mailbox-id]').forEach((input) => {
    input.checked = state.selectedCloudflareMailboxIds.has(input.dataset.cloudflareMailboxId);
  });
  updateCloudflareSelectionUi();
}

async function selectFirstFilteredMailboxes(button) {
  await withBusyButton(button, 'Selecting', 'Loading eligible mailboxes', async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (state.mailboxSearch) params.set('search', state.mailboxSearch);
    const data = await api(`/api/cloudflare/eligible-mailboxes?${params}`);
    const eligible = data.items || [];
    state.selectedCloudflareMailboxIds.clear();
    selectMailboxRows(eligible.slice(0, 100));
    showToast(`Selected ${state.selectedCloudflareMailboxIds.size} eligible mailbox${state.selectedCloudflareMailboxIds.size === 1 ? '' : 'es'}`);
  });
}

const MANUAL_CLOUDFLARE_STATUS_LABELS = {
  not_started: 'Not Started',
  signup_done: 'Signup Done',
  waiting_verification: 'Waiting Verification',
  verification_received: 'Verification Received',
  verified: 'Verified',
  failed: 'Failed',
};

function setManualCloudflareAccessSecretsVisible({ globalApiKey = '', apiToken = '' } = {}) {
  state.manualCloudflareGlobalApiKey = globalApiKey || null;
  state.manualCloudflareApiToken = apiToken || null;
  const globalInput = $('#manualCloudflareGlobalApiKey');
  const tokenInput = $('#manualCloudflareApiToken');
  globalInput.value = globalApiKey || '';
  tokenInput.value = apiToken || '';
  globalInput.type = 'text';
  tokenInput.type = 'text';
  const reveal = $('#revealManualCloudflareAccessSecrets');
  reveal.textContent = 'Hide values';
  reveal.setAttribute('aria-pressed', 'true');
  $('#manualCloudflareSecretVisibilityHint').textContent = 'Saved values are visible on this screen and will be hidden when you refresh, change account, or log out.';
}

function hideManualCloudflareAccessSecretsOnly() {
  state.manualCloudflareGlobalApiKey = null;
  state.manualCloudflareApiToken = null;
  for (const id of ['manualCloudflareGlobalApiKey', 'manualCloudflareApiToken']) {
    const input = $(`#${id}`);
    if (input) { input.value = ''; input.type = 'password'; }
  }
  const reveal = $('#revealManualCloudflareAccessSecrets');
  if (reveal) {
    reveal.textContent = 'Show saved values';
    reveal.setAttribute('aria-pressed', 'false');
  }
  const hint = $('#manualCloudflareSecretVisibilityHint');
  if (hint) hint.textContent = 'Saved values are hidden after refresh, account change, or logout. Use Show saved values when needed.';
}

function hideManualCloudflarePasswordOnly() {
  state.manualCloudflarePassword = null;
  const password = $('#manualCloudflareFocusPassword');
  if (password) password.textContent = '••••••••••••••••••••';
  const reveal = $('#revealManualCloudflarePassword');
  if (reveal) reveal.textContent = 'Reveal';
}

function hideManualCloudflareSecrets() {
  state.manualCloudflareVerificationUrl = null;
  state.manualCloudflareVerificationCode = null;
  hideManualCloudflarePasswordOnly();
  hideManualCloudflareAccessSecretsOnly();
}

function manualCloudflareVerificationReady(account) {
  return Boolean(account?.verification_received_at && (account.has_verification_code || account.has_verification_link));
}

function renderManualCloudflareCredentialState(account) {
  if (!account) return;
  const globalSaved = Boolean(account.has_global_api_key);
  const tokenSaved = Boolean(account.has_api_token);
  const globalInput = $('#manualCloudflareGlobalApiKey');
  const tokenInput = $('#manualCloudflareApiToken');
  const globalStatus = $('#manualCloudflareGlobalApiKeyStatus');
  const tokenStatus = $('#manualCloudflareApiTokenStatus');

  globalStatus.textContent = globalSaved ? 'Saved' : 'Required';
  globalStatus.className = `mini-status ${globalSaved ? 'ok' : ''}`;
  tokenStatus.textContent = tokenSaved ? 'Saved' : 'Required';
  tokenStatus.className = `mini-status ${tokenSaved ? 'ok' : ''}`;
  globalInput.classList.toggle('saved', globalSaved);
  tokenInput.classList.toggle('saved', tokenSaved);
  globalInput.placeholder = globalSaved ? 'Saved: cfk_•••••••••••• — paste here to replace' : 'Paste Global API Key (cfk_...)';
  tokenInput.placeholder = tokenSaved ? 'Saved: cfat_/cfut_•••••••••••• — paste here to replace' : 'Paste API Token (cfat_... or cfut_...)';
  $('#manualCloudflareGlobalApiKeyHint').textContent = globalSaved
    ? 'Saved securely. Paste a new value only when you want to replace it.'
    : 'Required before this account can be completed.';
  $('#manualCloudflareApiTokenHint').textContent = tokenSaved
    ? 'Saved securely. Paste a new value only when you want to replace it.'
    : 'Required before this account can be completed.';

  const missing = [!globalSaved && 'Global API Key', !tokenSaved && 'API Token'].filter(Boolean);
  const guide = $('#manualCloudflareCredentialGuide');
  guide.textContent = missing.length
    ? `Still needed: ${missing.join(' and ')}. Paste the missing value${missing.length > 1 ? 's' : ''}, then click Save / update credentials.`
    : 'Both credentials are saved. You can show, copy, replace, or continue to the final step.';
  guide.className = `focus-secret-guide ${missing.length ? 'warning' : 'ready'}`;

  $('#copyManualCloudflareGlobalApiKey').disabled = !globalSaved;
  $('#copyManualCloudflareApiToken').disabled = !tokenSaved;
  $('#revealManualCloudflareAccessSecrets').disabled = !globalSaved && !tokenSaved;
}

function guideManualCloudflareStep(stepId, focusId, message) {
  const step = $(`#${stepId}`);
  if (step) {
    step.classList.remove('focus-attention');
    void step.offsetWidth;
    step.classList.add('focus-attention');
    step.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => step.classList.remove('focus-attention'), 3200);
  }
  const target = focusId ? $(`#${focusId}`) : null;
  if (target) setTimeout(() => target.focus({ preventScroll: true }), 350);
  showToast(message);
}

function manualCloudflareStatusLabel(status) {
  return MANUAL_CLOUDFLARE_STATUS_LABELS[status] || String(status || 'Unknown');
}

function manualCloudflareTimeline(account) {
  const signupDone = Boolean(account.signup_done_at);
  const emailReceived = Boolean(account.verification_received_at);
  const apiSecretsSaved = Boolean(account.has_global_api_key && account.has_api_token);
  const verified = Boolean(account.verified_at || account.status === 'verified');
  const rows = [
    ['Account prepared', true, false],
    ['Signup done', signupDone, account.status === 'not_started'],
    ['Verification received', emailReceived, signupDone && !emailReceived],
    ['API credentials saved', apiSecretsSaved, emailReceived && !apiSecretsSaved],
    ['Completed', verified, apiSecretsSaved && !verified],
  ];
  return rows.map(([label, done, active], index) => `<li class="${done ? 'done' : active ? 'active' : ''}">
    <span class="timeline-marker">${done ? '✓' : active ? '…' : index + 1}</span><span>${escapeHtml(label)}</span>
  </li>`).join('');
}

function renderManualCloudflareStats(stats = {}) {
  state.manualCloudflareSignupUrl = stats.signupUrl || 'https://dash.cloudflare.com/sign-up';
  $('#manualCloudflareTotal').textContent = stats.totalAccounts ?? 0;
  $('#manualCloudflareVerified').textContent = stats.verifiedAccounts ?? 0;
  $('#manualCloudflarePending').textContent = stats.pendingAccounts ?? 0;
  $('#manualCloudflareFailed').textContent = stats.failedAccounts ?? 0;
}

function renderManualCloudflareFocus(account, stats = {}) {
  const previousId = state.manualCloudflareAccount?.id;
  if (previousId !== account?.id) hideManualCloudflareSecrets();
  state.manualCloudflareAccount = account || null;
  $('#manualCloudflareFocusEmpty').hidden = Boolean(account);
  $('#manualCloudflareFocusCard').hidden = !account;
  if (!account) return;

  $('#manualCloudflareFocusCounter').textContent = `Account ${account.position || 1} / ${account.batch_total || stats.totalAccounts || 1}`;
  $('#manualCloudflareFocusEmail').textContent = account.email;
  $('#manualCloudflareFocusStatus').textContent = manualCloudflareStatusLabel(account.status);
  $('#manualCloudflareFocusStatus').className = `pill ${escapeHtml(account.status)}`;
  $('#manualCloudflareTimeline').innerHTML = manualCloudflareTimeline(account);
  $('#manualCloudflareNotes').value = account.notes || '';

  const notStarted = account.status === 'not_started';
  const signupDone = Boolean(account.signup_done_at);
  const hasVerificationCode = Boolean(account.has_verification_code && account.verification_received_at);
  const hasVerificationLink = Boolean(account.has_verification_link && account.verification_received_at);
  const verificationReceived = manualCloudflareVerificationReady(account);
  const apiSecretsReady = Boolean(account.has_global_api_key && account.has_api_token);
  const workflowReady = signupDone && verificationReceived && apiSecretsReady;
  const verified = Boolean(account.verified_at || account.status === 'verified');
  const failed = account.status === 'failed';
  const terminal = verified || failed;

  $('#regenerateManualCloudflarePassword').disabled = !notStarted;
  $('#manualCloudflarePasswordLocked').hidden = notStarted;
  $('#markManualCloudflareSignupDone').disabled = !notStarted;
  $('#checkManualCloudflareInbox').disabled = !signupDone || terminal;
  $('#openManualCloudflareSignup').disabled = !notStarted;
  $('#markManualCloudflareFailed').disabled = terminal;

  const finishButton = $('#markManualCloudflareVerified');
  finishButton.disabled = terminal;
  finishButton.textContent = verified ? 'Verified' : failed ? 'Failed' : workflowReady ? 'Mark Verified & Next' : 'Continue setup';
  $('#manualCloudflareFinishHint').textContent = verified
    ? 'This account is complete.'
    : failed
      ? 'This account is marked failed. Review its notes or continue with another account.'
      : !signupDone
        ? 'First complete the Cloudflare signup and click Signup Done.'
        : !verificationReceived
          ? 'Next, check the inbox and use the Cloudflare code or verification link.'
          : !apiSecretsReady
            ? 'Next, save the missing Cloudflare API credentials in Step 4.'
            : 'Ready: verification evidence and both API credentials are saved.';

  const nextAction = $('#manualCloudflareNextAction');
  if (verified) {
    nextAction.textContent = 'Completed: this Cloudflare account is verified and saved.';
    nextAction.className = 'focus-next-action ready';
  } else if (failed) {
    nextAction.textContent = 'This account is marked failed. Check the notes before retrying or replacing it.';
    nextAction.className = 'focus-next-action warning';
  } else if (!signupDone) {
    nextAction.textContent = 'Next step: copy the email/password, create the Cloudflare account, then click Signup Done.';
    nextAction.className = 'focus-next-action';
  } else if (!verificationReceived) {
    nextAction.textContent = 'Next step: click Check Inbox & Get Code/Link, then complete Cloudflare verification.';
    nextAction.className = 'focus-next-action warning';
  } else if (!apiSecretsReady) {
    const missing = [!account.has_global_api_key && 'Global API Key', !account.has_api_token && 'API Token'].filter(Boolean).join(' and ');
    nextAction.textContent = `Next step: paste and save the missing ${missing} in Step 4 below.`;
    nextAction.className = 'focus-next-action warning';
  } else {
    nextAction.textContent = 'Ready to finish: click Mark Verified & Next.';
    nextAction.className = 'focus-next-action ready';
  }

  const evidence = $('#manualCloudflareVerificationEvidence');
  evidence.hidden = !verificationReceived;
  $('#manualCloudflareVerificationSubject').textContent = account.verification_subject || 'Trusted Cloudflare message';
  $('#manualCloudflareVerificationReceivedAt').textContent = account.verification_received_at ? formatDate(account.verification_received_at) : '';
  $('#manualCloudflareVerificationCodeRow').hidden = !hasVerificationCode;
  $('#manualCloudflareVerificationLinkRow').hidden = !hasVerificationLink;
  $('#manualCloudflareVerificationCode').textContent = hasVerificationCode
    ? (state.manualCloudflareVerificationCode || '••••••') : '';
  $('#manualCloudflareApiSecretBadges').innerHTML = [
    `<span class="chip ${account.has_global_api_key ? 'success' : ''}">API Key ${account.has_global_api_key ? 'saved' : 'missing'}</span>`,
    `<span class="chip ${account.has_api_token ? 'success' : ''}">API Token ${account.has_api_token ? 'saved' : 'missing'}</span>`,
  ].join('');
  renderManualCloudflareCredentialState(account);

  const message = $('#manualCloudflareFocusMessage');
  if (account.status === 'waiting_verification') {
    message.textContent = `No trusted Cloudflare verification email found yet.${account.last_inbox_check_at ? ` Last checked ${formatDate(account.last_inbox_check_at)}.` : ''}`;
    message.hidden = false;
  } else if (account.last_error) {
    message.textContent = account.last_error;
    message.hidden = false;
  } else {
    message.hidden = true;
    message.textContent = '';
  }
}

function renderManualCloudflareAccounts(accounts) {
  $('#manualCloudflareAccountsEmpty').hidden = accounts.length > 0;
  $('#manualCloudflareAccountsBody').innerHTML = accounts.map((account) => `<tr>
    <td><button class="text-button mono" type="button" data-manual-cloudflare-open="${escapeHtml(account.id)}">${escapeHtml(account.email)}</button></td>
    <td><span class="mono">••••••••</span> <button class="btn ghost small-btn" type="button" data-manual-cloudflare-copy-password="${escapeHtml(account.id)}">Copy</button></td>
    <td><span class="mini-status ${account.has_global_api_key ? 'ok' : ''}">Key ${account.has_global_api_key ? '✓' : '—'}</span> <span class="mini-status ${account.has_api_token ? 'ok' : ''}">Token ${account.has_api_token ? '✓' : '—'}</span></td>
    <td>${statusPill(account.status)}</td>
    <td>${escapeHtml(formatDate(account.verified_at))}</td>
    <td class="truncate" title="${escapeHtml(account.notes || '')}">${escapeHtml(account.notes || '—')}</td>
  </tr>`).join('');
}

async function loadManualCloudflare({ background = false } = {}) {
  const request = beginLatestRequest('manual-cloudflare', { skipIfBusy: background });
  if (!request) return;
  const endActivity = background ? () => {} : beginActivity('manual-cloudflare-load', 'Loading saved Cloudflare progress');
  if (!background) setButtonBusy($('#refreshManualCloudflare'), true, 'Refreshing');
  $('#manualCloudflareFocusPanel').setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams({ limit: '100', offset: '0' });
    if (state.manualCloudflareSearch) params.set('search', state.manualCloudflareSearch);
    if (state.manualCloudflareStatus) params.set('status', state.manualCloudflareStatus);
    const [focus, accounts] = await Promise.all([
      api('/api/cloudflare/focus', { signal: request.signal }),
      api(`/api/cloudflare/accounts?${params}`, { signal: request.signal }),
    ]);
    if (!request.isCurrent()) return;
    renderManualCloudflareStats(focus.stats);
    renderManualCloudflareFocus(focus.account, focus.stats);
    renderManualCloudflareAccounts(accounts.items || []);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      $('#manualCloudflareFocusPanel').setAttribute('aria-busy', 'false');
      if (!background) setButtonBusy($('#refreshManualCloudflare'), false);
    }
    endActivity();
  }
}

async function openManualCloudflareAccount(id) {
  const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(id)}`);
  const stats = await api('/api/cloudflare/status');
  renderManualCloudflareStats(stats);
  renderManualCloudflareFocus(result.account, stats);
  $('#manualCloudflareFocusPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function revealManualCloudflarePassword() {
  const account = state.manualCloudflareAccount;
  if (!account) return '';
  const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/password`, { method: 'POST', body: '{}' });
  state.manualCloudflarePassword = result.password;
  $('#manualCloudflareFocusPassword').textContent = result.password;
  $('#revealManualCloudflarePassword').textContent = 'Hide';
  return result.password;
}

async function manualCloudflareVerificationLink() {
  const account = state.manualCloudflareAccount;
  if (!account) return '';
  if (state.manualCloudflareVerificationUrl) return state.manualCloudflareVerificationUrl;
  const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/verification-link`, { method: 'POST', body: '{}' });
  state.manualCloudflareVerificationUrl = result.verificationUrl;
  return result.verificationUrl;
}

async function manualCloudflareVerificationCode() {
  const account = state.manualCloudflareAccount;
  if (!account) return '';
  if (state.manualCloudflareVerificationCode) return state.manualCloudflareVerificationCode;
  const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/verification-code`, { method: 'POST', body: '{}' });
  state.manualCloudflareVerificationCode = result.verificationCode;
  $('#manualCloudflareVerificationCode').textContent = result.verificationCode;
  return result.verificationCode;
}

async function fetchManualCloudflareAccessSecrets() {
  const account = state.manualCloudflareAccount;
  if (!account) return { globalApiKey: '', apiToken: '' };
  return api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/access-secrets/reveal`, { method: 'POST', body: '{}' });
}

async function revealManualCloudflareAccessSecrets() {
  const result = await fetchManualCloudflareAccessSecrets();
  setManualCloudflareAccessSecretsVisible(result);
  return result;
}

function openManualCloudflareBatchModal() {
  const count = state.selectedCloudflareMailboxIds.size;
  if (!count) return;
  $('#manualCloudflareSelectionSummary').textContent = `${count} email${count === 1 ? '' : 's'} selected`;
  $('#manualCloudflareCreateError').hidden = true;
  $('#manualCloudflareBatchModal').hidden = false;
  setTimeout(() => $('#submitManualCloudflareBatch').focus(), 0);
}

function closeManualCloudflareBatchModal() {
  if ($('#manualCloudflareBatchForm').getAttribute('aria-busy') === 'true') return;
  $('#manualCloudflareBatchModal').hidden = true;
}

async function downloadManualCloudflareSensitiveExport() {
  if (!confirm('This export contains plaintext Cloudflare passwords, Global API Keys and API Tokens. Store it securely and delete it when finished. Continue?')) return;
  const headers = { 'content-type': 'application/json' };
  if (state.csrf) headers['x-atomicmail-csrf'] = state.csrf;
  const response = await fetch('/api/cloudflare/accounts/export-sensitive', {
    method: 'POST', headers, credentials: 'same-origin',
    body: JSON.stringify({
      confirm: 'EXPORT CLOUDFLARE',
      search: state.manualCloudflareSearch,
      status: state.manualCloudflareStatus,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Cloudflare export failed (${response.status})`);
  }
  const href = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'cloudflare-accounts-sensitive.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function openCloudflareJobModal() {
  const count = state.selectedCloudflareMailboxIds.size;
  if (!count) return;
  $('#cloudflareCreateTitle').textContent = 'Cloudflare Account Batch';
  $('#cloudflareSelectionSummary').textContent = `${count} email${count === 1 ? '' : 's'} selected`;
  $('#cloudflarePasswordMode').value = 'manual';
  $('#cloudflareGeneratePassword').checked = false;
  $('#cloudflareManualPassword').value = '';
  $('#cloudflareManualPassword').disabled = false;
  $('#cloudflareManualPassword').required = true;
  $('#cloudflareCreateError').hidden = true;
  $('#cloudflareJobModal').hidden = false;
  setTimeout(() => $('#cloudflareManualPassword').focus(), 0);
}

function closeCloudflareJobModal() {
  if ($('#cloudflareJobForm').getAttribute('aria-busy') === 'true') return;
  $('#cloudflareJobModal').hidden = true;
  $('#cloudflareManualPassword').value = '';
  $('#cloudflareGeneratePassword').checked = false;
  $('#cloudflareManualPassword').disabled = false;
  $('#cloudflareManualPassword').type = 'password';
  $('#toggleCloudflareManualPassword').textContent = 'Show';
}

function cloudflareProgress(job) {
  const requested = Math.max(1, Number(job?.requested_count || 0));
  const counts = itemStatusCounts(job?.items || []);
  const done = Number(job?.verified_count || 0) + Number(job?.failed_count || 0) + Number(counts.cancelled || 0);
  return Math.min(100, Math.max(0, Math.round(done / requested * 100)));
}

function renderCloudflareStatus(status) {
  state.cloudflareStatus = status;
  state.activeCloudflareJob = status.activeJob || null;
  $('#cloudflareTotal').textContent = status.totalAccounts ?? 0;
  $('#cloudflareVerified').textContent = status.verifiedAccounts ?? 0;
  $('#cloudflareNeedsAction').textContent = status.needsActionAccounts ?? 0;
  $('#cloudflareRunnerShort').textContent = status.runner?.online ? 'Connected' : 'Disconnected';
  $('#cloudflareRunnerHeartbeat').textContent = status.runner?.online ? '' : 'Reconnect required';
  $('#pairCloudflareRunner').hidden = Boolean(status.runner?.online);
  $('#revokeCloudflareRunner').disabled = !status.runner?.online;
  $('#cloudflareRunnerStatus').innerHTML = status.runner?.online
    ? `<div class="runner-status-line"><span class="status-dot ok"></span><strong>${escapeHtml(status.runner.name || 'Operator browser')}</strong>${status.runner.busy ? '<span class="pill running">busy</span>' : '<span class="pill active">ready</span>'}</div><small>Runner ${escapeHtml(shortId(status.runner.runnerId))}${status.runner.activeItemId ? ` · item ${escapeHtml(shortId(status.runner.activeItemId))}` : ''}</small>`
    : '<div class="runner-status-line"><span class="status-dot off"></span><strong>No visible browser runner connected</strong></div><small>Create a pairing code, then run the displayed command on the operator workstation.</small>';
  $('#cloudflareRunnerStatus').innerHTML = status.runner?.online
    ? `<div class="runner-status-line"><span class="status-dot ok"></span><strong>Browser Runner</strong><span>Connected${status.runner.busy ? ' · working' : ''}</span></div>`
    : '<div class="runner-status-line"><span class="status-dot off"></span><strong>Browser Runner disconnected</strong></div>';
  if (status.runner?.online) $('#cloudflarePairingPanel').hidden = true;
  const circuit = status.circuit || { open: false };
  $('#cloudflareCircuitBanner').hidden = !circuit.open;
  $('#cloudflareCircuitBanner').textContent = circuit.open
    ? `Cloudflare workflow stopped: ${circuit.reason || 'provider cooldown'}${circuit.until ? ` · until ${formatDate(circuit.until)}` : ''}`
    : '';
  $('#resetCloudflareCircuit').hidden = !circuit.open;
}

function cloudflareTimelineState(item) {
  const accepted = Boolean(item?.submitted_at && item?.signup_acceptance_evidence);
  const received = Boolean(item?.verification_received_at);
  const verified = item?.status === 'verified';
  const started = Number(item?.attempts || 0) > 0 || Boolean(item?.attempt_started_at);
  const opened = started && !['queued', 'preparing', 'opening_signup'].includes(item?.phase);
  const needsAction = item?.status === 'needs_action';
  return [
    { label: 'Preparing account', done: started, current: !started },
    { label: 'Opening Cloudflare', done: opened, current: started && !opened },
    { label: 'Signup submitted', done: accepted, current: opened && !accepted },
    { label: 'Waiting for email', done: received, current: accepted && !received },
    { label: 'Email received', done: received, current: false },
    { label: 'Verifying account', done: verified, current: received && !verified },
    { label: 'Verified', done: verified, current: false },
  ].map((step) => ({ ...step, current: step.current && !needsAction }));
}

function renderCloudflareTimeline(job) {
  const items = job.items || [];
  const current = items.find((item) => item.status === 'needs_action')
    || items.find((item) => !['verified', 'failed', 'cancelled'].includes(item.status))
    || items.at(-1);
  const summary = $('#cloudflareCurrentSummary');
  const action = $('#cloudflareActionRequired');
  if (!current) {
    summary.hidden = true;
    action.hidden = true;
    $('#cloudflareTimeline').replaceChildren();
    return;
  }
  summary.hidden = false;
  const lastCheckSeconds = secondsBetween(current.last_inbox_check_at, Date.now());
  const nextCheckSeconds = secondsBetween(Date.now(), current.next_attempt_at);
  const remaining = Math.max(0, Number(job.requested_count || 0) - Number(job.verified_count || 0));
  const average = Number(job.timing?.average_verified_seconds || 0);
  summary.innerHTML = `<strong>Current: <span class="mono">${escapeHtml(current.email)}</span></strong>
    ${current.status === 'waiting_for_verification'
      ? `<span>Last inbox check: ${lastCheckSeconds == null ? 'not yet' : `${escapeHtml(formatDuration(lastCheckSeconds))} ago`} · Next check: ${nextCheckSeconds == null ? 'soon' : escapeHtml(formatDuration(nextCheckSeconds))}</span>`
      : `<span>${escapeHtml(current.phase_message || phaseLabel(current.phase))}</span>`}
    <span>Estimated remaining: ${average > 0 ? escapeHtml(formatDuration(average * remaining)) : 'estimating after the first verified account'}</span>`;
  $('#cloudflareTimeline').innerHTML = cloudflareTimelineState(current).map((step, index) => {
    const css = step.done ? 'done' : step.current ? 'current' : 'pending';
    const marker = step.done ? '&#10003;' : step.current ? '&#8987;' : '&mdash;';
    return `<li class="${css}"><span>${index + 1}. ${escapeHtml(step.label)}</span><strong>${marker}</strong></li>`;
  }).join('');

  if (current.status !== 'needs_action') {
    action.hidden = true;
    action.replaceChildren();
    return;
  }
  const canFocus = Boolean(current.leased_runner_id);
  const verificationTimeout = current.last_error_code === 'verification_email_timeout';
  action.hidden = false;
  action.innerHTML = `<div><strong>Action required</strong><span>${escapeHtml(current.phase_message || 'Open Cloudflare to continue')}</span></div>
    <div class="button-row">
      ${verificationTimeout ? `<button class="btn ghost small-btn" data-cloudflare-check-inbox="${escapeHtml(current.mailbox_id)}" data-cloudflare-check-email="${escapeHtml(current.email)}">Check inbox</button><button class="btn ghost small-btn" data-cloudflare-item-retry="${escapeHtml(current.id)}">Retry verification</button>` : ''}
      <button class="btn primary small-btn" data-cloudflare-item-open="${escapeHtml(current.id)}" data-cloudflare-open-mode="${canFocus ? 'focus' : 'reconcile'}">Open browser</button>
    </div>`;
}

function renderCloudflareJobs(jobs) {
  $('#cloudflareJobsEmpty').hidden = jobs.length > 0;
  $('#cloudflareJobsBody').innerHTML = jobs.map((job) => {
    const done = Number(job.verified_count || 0) + Number(job.failed_count || 0);
    return `<tr data-cloudflare-job-id="${escapeHtml(job.id)}">
      <td>${escapeHtml(formatDate(job.created_at))}</td><td class="mono">${escapeHtml(shortId(job.id))}</td>
      <td>${statusPill(job.status)}</td><td>${done}/${escapeHtml(job.requested_count)}</td>
      <td>${escapeHtml(job.password_mode)}</td></tr>`;
  }).join('');
}

function renderCloudflareAccounts(accounts) {
  $('#cloudflareAccountsEmpty').hidden = accounts.length > 0;
  $('#cloudflareAccountsBody').innerHTML = accounts.map((account) => `<tr>
    <td class="mono">${escapeHtml(account.email)}</td><td>${statusPill(account.status)}</td>
    <td>${escapeHtml(formatDate(account.verified_at))}</td><td class="mono">${escapeHtml(shortId(account.job_id))}</td>
  </tr>`).join('');
}

async function loadCloudflareJobDetail(id, { background = false } = {}) {
  const jobId = String(id || '');
  if (!jobId) return;
  if (state.selectedCloudflareJobId !== jobId) hideCloudflarePassword();
  state.selectedCloudflareJobId = jobId;
  const job = await api(`/api/cloudflare/jobs/${encodeURIComponent(jobId)}`);
  if (state.selectedCloudflareJobId !== jobId) return;
  state.selectedCloudflareJob = job;
  $('#cloudflareJobDetail').hidden = false;
  $('#cloudflareJobTitle').textContent = 'Cloudflare Account Batch';
  const percent = cloudflareProgress(job);
  $('#cloudflareJobMeta').textContent = `${job.requested_count} email${job.requested_count === 1 ? '' : 's'} · started ${formatDate(job.created_at)}`;
  $('#cloudflareJobProgress').style.width = `${percent}%`;
  $('#cloudflareJobNumbers').textContent = `${job.verified_count} / ${job.requested_count} Verified`;
  renderCloudflareTimeline(job);
  const actions = [];
  if (job.status === 'running') actions.push('<button class="btn ghost small-btn" data-cloudflare-job-action="pause">Pause</button>');
  if (job.status === 'paused') actions.push('<button class="btn primary small-btn" data-cloudflare-job-action="resume">Resume</button>');
  if (['running', 'paused', 'needs_action'].includes(job.status)) actions.push('<button class="btn danger-btn small-btn" data-cloudflare-job-action="cancel">Cancel</button>');
  $('#cloudflareJobActions').innerHTML = actions.join('');
  $('#cloudflareItemsBody').innerHTML = (job.items || []).map((item) => {
    const uncertainSignup = [
      'interrupted_submit_unknown', 'runner_disconnected_uncertain', 'paused_submit_unknown', 'submit_timeout',
      'submission_state_unknown', 'account_exists', 'invalid_credentials', 'reconcile_timeout',
      'verification_link_expired', 'challenge', 'challenge_timeout', 'rate_limited', 'policy_blocked',
      'signup_acceptance_unconfirmed',
    ]
      .includes(item.last_error_code);
    const canRetry = ['needs_action', 'failed', 'retry_waiting'].includes(item.status) && !item.leased_runner_id && !uncertainSignup;
    const canReconcile = ['needs_action', 'failed', 'retry_waiting'].includes(item.status) && !item.leased_runner_id;
    const canFocus = Boolean(item.leased_runner_id) && ['creating', 'awaiting_submit', 'verifying', 'needs_action'].includes(item.status);
    return `<tr><td>${escapeHtml(item.position)}</td><td class="mono">${escapeHtml(item.email)}</td>
      <td>${statusPill(item.status)}</td><td><span class="phase-label">${escapeHtml(phaseLabel(item.phase))}</span><small class="phase-message">${escapeHtml(item.phase_message || '')}</small></td>
      <td class="mono" data-elapsed-start="${escapeHtml(item.attempt_started_at || '')}" data-elapsed-end="${escapeHtml(item.finished_at || '')}">${item.attempt_started_at ? escapeHtml(formatDuration(secondsBetween(item.attempt_started_at, item.finished_at || Date.now()))) : '—'}</td>
      <td>${escapeHtml(item.attempts)}</td><td><div class="cloudflare-item-actions">${canFocus ? `<button class="btn ghost small-btn" data-cloudflare-item-focus="${escapeHtml(item.id)}">Open browser</button>` : ''}${canRetry ? `<button class="btn ghost small-btn" data-cloudflare-item-retry="${escapeHtml(item.id)}">Retry</button>` : ''}${canReconcile ? `<button class="btn ghost small-btn" data-cloudflare-item-reconcile="${escapeHtml(item.id)}">Open Cloudflare</button>` : ''}${item.has_artifact ? `<button class="btn ghost small-btn" data-cloudflare-artifact="${escapeHtml(item.id)}">View failure</button>` : ''}</div></td>
      <td class="truncate" title="${escapeHtml(item.last_error || '')}">${escapeHtml(item.last_error || '—')}</td></tr>`;
  }).join('');
  if (!background) refreshLiveTimers();
}

async function loadCloudflare({ background = false } = {}) {
  const request = beginLatestRequest('cloudflare', { skipIfBusy: background });
  if (!request) return;
  const endActivity = background ? () => {} : beginActivity('cloudflare-load', 'Loading Cloudflare workflow');
  if (!background) setButtonBusy($('#refreshCloudflare'), true, 'Refreshing');
  $('#cloudflareJobsPanel').setAttribute('aria-busy', 'true');
  try {
    const [status, jobs, accounts] = await Promise.all([
      api('/api/cloudflare/status', { signal: request.signal }),
      api('/api/cloudflare/jobs?limit=75', { signal: request.signal }),
      api('/api/cloudflare/accounts?limit=100&offset=0', { signal: request.signal }),
    ]);
    if (!request.isCurrent()) return;
    renderCloudflareStatus(status);
    renderCloudflareJobs(jobs.jobs || []);
    renderCloudflareAccounts(accounts.items || []);
    const jobId = state.selectedCloudflareJobId || status.activeJob?.id || jobs.jobs?.[0]?.id;
    if (jobId) await loadCloudflareJobDetail(jobId, { background });
    else $('#cloudflareJobDetail').hidden = true;
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      $('#cloudflareJobsPanel').removeAttribute('aria-busy');
      if (!background) setButtonBusy($('#refreshCloudflare'), false);
    }
    endActivity();
  }
}

async function runCloudflareJobAction(action, button) {
  if (!state.selectedCloudflareJobId) return;
  if (action === 'cancel' && !confirm('Cancel this Cloudflare job? An already submitted external account may still exist.')) return;
  await withBusyButton(button, `${action}…`, `Requesting Cloudflare job ${action}`, async () => {
    await api(`/api/cloudflare/jobs/${encodeURIComponent(state.selectedCloudflareJobId)}/${action}`, { method: 'POST', body: '{}' });
    showToast(`Cloudflare job ${action} requested`);
    await Promise.all([loadCloudflare(), loadDashboard()]);
  });
}

function hideCloudflarePassword() {
  state.cloudflareJobPassword = null;
  if (!$('#cloudflarePasswordValue')) return;
  $('#cloudflarePasswordValue').textContent = '************';
  $('#copyCloudflarePassword').disabled = true;
  $('#hideCloudflarePassword').hidden = true;
  $('#revealCloudflarePassword').hidden = false;
}

async function revealCloudflarePassword(button) {
  if (!state.selectedCloudflareJobId) return;
  await withBusyButton(button, 'Decrypting', 'Decrypting Cloudflare job password', async () => {
    const result = await api(`/api/cloudflare/jobs/${encodeURIComponent(state.selectedCloudflareJobId)}/password`, { method: 'POST', body: '{}' });
    state.cloudflareJobPassword = result.password;
    $('#cloudflarePasswordValue').textContent = result.password;
    $('#copyCloudflarePassword').disabled = false;
    $('#hideCloudflarePassword').hidden = false;
    $('#revealCloudflarePassword').hidden = true;
  });
}

async function downloadCloudflareSensitiveExport() {
  if (!confirm('This export contains plaintext Cloudflare passwords, Global API Keys and API Tokens. Store it securely and delete it when finished. Continue?')) return;
  const headers = { 'content-type': 'application/json' };
  if (state.csrf) headers['x-atomicmail-csrf'] = state.csrf;
  const response = await fetch('/api/cloudflare/accounts/export-sensitive', {
    method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ confirm: 'EXPORT CLOUDFLARE' }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Cloudflare export failed (${response.status})`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'cloudflare-accounts.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

async function viewCloudflareArtifact(itemId) {
  if (!confirm('Failure screenshots may contain account metadata. Decrypt and view this screenshot?')) return;
  const headers = { 'content-type': 'application/json' };
  if (state.csrf) headers['x-atomicmail-csrf'] = state.csrf;
  const response = await fetch(`/api/cloudflare/items/${encodeURIComponent(itemId)}/artifact`, {
    method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ confirm: 'VIEW' }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Could not open Cloudflare failure screenshot');
  }
  const href = URL.createObjectURL(await response.blob());
  window.open(href, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

function setMailError(message = '', detail = '', { temporary = false } = {}) {
  const box = $('#mailError');
  box.classList.toggle('danger', Boolean(message) && !temporary);
  box.classList.toggle('warning', Boolean(message) && temporary);
  box.replaceChildren();
  if (message) {
    const summary = document.createElement('strong');
    summary.textContent = message;
    box.append(summary);
    if (detail && detail !== message) {
      const details = document.createElement('details');
      const label = document.createElement('summary');
      label.textContent = 'Provider details';
      const content = document.createElement('p');
      content.textContent = detail;
      details.append(label, content);
      box.append(details);
    }
  }
  box.hidden = !message;
}

function renderInbox(items) {
  state.inboxItems = items || [];
  $('#inboxEmpty').hidden = state.inboxItems.length > 0;
  const first = state.mailTotal ? state.mailPosition + 1 : 0;
  const last = Math.min(state.mailTotal, state.mailPosition + state.inboxItems.length);
  $('#inboxCountText').textContent = `${first}–${last} of ${state.mailTotal} message${state.mailTotal === 1 ? '' : 's'}`;
  $('#inboxList').innerHTML = state.inboxItems.map((item) => {
    const active = state.selectedMessageId === item.id ? ' active' : '';
    const loading = state.messageLoadingId === item.id ? ' loading' : '';
    const unread = item.unread ? ' unread' : '';
    return `<button class="mail-row${active}${loading}${unread}" type="button" data-message-id="${escapeHtml(item.id)}"${active ? ' aria-current="true"' : ''}${loading ? ' aria-busy="true"' : ''}>
      <span class="mail-row-top"><span class="mail-from">${item.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}${escapeHtml(state.mailFolder === 'sent' ? (item.toText || 'Unknown recipient') : (item.fromText || 'Unknown sender'))}</span><span class="mail-date">${escapeHtml(formatDate(item.receivedAt || item.sentAt))}</span></span>
      <span class="mail-subject">${escapeHtml(item.subject || '(no subject)')}${item.hasAttachment ? ' · 📎' : ''}</span>
      <span class="mail-preview">${escapeHtml(item.preview || '')}</span>
    </button>`;
  }).join('');
  const page = Math.floor(state.mailPosition / state.mailLimit) + 1;
  const pages = Math.max(1, Math.ceil(state.mailTotal / state.mailLimit));
  $('#mailPageText').textContent = `Page ${page} of ${pages}`;
  $('#mailPrev').disabled = state.mailPosition <= 0;
  $('#mailNext').disabled = state.mailPosition + state.mailLimit >= state.mailTotal;
}

async function loadInbox({ background = false, statusText = 'Syncing mailbox' } = {}) {
  if (!state.selectedMailbox) return;
  const request = beginLatestRequest('inbox', { skipIfBusy: background });
  if (!request) return;
  const mailboxId = state.selectedMailbox.id;
  const folder = state.mailFolder;
  state.mailRefreshBusy = true;
  const loading = $('#inboxLoading');
  loading.hidden = false;
  $('#inboxLoadingText').textContent = background ? 'Checking for new mail…' : `${statusText}…`;
  $('#mailListPanel').setAttribute('aria-busy', 'true');
  $('#inboxList').classList.add('is-refreshing');
  setMailError('');
  setButtonBusy($('#refreshInbox'), true, 'Syncing');
  const endActivity = background ? () => {} : beginActivity('mail-sync', statusText);
  try {
    const params = new URLSearchParams({
      folder,
      limit: state.mailLimit,
      position: state.mailPosition,
      field: state.mailSearchField,
    });
    if (state.mailSearch) params.set('search', state.mailSearch);
    const data = await api(`/api/mailboxes/${encodeURIComponent(mailboxId)}/mail?${params}`, { signal: request.signal });
    if (!request.isCurrent() || state.selectedMailbox?.id !== mailboxId || state.mailFolder !== folder) return;
    state.selectedMailbox = data.mailbox || state.selectedMailbox;
    state.mailTotal = Number(data.total || 0);
    $('#webmailAddress').textContent = state.selectedMailbox.email;
    $('#webmailSyncText').textContent = `${state.mailFolder === 'sent' ? 'Sent' : 'Inbox'} synced ${formatDate(data.syncedAt || new Date().toISOString())}`;
    $('#inboxUnreadBadge').textContent = state.mailFolder === 'inbox' && Number(data.unreadTotal || 0) > 0 ? String(data.unreadTotal) : '';
    renderInbox(data.items || []);
  } catch (error) {
    if (!isAbortError(error) && request.isCurrent()) {
      if (error.body?.code === 'mail_rate_limited') {
        setMailError(
          'Atomic Mail is temporarily rate limiting requests. Retrying automatically…',
          '',
          { temporary: true },
        );
        clearTimeout(state.mailRateRetryTimer);
        const retryMs = Math.max(2000, Number(error.body.retryAfterMs || 5000));
        const expectedMailboxId = mailboxId;
        state.mailRateRetryTimer = setTimeout(() => {
          if (state.currentView === 'webmail' && state.selectedMailbox?.id === expectedMailboxId) {
            loadInbox({ background: true, statusText: 'Retrying inbox sync' }).catch(() => {});
          }
        }, retryMs);
      } else {
        setMailError(error.message, error.body?.detail || '');
      }
    }
  } finally {
    if (request.isCurrent()) {
      request.finish();
      loading.hidden = true;
      $('#mailListPanel').removeAttribute('aria-busy');
      $('#inboxList').classList.remove('is-refreshing');
      setButtonBusy($('#refreshInbox'), false);
      state.mailRefreshBusy = false;
    }
    endActivity();
  }
}

async function openMailbox(id, email) {
  state.selectedMailbox = { id, email };
  state.selectedMessage = null;
  state.selectedMessageId = null;
  state.messageLoadingId = null;
  cancelRequest('message');
  state.mailFolder = 'inbox';
  state.mailPosition = 0;
  state.mailSearch = '';
  $('#mailSearch').value = '';
  selectMailFolder('inbox', false);
  $('#webmailAddress').textContent = email;
  $('#webmailSyncText').textContent = 'Loading on-demand inbox…';
  $('#messageEmpty').hidden = false;
  $('#messageDetail').hidden = true;
  $('#messageLoading').hidden = true;
  renderInbox([]);
  switchView('webmail');
  await loadInbox({ statusText: 'Opening inbox' });
}

function selectMailFolder(folder, refresh = true) {
  if (!['inbox', 'sent'].includes(folder)) return;
  state.mailFolder = folder;
  state.mailPosition = 0;
  state.selectedMessage = null;
  state.selectedMessageId = null;
  state.messageLoadingId = null;
  cancelRequest('message');
  $('#messageLoading').hidden = true;
  $('#messagePanel').removeAttribute('aria-busy');
  $('#messageEmpty').textContent = 'Select an email to read it.';
  $('#messageEmpty').hidden = false;
  $('#messageDetail').hidden = true;
  $('#mailFolderTitle').textContent = folder === 'sent' ? 'Sent' : 'Inbox';
  $('#inboxEmpty').textContent = folder === 'sent' ? 'No sent messages yet.' : 'No messages in this inbox yet.';
  $$('[data-mail-folder]').forEach((button) => button.classList.toggle('active', button.dataset.mailFolder === folder));
  $('#archiveMail').hidden = folder !== 'inbox';
  if (refresh) loadInbox({ statusText: `Opening ${folder === 'sent' ? 'Sent' : 'Inbox'}` }).catch(handleError);
}

function stopWebmailAutoRefresh() {
  clearInterval(state.mailAutoTimer);
  clearTimeout(state.mailRateRetryTimer);
  state.mailAutoTimer = null;
  state.mailRateRetryTimer = null;
}

function startWebmailAutoRefresh() {
  stopWebmailAutoRefresh();
  if (!state.selectedMailbox || state.currentView !== 'webmail') return;
  const seconds = Math.max(30, Number(state.dashboard?.mail?.autoRefreshSeconds || 45));
  state.mailAutoTimer = setInterval(() => {
    if (state.currentView === 'webmail' && !document.hidden) loadInbox({ background: true }).catch(() => {});
  }, seconds * 1000);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderCopyItems(target, title, values) {
  const box = $(target);
  const safeValues = Array.isArray(values) ? values : [];
  box.hidden = safeValues.length === 0;
  box.innerHTML = safeValues.length
    ? `<strong>${escapeHtml(title)}</strong><div class="helper-items">${safeValues.map((value) => `<span class="helper-item"><code>${escapeHtml(value)}</code><button class="copy-btn" type="button" data-copy-value="${escapeHtml(value)}">Copy</button></span>`).join('')}</div>`
    : '';
}

function renderVerificationLinks(links) {
  const safeLinks = (Array.isArray(links) ? links : []).map(safeHttpUrl).filter(Boolean);
  const box = $('#verificationLinks');
  box.hidden = safeLinks.length === 0;
  box.innerHTML = safeLinks.length
    ? `<strong>Verification links</strong><div class="helper-items">${safeLinks.map((link) => `<span class="helper-item"><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open</a><button class="copy-btn" type="button" data-copy-value="${escapeHtml(link)}">Copy</button></span>`).join('')}</div>`
    : '';
}

function renderAttachments(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const box = $('#messageAttachments');
  box.hidden = items.length === 0;
  if (!items.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<strong>Attachments</strong><div class="helper-items">${items.map((item) => {
    const href = `/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/messages/${encodeURIComponent(state.selectedMessage.id)}/attachments/${encodeURIComponent(item.id)}`;
    return `<span class="helper-item attachment-row"><span class="attachment-meta"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.type)} · ${escapeHtml(formatBytes(item.size))}</small></span><a class="btn ghost small-btn" href="${href}" download>Download</a></span>`;
  }).join('')}</div>`;
}

function renderMessage(message) {
  state.selectedMessage = message;
  state.selectedMessageId = message.id;
  $('#messageSubject').textContent = message.subject || '(no subject)';
  const rows = [
    ['From', message.fromText || 'Unknown sender'],
    ['To', message.toText || state.selectedMailbox?.email || '—'],
  ];
  if (message.ccText) rows.push(['Cc', message.ccText]);
  rows.push(['Received', formatDate(message.receivedAt || message.sentAt)]);
  $('#messageMeta').innerHTML = rows.map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`).join('');
  $('#messageBody').textContent = message.body || '(empty message)';
  $('#toggleReadMail').textContent = message.unread ? 'Mark read' : 'Mark unread';
  $('#toggleReadMail').dataset.mailAction = message.unread ? 'mark_read' : 'mark_unread';
  $('#messageTruncated').hidden = !message.bodyTruncated;
  renderCopyItems('#verificationCodes', 'Detected verification codes', message.verificationCodes);
  renderVerificationLinks(message.verificationLinks);
  renderAttachments(message.attachments);
  const links = (Array.isArray(message.links) ? message.links : []).map(safeHttpUrl).filter(Boolean);
  const linkBox = $('#messageLinks');
  linkBox.hidden = links.length === 0;
  linkBox.innerHTML = links.length
    ? `<strong>Links in this message</strong>${links.map((link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a>`).join('')}`
    : '';
  $('#messageEmpty').hidden = true;
  $('#messageDetail').hidden = false;
  renderInbox(state.inboxItems);
}

async function runMailAction(action) {
  if (!state.selectedMailbox || !state.selectedMessage || state.mailActionBusy) return;
  if (action === 'trash' && !confirm('Move this message to Trash? It will not be permanently deleted.')) return;
  const mailboxId = state.selectedMailbox.id;
  const messageId = state.selectedMessage.id;
  const operation = action === 'trash' ? 'Moving message to Trash' : `${action.replaceAll('_', ' ')} message`;
  const endActivity = beginActivity('mail-action', operation);
  state.mailActionBusy = true;
  $('#messagePanel').setAttribute('aria-busy', 'true');
  $('#inboxList').setAttribute('aria-busy', 'true');
  $('#messageOperationText').textContent = `${operation}…`;
  $('#messageOperation').hidden = false;
  $$('.message-actions button').forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    showToast(action === 'trash' ? 'Message moved to Trash' : `Message updated: ${action.replaceAll('_', ' ')}`);
    if (state.selectedMessageId === messageId && ['archive', 'trash'].includes(action)) {
      state.selectedMessage = null;
      state.selectedMessageId = null;
      $('#messageDetail').hidden = true;
      $('#messageEmpty').hidden = false;
    } else if (state.selectedMessage?.id === messageId) {
      state.selectedMessage.unread = action === 'mark_unread';
    }
    await loadInbox({ statusText: 'Updating folder' });
    if (state.selectedMessage?.id === messageId) renderMessage(state.selectedMessage);
  } finally {
    state.mailActionBusy = false;
    $('#messagePanel').removeAttribute('aria-busy');
    $('#inboxList').removeAttribute('aria-busy');
    $('#messageOperation').hidden = true;
    $$('.message-actions button').forEach((button) => { button.disabled = false; });
    endActivity();
  }
}

async function loadMessage(messageId) {
  if (!state.selectedMailbox) return;
  const request = beginLatestRequest('message');
  const mailboxId = state.selectedMailbox.id;
  state.selectedMessageId = messageId;
  state.messageLoadingId = messageId;
  state.selectedMessage = null;
  renderInbox(state.inboxItems);
  setMailError('');
  $('#messageEmpty').hidden = true;
  $('#messageDetail').hidden = true;
  $('#messageLoading').hidden = false;
  $('#messageLoadingText').textContent = 'Loading the selected message…';
  $('#messagePanel').setAttribute('aria-busy', 'true');
  const endActivity = beginActivity('message-read', 'Loading message');
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`, { signal: request.signal });
    if (!request.isCurrent() || state.selectedMailbox?.id !== mailboxId || state.selectedMessageId !== messageId) return;
    renderMessage(data.message);
  } catch (error) {
    if (!isAbortError(error) && request.isCurrent()) {
      setMailError(error.message, error.body?.detail || '');
      $('#messageEmpty').textContent = 'Could not load this message.';
      $('#messageEmpty').hidden = false;
    }
  } finally {
    if (request.isCurrent()) {
      request.finish();
      state.messageLoadingId = null;
      $('#messageLoading').hidden = true;
      $('#messagePanel').removeAttribute('aria-busy');
      renderInbox(state.inboxItems);
    }
    endActivity();
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error(`Could not read ${file.name}`)), { once: true });
    reader.addEventListener('abort', () => reject(new Error(`Reading ${file.name} was cancelled`)), { once: true });
    reader.readAsDataURL(file);
  });
}

async function serializeComposeAttachments(onProgress = () => {}) {
  const files = [...($('#composeAttachments').files || [])];
  const limits = state.dashboard?.mail || {};
  const maxCount = Number(limits.maxAttachmentCount || 5);
  const maxEach = Number(limits.maxAttachmentBytes || 5242880);
  const maxTotal = Number(limits.maxTotalAttachmentBytes || 10485760);
  if (files.length > maxCount) throw new Error(`Choose at most ${maxCount} attachments`);
  let total = 0;
  for (const file of files) {
    if (file.size > maxEach) throw new Error(`${file.name} exceeds the ${formatBytes(maxEach)} per-file limit`);
    total += file.size;
  }
  if (total > maxTotal) throw new Error(`Attachments exceed the ${formatBytes(maxTotal)} total limit`);
  const attachments = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    onProgress(index + 1, files.length, file.name);
    attachments.push({
      name: file.name,
      type: file.type || 'application/octet-stream',
      data: await fileToBase64(file),
    });
  }
  return attachments;
}

function setComposeProgress(stage, detail = '') {
  state.composeStage = stage;
  state.composeDetail = detail;
  renderComposeProgress();
}

function renderComposeProgress() {
  const box = $('#composeProgress');
  if (!box || !state.composeBusy) return;
  const elapsed = Math.max(0, (Date.now() - state.composeStartedAt) / 1000);
  $('#composeProgressTitle').textContent = state.composeStage || 'Working…';
  $('#composeProgressDetail').textContent = `${state.composeDetail}${state.composeDetail ? ' · ' : ''}Elapsed ${formatDuration(elapsed)}`;
  const buttonLabel = $('#sendCompose').querySelector('span:last-child');
  if (buttonLabel) buttonLabel.textContent = `${state.composeStage.startsWith('Preparing') ? 'Preparing' : 'Sending'} · ${formatDuration(elapsed)}`;
}

function setComposeBusy(busy) {
  state.composeBusy = busy;
  $('#composeForm').setAttribute('aria-busy', busy ? 'true' : 'false');
  ['#composeTo', '#composeSubject', '#composeBody', '#composeAttachments', '#closeCompose', '#cancelCompose'].forEach((selector) => {
    $(selector).disabled = busy;
  });
  setButtonBusy($('#sendCompose'), busy, 'Sending · 0s');
  $('#composeProgress').hidden = !busy;
  if (!busy) {
    state.composeStartedAt = null;
    state.composeStage = '';
    state.composeDetail = '';
  }
}

function openCompose(mode = 'new') {
  if (!state.selectedMailbox) return;
  state.composeReturnFocus = document.activeElement;
  state.composeMode = mode;
  const reply = mode === 'reply';
  $('#composeTitle').textContent = reply ? 'Reply' : 'New message';
  $('#composeFrom').textContent = `From ${state.selectedMailbox.email}`;
  $('#composeToRow').hidden = reply;
  $('#composeSubjectRow').hidden = reply;
  $('#composeTo').required = !reply;
  $('#composeTo').value = reply ? (state.selectedMessage?.from?.[0]?.email || '') : '';
  $('#composeSubject').value = reply ? `Re: ${state.selectedMessage?.subject || ''}` : '';
  $('#composeBody').value = '';
  $('#composeAttachments').value = '';
  const limits = state.dashboard?.mail || {};
  $('#attachmentLimits').textContent = `Up to ${limits.maxAttachmentCount || 5} files, ${formatBytes(limits.maxAttachmentBytes || 5242880)} each, ${formatBytes(limits.maxTotalAttachmentBytes || 10485760)} total.`;
  $('#composeError').hidden = true;
  $('#composeModal').hidden = false;
  setTimeout(() => (reply ? $('#composeBody') : $('#composeTo')).focus(), 0);
}

function closeCompose(force = false) {
  if (state.composeBusy && !force) return;
  $('#composeModal').hidden = true;
  $('#composeError').hidden = true;
  $('#composeAttachments').value = '';
  if (state.composeReturnFocus?.isConnected) state.composeReturnFocus.focus();
  state.composeReturnFocus = null;
}

async function submitCompose() {
  if (!state.selectedMailbox || state.composeBusy) return;
  const errorBox = $('#composeError');
  errorBox.hidden = true;
  state.composeStartedAt = Date.now();
  setComposeBusy(true);
  setComposeProgress('Preparing message', 'Checking size and attachments');
  const endActivity = beginActivity('compose', state.composeMode === 'reply' ? 'Sending reply' : 'Sending email', { immediate: true });
  let sent = false;
  try {
    const attachments = await serializeComposeAttachments((position, count, name) => {
      setComposeProgress(`Preparing attachment ${position}/${count}`, name);
    });
    const timeoutSeconds = Math.ceil(Number(state.dashboard?.mail?.commandTimeoutMs || 60000) / 1000);
    setComposeProgress(state.composeMode === 'reply' ? 'Sending reply' : 'Sending email', `Keep this window open while Atomic Mail processes the request (timeout guard ${timeoutSeconds}s)`);
    if (state.composeMode === 'reply') {
      if (!state.selectedMessage?.id) throw new Error('No message selected for reply');
      await api(`/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/messages/${encodeURIComponent(state.selectedMessage.id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: $('#composeBody').value, attachments }),
      });
      showToast('Reply sent');
    } else {
      await api(`/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({ to: $('#composeTo').value, subject: $('#composeSubject').value, body: $('#composeBody').value, attachments }),
      });
      showToast('Email sent');
    }
    sent = true;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    endActivity();
    setComposeBusy(false);
  }
  if (sent) {
    closeCompose(true);
    if (state.mailFolder === 'sent') await loadInbox({ statusText: 'Refreshing Sent' });
  }
}

function hideJobPassword() {
  state.jobDestinationPassword = null;
  const value = $('#jobPasswordValue');
  if (!value) return;
  value.textContent = '************';
  $('#copyJobPassword').disabled = true;
  $('#hideJobPassword').hidden = true;
  $('#revealJobPassword').hidden = false;
}

async function revealJobPassword(sourceButton) {
  if (!state.selectedJobId) return;
  await withBusyButton(sourceButton, 'Decrypting', 'Decrypting destination password', async () => {
    const result = await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/destination-password`, { method: 'POST', body: '{}' });
    state.jobDestinationPassword = result.password;
    $('#jobPasswordValue').textContent = result.password;
    $('#copyJobPassword').disabled = false;
    $('#hideJobPassword').hidden = false;
    $('#revealJobPassword').hidden = true;
  });
}

async function copyText(value, successMessage = 'Copied') {
  try {
    await navigator.clipboard.writeText(String(value));
    showToast(successMessage);
  } catch {
    showToast('Clipboard access failed', true);
  }
}

async function downloadSensitiveExport() {
  if (!confirm('This export contains plaintext destination passwords. Store it securely and delete it when finished. Continue?')) return;
  const response = await fetch('/api/mailboxes/export-sensitive', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(state.csrf ? { 'x-atomicmail-csrf': state.csrf } : {}),
    },
    body: JSON.stringify({ confirm: 'EXPORT', search: state.mailboxSearch }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Sensitive export failed (${response.status})`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'atomicmail-email-destination-passwords.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  showToast('Sensitive export downloaded');
}

function renderCircuit(circuit) {
  const values = [
    ['State', circuit.open ? (circuit.permanent ? 'Permanent stop' : 'Temporary cooldown') : 'Closed'],
    ['Reason', circuit.reason || '—'],
    ['Until', circuit.until ? formatDate(circuit.until) : '—'],
  ];
  $('#circuitDetails').innerHTML = values.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  $('#resetCircuit').hidden = !circuit.open;
  $('#resetCircuit').dataset.permanent = circuit.permanent ? 'true' : 'false';
}

function renderAudit(items) {
  $('#auditList').innerHTML = items.length ? items.map((item) => `<div class="audit-item">
    <div class="audit-item-head"><strong class="level-${escapeHtml(item.level)}">${escapeHtml(item.event)}</strong><span class="muted">${escapeHtml(formatDate(item.created_at))}</span></div>
    <p>${escapeHtml(item.message)}</p>
  </div>`).join('') : '<div class="empty">No audit events.</div>';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDataSafety(data) {
  const vault = data?.vault || {};
  const backups = data?.backups || {};
  const latest = backups.latest;
  const vaultRows = [
    ['Credential encryption', vault.encryption || 'Unavailable'],
    ['Encrypted files', vault.encryptedCredentialFiles ?? '—'],
    ['Plaintext files', vault.plaintextCredentialFiles ?? '—'],
    ['Temporary workspaces', vault.runtimeCredentialDirectories ?? '—'],
    ['Key storage', vault.keySource || '—'],
    ['Key fingerprint', vault.keyFingerprint || '—'],
    ['File permissions', vault.filePermissions?.hardened ? vault.filePermissions.method : `Warning: ${vault.filePermissions?.warning || 'not hardened'}`],
  ];
  const backupRows = [
    ['Automatic backups', backups.enabled ? 'Enabled' : 'Disabled'],
    ['Schedule', backups.enabled ? `Every ${backups.intervalMinutes} min` : '—'],
    ['Retention', backups.retention ? `${backups.retention} backups` : '—'],
    ['Backup count', backups.backupCount ?? '—'],
    ['Latest backup', latest ? formatDate(latest.createdAt) : 'None yet'],
    ['Latest size', latest ? formatBytes(latest.sizeBytes) : '—'],
  ];
  $('#vaultDetails').innerHTML = vaultRows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  $('#backupDetails').innerHTML = backupRows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const warning = $('#dataSafetyWarning');
  const plaintext = Number(vault.plaintextCredentialFiles || 0);
  const permissionWarning = vault.filePermissions && !vault.filePermissions.hardened ? vault.filePermissions.warning : '';
  const warnings = [];
  if (plaintext) warnings.push(`${plaintext} plaintext credential file(s) remain on disk. Do not create more mailboxes until migration succeeds.`);
  if (permissionWarning) warnings.push(`OS file-permission hardening warning: ${permissionWarning}`);
  warning.hidden = warnings.length === 0;
  warning.textContent = warnings.join(' ');
  if ($('#verifyBackup').dataset.busy !== 'true') $('#verifyBackup').disabled = !latest;
}

async function loadSystem() {
  const request = beginLatestRequest('system');
  const endActivity = beginActivity('system-load', 'Loading system status');
  setButtonBusy($('#refreshAudit'), true, 'Refreshing');
  try {
    const [circuit, audit, dataSafety] = await Promise.all([
      api('/api/system/circuit', { signal: request.signal }),
      api('/api/audit?limit=80', { signal: request.signal }),
      api('/api/system/data-safety', { signal: request.signal }),
    ]);
    if (!request.isCurrent()) return;
    renderCircuit(circuit);
    renderAudit(audit.items || []);
    renderDataSafety(dataSafety);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    if (request.isCurrent()) {
      request.finish();
      setButtonBusy($('#refreshAudit'), false);
    }
    endActivity();
  }
}

function startPolling() {
  schedulePoll(state.activeJob || state.activeCloudflareJob ? 2500 : 8000);
  if (!state.clockTimer) state.clockTimer = setInterval(refreshLiveTimers, 1000);
}

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    await poll();
    if (!state.authenticated) {
      state.pollTimer = null;
      return;
    }
    const active = ['pending', 'running'].includes(state.activeJob?.status)
      || ['running', 'needs_action'].includes(state.activeCloudflareJob?.status);
    schedulePoll(active ? 2500 : 10000);
  }, delay);
}

async function poll() {
  if (state.pollBusy || document.hidden || !state.authenticated) return;
  state.pollBusy = true;
  try {
    await loadDashboard();
    if (state.currentView === 'jobs' && state.activeJob) await loadJobs({ background: true });
    if (state.currentView === 'cloudflare') await loadManualCloudflare({ background: true });
  } catch (error) {
    if (!isAbortError(error) && error?.status !== 401) console.warn(error);
  } finally {
    state.pollBusy = false;
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#loginError');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  errorBox.hidden = true;
  setButtonBusy(button, true, 'Signing in');
  try {
    const auth = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value }),
    });
    showApp(auth);
    await loadDashboard();
    switchView('dashboard');
    startPolling();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    setButtonBusy(button, false);
  }
});

$('#logoutButton').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Signing out', 'Signing out', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
    stopWebmailAutoRefresh();
    hideJobPassword();
    hideCloudflarePassword();
    state.csrf = null;
    state.authenticated = false;
    showLogin();
  });
});

$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view-target]');
  if (button) switchView(button.dataset.viewTarget);
});

$('#batchPrefix').addEventListener('input', refreshNamePreview);
$('#batchCount').addEventListener('input', refreshNamePreview);

$('#createForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#createError');
  errorBox.hidden = true;
  const button = $('#createButton');
  setButtonBusy(button, true, 'Creating batch');
  const endActivity = beginActivity('create-batch', 'Creating batch', { immediate: true });
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        count: Number($('#batchCount').value),
        prefix: $('#batchPrefix').value,
        destinationPassword: $('#destinationPassword').value,
      }),
    });
    $('#destinationPassword').value = '';
    $('#destinationPassword').type = 'password';
    $('#toggleDestinationPassword').textContent = 'Show';
    state.selectedJobId = job.id;
    showToast(`Batch created: ${job.requested_count} email${job.requested_count === 1 ? '' : 's'}`);
    switchView('jobs', { load: false });
    await Promise.all([loadJobs(), loadDashboard()]);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    endActivity();
    setButtonBusy(button, false);
    button.disabled = Boolean(state.dashboard?.circuit?.open) || !state.dashboard?.workerEnabled;
  }
});

$('#jobsBody').addEventListener('click', (event) => {
  const row = event.target.closest('[data-job-id]');
  if (row) loadJobDetail(row.dataset.jobId).catch(handleError);
});

$('#jobActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-job-action]');
  if (button) runJobAction(button.dataset.jobAction, button).catch(handleError);
});

$('#refreshJobs').addEventListener('click', () => loadJobs().catch(handleError));
$('#openCurrentJob').addEventListener('click', (event) => {
  state.selectedJobId = event.currentTarget.dataset.jobId;
  switchView('jobs');
});

$('#mailboxSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.mailboxSearch = $('#mailboxSearch').value.trim().slice(0, 100);
  state.mailboxOffset = 0;
  loadMailboxes().catch(handleError);
});

$('#clearMailboxSearch').addEventListener('click', () => {
  $('#mailboxSearch').value = '';
  state.mailboxSearch = '';
  state.mailboxOffset = 0;
  loadMailboxes().catch(handleError);
});

$('#mailboxPrev').addEventListener('click', () => {
  state.mailboxOffset = Math.max(0, state.mailboxOffset - state.mailboxLimit);
  loadMailboxes().catch(handleError);
});

$('#mailboxNext').addEventListener('click', () => {
  if (state.mailboxOffset + state.mailboxLimit < state.mailboxTotal) state.mailboxOffset += state.mailboxLimit;
  loadMailboxes().catch(handleError);
});

$('#mailboxesBody').addEventListener('click', async (event) => {
  const openButton = event.target.closest('[data-open-inbox]');
  if (openButton) {
    await withBusyButton(openButton, 'Opening', 'Opening mailbox', () => openMailbox(openButton.dataset.openInbox, openButton.dataset.mailboxEmail)).catch(handleError);
    return;
  }
  const passwordButton = event.target.closest('[data-copy-mailbox-password]');
  if (passwordButton) {
    try {
      await withBusyButton(passwordButton, 'Copying', 'Decrypting destination password', async () => {
        const result = await api(`/api/mailboxes/${encodeURIComponent(passwordButton.dataset.copyMailboxPassword)}/destination-password`, { method: 'POST', body: '{}' });
        await copyText(result.password, 'Destination password copied');
      });
    } catch (error) {
      handleError(error);
    }
    return;
  }
  const button = event.target.closest('[data-copy-email]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyEmail);
    showToast('Email copied');
  } catch {
    showToast('Clipboard access failed', true);
  }
});

$('#mailboxesBody').addEventListener('change', (event) => {
  const input = event.target.closest('[data-cloudflare-mailbox-id]');
  if (!input || input.disabled) return;
  if (input.checked) {
    if (state.selectedCloudflareMailboxIds.size >= 100) {
      input.checked = false;
      showToast('A Cloudflare job is limited to 100 mailboxes', true);
      return;
    }
    state.selectedCloudflareMailboxIds.add(input.dataset.cloudflareMailboxId);
  } else {
    state.selectedCloudflareMailboxIds.delete(input.dataset.cloudflareMailboxId);
  }
  updateCloudflareSelectionUi();
});

$('#toggleMailboxPageSelection').addEventListener('change', (event) => {
  selectMailboxRows(state.mailboxItems, event.currentTarget.checked);
});
$('#selectCloudflarePage').addEventListener('click', () => selectMailboxRows(state.mailboxItems, true));
$('#selectCloudflareFiltered').addEventListener('click', (event) => selectFirstFilteredMailboxes(event.currentTarget).catch(handleError));
$('#clearCloudflareSelection').addEventListener('click', () => {
  state.selectedCloudflareMailboxIds.clear();
  selectMailboxRows(state.mailboxItems, false);
});
$('#createCloudflareSelection').addEventListener('click', openManualCloudflareBatchModal);
$('#closeManualCloudflareBatch').addEventListener('click', closeManualCloudflareBatchModal);
$('#cancelManualCloudflareBatch').addEventListener('click', closeManualCloudflareBatchModal);
$('#manualCloudflareBatchModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeManualCloudflareBatchModal();
});
$('#manualCloudflareBatchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#submitManualCloudflareBatch');
  const errorBox = $('#manualCloudflareCreateError');
  errorBox.hidden = true;
  form.setAttribute('aria-busy', 'true');
  setButtonBusy(button, true, 'Creating accounts');
  const endActivity = beginActivity('manual-cloudflare-create', 'Generating and encrypting unique account passwords', { immediate: true });
  try {
    const result = await api('/api/cloudflare/jobs', {
      method: 'POST',
      body: JSON.stringify({ mailboxIds: [...state.selectedCloudflareMailboxIds] }),
    });
    state.selectedCloudflareMailboxIds.clear();
    $('#manualCloudflareBatchModal').hidden = true;
    showToast(`${result.requested_count} Cloudflare account record${result.requested_count === 1 ? '' : 's'} ready`);
    switchView('cloudflare', { load: false });
    await Promise.all([loadManualCloudflare(), loadMailboxes({ background: true }), loadDashboard()]);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    form.setAttribute('aria-busy', 'false');
    setButtonBusy(button, false);
    endActivity();
  }
});

$('#refreshManualCloudflare').addEventListener('click', () => loadManualCloudflare().catch(handleError));
$('#copyManualCloudflareEmail').addEventListener('click', () => {
  const email = state.manualCloudflareAccount?.email;
  if (email) copyText(email, 'Cloudflare email copied').catch(handleError);
});
$('#revealManualCloudflarePassword').addEventListener('click', async (event) => {
  if (state.manualCloudflarePassword) {
    hideManualCloudflarePasswordOnly();
    return;
  }
  await withBusyButton(event.currentTarget, 'Decrypting', 'Decrypting this account password', revealManualCloudflarePassword).catch(handleError);
});
$('#copyManualCloudflarePassword').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Copying', 'Decrypting this account password', async () => {
    const password = state.manualCloudflarePassword || await revealManualCloudflarePassword();
    if (password) await copyText(password, 'Cloudflare password copied');
  }).catch(handleError);
});
$('#regenerateManualCloudflarePassword').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account || !confirm('Replace this unused password with a new random password?')) return;
  await withBusyButton(event.currentTarget, 'Regenerating', 'Encrypting a new account password', async () => {
    const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/regenerate-password`, { method: 'POST', body: '{}' });
    state.manualCloudflareAccount = result.account;
    state.manualCloudflarePassword = result.password;
    $('#manualCloudflareFocusPassword').textContent = result.password;
    $('#revealManualCloudflarePassword').textContent = 'Hide';
    showToast('New unique password generated');
  }).catch(handleError);
});
$('#openManualCloudflareSignup').addEventListener('click', () => {
  window.open(state.manualCloudflareSignupUrl, '_blank', 'noopener,noreferrer');
});
$('#markManualCloudflareSignupDone').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account || !confirm('Confirm that Cloudflare accepted the signup for this exact email. The password will be locked.')) return;
  await withBusyButton(event.currentTarget, 'Saving', 'Locking password and saving Signup Done', async () => {
    await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/signup-done`, { method: 'POST', body: '{}' });
    hideManualCloudflareSecrets();
    await loadManualCloudflare();
    guideManualCloudflareStep('manualCloudflareInboxStep', 'checkManualCloudflareInbox', 'Signup saved and password locked. Next: check the inbox for the Cloudflare code or link.');
  }).catch(handleError);
});
$('#checkManualCloudflareInbox').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account) return;
  await withBusyButton(event.currentTarget, 'Checking inbox', 'Looking for a Cloudflare code or verification link', async () => {
    const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/check-inbox`, { method: 'POST', body: '{}' });
    if (result.evidence?.verificationUrl) state.manualCloudflareVerificationUrl = result.evidence.verificationUrl;
    if (result.evidence?.verificationCode) state.manualCloudflareVerificationCode = result.evidence.verificationCode;
    await loadManualCloudflare();
    if (result.found) {
      if (state.manualCloudflareVerificationCode) $('#manualCloudflareVerificationCode').textContent = state.manualCloudflareVerificationCode;
      const current = state.manualCloudflareAccount;
      if (current && (!current.has_global_api_key || !current.has_api_token)) {
        const focusId = !current.has_global_api_key ? 'manualCloudflareGlobalApiKey' : 'manualCloudflareApiToken';
        guideManualCloudflareStep('manualCloudflareCredentialStep', focusId, 'Verification found. Next: paste and save the missing Cloudflare API credentials.');
      } else {
        showToast('Cloudflare verification found and saved');
      }
    } else if (result.retainedEvidence) {
      showToast('No newer Cloudflare email found; saved verification evidence is still available');
    } else {
      showToast('No Cloudflare verification email yet');
    }
  }).catch(handleManualCloudflareError);
});
$('#openManualCloudflareVerifyLink').addEventListener('click', async (event) => {
  const popup = window.open('about:blank', '_blank');
  await withBusyButton(event.currentTarget, 'Opening', 'Validating the Cloudflare verification link', async () => {
    const url = await manualCloudflareVerificationLink();
    if (popup) {
      popup.opener = null;
      popup.location.replace(url);
    } else {
      throw new Error('The browser blocked the new tab. Allow popups and try again.');
    }
  }).catch((error) => {
    try { popup?.close(); } catch {}
    handleError(error);
  });
});
$('#copyManualCloudflareVerifyLink').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Copying', 'Validating the Cloudflare verification link', async () => {
    await copyText(await manualCloudflareVerificationLink(), 'Verification link copied');
  }).catch(handleError);
});
$('#copyManualCloudflareVerificationCode').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Copying', 'Decrypting the saved Cloudflare verification code', async () => {
    await copyText(await manualCloudflareVerificationCode(), 'Cloudflare verification code copied');
  }).catch(handleError);
});
$('#saveManualCloudflareAccessSecrets').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account) return;
  const globalApiKey = $('#manualCloudflareGlobalApiKey').value.trim();
  const apiToken = $('#manualCloudflareApiToken').value.trim();
  if (!globalApiKey && !apiToken) {
    const focusId = !account.has_global_api_key ? 'manualCloudflareGlobalApiKey' : 'manualCloudflareApiToken';
    guideManualCloudflareStep('manualCloudflareCredentialStep', focusId, 'Paste at least one new credential before saving. Saved credentials can be shown with Show saved values.');
    return;
  }
  await withBusyButton(event.currentTarget, 'Saving', 'Encrypting Cloudflare API credentials for this account', async () => {
    const body = {};
    if (globalApiKey) body.globalApiKey = globalApiKey;
    if (apiToken) body.apiToken = apiToken;
    const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/access-secrets`, {
      method: 'POST', body: JSON.stringify(body),
    });
    state.manualCloudflareAccount = result.account;
    setManualCloudflareAccessSecretsVisible({
      globalApiKey: globalApiKey || state.manualCloudflareGlobalApiKey || '',
      apiToken: apiToken || state.manualCloudflareApiToken || '',
    });
    renderManualCloudflareFocus(result.account, { totalAccounts: result.account.batch_total || 1 });
    await loadManualCloudflare({ background: true });
    if (result.account.has_global_api_key && result.account.has_api_token) {
      guideManualCloudflareStep('manualCloudflareFinishStep', 'markManualCloudflareVerified', 'Credentials saved. Next: Mark Verified & Next.');
    } else {
      const focusId = !result.account.has_global_api_key ? 'manualCloudflareGlobalApiKey' : 'manualCloudflareApiToken';
      guideManualCloudflareStep('manualCloudflareCredentialStep', focusId, 'Credential saved. Add the remaining credential to finish this account.');
    }
  }).catch(handleError);
});
$('#revealManualCloudflareAccessSecrets').addEventListener('click', async (event) => {
  if (state.manualCloudflareGlobalApiKey || state.manualCloudflareApiToken) {
    const globalText = $('#manualCloudflareGlobalApiKey').value.trim();
    const tokenText = $('#manualCloudflareApiToken').value.trim();
    const hasUnsavedChanges = globalText !== (state.manualCloudflareGlobalApiKey || '')
      || tokenText !== (state.manualCloudflareApiToken || '');
    if (hasUnsavedChanges && !confirm('Hide these values and discard your unsaved edits?')) return;
    hideManualCloudflareAccessSecretsOnly();
    renderManualCloudflareCredentialState(state.manualCloudflareAccount);
    return;
  }
  const hasUnsavedText = $('#manualCloudflareGlobalApiKey').value.trim() || $('#manualCloudflareApiToken').value.trim();
  if (hasUnsavedText) {
    guideManualCloudflareStep('manualCloudflareCredentialStep', 'saveManualCloudflareAccessSecrets', 'Save or clear the values you typed before showing the previously saved credentials.');
    return;
  }
  await withBusyButton(event.currentTarget, 'Decrypting', 'Decrypting saved Cloudflare API credentials', revealManualCloudflareAccessSecrets).catch(handleError);
});
$('#copyManualCloudflareGlobalApiKey').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Copying', 'Decrypting saved Global API Key', async () => {
    const globalApiKey = state.manualCloudflareGlobalApiKey || (await fetchManualCloudflareAccessSecrets()).globalApiKey;
    if (!globalApiKey) throw new Error('No Global API Key is saved for this account');
    await copyText(globalApiKey, 'Cloudflare Global API Key copied');
  }).catch(handleError);
});
$('#copyManualCloudflareApiToken').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Copying', 'Decrypting saved API Token', async () => {
    const apiToken = state.manualCloudflareApiToken || (await fetchManualCloudflareAccessSecrets()).apiToken;
    if (!apiToken) throw new Error('No API Token is saved for this account');
    await copyText(apiToken, 'Cloudflare API Token copied');
  }).catch(handleError);
});
$('#markManualCloudflareVerified').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account) return;
  if (!account.signup_done_at) {
    guideManualCloudflareStep('manualCloudflareSignupStep', 'openManualCloudflareSignup', 'First create the Cloudflare account, then click Signup Done.');
    return;
  }
  if (!manualCloudflareVerificationReady(account)) {
    guideManualCloudflareStep('manualCloudflareInboxStep', 'checkManualCloudflareInbox', 'Next: check the inbox and complete Cloudflare verification.');
    return;
  }
  if (!account.has_global_api_key || !account.has_api_token) {
    const focusId = !account.has_global_api_key ? 'manualCloudflareGlobalApiKey' : 'manualCloudflareApiToken';
    guideManualCloudflareStep('manualCloudflareCredentialStep', focusId, 'Next: paste and save the missing Cloudflare API credentials.');
    return;
  }
  if (!confirm('Confirm that Cloudflare shows this email as verified. Continue to the next account?')) return;
  await withBusyButton(event.currentTarget, 'Saving', 'Marking account verified and loading the next account', async () => {
    await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/verified`, { method: 'POST', body: '{}' });
    hideManualCloudflareSecrets();
    await Promise.all([loadManualCloudflare(), loadDashboard()]);
    showToast('Account verified. Focus Mode advanced to the next account.');
  }).catch(handleError);
});

$('#saveManualCloudflareNotes').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account) return;
  await withBusyButton(event.currentTarget, 'Saving', 'Saving account notes', async () => {
    await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/notes`, {
      method: 'POST', body: JSON.stringify({ notes: $('#manualCloudflareNotes').value }),
    });
    await loadManualCloudflare({ background: true });
    showToast('Notes saved');
  }).catch(handleError);
});
$('#markManualCloudflareFailed').addEventListener('click', async (event) => {
  const account = state.manualCloudflareAccount;
  if (!account || !confirm('Mark this account as Failed and move to the next unfinished account?')) return;
  await withBusyButton(event.currentTarget, 'Saving', 'Marking account failed', async () => {
    await api(`/api/cloudflare/accounts/${encodeURIComponent(account.id)}/failed`, {
      method: 'POST', body: JSON.stringify({ reason: $('#manualCloudflareNotes').value || 'Marked failed by operator' }),
    });
    hideManualCloudflareSecrets();
    await loadManualCloudflare();
  }).catch(handleError);
});
$('#manualCloudflareAccountFilters').addEventListener('submit', (event) => {
  event.preventDefault();
  state.manualCloudflareSearch = $('#manualCloudflareAccountSearch').value.trim();
  state.manualCloudflareStatus = $('#manualCloudflareAccountStatus').value;
  loadManualCloudflare().catch(handleError);
});
$('#manualCloudflareAccountsBody').addEventListener('click', async (event) => {
  const open = event.target.closest('[data-manual-cloudflare-open]');
  if (open) {
    await withBusyButton(open, 'Opening', 'Loading saved Cloudflare account', () => openManualCloudflareAccount(open.dataset.manualCloudflareOpen)).catch(handleError);
    return;
  }
  const copy = event.target.closest('[data-manual-cloudflare-copy-password]');
  if (copy) {
    await withBusyButton(copy, 'Copying', 'Decrypting this account password', async () => {
      const result = await api(`/api/cloudflare/accounts/${encodeURIComponent(copy.dataset.manualCloudflareCopyPassword)}/password`, { method: 'POST', body: '{}' });
      await copyText(result.password, 'Cloudflare password copied');
    }).catch(handleError);
  }
});
$('#exportManualCloudflareSensitive').addEventListener('click', (event) => {
  withBusyButton(event.currentTarget, 'Exporting', 'Preparing explicit sensitive export', downloadManualCloudflareSensitiveExport).catch(handleError);
});

$('#closeCloudflareJobModal').addEventListener('click', closeCloudflareJobModal);
$('#cancelCloudflareJob').addEventListener('click', closeCloudflareJobModal);
$('#cloudflareJobModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeCloudflareJobModal();
});
$('#cloudflareGeneratePassword').addEventListener('change', (event) => {
  const generated = event.currentTarget.checked;
  $('#cloudflarePasswordMode').value = generated ? 'generated' : 'manual';
  $('#cloudflareManualPassword').disabled = generated;
  $('#cloudflareManualPassword').required = !generated;
  if (generated) $('#cloudflareManualPassword').value = '';
  else $('#cloudflareManualPassword').focus();
});
$('#toggleCloudflareManualPassword').addEventListener('click', () => {
  const input = $('#cloudflareManualPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggleCloudflareManualPassword').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#cloudflareJobForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#submitCloudflareJob');
  const errorBox = $('#cloudflareCreateError');
  errorBox.hidden = true;
  form.setAttribute('aria-busy', 'true');
  setButtonBusy(button, true, 'Creating job');
  const endActivity = beginActivity('cloudflare-create', 'Creating encrypted Cloudflare job', { immediate: true });
  try {
    const passwordMode = $('#cloudflarePasswordMode').value;
    const job = await api('/api/cloudflare/jobs', {
      method: 'POST',
      body: JSON.stringify({
        mailboxIds: [...state.selectedCloudflareMailboxIds],
        passwordMode,
        ...(passwordMode === 'manual' ? { password: $('#cloudflareManualPassword').value } : {}),
      }),
    });
    state.selectedCloudflareMailboxIds.clear();
    state.selectedCloudflareJobId = job.id;
    $('#cloudflareJobModal').hidden = true;
    $('#cloudflareManualPassword').value = '';
    showToast(`Cloudflare job created for ${job.requested_count} account${job.requested_count === 1 ? '' : 's'}`);
    switchView('cloudflare', { load: false });
    await Promise.all([loadCloudflare(), loadMailboxes({ background: true }), loadDashboard()]);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    form.setAttribute('aria-busy', 'false');
    setButtonBusy(button, false);
    endActivity();
  }
});

$('#refreshCloudflare').addEventListener('click', () => loadCloudflare().catch(handleError));
$('#cloudflareJobsBody').addEventListener('click', (event) => {
  const row = event.target.closest('[data-cloudflare-job-id]');
  if (row) loadCloudflareJobDetail(row.dataset.cloudflareJobId).catch(handleError);
});
$('#cloudflareJobActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cloudflare-job-action]');
  if (button) runCloudflareJobAction(button.dataset.cloudflareJobAction, button).catch(handleError);
});
$('#cloudflareActionRequired').addEventListener('click', async (event) => {
  const inbox = event.target.closest('[data-cloudflare-check-inbox]');
  if (inbox) {
    await openMailbox(inbox.dataset.cloudflareCheckInbox, inbox.dataset.cloudflareCheckEmail).catch(handleError);
    return;
  }
  const retry = event.target.closest('[data-cloudflare-item-retry]');
  if (retry) {
    await withBusyButton(retry, 'Retrying', 'Scheduling another verification inbox check', async () => {
      await api(`/api/cloudflare/items/${encodeURIComponent(retry.dataset.cloudflareItemRetry)}/retry`, { method: 'POST', body: '{}' });
      await loadCloudflare();
    }).catch(handleError);
    return;
  }
  const open = event.target.closest('[data-cloudflare-item-open]');
  if (!open) return;
  const mode = open.dataset.cloudflareOpenMode;
  await withBusyButton(open, 'Opening', 'Opening the visible Cloudflare browser', async () => {
    if (mode === 'focus') {
      await api(`/api/cloudflare/items/${encodeURIComponent(open.dataset.cloudflareItemOpen)}/focus`, { method: 'POST', body: '{}' });
    } else {
      await api(`/api/cloudflare/items/${encodeURIComponent(open.dataset.cloudflareItemOpen)}/reconcile`, { method: 'POST', body: '{}' });
      await loadCloudflare();
    }
  }).catch(handleError);
});
$('#cloudflareItemsBody').addEventListener('click', async (event) => {
  const focus = event.target.closest('[data-cloudflare-item-focus]');
  if (focus) {
    await withBusyButton(focus, 'Focusing', 'Focusing visible Chromium', () => api(`/api/cloudflare/items/${encodeURIComponent(focus.dataset.cloudflareItemFocus)}/focus`, { method: 'POST', body: '{}' })).catch(handleError);
    return;
  }
  const retry = event.target.closest('[data-cloudflare-item-retry]');
  if (retry) {
    await withBusyButton(retry, 'Retrying', 'Scheduling safe Cloudflare reconciliation', async () => {
      await api(`/api/cloudflare/items/${encodeURIComponent(retry.dataset.cloudflareItemRetry)}/retry`, { method: 'POST', body: '{}' });
      await loadCloudflare();
    }).catch(handleError);
    return;
  }
  const reconcile = event.target.closest('[data-cloudflare-item-reconcile]');
  if (reconcile) {
    await withBusyButton(reconcile, 'Opening login', 'Scheduling existing-account reconciliation', async () => {
      await api(`/api/cloudflare/items/${encodeURIComponent(reconcile.dataset.cloudflareItemReconcile)}/reconcile`, { method: 'POST', body: '{}' });
      await loadCloudflare();
    }).catch(handleError);
    return;
  }
  const artifact = event.target.closest('[data-cloudflare-artifact]');
  if (artifact) await viewCloudflareArtifact(artifact.dataset.cloudflareArtifact).catch(handleError);
});
$('#revealCloudflarePassword').addEventListener('click', (event) => revealCloudflarePassword(event.currentTarget).catch(handleError));
$('#hideCloudflarePassword').addEventListener('click', hideCloudflarePassword);
$('#copyCloudflarePassword').addEventListener('click', () => {
  if (state.cloudflareJobPassword != null) copyText(state.cloudflareJobPassword, 'Cloudflare password copied').catch(handleError);
});
$('#exportCloudflareSensitive').addEventListener('click', (event) => withBusyButton(event.currentTarget, 'Exporting', 'Preparing sensitive Cloudflare export', downloadCloudflareSensitiveExport).catch(handleError));
$('#pairCloudflareRunner').addEventListener('click', async (event) => {
  await withBusyButton(event.currentTarget, 'Creating code', 'Creating one-time runner pairing code', async () => {
    const pairing = await api('/api/cloudflare/runners/pairing', { method: 'POST', body: '{}' });
    const command = `npm.cmd run cloudflare:runner -- --panel "${location.origin}" --code ${pairing.code}`;
    state.cloudflarePairingCommand = command;
    $('#cloudflarePairingCommand').textContent = command;
    $('#cloudflarePairingExpiry').textContent = `Expires ${formatDate(pairing.expiresAt)} · token remains only in runner memory`;
    $('#cloudflarePairingPanel').hidden = false;
  });
});
$('#copyCloudflarePairing').addEventListener('click', () => copyText(state.cloudflarePairingCommand, 'Runner command copied').catch(handleError));
$('#revokeCloudflareRunner').addEventListener('click', async (event) => {
  if (!confirm('Revoke the connected Cloudflare runner? Any visible browser task will stop.')) return;
  await withBusyButton(event.currentTarget, 'Revoking', 'Revoking Cloudflare runner', async () => {
    await api('/api/cloudflare/runners/revoke', { method: 'POST', body: '{}' });
    $('#cloudflarePairingPanel').hidden = true;
    await loadCloudflare();
  }).catch(handleError);
});
$('#resetCloudflareCircuit').addEventListener('click', async (event) => {
  if (!confirm('Reset the Cloudflare cooldown only after reviewing the provider response. Continue?')) return;
  await withBusyButton(event.currentTarget, 'Resetting', 'Resetting Cloudflare cooldown', async () => {
    await api('/api/cloudflare/circuit/reset', { method: 'POST', body: '{}' });
    await loadCloudflare();
  }).catch(handleError);
});

$('#backToMailboxes').addEventListener('click', () => switchView('mailboxes'));
$('#refreshInbox').addEventListener('click', () => loadInbox({ statusText: 'Refreshing mailbox' }).catch(handleError));
$$('[data-mail-folder]').forEach((button) => button.addEventListener('click', () => selectMailFolder(button.dataset.mailFolder)));
$('#mailSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.mailSearch = $('#mailSearch').value.trim();
  state.mailSearchField = $('#mailSearchField').value;
  state.mailPosition = 0;
  loadInbox({ statusText: 'Searching mail' }).catch(handleError);
});
$('#clearMailSearch').addEventListener('click', () => {
  $('#mailSearch').value = '';
  state.mailSearch = '';
  state.mailPosition = 0;
  loadInbox({ statusText: 'Clearing search' }).catch(handleError);
});
$('#mailPageSize').addEventListener('change', () => {
  state.mailLimit = Number($('#mailPageSize').value) || 25;
  state.mailPosition = 0;
  loadInbox({ statusText: 'Changing page size' }).catch(handleError);
});
$('#mailPrev').addEventListener('click', () => {
  state.mailPosition = Math.max(0, state.mailPosition - state.mailLimit);
  loadInbox({ statusText: 'Loading previous page' }).catch(handleError);
});
$('#mailNext').addEventListener('click', () => {
  if (state.mailPosition + state.mailLimit < state.mailTotal) state.mailPosition += state.mailLimit;
  loadInbox({ statusText: 'Loading next page' }).catch(handleError);
});
$('#composeMail').addEventListener('click', () => openCompose('new'));
$('#replyMail').addEventListener('click', () => openCompose('reply'));
$('#toggleReadMail').addEventListener('click', (event) => runMailAction(event.currentTarget.dataset.mailAction).catch(handleError));
$('#archiveMail').addEventListener('click', () => runMailAction('archive').catch(handleError));
$('#trashMail').addEventListener('click', () => runMailAction('trash').catch(handleError));
$('#inboxList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-message-id]');
  if (row) loadMessage(row.dataset.messageId).catch(handleError);
});
$('#messageDetail').addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-value]');
  if (button) copyText(button.dataset.copyValue).catch(handleError);
});
$('#closeCompose').addEventListener('click', () => closeCompose());
$('#cancelCompose').addEventListener('click', () => closeCompose());
$('#composeModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeCompose();
});
$('#composeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitCompose().catch(handleError);
});

$('#exportCsv').addEventListener('click', (event) => withBusyButton(event.currentTarget, 'Exporting', 'Preparing CSV export', () => downloadExport('csv')).catch(handleError));
$('#exportJson').addEventListener('click', (event) => withBusyButton(event.currentTarget, 'Exporting', 'Preparing JSON export', () => downloadExport('json')).catch(handleError));
$('#exportSensitiveCsv').addEventListener('click', (event) => withBusyButton(event.currentTarget, 'Exporting', 'Preparing sensitive export', () => downloadSensitiveExport()).catch(handleError));
$('#toggleDestinationPassword').addEventListener('click', () => {
  const input = $('#destinationPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggleDestinationPassword').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#revealJobPassword').addEventListener('click', (event) => revealJobPassword(event.currentTarget).catch(handleError));
$('#hideJobPassword').addEventListener('click', hideJobPassword);
$('#copyJobPassword').addEventListener('click', () => {
  if (state.jobDestinationPassword != null) copyText(state.jobDestinationPassword, 'Destination password copied').catch(handleError);
});
$('#refreshAudit').addEventListener('click', () => loadSystem().catch(handleError));
$('#createBackup').addEventListener('click', async () => {
  const button = $('#createBackup');
  try {
    await withBusyButton(button, 'Creating', 'Creating and verifying encrypted backup', async () => {
      const result = await api('/api/system/backups', { method: 'POST', body: '{}' });
      showToast(`Encrypted backup created and verified: ${result.name}`);
      await loadSystem();
    });
  } catch (error) {
    handleError(error);
  }
});
$('#verifyBackup').addEventListener('click', async () => {
  const button = $('#verifyBackup');
  try {
    await withBusyButton(button, 'Verifying', 'Verifying latest encrypted backup', async () => {
      const result = await api('/api/system/backups/verify', { method: 'POST', body: '{}' });
      showToast(`Backup verified: ${result.name}`);
      await loadSystem();
    });
  } catch (error) {
    handleError(error);
  }
});

$('#resetCircuit').addEventListener('click', async (event) => {
  const permanent = event.currentTarget.dataset.permanent === 'true';
  const message = permanent
    ? 'This is a permanent policy/abuse-protection stop. Reset only after you reviewed the provider response. Continue?'
    : 'Reset the temporary circuit now? Normal cooldown is safer unless the underlying issue is resolved.';
  if (!confirm(message)) return;
  try {
    await withBusyButton(event.currentTarget, 'Resetting', 'Resetting circuit breaker', async () => {
      await api('/api/system/circuit/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: permanent ? 'RESET' : 'TEMPORARY' }),
      });
      showToast('Circuit reset');
      await Promise.all([loadSystem(), loadDashboard()]);
    });
  } catch (error) {
    handleError(error);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentView === 'webmail' && state.selectedMailbox) loadInbox({ background: true }).catch(() => {});
  if (!document.hidden && state.currentView === 'cloudflare') loadManualCloudflare({ background: true }).catch(() => {});
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#composeModal').hidden) closeCompose();
  if (event.key === 'Escape' && !$('#cloudflareJobModal').hidden) closeCloudflareJobModal();
  if (event.key === 'Escape' && !$('#manualCloudflareBatchModal').hidden) closeManualCloudflareBatchModal();
});

window.addEventListener('beforeunload', (event) => {
  if (!state.composeBusy) return;
  event.preventDefault();
  event.returnValue = '';
});

async function boot() {
  try {
    const auth = await api('/api/auth/status');
    if (auth.authRequired && !auth.authenticated) {
      state.authRequired = true;
      showLogin();
      return;
    }
    showApp(auth);
    await loadDashboard();
    switchView('dashboard');
    startPolling();
  } catch (error) {
    showToast(`Startup failed: ${error.message}`, true);
  }
}

boot();
