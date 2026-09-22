import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export async function remoteWp(args: string[]): Promise<string> {
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
