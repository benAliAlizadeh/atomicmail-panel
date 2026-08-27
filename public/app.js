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
  jobDestinationPassword: null,
  composeMode: 'new',
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
  if (state.currentView === 'webmail' && view !== 'webmail') stopWebmailAutoRefresh();
  if (state.currentView === 'jobs' && view !== 'jobs') hideJobPassword();
  state.currentView = view;
  $$('.view').forEach((item) => { item.hidden = item.dataset.view !== view; });
  const navView = view === 'webmail' ? 'mailboxes' : view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.viewTarget === navView));
  $('#pageTitle').textContent = viewMeta[view][0];
  $('#pageSubtitle').textContent = viewMeta[view][1];
  if (view === 'jobs') loadJobs().catch(handleError);
  if (view === 'mailboxes') loadMailboxes().catch(handleError);
  if (view === 'system') loadSystem().catch(handleError);
  if (view === 'webmail') startWebmailAutoRefresh();
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
  if (state.selectedJobId !== job.id) hideJobPassword();
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
    <td><div class="mailbox-action-group"><button class="btn primary small-btn open-inbox-btn" data-open-inbox="${escapeHtml(item.id)}" data-mailbox-email="${escapeHtml(item.email)}">Open inbox</button><button class="copy-btn" data-copy-email="${escapeHtml(item.email)}">Copy email</button>${item.has_destination_password ? `<button class="copy-btn" data-copy-mailbox-password="${escapeHtml(item.id)}">Copy password</button>` : ''}</div></td>
  </tr>`).join('');
  const page = Math.floor(state.mailboxOffset / state.mailboxLimit) + 1;
  const pages = Math.max(1, Math.ceil(state.mailboxTotal / state.mailboxLimit));
  $('#mailboxPageText').textContent = `Page ${page} of ${pages}`;
  $('#mailboxPrev').disabled = state.mailboxOffset <= 0;
  $('#mailboxNext').disabled = state.mailboxOffset + state.mailboxLimit >= state.mailboxTotal;
}

function setMailError(message = '', detail = '') {
  const box = $('#mailError');
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
    const active = state.selectedMessage?.id === item.id ? ' active' : '';
    const unread = item.unread ? ' unread' : '';
    return `<button class="mail-row${active}${unread}" type="button" data-message-id="${escapeHtml(item.id)}">
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

async function loadInbox() {
  if (!state.selectedMailbox || state.mailRefreshBusy) return;
  state.mailRefreshBusy = true;
  const loading = $('#inboxLoading');
  loading.hidden = false;
  setMailError('');
  $('#refreshInbox').disabled = true;
  try {
    const params = new URLSearchParams({
      folder: state.mailFolder,
      limit: state.mailLimit,
      position: state.mailPosition,
      field: state.mailSearchField,
    });
    if (state.mailSearch) params.set('search', state.mailSearch);
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/mail?${params}`);
    state.selectedMailbox = data.mailbox || state.selectedMailbox;
    state.mailTotal = Number(data.total || 0);
    $('#webmailAddress').textContent = state.selectedMailbox.email;
    $('#webmailSyncText').textContent = `${state.mailFolder === 'sent' ? 'Sent' : 'Inbox'} synced ${formatDate(data.syncedAt || new Date().toISOString())}`;
    $('#inboxUnreadBadge').textContent = state.mailFolder === 'inbox' && Number(data.unreadTotal || 0) > 0 ? String(data.unreadTotal) : '';
    renderInbox(data.items || []);
  } catch (error) {
    setMailError(error.message, error.body?.detail || '');
  } finally {
    loading.hidden = true;
    $('#refreshInbox').disabled = false;
    state.mailRefreshBusy = false;
  }
}

async function openMailbox(id, email) {
  state.selectedMailbox = { id, email };
  state.selectedMessage = null;
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
  await loadInbox();
}

function selectMailFolder(folder, refresh = true) {
  if (!['inbox', 'sent'].includes(folder)) return;
  state.mailFolder = folder;
  state.mailPosition = 0;
  state.selectedMessage = null;
  $('#messageEmpty').textContent = 'Select an email to read it.';
  $('#messageEmpty').hidden = false;
  $('#messageDetail').hidden = true;
  $('#mailFolderTitle').textContent = folder === 'sent' ? 'Sent' : 'Inbox';
  $('#inboxEmpty').textContent = folder === 'sent' ? 'No sent messages yet.' : 'No messages in this inbox yet.';
  $$('[data-mail-folder]').forEach((button) => button.classList.toggle('active', button.dataset.mailFolder === folder));
  $('#archiveMail').hidden = folder !== 'inbox';
  if (refresh) loadInbox().catch(handleError);
}

function stopWebmailAutoRefresh() {
  clearInterval(state.mailAutoTimer);
  state.mailAutoTimer = null;
}

function startWebmailAutoRefresh() {
  stopWebmailAutoRefresh();
  if (!state.selectedMailbox || state.currentView !== 'webmail') return;
  const seconds = Math.max(30, Number(state.dashboard?.mail?.autoRefreshSeconds || 45));
  state.mailAutoTimer = setInterval(() => {
    if (state.currentView === 'webmail' && !document.hidden) loadInbox().catch(() => {});
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
  if (!state.selectedMailbox || !state.selectedMessage) return;
  if (action === 'trash' && !confirm('Move this message to Trash? It will not be permanently deleted.')) return;
  await api(`/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/messages/${encodeURIComponent(state.selectedMessage.id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  showToast(action === 'trash' ? 'Message moved to Trash' : `Message updated: ${action.replaceAll('_', ' ')}`);
  if (['archive', 'trash'].includes(action)) {
    state.selectedMessage = null;
    $('#messageDetail').hidden = true;
    $('#messageEmpty').hidden = false;
  } else {
    state.selectedMessage.unread = action === 'mark_unread';
  }
  await loadInbox();
  if (state.selectedMessage) renderMessage(state.selectedMessage);
}

async function loadMessage(messageId) {
  if (!state.selectedMailbox) return;
  setMailError('');
  $('#messageEmpty').hidden = true;
  $('#messageDetail').hidden = true;
  $('#messageLoading').hidden = false;
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(state.selectedMailbox.id)}/messages/${encodeURIComponent(messageId)}`);
    renderMessage(data.message);
  } catch (error) {
    setMailError(error.message, error.body?.detail || '');
    $('#messageEmpty').textContent = 'Could not load this message.';
    $('#messageEmpty').hidden = false;
  } finally {
    $('#messageLoading').hidden = true;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

async function serializeComposeAttachments() {
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
  return Promise.all(files.map(async (file) => ({
    name: file.name,
    type: file.type || 'application/octet-stream',
    data: arrayBufferToBase64(await file.arrayBuffer()),
  })));
}

function openCompose(mode = 'new') {
  if (!state.selectedMailbox) return;
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

function closeCompose() {
  $('#composeModal').hidden = true;
  $('#composeError').hidden = true;
  $('#composeAttachments').value = '';
}

async function submitCompose() {
  if (!state.selectedMailbox) return;
  const button = $('#sendCompose');
  const errorBox = $('#composeError');
  button.disabled = true;
  errorBox.hidden = true;
  try {
    const attachments = await serializeComposeAttachments();
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
    closeCompose();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
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

async function revealJobPassword() {
  if (!state.selectedJobId) return;
  const result = await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/destination-password`, { method: 'POST', body: '{}' });
  state.jobDestinationPassword = result.password;
  $('#jobPasswordValue').textContent = result.password;
  $('#copyJobPassword').disabled = false;
  $('#hideJobPassword').hidden = false;
  $('#revealJobPassword').hidden = true;
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
  $('#verifyBackup').disabled = !latest;
}

async function loadSystem() {
  const [circuit, audit, dataSafety] = await Promise.all([
    api('/api/system/circuit'),
    api('/api/audit?limit=80'),
    api('/api/system/data-safety'),
  ]);
  renderCircuit(circuit);
  renderAudit(audit.items || []);
  renderDataSafety(dataSafety);
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
  stopWebmailAutoRefresh();
  hideJobPassword();
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
  const openButton = event.target.closest('[data-open-inbox]');
  if (openButton) {
    await openMailbox(openButton.dataset.openInbox, openButton.dataset.mailboxEmail).catch(handleError);
    return;
  }
  const passwordButton = event.target.closest('[data-copy-mailbox-password]');
  if (passwordButton) {
    try {
      const result = await api(`/api/mailboxes/${encodeURIComponent(passwordButton.dataset.copyMailboxPassword)}/destination-password`, { method: 'POST', body: '{}' });
      await copyText(result.password, 'Destination password copied');
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

$('#backToMailboxes').addEventListener('click', () => switchView('mailboxes'));
$('#refreshInbox').addEventListener('click', () => loadInbox().catch(handleError));
$$('[data-mail-folder]').forEach((button) => button.addEventListener('click', () => selectMailFolder(button.dataset.mailFolder)));
$('#mailSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.mailSearch = $('#mailSearch').value.trim();
  state.mailSearchField = $('#mailSearchField').value;
  state.mailPosition = 0;
  loadInbox().catch(handleError);
});
$('#clearMailSearch').addEventListener('click', () => {
  $('#mailSearch').value = '';
  state.mailSearch = '';
  state.mailPosition = 0;
  loadInbox().catch(handleError);
});
$('#mailPageSize').addEventListener('change', () => {
  state.mailLimit = Number($('#mailPageSize').value) || 25;
  state.mailPosition = 0;
  loadInbox().catch(handleError);
});
$('#mailPrev').addEventListener('click', () => {
  state.mailPosition = Math.max(0, state.mailPosition - state.mailLimit);
  loadInbox().catch(handleError);
});
$('#mailNext').addEventListener('click', () => {
  if (state.mailPosition + state.mailLimit < state.mailTotal) state.mailPosition += state.mailLimit;
  loadInbox().catch(handleError);
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
$('#closeCompose').addEventListener('click', closeCompose);
$('#cancelCompose').addEventListener('click', closeCompose);
$('#composeModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeCompose();
});
$('#composeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitCompose().catch(handleError);
});

$('#exportCsv').addEventListener('click', () => downloadExport('csv').catch(handleError));
$('#exportJson').addEventListener('click', () => downloadExport('json').catch(handleError));
$('#exportSensitiveCsv').addEventListener('click', () => downloadSensitiveExport().catch(handleError));
$('#toggleDestinationPassword').addEventListener('click', () => {
  const input = $('#destinationPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggleDestinationPassword').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#revealJobPassword').addEventListener('click', () => revealJobPassword().catch(handleError));
$('#hideJobPassword').addEventListener('click', hideJobPassword);
$('#copyJobPassword').addEventListener('click', () => {
  if (state.jobDestinationPassword != null) copyText(state.jobDestinationPassword, 'Destination password copied').catch(handleError);
});
$('#refreshAudit').addEventListener('click', () => loadSystem().catch(handleError));
$('#createBackup').addEventListener('click', async () => {
  const button = $('#createBackup');
  button.disabled = true;
  try {
    const result = await api('/api/system/backups', { method: 'POST', body: '{}' });
    showToast(`Encrypted backup created and verified: ${result.name}`);
    await loadSystem();
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
  }
});
$('#verifyBackup').addEventListener('click', async () => {
  const button = $('#verifyBackup');
  button.disabled = true;
  try {
    const result = await api('/api/system/backups/verify', { method: 'POST', body: '{}' });
    showToast(`Backup verified: ${result.name}`);
    await loadSystem();
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
  }
});

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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentView === 'webmail' && state.selectedMailbox) loadInbox().catch(() => {});
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
