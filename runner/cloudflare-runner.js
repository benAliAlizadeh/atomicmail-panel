import os from 'node:os';
import { chromium } from 'playwright';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 10000;
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function panelUrl(value) {
  const parsed = new URL(String(value || 'http://127.0.0.1:8787'));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Panel URL must use HTTP or HTTPS');
  if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new Error('A remote panel must use HTTPS. Plain HTTP is allowed only on loopback.');
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function officialCloudflareUrl(value) {
  const raw = String(value || '');
  if (!raw || raw.length > 4096) throw Object.assign(new Error('Runner refused an invalid Cloudflare browser target'), { code: 'unsafe_browser_target' });
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol !== 'https:' || (host !== 'cloudflare.com' && !host.endsWith('.cloudflare.com'))) {
    throw Object.assign(new Error('Runner refused a non-Cloudflare browser target'), { code: 'unsafe_browser_target' });
  }
  return parsed.toString();
}

async function request(base, pathname, { method = 'GET', token = '', body = null, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${base}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body == null ? {} : { 'content-type': 'application/json' }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Panel returned HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = payload.code;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeTaskError(error, task) {
  let message = normalizedText(error?.message || 'Cloudflare browser task failed');
  if (task?.password) message = message.replaceAll(String(task.password), '[REDACTED]');
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]').slice(0, 700);
}

async function pageText(page) {
  return normalizedText((await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 120000));
}

function challengePage(url, text) {
  return /\/cdn-cgi\/challenge|challenge-platform/i.test(url)
    || /verify you are human|checking your browser|security check|captcha|turnstile/i.test(text);
}

function rateLimited(text) {
  return /too many requests|rate.?limit|try again later|temporarily blocked/i.test(text);
}

function accountExists(text) {
  return /account.*already exists|email.*already (?:registered|in use)|already have an account/i.test(text);
}

function signupAccepted(url, text) {
  return /verify (?:your )?email|check (?:your )?(?:email|inbox)|verification email/i.test(text)
    || (!/sign-?up|register/i.test(url) && /dash\.cloudflare\.com/i.test(url) && !/login/i.test(url));
}

function emailVerifiedOnPage(text, email) {
  const normalized = normalizedText(text).toLowerCase();
  const address = String(email || '').trim().toLowerCase();
  const position = normalized.indexOf(address);
  if (position < 0) return false;
  const context = normalized.slice(Math.max(0, position - 300), position + address.length + 300);
  if (/not\s+verified|unverified|verification\s+(?:pending|required)|verify\s+your\s+email/i.test(context)) return false;
  return /\b(?:verified|confirmed)\b/i.test(context);
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const candidate = locator.first();
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function fillSignup(page, task) {
  await page.goto(officialCloudflareUrl(task.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const email = await firstVisible([
    page.getByLabel(/email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
  ]);
  const password = await firstVisible([
    page.getByLabel(/password/i),
    page.locator('input[type="password"]'),
  ]);
  if (!email || !password) throw Object.assign(new Error('Cloudflare signup fields were not recognized; UI may have changed'), { code: 'unknown_ui' });
  await email.fill(task.email);
  const passwordFields = page.locator('input[type="password"]');
  const passwordCount = Math.min(3, await passwordFields.count());
  if (!passwordCount) await password.fill(task.password);
  for (let index = 0; index < passwordCount; index += 1) {
    const field = passwordFields.nth(index);
    if (await field.isVisible().catch(() => false)) await field.fill(task.password);
  }
  await page.bringToFront();
}

async function loginIfNeeded(page, task, notifyNeedsAction) {
  let email = await firstVisible([page.getByLabel(/email/i), page.locator('input[type="email"]')]);
  let password = await firstVisible([page.getByLabel(/password/i), page.locator('input[type="password"]')]);
  if (!email && !password) return;
  officialCloudflareUrl(page.url());
  if (email) await email.fill(task.email);
  if (!password && email) {
    const continueButton = await firstVisible([
      page.getByRole('button', { name: /continue|next|log ?in|sign ?in/i }),
      page.locator('button[type="submit"]'),
    ]);
    if (!continueButton) throw Object.assign(new Error('Cloudflare login continue control was not recognized'), { code: 'unknown_ui' });
    await continueButton.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    password = await firstVisible([page.getByLabel(/password/i), page.locator('input[type="password"]')]);
  }
  if (!password) throw Object.assign(new Error('Cloudflare login password field was not recognized'), { code: 'unknown_ui' });
  await password.fill(task.password);
  const submit = await firstVisible([
    page.getByRole('button', { name: /log ?in|sign ?in|continue/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (!submit) throw Object.assign(new Error('Cloudflare login submit control was not recognized'), { code: 'unknown_ui' });
  await submit.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  let challengeReported = false;
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await pageText(page);
    if (challengePage(page.url(), text)) {
      if (!challengeReported) {
        await notifyNeedsAction('challenge', 'Complete the Cloudflare login challenge in the visible Chromium window');
        challengeReported = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (!/login/i.test(page.url()) && !(await password.isVisible().catch(() => false))) return;
    if (/invalid.*(?:email|password)|incorrect.*password/i.test(text)) {
      throw Object.assign(new Error('Cloudflare rejected the stored job password'), { code: 'invalid_credentials' });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Object.assign(new Error('Cloudflare login timed out'), { code: 'login_timeout', retryable: true });
}

async function screenshot(page) {
  if (!page || page.isClosed()) return null;
  try {
    return (await page.screenshot({ type: 'png', fullPage: false, timeout: 10000 })).toString('base64');
  } catch {
    return null;
  }
}

class Runner {
  constructor(base, token, browser) {
    this.base = base;
    this.token = token;
    this.browser = browser;
    this.active = null;
    this.heartbeatTimer = null;
    this.heartbeatFailures = 0;
    this.stopping = false;
  }

  async event(task, event, payload = {}) {
    return request(this.base, `/api/cloudflare/runner/tasks/${encodeURIComponent(task.id)}/events`, {
      method: 'POST', token: this.token, timeoutMs: 45000,
      body: { event, generation: task.generation, ...payload },
    });
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => {
        this.heartbeatFailures += 1;
        process.stderr.write(`Runner heartbeat failed: ${error.message}\n`);
        if ([401, 403].includes(error.statusCode) || this.heartbeatFailures >= 3) void this.stop();
      });
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async heartbeat() {
    const response = await request(this.base, '/api/cloudflare/runner/heartbeat', {
      method: 'POST', token: this.token, timeoutMs: 15000,
      body: {
        activeItemId: this.active?.task.id || null,
        generation: this.active?.task.generation || null,
      },
    });
    this.heartbeatFailures = 0;
    for (const command of response.commands || []) {
      if (command.itemId && command.itemId !== this.active?.task.id) continue;
      if (command.type === 'focus') await this.active?.page?.bringToFront().catch(() => {});
      if (command.type === 'resend-confirmed' && this.active) this.active.resendConfirmed = true;
      if (command.type === 'cancel') {
        this.active.cancelled = true;
        await this.active.context?.close().catch(() => {});
      }
    }
  }

  async signup(task, context, page) {
    await this.event(task, 'progress', { phase: 'opening_signup', message: 'Opening the official Cloudflare signup page' });
    await fillSignup(page, task);
    this.active.stage = 'awaiting_submit';
    await this.event(task, 'awaiting_submit', { storageState: await context.storageState() });
    process.stdout.write(`Ready: submit ${task.email} in the visible Chromium window.\n`);

    let challengeReported = false;
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (Date.now() < deadline && !this.active.cancelled && !page.isClosed()) {
      const text = await pageText(page);
      const url = page.url();
      if (rateLimited(text)) {
        await this.event(task, 'failed', {
          code: 'rate_limited', message: 'Cloudflare rate limited or temporarily blocked signup', uncertain: true,
          screenshotBase64: await screenshot(page),
        });
        return;
      }
      if (accountExists(text)) {
        await this.event(task, 'failed', {
          code: 'account_exists', message: 'Cloudflare reports that this email already has an account',
          screenshotBase64: await screenshot(page),
        });
        return;
      }
      if (challengePage(url, text)) {
        if (!challengeReported) {
          await this.event(task, 'needs_action', {
            code: 'challenge', message: 'Complete the Cloudflare challenge in the visible Chromium window', keepTaskOpen: true,
          });
          challengeReported = true;
        }
      } else if (signupAccepted(url, text)) {
        this.active.stage = 'submitted';
        await this.event(task, 'submitted', { storageState: await context.storageState() });
        process.stdout.write(`Submitted: ${task.email}; the panel is polling AtomicMail.\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.active.cancelled) {
      await this.event(task, 'failed', {
        code: 'submit_timeout', message: 'Manual Cloudflare signup submission timed out', uncertain: true,
        screenshotBase64: await screenshot(page),
      });
    }
  }

  async verify(task, context, page) {
    await this.event(task, 'progress', { phase: 'opening_verification', message: 'Opening the trusted Cloudflare verification link' });
    await page.goto(officialCloudflareUrl(task.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const notifyNeedsAction = async (code, message) => this.event(task, 'needs_action', { code, message, keepTaskOpen: true });
    let text = await pageText(page);
    if (challengePage(page.url(), text)) {
      await notifyNeedsAction('challenge', 'Complete the Cloudflare verification challenge in the visible Chromium window');
      const challengeDeadline = Date.now() + TASK_TIMEOUT_MS;
      while (Date.now() < challengeDeadline && !this.active.cancelled && !page.isClosed()) {
        text = await pageText(page);
        if (!challengePage(page.url(), text)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (challengePage(page.url(), text)) {
        throw Object.assign(new Error('Cloudflare verification challenge timed out'), { code: 'challenge_timeout' });
      }
    }
    await loginIfNeeded(page, task, notifyNeedsAction);

    await page.goto('https://dash.cloudflare.com/profile', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + 90000;
    let challengeReported = false;
    while (Date.now() < deadline && !this.active.cancelled && !page.isClosed()) {
      text = await pageText(page);
      if (challengePage(page.url(), text)) {
        if (!challengeReported) {
          await notifyNeedsAction('challenge', 'Complete the Cloudflare profile challenge in the visible Chromium window');
          challengeReported = true;
        }
      } else if (emailVerifiedOnPage(text, task.email)) {
        const accountId = page.url().match(/\b([a-f0-9]{32})\b/i)?.[1] || null;
        await this.event(task, 'verified', { cloudflareAccountId: accountId });
        process.stdout.write(`Verified: ${task.email}\n`);
        return;
      } else if (/verification link.*(?:expired|invalid)|unable to verify/i.test(text)) {
        await this.event(task, 'needs_action', {
          code: 'verification_link_expired', message: 'Cloudflare says the verification link is invalid or expired',
          screenshotBase64: await screenshot(page),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.active.cancelled) {
      await this.event(task, 'failed', {
        code: 'unknown_ui', message: 'Could not confirm Verified status from the Cloudflare profile', uncertain: true,
        screenshotBase64: await screenshot(page),
      });
    }
  }

  async reconcile(task, context, page) {
    await this.event(task, 'progress', {
      phase: 'reconciling', message: 'Logging in to inspect the existing Cloudflare account without submitting signup again',
    });
    await page.goto(officialCloudflareUrl(task.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const notifyNeedsAction = async (code, message) => this.event(task, 'needs_action', { code, message, keepTaskOpen: true });
    await loginIfNeeded(page, task, notifyNeedsAction);
    await page.goto('https://dash.cloudflare.com/profile', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const initialText = await pageText(page);
    if (emailVerifiedOnPage(initialText, task.email)) {
      const accountId = page.url().match(/\b([a-f0-9]{32})\b/i)?.[1] || null;
      await this.event(task, 'verified', { cloudflareAccountId: accountId });
      process.stdout.write(`Verified during reconciliation: ${task.email}\n`);
      return;
    }
    await notifyNeedsAction(
      'verification_pending',
      'Existing account opened. Use Cloudflare\'s visible UI to resend verification, then click "I clicked Resend" in the panel.',
    );
    let challengeReported = false;
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (Date.now() < deadline && !this.active.cancelled && !page.isClosed()) {
      const text = await pageText(page);
      if (challengePage(page.url(), text)) {
        if (!challengeReported) {
          await notifyNeedsAction('challenge', 'Complete the Cloudflare reconciliation challenge in the visible Chromium window');
          challengeReported = true;
        }
      } else if (emailVerifiedOnPage(text, task.email)) {
        const accountId = page.url().match(/\b([a-f0-9]{32})\b/i)?.[1] || null;
        await this.event(task, 'verified', { cloudflareAccountId: accountId });
        process.stdout.write(`Verified during reconciliation: ${task.email}\n`);
        return;
      } else if (this.active.resendConfirmed) {
        this.active.stage = 'submitted';
        await this.event(task, 'submitted', { storageState: await context.storageState(), resubmitted: true });
        process.stdout.write(`Verification requested during reconciliation: ${task.email}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.active.cancelled) {
      await this.event(task, 'failed', {
        code: 'reconcile_timeout', message: 'Existing Cloudflare account reconciliation timed out', uncertain: true,
        screenshotBase64: await screenshot(page),
      });
    }
  }

  async handle(task) {
    const context = await this.browser.newContext(task.storageState ? { storageState: task.storageState } : {});
    const page = await context.newPage();
    this.active = { task, context, page, cancelled: false, stage: 'opening', resendConfirmed: false };
    try {
      if (task.kind === 'signup') await this.signup(task, context, page);
      else if (task.kind === 'verify') await this.verify(task, context, page);
      else if (task.kind === 'reconcile') await this.reconcile(task, context, page);
      else throw Object.assign(new Error(`Unknown runner task ${task.kind}`), { code: 'unknown_task' });
    } catch (error) {
      if (!this.active.cancelled) {
        const safeMessage = safeTaskError(error, task);
        await this.event(task, 'failed', {
          code: error.code || 'browser_error',
          message: safeMessage,
          retryable: Boolean(error.retryable || /timeout|network|closed/i.test(safeMessage)),
          uncertain: task.kind === 'reconcile'
            || (task.kind === 'signup' && ['awaiting_submit', 'submitted'].includes(this.active.stage)),
          screenshotBase64: await screenshot(page),
        }).catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
      this.active = null;
      await this.heartbeat().catch(() => {});
    }
  }

  async loop() {
    this.startHeartbeat();
    await this.heartbeat();
    while (!this.stopping) {
      const response = await request(this.base, '/api/cloudflare/runner/tasks/next?wait=20', {
        token: this.token, timeoutMs: 30000,
      });
      if (response.task) await this.handle(response.task);
    }
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.active) this.active.cancelled = true;
    await this.active?.context?.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

async function main() {
  const base = panelUrl(argument('panel', process.env.ATOMICMAIL_PANEL_URL || 'http://127.0.0.1:8787'));
  const code = argument('code', process.env.CLOUDFLARE_PAIRING_CODE || '').trim();
  if (!code) throw new Error('Provide the one-time code with --code XXXX-XXXX');
  const paired = await request(base, '/api/cloudflare/runner/pair', {
    method: 'POST',
    body: { code, protocolVersion: PROTOCOL_VERSION, name: `${os.hostname()} operator browser` },
  });
  const browser = await chromium.launch({ headless: false });
  const runner = new Runner(base, paired.token, browser);
  process.stdout.write(`Cloudflare runner ${paired.runnerId} connected to ${base}.\n`);
  const shutdown = () => { void runner.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    await runner.loop();
  } finally {
    await runner.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`Cloudflare runner stopped: ${error?.message || error}\n`);
  process.exitCode = 1;
});
