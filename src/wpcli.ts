import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { executeMutation, hashPayload, insidePolicyExecution } from './policy.js';
import { siteUrl } from './wordpress.js';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export async function remoteWp(args: string[]): Promise<string> {
  const readEval = [
    'echo get_stylesheet();',
    '$p = wp_get_custom_css_post(); echo base64_encode($p ? $p->post_content : "");',
    '$p = wp_get_custom_css_post(); echo $p ? $p->ID : "";',
  ];
  const read = args.length === 2 && args[0] === 'core' && args[1] === 'version'
    || args[0] === 'option' && args[1] === 'get' && args[2] === 'generate_settings' && args[3] === '--format=json' && args.length === 4
    || args.length === 2 && args[0] === 'eval' && readEval.includes(args[1]);
  if (!read && !insidePolicyExecution()) {
    return executeMutation({ tool: 'wp-cli.raw', category: 'raw', mutation: true, target: { type: 'wp-cli', id: args[0] || 'unknown' }, reversible: 'partial', input: { command: args.slice(0, 2).map((value, index) => index === 1 && args[0] === 'eval' ? '[code]' : value), argsHash: hashPayload(args) } }, () => remoteWp(args), { site: siteUrl(), interactive: !process.argv.includes('--json') });
  }
  const { WP_SSH_HOST: host, WP_SSH_USER: user, WP_SSH_KEY_PATH: key, WP_SSH_PORT: port, WP_PATH: wpPath } = process.env;
  if (!host || !user || !key || !wpPath) throw new Error('WP-CLI needs WP_SSH_HOST, WP_SSH_USER, WP_SSH_KEY_PATH, and WP_PATH.');
  const remote = ['wp', `--path=${wpPath}`, ...args].map(quote).join(' ');
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', key, '-p', port || '22', `${user}@${host}`, remote];
  try {
    const result = await execFileAsync('ssh', sshArgs, { timeout: 60000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const result = error as Error & { stderr?: string };
    throw new Error(`WP-CLI failed: ${result.stderr?.trim() || result.message}`);
  }
}
