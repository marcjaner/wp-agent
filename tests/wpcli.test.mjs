import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyWpCli } from '../dist/wpcli.js';
import { readSession, startSession } from '../dist/policy.js';

const execFileAsync = promisify(execFile);
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const site = 'https://example.test/';

test('WP-CLI reads are limited to known command paths', () => {
  for (const args of [['post', 'list', '--post_type=page', '--format=json'], ['option', 'get', 'blogname'], ['post', 'meta', 'get', '12', 'key'], ['theme', 'mod', 'list'], ['core', 'version'], ['plugin', 'is-active', 'wpml'], ['help', 'post']])
    assert.equal(classifyWpCli(args).readOnly, true, args.join(' '));
  for (const code of [
    'echo get_stylesheet();',
    '$p = wp_get_custom_css_post(); echo base64_encode($p ? $p->post_content : "");',
    '$p = wp_get_custom_css_post(); echo $p ? $p->ID : "";',
  ]) assert.equal(classifyWpCli(['eval', code]).readOnly, true, code);
  for (const args of [['eval', 'echo 1;'], ['option', 'update', 'list', 'x'], ['post', 'update', '5', 'get'], ['search-replace', 'a', 'b'], ['db', 'query', 'SELECT 1'], ['list'], ['option', 'get', 'blogname', '--exec=wp_delete_post(1);'], ['cron', 'event', 'run', '--all'], ['post', 'is-active', '5'], ['plugin', 'random-plugin-verb'], ['post', 'meta', 'search', '5', 'needle'], ['post', 'list', 'unknown-subcommand'], ['option', 'get', 'blogname', 'unknown-subcommand']])
    assert.equal(classifyWpCli(args).readOnly, false, args.join(' '));
  assert.match(classifyWpCli(['post', 'list', '--ssh=other.host']).refused, /--ssh/);
  assert.match(classifyWpCli(['post', 'list', '--path=/elsewhere']).refused, /--path/);
  assert.match(classifyWpCli(['post', 'list', '--url=https://other.test/']).refused, /--url/);
  assert.match(classifyWpCli(['--url', 'https://other.test/', 'post', 'list']).refused, /--url/);
  assert.match(classifyWpCli(['post', 'list', '--config=other.yml']).refused, /--config/);
  assert.match(classifyWpCli(['shell']).refused, /Interactive/);
  assert.match(classifyWpCli(['db', 'cli']).refused, /Interactive/);
});

function fakeSsh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-wpcli-'));
  const log = path.join(directory, 'ssh.log');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho '[{"ID":1}]'\n`, { mode: 0o755 });
  const file = path.join(directory, 'session.json');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WP_URL: site, WP_USER: 'wpcli-user', WP_APP_PASSWORD: 'wpcli-app-password', WP_SSH_HOST: 'host.test', WP_SSH_USER: 'deploy', WP_SSH_KEY_PATH: '/dev/null', WP_SSH_PORT: '22', WP_PATH: '/srv/wp', WP_AGENT_SESSION_FILE: file, TYPESAFE_API_KEY: '' };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const run = args => execFileAsync(process.execPath, [cli, '--json', ...args], { cwd: directory, env });
  return { directory, file, calls, run };
}

test('wpcli runs reads directly and journals them', async () => {
  const ssh = fakeSsh();
  startSession('Inspect posts.', 'production', site, ssh.file);
  const result = JSON.parse((await ssh.run(['wpcli', 'post', 'list', '--format=json'])).stdout);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.args, ['post', 'list', '--format=json']);
  assert.deepEqual(result.data, [{ ID: 1 }]);
  assert.equal(ssh.calls().length, 1);
  assert.match(ssh.calls()[0], /'wp' '--path=\/srv\/wp' '--url=https:\/\/example\.test\/' 'post' 'list' '--format=json'/);
  assert.equal(readSession(ssh.file).actions.at(-1).tool, 'wpcli.run');
  const separated = JSON.parse((await ssh.run(['wpcli', '--', 'option', 'get', 'blogname'])).stdout);
  assert.deepEqual(separated.args, ['option', 'get', 'blogname']);
});

test('wpcli mutations stop before SSH and run once after an approval retry', async () => {
  const ssh = fakeSsh();
  startSession('Link a translation.', 'production', site, ssh.file);
  const command = ['wpcli', 'eval', 'do_action("wpml_set_element_language_details", []);'];
  let denial;
  try { await ssh.run(command); } catch (error) { denial = JSON.parse(error.stderr); }
  assert.equal(denial.error.code, 'policy_decision');
  assert.equal(denial.error.policy.decision, 'require_approval');
  assert.equal(denial.error.action.tool, 'wpcli.run');
  assert.deepEqual(denial.error.action.input.args, command.slice(1));
  assert.equal(ssh.calls().length, 0);
  let mismatch;
  try { await ssh.run(['--approval-request', denial.error.approvalRequestId, '--approval-note', 'Approved in chat', 'wpcli', 'eval', 'echo "different";']); } catch (error) { mismatch = JSON.parse(error.stderr); }
  assert.equal(mismatch.error.code, 'policy_decision');
  assert.equal(ssh.calls().length, 0);
  const approved = JSON.parse((await ssh.run(['--approval-request', denial.error.approvalRequestId, '--approval-note', 'Approved in chat', ...command])).stdout);
  assert.equal(approved.readOnly, false);
  assert.equal(ssh.calls().length, 1);
  assert.equal(readSession(ssh.file).actions.at(-1).approval.note, 'Approved in chat');
});

test('an unknown plugin command path needs approval before SSH', async () => {
  const ssh = fakeSsh();
  startSession('Inspect a plugin.', 'production', site, ssh.file);
  let denial;
  try { await ssh.run(['wpcli', 'plugin', 'custom-inspect', '--format=json']); } catch (error) { denial = JSON.parse(error.stderr); }
  assert.equal(denial.error.policy.decision, 'require_approval');
  assert.deepEqual(denial.error.action.input.args, ['plugin', 'custom-inspect', '--format=json']);
  assert.equal(ssh.calls().length, 0);
});

test('an unknown suffix after a read command needs approval before SSH', async () => {
  const ssh = fakeSsh();
  startSession('Inspect posts.', 'production', site, ssh.file);
  let denial;
  try { await ssh.run(['wpcli', 'post', 'list', 'unknown-subcommand']); } catch (error) { denial = JSON.parse(error.stderr); }
  assert.equal(denial.error.policy.decision, 'require_approval');
  assert.equal(ssh.calls().length, 0);
});

test('wpcli refuses retargeting flags without contacting the server', async () => {
  const ssh = fakeSsh();
  startSession('Inspect posts.', 'production', site, ssh.file);
  for (const args of [
    ['post', 'list', '--ssh=other.host'],
    ['post', 'list', '--url=https://other.test/'],
    ['--url', 'https://other.test/', 'post', 'list'],
    ['post', 'list', '--config=other.yml'],
  ]) {
    let refused;
    try { await ssh.run(['wpcli', ...args]); } catch (error) { refused = JSON.parse(error.stderr); }
    assert.match(refused.error.message, /is not allowed/, args.join(' '));
  }
  assert.equal(ssh.calls().length, 0);
});
