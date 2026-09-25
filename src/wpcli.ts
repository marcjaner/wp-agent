import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { executeMutation, hashPayload, insidePolicyExecution, type ProposedAction } from './policy.js';
import { siteUrl } from './wordpress.js';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

// Nouns that may precede a read verb, as in `post meta get` or `theme mod list`.
const readNouns = new Set(['cap', 'cli', 'comment', 'core', 'cron', 'event', 'item', 'language', 'location', 'media', 'menu', 'meta', 'mod', 'network', 'option', 'plugin', 'post', 'post-type', 'role', 'rewrite', 'schedule', 'sidebar', 'site', 'taxonomy', 'term', 'theme', 'transient', 'user', 'widget']);
const readVerbs = new Set(['check-update', 'count', 'exists', 'get', 'is-active', 'is-installed', 'list', 'path', 'pluck', 'search', 'status', 'version']);
// Global flags that run PHP make any command a mutation; flags that retarget WP-CLI are refused.
const codeFlags = new Set(['exec', 'require']);
const refusedFlags = new Set(['http', 'path', 'prompt', 'ssh']);
const readEval = [
  'echo get_stylesheet();',
  '$p = wp_get_custom_css_post(); echo base64_encode($p ? $p->post_content : "");',
  '$p = wp_get_custom_css_post(); echo $p ? $p->ID : "";',
];

export type WpCliAccess = { readOnly: boolean; refused?: string };

export function classifyWpCli(args: string[]): WpCliAccess {
  const flags = args.filter(arg => arg.startsWith('--')).map(arg => arg.slice(2).split('=')[0]);
  const refused = flags.find(flag => refusedFlags.has(flag));
  if (refused) return { readOnly: false, refused: `--${refused} is not allowed; wp-agent runs WP-CLI against the configured site.` };
  const words = args.filter(arg => !arg.startsWith('-'));
  if (!words.length) return { readOnly: false, refused: 'Provide a WP-CLI command.' };
  if (words[0] === 'shell' || words[0] === 'db' && words[1] === 'cli') return { readOnly: false, refused: 'Interactive WP-CLI commands are not supported.' };
  if (flags.some(flag => codeFlags.has(flag))) return { readOnly: false };
  if (args.length === 2 && args[0] === 'eval' && readEval.includes(args[1])) return { readOnly: true };
  if (words[0] === 'help') return { readOnly: true };
  const verb = words.findIndex(word => readVerbs.has(word));
  return { readOnly: verb > 0 && words.slice(0, verb).every(word => readNouns.has(word)) };
}

export function wpCliAction(tool: string, args: string[], input: Record<string, unknown> = { args }): ProposedAction {
  return { tool, category: 'raw', mutation: true, target: { type: 'wp-cli', id: args.find(arg => !arg.startsWith('-')) || 'unknown' }, reversible: 'partial', input: { ...input, argsHash: hashPayload(args) } };
}

export async function remoteWp(args: string[]): Promise<string> {
  const access = classifyWpCli(args);
  if (access.refused) throw new Error(access.refused);
  if (!access.readOnly && !insidePolicyExecution()) {
    return executeMutation(wpCliAction('wp-cli.raw', args, { command: args.slice(0, 2).map((value, index) => index === 1 && args[0] === 'eval' ? '[code]' : value) }), () => remoteWp(args), { site: siteUrl(), interactive: !process.argv.includes('--json') });
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
