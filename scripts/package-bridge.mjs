import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

fs.rmSync('wp-agent-bridge.zip', { force: true });
execFileSync('zip', ['-q', '-r', 'wp-agent-bridge.zip', 'wp-agent-bridge']);
console.log('wp-agent-bridge.zip');
