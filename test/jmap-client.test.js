import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicMailJmapClient, MailClientError, extractSafeLinks, htmlToSafeText } from '../src/jmap-client.js';

function config() {
  return {
    atomicCliCommand: 'atomicmail-test',
    atomicCliPrefixArgs: ['atomicmail'],
    mailCommandTimeoutMs: 60000,
    mailMaxBodyBytes: 524288,
    mailMaxComposeBytes: 204800,
    mailMaxSubjectBytes: 2048,
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

test('HTML helpers never expose javascript links', () => {
  assert.equal(htmlToSafeText('<b>Hello</b><script>bad()</script>'), 'Hello');
  assert.deepEqual(extractSafeLinks('https://ok.example/a', '<a href="javascript:bad()">x</a>'), ['https://ok.example/a']);
});
