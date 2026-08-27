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
    return /(?:verify|verification|confirm|activate|email|token)/i.test(`${parsed.pathname}${parsed.search}`);
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
      return /(?:verify|verification|confirm).*(?:email|address)|(?:email|address).*(?:verify|verification|confirm)/i
        .test(String(message?.subject || ''));
    })
    .sort((left, right) => Date.parse(right.receivedAt || '') - Date.parse(left.receivedAt || ''));

  for (const message of candidates) {
    const url = (message.links || []).find(isCloudflareVerificationUrl);
    if (url) {
      return {
        messageId: String(message.id || ''),
        receivedAt: message.receivedAt || null,
        url,
      };
    }
  }
  return null;
}
