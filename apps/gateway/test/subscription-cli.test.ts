import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investigationModelProviderForPreset, investigationProviderCatalog } from '@gotchu/contracts';
import { ModelProviderError, type ModelCompletionRequest } from '../src/model-port.js';
import { createSubscriptionCliPorts } from '../src/subscription-cli.js';

// Fake CLIs record what they received to a file baked into the script, because the adapter
// deliberately hands the child nothing but PATH and the credential.
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'gotchu-cli-test-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function fakeCli(name: string, body: string): Promise<{ binary: string; record: string }> {
  const binary = join(directory, name);
  const record = join(directory, `${name}.json`);
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const record = ${JSON.stringify(record)};
fs.writeFileSync(record, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), stdin }));
${body}
`);
  await chmod(binary, 0o700);
  return { binary, record };
}

function request(presetId: 'claude_code' | 'codex', apiKey: string, extra: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  const preset = investigationProviderCatalog.find(item => item.id === presetId);
  if (!preset?.baseUrl || !preset.defaultModelId) throw new Error('preset fixture');
  return {
    provider: investigationModelProviderForPreset(preset), providerPresetId: preset.id, endpoint: new URL(preset.baseUrl),
    modelId: preset.defaultModelId, apiKey, systemInstruction: 'Return JSON only.', userContext: '{"evidence":"untrusted"}',
    maxOutputTokens: 512, signal: AbortSignal.timeout(10_000), ...extra,
  };
}

const claudeToken = `sk-ant-oat01-${'a'.repeat(40)}`;
const codexAuth = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: '2026-10-20T00:00:00Z',
  tokens: { id_token: 'id-fixture', access_token: 'access-fixture', refresh_token: 'refresh-fixture', account_id: 'account-fixture' } });

describe('Claude Code subscription adapter', () => {
  it('runs claude headless with no tools, an isolated home, and the OAuth token only', async () => {
    const { binary, record } = await fakeCli('claude-ok', `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: '\`\`\`json\\n{"ok":true}\\n\`\`\`', usage: { input_tokens: 400, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 9 } }));`);
    const port = createSubscriptionCliPorts({ claudeCodeBinary: binary }).claudeCode;
    await expect(port.complete(request('claude_code', claudeToken))).resolves.toEqual({ output: { ok: true }, inputTokens: 415, outputTokens: 9 });

    const seen = JSON.parse(await readFile(record, 'utf8'));
    expect(seen.argv).toEqual(['-p', '--output-format', 'json', '--model', 'claude-sonnet-5-5', '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', 'Return JSON only.']);
    expect(Object.keys(seen.env).sort()).toEqual(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'PATH']);
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(claudeToken);
    expect(seen.env.HOME.startsWith(tmpdir())).toBe(true);
    expect(seen.cwdEntries).toEqual([]);
    expect(seen.stdin).toBe('{"evidence":"untrusted"}');
    await expect(stat(seen.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps the CLI API error status so the probe can name the cause', async () => {
    const { binary } = await fakeCli('claude-401', `process.stdout.write(JSON.stringify({ type: 'result', is_error: true, api_error_status: 401,
      result: 'Failed to authenticate.' })); process.exitCode = 1;`);
    const port = createSubscriptionCliPorts({ claudeCodeBinary: binary }).claudeCode;
    await expect(port.complete(request('claude_code', claudeToken))).rejects.toMatchObject({ code: 'request_failed', status: 401 });
  });

  it('reports a missing CLI distinctly from a provider failure', async () => {
    const port = createSubscriptionCliPorts({ claudeCodeBinary: join(directory, 'not-installed') }).claudeCode;
    await expect(port.complete(request('claude_code', claudeToken))).rejects.toMatchObject({ code: 'cli_unavailable' });
  });

  it('kills the CLI when the call is cancelled', async () => {
    const { binary } = await fakeCli('claude-hang', 'setInterval(() => {}, 1_000);');
    const port = createSubscriptionCliPorts({ claudeCodeBinary: binary }).claudeCode;
    const controller = new AbortController();
    const pending = port.complete(request('claude_code', claudeToken, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toBeInstanceOf(ModelProviderError);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('Codex subscription adapter', () => {
  it('runs codex exec read-only with tools disabled and persists rotated tokens', async () => {
    const { binary, record } = await fakeCli('codex-ok', `const auth = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8'));
      auth.tokens.refresh_token = 'refresh-rotated';
      fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify(auth));
      const instructions = fs.readFileSync(process.env.CODEX_HOME + '/instructions.md', 'utf8');
      console.log('WARN a stray diagnostic line that is not JSON');
      for (const event of [{ type: 'thread.started' }, { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Working on it.' } },
        { type: 'item.completed', item: { type: 'agent_message', text: instructions === 'Return JSON only.' ? '{"ok":true}' : 'wrong' } },
        { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 12 } }]) console.log(JSON.stringify(event));`);
    const persisted: string[] = [];
    const port = createSubscriptionCliPorts({ codexBinary: binary }).codex;
    await expect(port.complete(request('codex', codexAuth, { persistCredential: async next => { persisted.push(next); } })))
      .resolves.toEqual({ output: { ok: true }, inputTokens: 5000, outputTokens: 12 });

    const seen = JSON.parse(await readFile(record, 'utf8'));
    expect(seen.argv).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '-m', 'gpt-6-luna', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"']));
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use']) {
      expect(seen.argv.join(' ')).toContain(`--disable ${feature}`);
    }
    expect(Object.keys(seen.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    expect(seen.stdin).toBe('{"evidence":"untrusted"}');
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0] ?? '').tokens.refresh_token).toBe('refresh-rotated');
  });

  it('keeps rotated tokens even when the turn fails, and maps the failure status', async () => {
    const { binary } = await fakeCli('codex-fail', `const auth = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8'));
      auth.tokens.access_token = 'access-rotated';
      fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify(auth));
      console.log(JSON.stringify({ type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"code":"model_not_found"}}' } }));
      process.exitCode = 1;`);
    const persisted: string[] = [];
    const port = createSubscriptionCliPorts({ codexBinary: binary }).codex;
    await expect(port.complete(request('codex', codexAuth, { persistCredential: async next => { persisted.push(next); } })))
      .rejects.toMatchObject({ code: 'request_failed', status: 404 });
    expect(persisted).toHaveLength(1);
  });

  it('rejects a credential that is not a ChatGPT auth.json before starting the CLI', async () => {
    const { binary, record } = await fakeCli('codex-unused', '');
    const port = createSubscriptionCliPorts({ codexBinary: binary }).codex;
    await expect(port.complete(request('codex', '{"OPENAI_API_KEY":"sk-test"}'))).rejects.toMatchObject({ code: 'request_failed', status: 401 });
    await expect(stat(record)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a request whose endpoint differs from the preset', async () => {
    const { binary } = await fakeCli('codex-endpoint', '');
    const port = createSubscriptionCliPorts({ codexBinary: binary }).codex;
    await expect(port.complete(request('codex', codexAuth, { endpoint: new URL('https://example.com/v1') })))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
