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
  $('#appShell').hidden = true;
  $('#authGate').hidden = false;
  $('#loginPassword').value = '';
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

function switchView(view) {
  if (!viewMeta[view]) return;
  state.currentView = view;
  $$('.view').forEach((item) => { item.hidden = item.dataset.view !== view; });
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.viewTarget === view));
  $('#pageTitle').textContent = viewMeta[view][0];
  $('#pageSubtitle').textContent = viewMeta[view][1];
  if (view === 'jobs') loadJobs().catch(handleError);
  if (view === 'mailboxes') loadMailboxes().catch(handleError);
  if (view === 'system') loadSystem().catch(handleError);
}

function handleError(error) {
  if (error?.status === 401) return;
  showToast(error?.message || 'Unexpected error', true);
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
  $('#createButton').disabled = Boolean(circuit.open) || !data.workerEnabled;

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
  refreshNamePreview();
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

async function loadJobs() {
  const data = await api('/api/jobs?limit=75');
  renderJobs(data.jobs || []);
  if (state.selectedJobId) await loadJobDetail(state.selectedJobId);
}

function itemStatusCounts(items) {
  const counts = {};
  for (const item of items || []) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

async function loadJobDetail(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  state.selectedJobId = job.id;
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

async function runJobAction(action) {
  if (!state.selectedJobId) return;
  if (action === 'cancel' && !confirm('Cancel all pending items in this job? A registration already in progress cannot be interrupted safely.')) return;
  await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/${action}`, { method: 'POST', body: '{}' });
  showToast(`Job ${action} requested`);
  await Promise.all([loadJobDetail(state.selectedJobId), loadJobs(), loadDashboard()]);
}

async function loadMailboxes() {
  const params = new URLSearchParams({ limit: state.mailboxLimit, offset: state.mailboxOffset });
  if (state.mailboxSearch) params.set('search', state.mailboxSearch);
  const data = await api(`/api/mailboxes?${params}`);
  state.mailboxTotal = Number(data.total || 0);
  const items = data.items || [];
  $('#mailboxesEmpty').hidden = items.length > 0;
  $('#mailboxCountText').textContent = `${state.mailboxTotal} mailbox${state.mailboxTotal === 1 ? '' : 'es'}${state.mailboxSearch ? ` matching “${state.mailboxSearch}”` : ''}`;
  $('#mailboxesBody').innerHTML = items.map((item) => `<tr>
    <td class="mono">${escapeHtml(item.email)}</td>
    <td>${statusPill(item.status)}</td>
    <td><span class="pill">API key</span></td>
    <td>${escapeHtml(formatDate(item.created_at))}</td>
    <td class="mono" title="${escapeHtml(item.job_id || '')}">${escapeHtml(item.job_id ? shortId(item.job_id) : '—')}</td>
    <td><button class="copy-btn" data-copy-email="${escapeHtml(item.email)}">Copy</button></td>
  </tr>`).join('');
  const page = Math.floor(state.mailboxOffset / state.mailboxLimit) + 1;
  const pages = Math.max(1, Math.ceil(state.mailboxTotal / state.mailboxLimit));
  $('#mailboxPageText').textContent = `Page ${page} of ${pages}`;
  $('#mailboxPrev').disabled = state.mailboxOffset <= 0;
  $('#mailboxNext').disabled = state.mailboxOffset + state.mailboxLimit >= state.mailboxTotal;
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

async function loadSystem() {
  const [circuit, audit] = await Promise.all([api('/api/system/circuit'), api('/api/audit?limit=80')]);
  renderCircuit(circuit);
  renderAudit(audit.items || []);
}

function startPolling() {
  if (!state.pollTimer) state.pollTimer = setInterval(poll, 2000);
  if (!state.clockTimer) state.clockTimer = setInterval(refreshLiveTimers, 1000);
}

async function poll() {
  if (state.pollBusy || document.hidden || !state.authenticated) return;
  state.pollBusy = true;
  try {
    await loadDashboard();
    if (state.currentView === 'jobs') await loadJobs();
    if (state.currentView === 'mailboxes') await loadMailboxes();
    if (state.currentView === 'system') await loadSystem();
  } catch (error) {
    if (error?.status !== 401) console.warn(error);
  } finally {
    state.pollBusy = false;
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#loginError');
  errorBox.hidden = true;
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
  }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  state.csrf = null;
  state.authenticated = false;
  showLogin();
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
  button.disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ count: Number($('#batchCount').value), prefix: $('#batchPrefix').value }),
    });
    state.selectedJobId = job.id;
    showToast(`Batch created: ${job.requested_count} email${job.requested_count === 1 ? '' : 's'}`);
    switchView('jobs');
    await Promise.all([loadJobs(), loadDashboard()]);
    await loadJobDetail(job.id);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = Boolean(state.dashboard?.circuit?.open) || !state.dashboard?.workerEnabled;
  }
});

$('#jobsBody').addEventListener('click', (event) => {
  const row = event.target.closest('[data-job-id]');
  if (row) loadJobDetail(row.dataset.jobId).catch(handleError);
});

$('#jobActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-job-action]');
  if (button) runJobAction(button.dataset.jobAction).catch(handleError);
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
  const button = event.target.closest('[data-copy-email]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyEmail);
    showToast('Email copied');
  } catch {
    showToast('Clipboard access failed', true);
  }
});

$('#exportCsv').addEventListener('click', () => downloadExport('csv').catch(handleError));
$('#exportJson').addEventListener('click', () => downloadExport('json').catch(handleError));
$('#refreshAudit').addEventListener('click', () => loadSystem().catch(handleError));

$('#resetCircuit').addEventListener('click', async (event) => {
  const permanent = event.currentTarget.dataset.permanent === 'true';
  const message = permanent
    ? 'This is a permanent policy/abuse-protection stop. Reset only after you reviewed the provider response. Continue?'
    : 'Reset the temporary circuit now? Normal cooldown is safer unless the underlying issue is resolved.';
  if (!confirm(message)) return;
  try {
    await api('/api/system/circuit/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: permanent ? 'RESET' : 'TEMPORARY' }),
    });
    showToast('Circuit reset');
    await Promise.all([loadSystem(), loadDashboard()]);
  } catch (error) {
    handleError(error);
  }
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
