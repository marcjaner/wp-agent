import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluateStatic, evaluatePolicy, executeMutation, readSession, recordRead, redact, startSession, PolicyDecisionError } from '../dist/policy.js';
import { WordPress } from '../dist/wordpress.js';
import { BridgeClient } from '../dist/bridge.js';
import { normalizeSiteUrl } from '../dist/site-url.js';

const site = 'https://example.test/';
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-policy-')), 'session.json');
const action = (tool, target, extras = {}) => ({ tool, category: 'content', mutation: true, target, reversible: 'reversible', ...extras });
const page = (id, status, origin) => ({ type: 'page', id, status, origin });
const execFileAsync = promisify(execFile);

test('static policy distinguishes reads, owned drafts, existing published pages, and deletion', () => {
  const file = tempFile();
  const session = startSession('Create a new draft.', 'production', site, file);
  session.resources['page:105'] = { origin: 'session', createdBy: 'a1', status: 'draft' };
  assert.equal(evaluateStatic(action('pages.get', page(42, 'publish'), { mutation: false }), session).decision, 'allow');
  assert.equal(evaluateStatic(action('pages.update', page(105, 'draft')), session).decision, 'allow');
  assert.equal(evaluateStatic(action('pages.delete', page(105, 'draft'), { reversible: 'partial' }), session).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(action('pages.update', page(42, 'publish')), session).decision, 'require_approval');
  assert.equal(evaluateStatic(action('pages.delete', page(42, 'publish'), { reversible: 'partial' }), session).decision, 'require_approval');
  assert.equal(evaluateStatic(action('pages.update', page(105, 'draft'), { intent: { status: 'publish' } }), session).decision, 'require_approval');
  assert.equal(evaluateStatic(action('pages.update', page(105, 'draft'), { intent: { status: 'future' } }), session).decision, 'require_approval');
  assert.equal(evaluateStatic(action('pages.update', page(105, 'draft'), { intent: { status: 'trash' } }), session).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(action('pages.delete', page(42, 'draft'), { intent: { count: 5 }, reversible: 'partial' }), session).staticRisk, 'critical');
  assert.equal(evaluateStatic(action('pages.bulk-delete', page(42, 'draft'), { intent: { count: 5 }, reversible: 'partial' }), session).staticRisk, 'critical');
  assert.equal(evaluateStatic(action('theme.activate', { type: 'theme', id: 'other' }, { category: 'theme' }), session).staticRisk, 'critical');
  assert.equal(evaluateStatic(action('custom-css.set', { type: 'custom-css', id: 'theme' }, { category: 'site_config' }), session).decision, 'require_approval');
});

test('environment changes site-wide and published-page decisions', () => {
  const sessions = Object.fromEntries(['disposable', 'staging', 'production'].map(env => [env, startSession('Change layout.', env, site, tempFile())]));
  const css = action('custom-css.set', { type: 'custom-css', id: 'theme' }, { category: 'site_config' });
  const published = action('pages.update', page(42, 'publish'));
  assert.equal(evaluateStatic(css, sessions.disposable).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(css, sessions.staging).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(css, sessions.production).decision, 'require_approval');
  assert.equal(evaluateStatic(published, sessions.disposable).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(published, sessions.staging).decision, 'allow_with_snapshot');
  assert.equal(evaluateStatic(published, sessions.production).decision, 'require_approval');
});

test('cloning tracks the source as read and the draft as created', async () => {
  const file = tempFile();
  startSession('Clone a published page into a draft.', 'production', site, file);
  await executeMutation(action('pages.clone', { type: 'page', status: 'draft' }, { source: page(42, 'publish'), intent: { sourceId: 42 } }), async () => ({ id: 105, status: 'draft' }), { file, site, provider: null, created: result => page(result.id, result.status) });
  const journal = readSession(file);
  assert.equal(journal.resources['page:42'].origin, 'preexisting');
  assert.equal(journal.resources['page:42'].modifiedBy, undefined);
  assert.equal(journal.resources['page:105'].origin, 'session');
  assert.equal(journal.actions[0].source.id, 42);
  assert.equal(journal.actions[0].result.created.id, 105);
});

test('Jev can raise but never lower a deterministic decision', async () => {
  const session = startSession('Create a draft from page 42.', 'production', site, tempFile());
  const suspicious = { classify: async () => ({ classification: 'suspicious', intentMismatch: true, confidence: 0.96, reason: 'Goal mismatch.' }) };
  const consistent = { classify: async () => ({ classification: 'consistent', intentMismatch: false, confidence: 0.98, reason: 'Fits goal.' }) };
  const existingDraft = action('pages.update', page(42, 'draft'));
  assert.equal((await evaluatePolicy(existingDraft, session, suspicious)).decision, 'require_approval');
  assert.equal((await evaluatePolicy(action('pages.delete', page(42, 'publish'), { reversible: 'partial' }), session, consistent)).decision, 'require_approval');
  const failed = { classify: async () => { throw new Error('timeout'); } };
  assert.equal((await evaluatePolicy(existingDraft, session, failed)).decision, 'require_approval');
  const invalid = { classify: async () => ({ classification: 'consistent' }) };
  assert.equal((await evaluatePolicy(existingDraft, session, invalid)).decision, 'require_approval');
  const owned = action('pages.update', page(105, 'draft', 'session'));
  session.resources['page:105'] = { origin: 'session', status: 'draft' };
  assert.equal((await evaluatePolicy(owned, session, failed)).decision, 'allow');
  assert.equal((await evaluatePolicy(existingDraft, session, null)).decision, 'allow_with_snapshot');
  assert.equal((await evaluatePolicy(action('media.upload', { type: 'media' }, { category: 'media' }), session, failed)).decision, 'allow');
});

test('journal records creation, snapshots, decisions, failures, and redacts secrets', async () => {
  const file = tempFile();
  startSession('Create a draft.', 'production', site, file);
  const created = await executeMutation(action('pages.create', { type: 'page', status: 'draft' }, { input: { apiKey: 'secret', note: 'Bearer abcdefghijklmnop' } }), async () => ({ id: 105, status: 'draft' }), { file, site, provider: null, created: result => page(result.id, result.status) });
  assert.equal(created.id, 105);
  let ran = false;
  await assert.rejects(() => executeMutation(action('pages.delete', page(42, 'publish'), { reversible: 'partial' }), async () => { ran = true; }, { file, site, provider: null }), PolicyDecisionError);
  assert.equal(ran, false);
  let snapshotCount = 0;
  await executeMutation(action('pages.update', page(42, 'draft')), async () => 'updated', { file, site, provider: null, snapshot: () => { snapshotCount++; return '/tmp/snapshot.json'; } });
  const journal = readSession(file);
  assert.equal(journal.resources['page:105'].origin, 'session');
  assert.equal(journal.actions.length, 3);
  assert.equal(journal.actions[0].input.apiKey, '[REDACTED]');
  assert.equal(journal.actions[0].input.note, '[REDACTED]');
  assert.equal(journal.actions[1].result.success, false);
  assert.equal(journal.actions[2].result.snapshot, '/tmp/snapshot.json');
  assert.equal(snapshotCount, 1);
  assert.equal(redact({ password: 'x', nested: { authorization: 'y' } }).nested.authorization, '[REDACTED]');
  await assert.rejects(() => executeMutation(action('pages.update', page(42, 'draft')), async () => { throw new Error('Backend failed'); }, { file, site, provider: null, snapshot: () => '/tmp/recover.json' }), error => error.snapshot === '/tmp/recover.json');
  assert.equal(readSession(file).actions.at(-1).result.snapshot, '/tmp/recover.json');
});

test('short app passwords do not corrupt the saved site or approval retry', async () => {
  const file = tempFile();
  const site = 'https://lavendel.example/';
  const previousPassword = process.env.WP_APP_PASSWORD;
  process.env.WP_APP_PASSWORD = 'lave';
  try {
    startSession('Publish a page.', 'production', site, file);
    assert.equal(readSession(file).environment.site, site);
    recordRead('pages.get', page(42, 'publish'), site, { note: 'lave is a secret' }, file);
    assert.equal(readSession(file).environment.site, site);
    assert.equal(readSession(file).actions[0].input.note, '[REDACTED] is a secret');

    const proposal = action('pages.update', page(42, 'publish'), { input: { changesHash: 'change-a', beforeHash: 'page-a' } });
    let requestId;
    await assert.rejects(() => executeMutation(proposal, async () => { throw new Error('must not run'); }, { site, file, provider: null }), error => {
      requestId = error.action.id;
      return error instanceof PolicyDecisionError;
    });
    assert.equal(readSession(file).environment.site, site);
    assert.equal(await executeMutation(proposal, async () => 'updated', { site, file, provider: null, approval: { requestId, note: 'Approved in chat' } }), 'updated');
    assert.equal(readSession(file).actions.at(-1).approval.requestId, requestId);
  } finally {
    if (previousPassword === undefined) delete process.env.WP_APP_PASSWORD;
    else process.env.WP_APP_PASSWORD = previousPassword;
  }
});

test('starting a new session archives a legacy journal without a site', () => {
  const file = tempFile();
  const legacy = {
    sessionId: 'legacy-session',
    goal: 'Inspect an old site.',
    environment: { type: 'production' },
    startedAt: '2025-01-01T00:00:00.000Z',
    resources: {},
    actions: [],
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.throws(() => recordRead('pages.get', page(42, 'publish'), site, {}, file), /Legacy session has no site/);
  const current = startSession('Inspect the configured site.', 'production', site, file);
  const archive = path.join(path.dirname(file), 'sessions', `${legacy.sessionId}.json`);
  assert.deepEqual(readSession(archive), legacy);
  assert.equal(readSession(file).sessionId, current.sessionId);
  assert.equal(readSession(file).environment.site, site);
  recordRead('pages.get', page(42, 'publish'), site, {}, file);
  assert.equal(readSession(file).actions.length, 1);
});

test('site identities reject credential-bearing URLs before they reach the journal', () => {
  const invalid = [
    'https://user:password@example.test/',
    'https://example.test/?token=secret',
    'https://example.test/#secret',
    'file:///tmp/wordpress',
  ];
  for (const url of invalid) {
    assert.throws(() => normalizeSiteUrl(url));
    assert.throws(() => startSession('Inspect.', 'production', url, tempFile()));
    assert.throws(() => new WordPress(url, { user: 'test', appPassword: 'test' }));
  }
});

test('agent approval retries one exact denied action and records its source', async () => {
  const file = tempFile();
  const session = startSession('Publish the reviewed draft.', 'production', site, file);
  const proposal = action('pages.update', page(105, 'draft'), { intent: { status: 'publish' }, input: { changesHash: 'content-a', beforeHash: 'draft-a' } });
  let request;
  await assert.rejects(() => executeMutation(proposal, async () => { throw new Error('must not run'); }, { file, site, provider: null }), error => {
    assert.ok(error instanceof PolicyDecisionError);
    assert.equal(error.sessionId, session.sessionId);
    request = error.action.id;
    return true;
  });
  let calls = 0;
  const approved = { requestId: request, note: 'User approved publication in chat' };
  assert.equal(await executeMutation(proposal, async () => { calls++; return 'published'; }, { file, site, provider: null, approval: approved }), 'published');
  assert.equal(calls, 1);
  const journal = readSession(file);
  assert.equal(journal.actions[0].id, request);
  assert.equal(journal.actions[1].approval.requestId, request);
  assert.equal(journal.actions[1].approval.note, approved.note);
  assert.equal(journal.actions[1].result.success, true);
  await assert.rejects(() => executeMutation(proposal, async () => { calls++; }, { file, site, provider: null, approval: approved }), PolicyDecisionError);
  assert.equal(calls, 1);
});

test('agent approval rejects changed payloads and remains usable for the original action', async () => {
  const file = tempFile();
  startSession('Publish a draft.', 'production', site, file);
  const original = action('pages.update', page(105, 'draft'), { intent: { status: 'publish' }, input: { changesHash: 'content-a', beforeHash: 'draft-a' } });
  let request;
  await assert.rejects(() => executeMutation(original, async () => undefined, { file, site, provider: null }), error => { request = error.action.id; return error instanceof PolicyDecisionError; });
  const approval = { requestId: request, note: 'Approved in chat' };
  let calls = 0;
  const changed = action('pages.update', page(105, 'draft'), { intent: { status: 'publish' }, input: { changesHash: 'content-b', beforeHash: 'draft-a' } });
  await assert.rejects(() => executeMutation(changed, async () => { calls++; }, { file, site, provider: null, approval }), PolicyDecisionError);
  assert.equal(calls, 0);
  assert.equal(await executeMutation(original, async () => { calls++; return 'ok'; }, { file, site, provider: null, approval }), 'ok');
  assert.equal(calls, 1);
});

test('agent approval cannot cross sessions or approve uninspectable raw bodies', async () => {
  const file = tempFile();
  startSession('Raw mutation.', 'production', site, file);
  const proposal = action('rest.raw', { type: 'rest-route', id: 'wp/v2/pages' }, { category: 'raw', input: { bodyHash: 'x', agentApprovalUnsupported: true } });
  let request;
  await assert.rejects(() => executeMutation(proposal, async () => undefined, { file, site, provider: null }), error => { request = error.action.id; return error instanceof PolicyDecisionError; });
  let calls = 0;
  await assert.rejects(() => executeMutation(proposal, async () => { calls++; }, { file, site, provider: null, approval: { requestId: request, note: 'Approved in chat' } }), PolicyDecisionError);
  assert.equal(calls, 0);
  const otherFile = tempFile();
  startSession('Raw mutation.', 'production', site, otherFile);
  await assert.rejects(() => executeMutation({ ...proposal, input: { bodyHash: 'x' } }, async () => { calls++; }, { file: otherFile, site, provider: null, approval: { requestId: request, note: 'Approved in chat' } }), PolicyDecisionError);
  assert.equal(calls, 0);
});

test('JSON CLI retries an approved page update without an interactive prompt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-cli-approval-'));
  const file = path.join(directory, 'session.json');
  let writes = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/wp-json/wp/v2/pages/105?context=edit') {
      response.end(JSON.stringify({ id: 105, status: 'draft', slug: 'draft', link: '', template: '', parent: 0, featured_media: 0, menu_order: 0, comment_status: 'closed', modified: '2026-09-24T00:00:00', title: { raw: 'Draft', rendered: 'Draft' }, content: { raw: '<p>Draft</p>', rendered: '<p>Draft</p>' }, meta: {} }));
    } else if (request.method === 'POST' && request.url === '/wp-json/wp/v2/pages/105') {
      writes++;
      response.end(JSON.stringify({ id: 105, status: 'publish', slug: 'draft', link: '', template: '', parent: 0, featured_media: 0, menu_order: 0, comment_status: 'closed', modified: '2026-09-24T00:00:01', title: { raw: 'Draft', rendered: 'Draft' }, content: { raw: '<p>Draft</p>', rendered: '<p>Draft</p>' }, meta: {} }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const env = { ...process.env, WP_URL: url, WP_USER: 'test', WP_APP_PASSWORD: 'test', WP_AGENT_SESSION_FILE: file, TYPESAFE_API_KEY: '' };
  try {
    startSession('Publish the draft.', 'production', url, file);
    let denial;
    try { await execFileAsync(process.execPath, [cli, '--json', 'pages', 'update', '105', '--publish'], { cwd: directory, env }); }
    catch (error) { denial = JSON.parse(error.stderr); }
    assert.equal(denial.error.policy.decision, 'require_approval');
    assert.equal(writes, 0);
    const result = await execFileAsync(process.execPath, [cli, '--json', '--approval-request', denial.error.approvalRequestId, '--approval-note', 'Approved in chat', 'pages', 'update', '105', '--publish'], { cwd: directory, env });
    assert.equal(JSON.parse(result.stdout).status, 'publish');
    assert.equal(writes, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('raw REST mutations stop before HTTP while reads stay available', async () => {
  const file = tempFile();
  const previousFile = process.env.WP_AGENT_SESSION_FILE;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.WP_AGENT_SESSION_FILE = file;
  process.env.TYPESAFE_API_KEY = '';
  try {
    startSession('Inspect a page.', 'production', site, file);
    const client = new WordPress(site, { user: 'test', appPassword: 'test' });
    await assert.rejects(() => client.post('wp/v2/pages/42', { title: 'No write' }), PolicyDecisionError);
    assert.equal(readSession(file).actions.at(-1).tool, 'rest.raw');
  } finally {
    if (previousFile === undefined) delete process.env.WP_AGENT_SESSION_FILE;
    else process.env.WP_AGENT_SESSION_FILE = previousFile;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test('direct Bridge writes receive a semantic site-configuration decision', async () => {
  const file = tempFile();
  const previousFile = process.env.WP_AGENT_SESSION_FILE;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.WP_AGENT_SESSION_FILE = file;
  process.env.TYPESAFE_API_KEY = '';
  let posts = 0;
  try {
    startSession('Create a page draft.', 'production', site, file);
    const bridge = new BridgeClient({
      url: site,
      get: async route => route === 'wp-agent/v1/manifest' ? { bridgeVersion: '0.1.0', capabilities: ['customCss.read', 'customCss.write'] } : { stylesheet: 'theme', css: '', hash: 'hash', postId: 1 },
      post: async () => { posts++; return {}; },
    });
    await assert.rejects(() => bridge.writeCss('body{}', 'hash'), PolicyDecisionError);
    assert.equal(posts, 0);
    assert.equal(readSession(file).actions.at(-1).tool, 'custom-css.set');
  } finally {
    if (previousFile === undefined) delete process.env.WP_AGENT_SESSION_FILE;
    else process.env.WP_AGENT_SESSION_FILE = previousFile;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});
