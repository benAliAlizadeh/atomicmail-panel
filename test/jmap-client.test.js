import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AtomicMailJmapClient,
  MailClientError,
  extractSafeLinks,
  extractVerificationCodes,
  extractVerificationLinks,
  htmlToSafeText,
} from '../src/jmap-client.js';

function config() {
  return {
    atomicCliCommand: 'atomicmail-test',
    atomicCliPrefixArgs: ['atomicmail'],
    mailCommandTimeoutMs: 60000,
    mailMaxBodyBytes: 524288,
    mailMaxComposeBytes: 204800,
    mailMaxSubjectBytes: 2048,
    mailMaxSearchBytes: 256,
    mailMaxAttachmentBytes: 5242880,
  };
}

function fakeVault(root) {
  const materialized = [];
  const committed = [];
  const discarded = [];
  return {
    materialized,
    committed,
    discarded,
    materialize(username) {
      const dir = fs.mkdtempSync(path.join(root, `${username}-`));
      fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ inboxId: username, apiKey: 'secret' }));
      materialized.push({ username, dir });
      return dir;
    },
    commitRuntime(username, dir) {
      committed.push({ username, dir });
      fs.rmSync(dir, { recursive: true, force: true });
      return { username };
    },
    discardRuntime(dir) {
      discarded.push(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function response(methodResponses) {
  return { code: 0, signal: null, timedOut: false, stdout: JSON.stringify({ methodResponses, _next: [] }), stderr: '' };
}

test('JMAP inbox listing normalizes sender, unread state, preview and attachment flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-list-'));
  try {
    const vault = fakeVault(root);
    const runner = async (_command, args) => {
      assert.ok(args.includes('jmap_request'));
      const ops = JSON.parse(args[args.indexOf('--ops') + 1]);
      assert.equal(ops.methodCalls[0][0], 'Email/query');
      assert.equal(ops.methodCalls[0][1].limit, 25);
      return response([
        ['Email/query', { ids: ['m1'], total: 1, queryState: 'qstate' }, 'q0'],
        ['Email/get', { list: [{
          id: 'm1', threadId: 't1', receivedAt: '2026-08-27T10:00:00Z',
          from: [{ name: 'Cloudflare', email: 'noreply@example.com' }],
          to: [{ email: 'box@atomicmail.ai' }], subject: 'Verify', preview: 'Your code is 123456',
          keywords: {}, hasAttachment: true,
        }] }, 'g0'],
      ]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const inbox = await client.listInbox('boxname111', { limit: 25 });
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].fromText, 'Cloudflare <noreply@example.com>');
    assert.equal(inbox.items[0].unread, true);
    assert.equal(inbox.items[0].hasAttachment, true);
    assert.equal(vault.committed.length, 1);
    assert.equal(vault.discarded.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('message read returns safe plain text and only http/https links from untrusted HTML', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-read-'));
  try {
    const vault = fakeVault(root);
    const runner = async (_command, args) => {
      const vars = JSON.parse(args[args.indexOf('--vars') + 1]);
      assert.equal(vars.MAIL_ID, 'm-123');
      return response([['Email/get', { list: [{
        id: 'm-123', threadId: 't1', from: [{ email: 'sender@example.com' }], to: [{ email: 'box@atomicmail.ai' }],
        subject: 'HTML only', receivedAt: '2026-08-27T10:00:00Z', preview: 'Verify now',
        htmlBody: [{ partId: 'h1', type: 'text/html' }],
        bodyValues: { h1: { value: '<p>Hello &amp; welcome</p><a href="https://example.com/verify?a=1&amp;b=2">Verify</a><script>alert(1)</script><a href="javascript:alert(2)">bad</a>' } },
        keywords: { '$seen': true }, attachments: [],
      }] }, 'g0']]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const mail = await client.getMessage('boxname111', 'm-123');
    assert.match(mail.body, /Hello & welcome/);
    assert.doesNotMatch(mail.body, /alert\(1\)/);
    assert.deepEqual(mail.links, ['https://example.com/verify?a=1&b=2']);
    assert.equal(mail.unread, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('send and reply use official bundled AgentSkill presets and keep credentials encrypted after each request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-send-'));
  try {
    const vault = fakeVault(root);
    const calls = [];
    const runner = async (_command, args) => {
      const preset = args[args.indexOf('--ops-file') + 1];
      const vars = JSON.parse(args[args.indexOf('--vars') + 1]);
      calls.push({ preset, vars });
      return response([
        ['Email/set', { created: { d1: { id: `mail-${calls.length}` } } }, 'c0'],
        ['EmailSubmission/set', { created: { s1: { id: `sub-${calls.length}` } } }, 'c1'],
      ]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const sent = await client.send('boxname111', { to: 'person@example.com', subject: 'Hi', body: 'Hello' });
    const replied = await client.reply('boxname111', 'message-7', { body: 'Thanks' });
    assert.deepEqual(calls[0], { preset: 'send_mail.json', vars: { TO: 'person@example.com', SUBJECT: 'Hi', BODY: 'Hello' } });
    assert.deepEqual(calls[1], { preset: 'reply.json', vars: { MAIL_ID: 'message-7', BODY: 'Thanks' } });
    assert.equal(sent.submissionId, 'sub-1');
    assert.equal(replied.submissionId, 'sub-2');
    assert.equal(vault.committed.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JMAP method-level errors are surfaced safely even when HTTP/CLI succeeded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-method-error-'));
  try {
    const vault = fakeVault(root);
    const runner = async () => response([['error', { type: 'invalidArguments', description: 'recipient rejected' }, 'c0']]);
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    await assert.rejects(
      () => client.send('boxname111', { to: 'person@example.com', subject: 'Hi', body: 'Hello' }),
      (error) => error instanceof MailClientError && error.statusCode === 422 && /recipient rejected/i.test(error.message),
    );
    assert.equal(vault.committed.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same-mailbox JMAP requests are serialized to avoid refreshed-token races', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-queue-'));
  try {
    const vault = fakeVault(root);
    let active = 0;
    let maxActive = 0;
    const runner = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return response([
        ['Email/query', { ids: [], total: 0 }, 'q0'],
        ['Email/get', { list: [] }, 'g0'],
      ]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    await Promise.all([
      client.listInbox('boxname111'),
      client.listInbox('boxname111'),
      client.listInbox('boxname111'),
    ]);
    assert.equal(maxActive, 1);
    assert.equal(client.queues.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelled read requests stop before commit and discard their temporary credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-cancel-'));
  try {
    const vault = fakeVault(root);
    const controller = new AbortController();
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const runner = async (_command, _args, options) => {
      markStarted();
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      return { code: null, signal: 'SIGTERM', timedOut: false, aborted: true, stdout: '', stderr: '' };
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const operation = client.listInbox('boxname111', { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(
      operation,
      (error) => error instanceof MailClientError && error.code === 'mail_cancelled' && error.statusCode === 499,
    );
    assert.equal(vault.committed.length, 0);
    assert.equal(vault.discarded.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTML helpers never expose javascript links', () => {
  assert.equal(htmlToSafeText('<b>Hello</b><script>bad()</script>'), 'Hello');
  assert.deepEqual(extractSafeLinks('https://ok.example/a', '<a href="javascript:bad()">x</a>'), ['https://ok.example/a']);
});

test('Sent listing uses provider-side search, position pagination, total and unread count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-sent-'));
  try {
    const vault = fakeVault(root);
    let call = 0;
    const runner = async (_command, args) => {
      call += 1;
      const ops = JSON.parse(args[args.indexOf('--ops') + 1]);
      if (call === 1) {
        assert.equal(ops.methodCalls[0][0], 'Mailbox/query');
        assert.deepEqual(ops.methodCalls[0][1].filter, { role: 'sent' });
        return response([['Mailbox/query', { ids: ['sent-mailbox'] }, 'mq0']]);
      }
      const query = ops.methodCalls[0][1];
      assert.equal(query.filter.inMailbox, 'sent-mailbox');
      assert.equal(query.filter.to, 'person@example.com');
      assert.equal(query.position, 25);
      assert.equal(query.limit, 25);
      assert.equal(query.calculateTotal, true);
      return response([
        ['Email/query', { ids: ['s1'], total: 51, queryState: 'sent-state' }, 'q0'],
        ['Email/get', { list: [{
          id: 's1', to: [{ email: 'person@example.com' }], from: [{ email: 'box@atomicmail.ai' }],
          subject: 'Sent subject', sentAt: '2026-08-27T12:00:00Z', receivedAt: '2026-08-27T12:00:00Z',
          preview: 'hello', keywords: { '$seen': true },
        }] }, 'g0'],
        ['Email/query', { ids: [], total: 3 }, 'uq0'],
      ]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const page = await client.listMailbox('boxname111', {
      folder: 'sent', limit: 25, position: 25, search: 'person@example.com', field: 'to',
    });
    assert.equal(page.total, 51);
    assert.equal(page.unreadTotal, 3);
    assert.equal(page.position, 25);
    assert.equal(page.items[0].toText, 'person@example.com');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('message actions use safe JMAP patches and Trash role resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-actions-'));
  try {
    const vault = fakeVault(root);
    const seen = [];
    const runner = async (_command, args) => {
      const ops = JSON.parse(args[args.indexOf('--ops') + 1]);
      const method = ops.methodCalls[0][0];
      seen.push(ops);
      if (method === 'Mailbox/query') {
        const role = ops.methodCalls[0][1].filter.role;
        return response([['Mailbox/query', { ids: [role === 'archive' ? 'archive-folder' : 'trash-folder'] }, 'mq0']]);
      }
      const id = Object.keys(ops.methodCalls[0][1].update)[0];
      return response([['Email/set', { updated: [id] }, 'u0']]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    await client.updateMessage('boxname111', 'm1', 'mark_read');
    await client.updateMessage('boxname111', 'm1', 'archive');
    await client.updateMessage('boxname111', 'm1', 'trash');
    assert.deepEqual(seen[0].methodCalls[0][1].update.m1, { 'keywords/$seen': true });
    assert.equal(seen[1].methodCalls[0][0], 'Mailbox/query');
    assert.deepEqual(seen[2].methodCalls[0][1].update.m1, { mailboxIds: { 'archive-folder': true } });
    assert.equal(seen[3].methodCalls[0][0], 'Mailbox/query');
    assert.deepEqual(seen[4].methodCalls[0][1].update.m1, { mailboxIds: { 'trash-folder': true } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachments are uploaded from private temporary files and downloaded through Blob/get', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-attachments-'));
  try {
    const vault = fakeVault(root);
    const cfg = { ...config(), runtimeCredentialsRoot: path.join(root, 'runtime') };
    let call = 0;
    const runner = async (_command, args) => {
      call += 1;
      const ops = JSON.parse(args[args.indexOf('--ops') + 1]);
      if (call === 1) {
        const attachmentPath = args[args.indexOf('--attachment') + 1];
        assert.equal(fs.readFileSync(attachmentPath, 'utf8'), 'hello attachment');
        assert.equal(path.basename(attachmentPath), 'notes.txt');
        assert.equal(ops.methodCalls[0][0], 'Email/set');
        assert.equal(ops.methodCalls[0][1].create.m1.attachments[0].blobId, '$ATTACHMENT_0_BLOB_ID');
        return response([
          ['Email/set', { created: { m1: { id: 'mail-with-file' } } }, 'm0'],
          ['EmailSubmission/set', { created: { s1: { id: 'submission-with-file' } } }, 's0'],
        ]);
      }
      if (call === 2) {
        return response([['Email/get', { list: [{
          id: 'mail-with-file', attachments: [{ blobId: 'blob-1', name: '../unsafe.txt', type: 'text/plain', size: 3 }],
        }] }, 'g0']]);
      }
      assert.equal(ops.methodCalls[0][0], 'Blob/get');
      return response([['Blob/get', { list: [{ id: 'blob-1', size: 3, 'data:asBase64': 'QUJD' }] }, 'b0']]);
    };
    const client = new AtomicMailJmapClient(cfg, vault, { runner });
    const sent = await client.send('boxname111', {
      to: 'person@example.com', subject: 'Attachment', body: 'See file',
      attachments: [{ name: '../notes.txt', type: 'text/plain', data: Buffer.from('hello attachment') }],
    });
    assert.equal(sent.submissionId, 'submission-with-file');
    const downloaded = await client.downloadAttachment('boxname111', 'mail-with-file', '0');
    assert.equal(downloaded.name, 'unsafe.txt');
    assert.equal(downloaded.data.toString('utf8'), 'ABC');
    assert.equal(fs.readdirSync(cfg.runtimeCredentialsRoot).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verification helpers are heuristic and only return safe HTTP links', () => {
  assert.deepEqual(extractVerificationCodes('Your verification code is 483921. Order 998877.'), ['483921']);
  assert.deepEqual(
    extractVerificationLinks(['https://example.com/verify?token=abc', 'https://example.com/news', 'javascript:alert(1)']),
    ['https://example.com/verify?token=abc'],
  );
});

test('Cloudflare verification polling uses a bounded post-submit inbox query and trusted link selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-cloudflare-'));
  try {
    const vault = fakeVault(root);
    const runner = async (_command, args) => {
      const ops = JSON.parse(args[args.indexOf('--ops') + 1]);
      assert.equal(ops.methodCalls[0][0], 'Email/query');
      assert.equal(ops.methodCalls[0][1].filter.inMailbox, '$INBOX_MAILBOX_ID');
      assert.equal(ops.methodCalls[0][1].filter.after, '2026-08-27T09:50:00.000Z');
      assert.equal(ops.methodCalls[0][1].limit, 20);
      assert.equal(ops.methodCalls[1][1].maxBodyValueBytes, 262144);
      return response([
        ['Email/query', { ids: ['cf-mail'] }, 'cfq0'],
        ['Email/get', { list: [{
          id: 'cf-mail', receivedAt: '2026-08-27T09:59:30.000Z',
          from: [{ email: 'no-reply@cloudflare.com' }], to: [{ email: 'boxname111@atomicmail.ai' }],
          subject: 'Verify your email address', preview: 'Confirm your email',
          textBody: [{ partId: 't1', type: 'text/plain' }],
          bodyValues: { t1: { value: 'Open https://dash.cloudflare.com/verify-email?token=private' } },
        }] }, 'cfg0'],
      ]);
    };
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    const found = await client.findCloudflareVerification('boxname111', {
      recipient: 'boxname111@atomicmail.ai', submittedAt: '2026-08-27T10:00:00.000Z',
      lookbackMs: 600000,
    });
    assert.equal(found.messageId, 'cf-mail');
    assert.equal(found.url, 'https://dash.cloudflare.com/verify-email?token=private');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mail headers reject CRLF injection and provider errors redact private compose values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-jmap-redaction-'));
  try {
    const vault = fakeVault(root);
    const runner = async () => ({
      code: 1, signal: null, timedOut: false, stdout: '', stderr: 'failed request body private-body-778899',
    });
    const client = new AtomicMailJmapClient(config(), vault, { runner });
    await assert.rejects(
      () => client.send('boxname111', { to: 'person@example.com', subject: 'ok\r\nBcc: bad@example.com', body: 'body' }),
      (error) => error.code === 'invalid_header',
    );
    await assert.rejects(
      () => client.send('boxname111', { to: 'person@example.com', subject: 'Safe', body: 'private-body-778899' }),
      (error) => !error.message.includes('private-body-778899') && /REQUEST_VALUE_REDACTED/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production JMAP path reuses one encrypted-vault AgentSession per mailbox', async () => {
  let sessionCreations = 0;
  const seenSessions = [];
  const session = { id: 'cached-session' };
  const client = new AtomicMailJmapClient(config(), {}, {
    sessionFactory: async () => {
      sessionCreations += 1;
      return session;
    },
    jmapExecutor: async (input) => {
      seenSessions.push(input.session);
      return { ok: true, status: 200, bodyText: JSON.stringify({ methodResponses: [] }) };
    },
  });
  const operation = { using: ['urn:ietf:params:jmap:core'], methodCalls: [] };
  await client.request('boxname111', { ops: operation });
  await client.request('boxname111', { ops: operation });
  assert.equal(sessionCreations, 1);
  assert.deepEqual(seenSessions, [session, session]);
  assert.equal(client.coordinator.status().activeMailbox, null);
});
