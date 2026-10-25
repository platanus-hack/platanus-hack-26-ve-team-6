import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  investigationModelEndpointSchema,
  investigationModelProviderForPreset,
  investigationProviderCatalog,
  parseSubscriptionCredential,
} from '@gotchu/contracts';
import { ModelProviderError, type ModelCompletion, type ModelCompletionRequest, type ModelPort } from './model-port.js';

/**
 * Runs the official Claude Code and Codex CLIs headless with the customer's own subscription
 * login. Every call gets a fresh private home and an empty working directory, all built-in
 * tools are disabled, and only PATH plus the credential reach the child environment.
 */
export interface SubscriptionCliOptions {
  readonly claudeCodeBinary?: string;
  readonly codexBinary?: string;
  /** PATH for the child; Codex ships as a Node script and needs `node` on it. */
  readonly path?: string;
}

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 8_192;
const SCRATCH_DIRECTORY_PREFIX = 'gotchu-model-cli-';
const SCRATCH_DIRECTORY_MAX_AGE_MS = 10 * 60 * 1_000;

export async function cleanupStaleSubscriptionCliScratchDirectories(): Promise<void> {
  try {
    const owner = process.getuid?.();
    if (owner === undefined) return;
    const cutoff = Date.now() - SCRATCH_DIRECTORY_MAX_AGE_MS;
    const entries = await readdir(tmpdir());
    await Promise.all(entries.filter(name => name.startsWith(SCRATCH_DIRECTORY_PREFIX)).map(async name => {
      const path = join(tmpdir(), name);
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.uid !== owner || info.mtimeMs >= cutoff) return;
        await rm(path, { recursive: true, force: true });
      } catch { /* Startup cleanup is best-effort; a failed removal must not prevent the gateway starting. */ }
    }));
  } catch { /* An unavailable temporary directory must not prevent the gateway starting. */ }
}

// Fail closed: Codex rejects unknown feature names, so a renamed tool cannot silently stay enabled.
const codexDisabledFeatures = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'image_generation',
  'view_image', 'browser_use', 'computer_use', 'hooks',
] as const;

interface CliOutput { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }

function runCli(binary: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; stdin: string; signal: AbortSignal;
}): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(new ModelProviderError('aborted')); return; }
    // detached: the CLI is the leader of its own process group, so aborting kills its helpers too.
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure: ModelProviderError | undefined;
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const onAbort = () => { failure ??= new ModelProviderError('aborted'); kill(); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) { failure ??= new ModelProviderError('invalid_response'); kill(); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES); });
    child.stdin.on('error', () => undefined);
    child.once('error', error => {
      options.signal.removeEventListener('abort', onAbort);
      reject('code' in error && error.code === 'ENOENT' ? new ModelProviderError('cli_unavailable') : new ModelProviderError('request_failed'));
    });
    child.once('close', exitCode => {
      options.signal.removeEventListener('abort', onAbort);
      if (failure) { reject(failure); return; }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr, exitCode });
    });
    child.stdin.end(options.stdin);
  });
}

async function withScratchDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), SCRATCH_DIRECTORY_PREFIX));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** CLIs sometimes wrap the requested JSON in a Markdown fence; accept exactly one fenced block. */
function parseJsonReply(text: string): unknown {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  try {
    const parsed: unknown = JSON.parse(fenced?.[1] ?? text);
    return parsed;
  } catch { throw new ModelProviderError('invalid_response'); }
}

function assertPreset(request: ModelCompletionRequest, adapterKind: 'claude_code_cli' | 'codex_cli') {
  const preset = investigationProviderCatalog.find(item => item.id === request.providerPresetId);
  const endpoint = investigationModelEndpointSchema.safeParse(request.endpoint.href);
  if (!preset || preset.adapterKind !== adapterKind || request.provider !== investigationModelProviderForPreset(preset)
    || preset.baseUrl === null || !endpoint.success || endpoint.data !== new URL(preset.baseUrl).href) {
    throw new ModelProviderError('invalid_response');
  }
}

const claudeResultSchema = z.object({
  type: z.literal('result'),
  is_error: z.boolean(),
  result: z.string().optional(),
  api_error_status: z.number().int().nullable().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

function claudeCodeAdapter(binary: string, path: string): ModelPort {
  return {
    async complete(request) {
      assertPreset(request, 'claude_code_cli');
      if (!request.apiKey) throw new ModelProviderError('request_failed', 401);
      const token = request.apiKey;
      return withScratchDirectory(async directory => {
        const home = join(directory, 'home');
        const work = join(directory, 'work');
        await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
        const run = await runCli(binary, [
          '-p', '--output-format', 'json', '--model', request.modelId,
          '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
          '--system-prompt', request.systemInstruction,
        ], {
          cwd: work, stdin: request.userContext, signal: request.signal,
          env: {
            PATH: path, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_OAUTH_TOKEN: token,
            // Claude Code fails rather than truncates above this cap, so leave room for a short JSON reply.
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.max(256, request.maxOutputTokens)),
            DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        });
        let raw: unknown;
        try { raw = JSON.parse(run.stdout); }
        catch { throw new ModelProviderError(run.exitCode === 0 ? 'invalid_response' : 'request_failed'); }
        const result = claudeResultSchema.safeParse(raw);
        if (!result.success) throw new ModelProviderError('invalid_response');
        if (result.data.is_error) throw new ModelProviderError('request_failed', result.data.api_error_status ?? undefined);
        const usage = result.data.usage;
        if (!usage) throw new ModelProviderError('missing_usage');
        if (!result.data.result) throw new ModelProviderError('invalid_response');
        return {
          output: parseJsonReply(result.data.result),
          inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        } satisfies ModelCompletion;
      });
    },
  };
}

const codexEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item.completed'), item: z.object({ type: z.string(), text: z.string().optional() }).passthrough() }).passthrough(),
  z.object({ type: z.literal('turn.completed'), usage: z.object({
    input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  }).passthrough() }).passthrough(),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }).passthrough() }).passthrough(),
]);

/** Codex reports provider failures as text, e.g. `{"status":400,...}` or `unauthorized (401)`. */
function codexFailureStatus(message: string): number | undefined {
  if (message.includes('model_not_found')) return 404;
  const status = /"status"\s*:\s*(\d{3})/.exec(message)?.[1] ?? /\((\d{3})\)/.exec(message)?.[1];
  return status ? Number(status) : undefined;
}

function codexAdapter(binary: string, path: string): ModelPort {
  return {
    async complete(request) {
      assertPreset(request, 'codex_cli');
      const credential = request.apiKey ? parseSubscriptionCredential('codex', request.apiKey) : null;
      if (!credential) throw new ModelProviderError('request_failed', 401);
      return withScratchDirectory(async directory => {
        const home = join(directory, 'home');
        const codexHome = join(directory, 'codex');
        const work = join(directory, 'work');
        await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(codexHome, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
        const authFile = join(codexHome, 'auth.json');
        const instructionsFile = join(codexHome, 'instructions.md');
        await Promise.all([
          writeFile(authFile, credential, { mode: 0o600, flag: 'wx' }),
          writeFile(instructionsFile, request.systemInstruction, { mode: 0o600, flag: 'wx' }),
        ]);
        let run: CliOutput;
        try {
          // Codex 0.163 ignores model_max_output_tokens; the gateway relies on its input estimate.
          run = await runCli(binary, [
            'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
            '--sandbox', 'read-only', '--color', 'never', '-C', work, '-m', request.modelId,
            ...codexDisabledFeatures.flatMap(feature => ['--disable', feature]),
            '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
            '-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`,
            '-',
          ], { cwd: work, stdin: request.userContext, signal: request.signal, env: { PATH: path, HOME: home, CODEX_HOME: codexHome } });
        } finally {
          // Codex rotates its refresh token in place; losing the new one would log the workspace out.
          const next = await readFile(authFile, 'utf8').catch(() => null);
          const refreshed = next === null ? null : parseSubscriptionCredential('codex', next);
          if (refreshed !== null && refreshed !== credential) await request.persistCredential?.(refreshed);
        }
        if (run.stderr.includes('Unknown feature flag')) throw new ModelProviderError('cli_unavailable');
        let reply: string | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let completedTurns = 0;
        let failure: string | undefined;
        for (const line of run.stdout.split('\n')) {
          if (!line.trim()) continue;
          let raw: unknown;
          // Only JSONL events matter; ignore any stray diagnostic line instead of failing the call.
          try { raw = JSON.parse(line); }
          catch { continue; }
          const event = codexEventSchema.safeParse(raw);
          if (!event.success) continue;
          if (event.data.type === 'item.completed') {
            if (event.data.item.type === 'agent_message' && event.data.item.text) reply = event.data.item.text;
          } else if (event.data.type === 'turn.completed') {
            completedTurns += 1;
            inputTokens += event.data.usage.input_tokens;
            outputTokens += event.data.usage.output_tokens;
          } else {
            failure = event.data.error.message;
          }
        }
        if (failure !== undefined) throw new ModelProviderError('request_failed', codexFailureStatus(failure));
        if (run.exitCode !== 0) throw new ModelProviderError('request_failed');
        if (completedTurns === 0) throw new ModelProviderError('missing_usage');
        if (!reply) throw new ModelProviderError('invalid_response');
        return { output: parseJsonReply(reply), inputTokens, outputTokens } satisfies ModelCompletion;
      });
    },
  };
}

export function createSubscriptionCliPorts(options: SubscriptionCliOptions = {}) {
  const path = options.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    claudeCode: claudeCodeAdapter(options.claudeCodeBinary ?? 'claude', path),
    codex: codexAdapter(options.codexBinary ?? 'codex', path),
  };
}
