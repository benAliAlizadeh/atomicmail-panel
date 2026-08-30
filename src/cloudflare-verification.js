const CLOUDFLARE_MAIL_DOMAINS = new Set(['cloudflare.com', 'notify.cloudflare.com']);

function ownedDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'cloudflare.com' || host.endsWith('.cloudflare.com');
}

export function isCloudflareVerificationUrl(value) {
  try {
    const raw = String(value || '');
    if (!raw || raw.length > 4096) return false;
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !ownedDomain(parsed.hostname)) return false;
    return /(?:verify|verification|confirm|activate|email|token|challenge)/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export function isCloudflareSender(value) {
  const email = String(value || '').trim().toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return false;
  const domain = email.slice(separator + 1).replace(/\.$/, '');
  return CLOUDFLARE_MAIL_DOMAINS.has(domain) || domain.endsWith('.cloudflare.com');
}

function looksLikeVerificationMessage(message) {
  const subject = String(message?.subject || '');
  const body = String(message?.body || message?.preview || '');
  return /(?:verify|verification|confirm|activate|login|security|authentication|one[- ]time|otp|passcode|code)/i
    .test(`${subject}\n${body}`);
}

function firstVerificationCode(message) {
  const codes = Array.isArray(message?.verificationCodes) ? message.verificationCodes : [];
  const normalized = codes.map((value) => String(value || '').trim())
    .find((value) => /^(?=.*\d)[A-Z0-9]{4,10}$/i.test(value));
  if (normalized) return normalized;
  const source = `${String(message?.subject || '')}\n${String(message?.body || message?.preview || '')}`.replace(/\s+/g, ' ');
  const patterns = [
    /(?:verification|verify|login|security|authentication|one[- ]time|otp|passcode|code)[^0-9]{0,120}([0-9]{4,8})/i,
    /(?:enter|use|type)[^0-9]{0,80}([0-9]{4,8})[^0-9]{0,40}(?:code|challenge|verification)?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Select the newest trusted Cloudflare verification message for the exact
 * Atomic Mail recipient after signup was recorded. A message may contain a
 * verification URL, a login/security code, or both.
 */
export function selectCloudflareVerification(messages, { recipient, submittedAt }) {
  const expectedRecipient = String(recipient || '').trim().toLowerCase();
  const submittedMs = Date.parse(submittedAt || '');
  const earliest = Number.isFinite(submittedMs) ? submittedMs : Number.POSITIVE_INFINITY;
  const candidates = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const received = Date.parse(message?.receivedAt || '');
      if (!Number.isFinite(received) || received < earliest) return false;
      if (!(message?.from || []).some((entry) => isCloudflareSender(entry?.email))) return false;
      const recipients = [...(message?.to || []), ...(message?.cc || [])]
        .map((entry) => String(entry?.email || '').toLowerCase())
        .filter(Boolean);
      if (!expectedRecipient || !recipients.includes(expectedRecipient)) return false;
      return looksLikeVerificationMessage(message);
    })
    .sort((left, right) => Date.parse(right.receivedAt || '') - Date.parse(left.receivedAt || ''));

  for (const message of candidates) {
    const url = (message.links || []).find(isCloudflareVerificationUrl) || null;
    const code = firstVerificationCode(message);
    if (!url && !code) continue;
    return {
      messageId: String(message.id || ''),
      receivedAt: message.receivedAt || null,
      subject: String(message.subject || '').slice(0, 500),
      url,
      code,
    };
  }
  return null;
}
