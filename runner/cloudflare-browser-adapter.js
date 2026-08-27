function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsEmail(text, email) {
  const haystack = normalizedText(text).toLowerCase();
  const needle = String(email || '').trim().toLowerCase();
  return Boolean(needle && haystack.includes(needle));
}

export function isCloudflareChallenge(url, text) {
  return /\/cdn-cgi\/challenge|challenge-platform/i.test(String(url || ''))
    || /verify you are human|checking your browser|security check|captcha|turnstile/i.test(String(text || ''));
}

export function isCloudflareRateLimited(text) {
  return /too many requests|rate.?limit|try again later|temporarily blocked/i.test(String(text || ''));
}

export function isExistingCloudflareAccount(text) {
  return /account.*already exists|email.*already (?:registered|in use)|already have an account/i.test(String(text || ''));
}

export function inspectCloudflareSignup({
  url,
  text,
  email,
  submitObserved = false,
  signupFormVisible = false,
  invalidFieldVisible = false,
} = {}) {
  const body = normalizedText(text);
  if (isCloudflareChallenge(url, body)) return { state: 'challenge' };
  if (isCloudflareRateLimited(body)) return { state: 'rate_limited' };
  if (isExistingCloudflareAccount(body)) return { state: 'account_exists' };

  const validationCopy = /invalid (?:email|password)|password (?:must|should|does not)|required field|please enter|could not create|unable to (?:sign|register|create)/i.test(body);
  if (submitObserved && signupFormVisible && (invalidFieldVisible || validationCopy)) {
    return { state: 'validation_error' };
  }

  // A URL change alone is never proof of account creation. The transition is
  // accepted only after a real operator submit was observed, the signup form
  // disappeared, and Cloudflare rendered an explicit email-verification state.
  const explicitVerificationPrompt = /(?:verification|confirmation) email (?:has been |was )?(?:sent|requested)|(?:check|verify) (?:your )?(?:email|inbox)/i.test(body);
  if (submitObserved && !signupFormVisible && explicitVerificationPrompt) {
    return {
      state: 'accepted',
      evidence: containsEmail(body, email)
        ? 'verification_prompt_with_email'
        : 'verification_prompt_after_operator_submit',
    };
  }

  return { state: submitObserved ? 'processing_submission' : 'awaiting_submit' };
}

export function inspectCloudflareVerificationRequest({
  url,
  text,
  email,
  requestObserved = false,
} = {}) {
  const body = normalizedText(text);
  if (isCloudflareChallenge(url, body)) return { state: 'challenge' };
  if (isCloudflareRateLimited(body)) return { state: 'rate_limited' };
  const sentCopy = /(?:verification|confirmation) email (?:has been |was )?(?:sent|resent|requested)|(?:check|verify) (?:your )?(?:email|inbox)/i.test(body);
  if (requestObserved && sentCopy) {
    return {
      state: 'accepted',
      evidence: containsEmail(body, email)
        ? 'resend_prompt_with_email'
        : 'resend_prompt_after_operator_action',
    };
  }
  return { state: requestObserved ? 'processing_request' : 'awaiting_action' };
}

export async function signupFormState(page) {
  const email = page.locator('input[type="email"], input[name*="email" i]').first();
  const password = page.locator('input[type="password"]').first();
  const signupFormVisible = await email.isVisible().catch(() => false)
    && await password.isVisible().catch(() => false);
  const invalidFieldVisible = await page.locator('input:invalid, [aria-invalid="true"]').first().isVisible().catch(() => false);
  return { signupFormVisible, invalidFieldVisible };
}

export async function observeTrustedOperatorSubmit(page, onSubmit) {
  const binding = `__atomicmailOperatorSubmit_${Math.random().toString(36).slice(2)}`;
  await page.exposeFunction(binding, () => onSubmit(Date.now()));
  await page.addInitScript(({ callbackName }) => {
    const report = (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      const submitControl = target?.closest?.('button[type="submit"], input[type="submit"]');
      const button = target?.closest?.('button');
      const recognizedButton = button && /create account|sign ?up|register|continue|send|resend|verify/i.test(button.textContent || '');
      if (event.type === 'submit' || submitControl || recognizedButton) globalThis[callbackName]?.();
    };
    document.addEventListener('submit', report, true);
    document.addEventListener('click', report, true);
  }, { callbackName: binding });
  await page.evaluate(({ callbackName }) => {
    const report = (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      const submitControl = target?.closest?.('button[type="submit"], input[type="submit"]');
      const button = target?.closest?.('button');
      const recognizedButton = button && /create account|sign ?up|register|continue|send|resend|verify/i.test(button.textContent || '');
      if (event.type === 'submit' || submitControl || recognizedButton) globalThis[callbackName]?.();
    };
    document.addEventListener('submit', report, true);
    document.addEventListener('click', report, true);
  }, { callbackName: binding });
}
