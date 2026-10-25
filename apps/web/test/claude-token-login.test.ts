import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startClaudeTokenLogin } from '../src/server/claude-token-login.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(unsafe = false) {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-claude-protocol-test-'));
  directories.push(directory);
  const binary = join(directory, 'claude');
  await writeFile(binary, `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
if (process.argv[2] !== 'setup-token' || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.HOME !== process.env.CLAUDE_CONFIG_DIR || process.cwd() !== process.env.HOME) process.exit(2);
execFileSync(process.env.BROWSER, [${JSON.stringify(unsafe ? 'https://attacker.invalid/oauth/authorize' : 'https://claude.com/cai/oauth/authorize?client_id=synthetic&state=synthetic&code_challenge=synthetic')}]);
process.stdout.write('Paste code here if prompted>');
process.stdin.on('data', chunk => {
  if (!chunk.toString().includes('synthetic-code-123456')) return;
  process.stdout.write('sk-ant-oat01-syntheticPartialToken123456');
  setTimeout(() => process.stdout.write('FinalPart7890\\n'), 20);
});
`, { mode: 0o700 });
  return binary;
}
describe('Claude token authorization (synthetic CLI protocol, real private PTY)', () => {
  it('opens the provider URL and imports the entire token only after the user authorizes', async () => {
    const login = await startClaudeTokenLogin(await fixture());
    expect(new URL(login.verificationUrl).origin).toBe('https://claude.com');
    expect(login.userCode).toBeUndefined(); expect(login.submitCode).toBeDefined();
    login.submitCode?.('synthetic-code-123456');
    expect(await login.credential).toBe('sk-ant-oat01-syntheticPartialToken123456FinalPart7890');
    await login.cancel();
  });

  it('rejects shell text and cancels without importing credentials', async () => {
    const login = await startClaudeTokenLogin(await fixture());
    expect(() => login.submitCode?.('anything\nrun-other-command')).toThrow('Pega el código');
    await login.cancel(); expect(await login.credential).toBeNull();
  });

  it('rejects a provider URL outside Claude before returning it to the browser', async () => {
    await expect(startClaudeTokenLogin(await fixture(true))).rejects.toMatchObject({ code: 'claude_login_unavailable' });
  });
});
