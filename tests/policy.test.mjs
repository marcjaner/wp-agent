import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateStatic, evaluatePolicy, executeMutation, readSession, redact, startSession, PolicyDecisionError } from '../dist/policy.js';
import { WordPress } from '../dist/wordpress.js';
import { BridgeClient } from '../dist/bridge.js';

const site = 'https://example.test/';
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-policy-')), 'session.json');
const action = (tool, target, extras = {}) => ({ tool, category: 'content', mutation: true, target, reversible: 'reversible', ...extras });
const page = (id, status, origin) => ({ type: 'page', id, status, origin });

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
