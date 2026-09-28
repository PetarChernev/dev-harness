import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Config, PermissionRuleset } from '@opencode-ai/sdk/v2';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RuntimeMessage, RuntimeStatus, StartWorker, WorkerHandle, WorkerRuntime } from './runtime.js';
import { WorkerStartError } from './runtime.js';
import { minimalEnv } from './commands.js';
import { packageRoot } from './profiles.js';
import { canonical, errorText, hash, identity, privateWrite, processState, redact, sleep } from './util.js';

type Client = ReturnType<typeof createOpencodeClient>;
const metadataSchema = z.object({ baseUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), secretFile: z.string(), pid: z.number().int().positive(), start: z.string().nullable(), model: z.object({ providerID: z.string(), modelID: z.string() }), agent: z.literal('harness_worker'), steps: z.number().int().positive() });
type Metadata = z.infer<typeof metadataSchema>;
const secretsSchema = z.object({ password: z.string(), token: z.string() }).strict();

export function workerPermissions(input: StartWorker): NonNullable<Config['permission']> {
  const readOnly = input.readOnly || input.policy.roles[input.task.role]?.readOnly;
  const edit: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  if (!readOnly) for (const path of input.task.editablePaths) { edit[path] = 'allow'; edit[join(input.directory, path)] = 'allow'; }
  if (input.task.kind !== 'maintenance') for (const path of input.policy.protectedPaths) { edit[path] = 'deny'; edit[join(input.directory, path)] = 'deny'; }
  if (!input.task.allowDependencies) for (const path of input.policy.dependencyPaths) { edit[path] = 'deny'; edit[join(input.directory, path)] = 'deny'; }
  return { '*': 'ask', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*auth.json': 'deny', '*credentials*': 'deny', '*operator.json': 'deny', '*secret*': 'deny' }, glob: 'allow', grep: 'allow', list: 'allow', edit,
    bash: { '*': 'ask', 'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'git show*': 'allow', 'git rev-parse*': 'allow',
      ...(readOnly ? {} : { 'git add *': 'allow' as const, 'git commit *': 'allow' as const }),
      'git push*': 'deny', 'git reset*': 'deny', 'git clean*': 'deny', 'git checkout*': 'deny', 'git switch*': 'deny', 'git config*': 'deny', 'git worktree*': 'deny', 'git update-ref*': 'deny', 'git -C *': 'deny', 'git -c *': 'deny', 'sudo *': 'deny', 'su *': 'deny', 'rm *': 'deny', 'npm publish*': 'deny', 'cargo publish*': 'deny', 'env*': 'deny', 'printenv*': 'deny',
    }, task: 'deny', external_directory: 'deny', question: 'deny', todowrite: 'deny', skill: 'deny',
    harness_context: 'allow', harness_mail_send: 'allow', harness_mail_read: 'allow', harness_mail_ack: 'allow', harness_checkpoint: 'allow', harness_block: readOnly ? 'deny' : 'allow', harness_submit: readOnly ? 'deny' : 'allow',
  };
}
function rules(permission: NonNullable<Config['permission']>): PermissionRuleset {
  if (typeof permission === 'string') return [{ permission: '*', pattern: '*', action: permission }];
  return Object.entries(permission).flatMap(([name, value]) => typeof value === 'string' ? [{ permission: name, pattern: '*', action: value }] : Object.entries(value ?? {}).map(([pattern, action]) => ({ permission: name, pattern, action })));
}
export function verifyPermissions(effective: PermissionRuleset, intended: NonNullable<Config['permission']>, builtinOutputPattern?: string): void {
  // Agent rules must be the final suffix following a fresh catch-all. Deep-merged inherited allows cannot survive silently.
  const boundary = effective.findLastIndex(rule => rule.permission === '*' && rule.pattern === '*');
  const expected = rules(intended), suffix = effective.slice(boundary), extra = suffix.slice(expected.length);
  // 1.18.33 appends one built-in truncation-directory rule after agent rules. Session rules below override it.
  const knownBuiltin = extra.length === 1 && builtinOutputPattern && canonical(extra[0]) === canonical({ permission: 'external_directory', pattern: builtinOutputPattern, action: 'allow' });
  if (boundary < 0 || canonical(suffix.slice(0, expected.length)) !== canonical(expected) || (extra.length > 0 && !knownBuiltin)) throw new Error('effective merged agent permissions differ from approved restrictions');
}

export class OpenCodeRuntime implements WorkerRuntime {
  private readonly clients = new Map<string, Client>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly inFlight = new Set<string>();
  private readonly observations = new Map<string, AbortController>();
  constructor(readonly runtimeDirectory: string, readonly executable = 'opencode') {}
  private client(handle: WorkerHandle): Client {
    let client = this.clients.get(handle.id);
    if (!client) {
      const meta = metadataSchema.parse(handle.metadata), secret = secretsSchema.parse(JSON.parse(readFileSync(meta.secretFile, 'utf8')));
      client = createOpencodeClient({ baseUrl: meta.baseUrl, directory: handle.directory, headers: { Authorization: `Basic ${Buffer.from(`opencode:${secret.password}`).toString('base64')}` } }); this.clients.set(handle.id, client);
    }
    return client;
  }
  async health(): Promise<{ healthy: boolean; detail: string }> {
    const result = spawnSync(this.executable, ['--version'], { encoding: 'utf8', timeout: 10_000, env: minimalEnv() });
    return { healthy: !result.error && result.status === 0 && result.stdout.trim() === '1.18.33', detail: result.error ? result.error.message : `OpenCode ${result.stdout.trim()}; tested/pinned 1.18.33` };
  }
  async start(input: StartWorker): Promise<WorkerHandle> {
    if (!(await this.health()).healthy) throw new Error('OpenCode version missing/incompatible; rerun compatibility probe before upgrading');
    const directory = realpathSync(input.directory), serverDirectory = join(this.runtimeDirectory, 'servers', input.id);
    mkdirSync(join(serverDirectory, 'tools'), { recursive: true, mode: 0o700 });
    writeFileSync(join(serverDirectory, 'tools/harness.ts'), readFileSync(join(packageRoot, 'templates/opencode/harness.ts')), { mode: 0o600 });
    // Resolve the pinned plugin helper from this installed package, never from an application workspace.
    symlinkSync(join(packageRoot, 'node_modules'), join(serverDirectory, 'node_modules'), 'dir');
    const permission = workerPermissions(input), role = input.policy.roles[input.task.role]; if (!role) throw new Error('unknown role');
    const config: Config = { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', formatter: false, lsp: false, subagent_depth: 0,
      permission: { '*': 'ask', task: 'deny' },
      agent: { harness_worker: { mode: 'primary', description: 'Bounded supervised worker with authenticated harness tools', prompt: role.instructions, steps: input.task.limits.steps, permission },
        general: { disable: true }, explore: { disable: true } },
    };
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('port allocation failed');
    const port = address.port; await new Promise<void>(resolve => listener.close(() => resolve()));
    const password = randomBytes(32).toString('hex'), secretFile = join(serverDirectory, 'secrets.json'); privateWrite(secretFile, { password, token: input.token });
    const baseUrl = `http://127.0.0.1:${port}`;
    const processFile = join(serverDirectory, 'process.json'); privateWrite(processFile, { state: 'intent', directory, baseUrl, pid: null });
    const env = minimalEnv(Object.fromEntries(input.policy.providerEnv.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])));
    Object.assign(env, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_CONFIG_DIR: serverDirectory,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      HARNESS_WORKER_TOKEN: input.token, HARNESS_ENDPOINT_FILE: join(this.runtimeDirectory, 'endpoint.json'),
      TMPDIR: join(serverDirectory, 'tmp'), CARGO_TARGET_DIR: join(serverDirectory, 'build'), CARGO_BUILD_JOBS: '1' });
    mkdirSync(env.TMPDIR!, { recursive: true });
    let executable = this.executable, args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    if (!input.policy.approvedPlugins.length) args.push('--pure');
    if (input.policy.sandbox) { args = [...input.policy.sandbox.args, executable, ...args]; executable = input.policy.sandbox.executable; }
    const child = spawn(executable, args, { cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); this.children.set(input.id, child);
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    let output = ''; const collect = (chunk: Buffer): void => { output = (output + redact(chunk.toString(), [password, input.token])).slice(-64_000); };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    try {
      await Promise.race([once(child, 'spawn'), exited.then(() => { throw new Error('owned OpenCode process failed to start'); })]);
      const process = identity(child.pid!); privateWrite(processFile, { state: 'running', directory, baseUrl, ...process });
      const client = createOpencodeClient({ baseUrl, directory, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
      this.clients.set(input.id, client);
      let healthy = false;
      for (let i = 0; i < 100; i++) {
        try { const result = await client.global.health({ signal: AbortSignal.timeout(500) }); healthy = result.data?.healthy === true && result.data.version === '1.18.33'; } catch { /* bounded startup wait */ }
        if (healthy) break;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await sleep(200);
      }
      if (!healthy) throw new Error('owned server health/version/authentication unavailable');
      const path = (await client.path.get({ directory }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })).data;
      if (realpathSync(path.directory) !== directory) throw new Error('server directory mismatch');
      const merged = (await client.config.get({ directory }, { throwOnError: true })).data;
      const plugins = (merged.plugin ?? []).map(p => typeof p === 'string' ? p : p[0]);
      if (plugins.some(p => !input.policy.approvedPlugins.includes(p))) throw new Error('unapproved inherited plugin; review project policy');
      if (Object.values(merged.mcp ?? {}).some(m => m.enabled !== false)) throw new Error('inherited active MCP requires explicit disabling/review before supervised work');
      const agents = (await client.app.agents({ directory }, { throwOnError: true })).data, agent = agents.find(a => a.name === 'harness_worker');
      if (!agent || !agent.steps || agent.steps > input.task.limits.steps) throw new Error('effective agent step cap missing/exceeds approval');
      privateWrite(join(serverDirectory, 'permission-probe.json'), { effective: agent.permission, intended: rules(permission) });
      verifyPermissions(agent.permission, permission, join(path.home, '.local/share/opencode/tool-output/*'));
      const providers = (await client.provider.list({ directory }, { throwOnError: true })).data;
      let configured = role.model ?? merged.model;
      if (!configured && agent.model) configured = `${agent.model.providerID}/${agent.model.modelID}`;
      if (!configured) {
        // Same existing recent selection as the user's OpenCode UI, not a provider fallback.
        const recent = z.object({ recent: z.array(z.object({ providerID: z.string(), modelID: z.string() })) }).passthrough().parse(JSON.parse(readFileSync(join(path.state, 'model.json'), 'utf8'))).recent[0];
        if (recent) configured = `${recent.providerID}/${recent.modelID}`;
      }
      if (!configured) throw new Error('no existing selected model; configure an explicit per-role provider/model before live use');
      const slash = configured.indexOf('/'), model = { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1) };
      const provider = providers.all.find(p => p.id === model.providerID);
      if (!providers.connected.includes(model.providerID) || !provider?.models[model.modelID]) throw new Error('selected provider/model unavailable; no fallback performed');
      const session = (await client.session.create({ directory, title: `${input.task.id}@${input.task.revision} ${input.id}`, agent: 'harness_worker', model: { id: model.modelID, providerID: model.providerID }, permission: rules(permission) }, { throwOnError: true })).data;
      if (realpathSync(session.directory) !== directory) throw new Error('session directory mismatch');
      if (canonical(session.permission) !== canonical(rules(permission))) throw new Error('session permission overrides were not preserved');
      const metadata: Metadata = { baseUrl, secretFile, ...process, model, agent: 'harness_worker', steps: agent.steps };
      const handle: WorkerHandle = { id: input.id, session: session.id, directory, metadata };
      privateWrite(join(serverDirectory, 'effective-summary.json'), { version: '1.18.33', model, role: input.task.role, steps: agent.steps, permissionHash: hash(agent.permission), plugins, session: session.id, directory });
      privateWrite(join(serverDirectory, 'handle.json'), handle); return handle;
    } catch (error) {
      await this.terminate(child.pid!, child, exited); privateWrite(processFile, { state: 'stopped-after-start-failure', directory, error: redact(errorText(error), [password, input.token]), output });
      const stopped = !child.pid || child.exitCode !== null || child.signalCode !== null || processState(identity(child.pid)) === 'dead';
      if (stopped) this.children.delete(input.id);
      throw new WorkerStartError(errorText(error), stopped);
    }
  }
  async resume(handle: WorkerHandle): Promise<'owned' | 'stopped' | 'uncertain'> {
    const meta = metadataSchema.parse(handle.metadata), ownership = processState(meta);
    if (ownership === 'dead') return 'stopped'; if (ownership !== 'alive') return 'uncertain';
    try {
      const client = this.client(handle);
      const path = (await client.path.get({ directory: handle.directory }, { throwOnError: true, signal: AbortSignal.timeout(5000) })).data;
      const session = (await client.session.get({ directory: handle.directory, sessionID: handle.session }, { throwOnError: true, signal: AbortSignal.timeout(5000) })).data;
      return realpathSync(path.directory) === realpathSync(handle.directory) && session.directory === handle.directory ? 'owned' : 'uncertain';
    } catch { return 'uncertain'; }
  }
  async dispatch(handle: WorkerHandle, requestId: string, prompt: string): Promise<'accepted' | 'rejected' | 'uncertain'> {
    if (this.inFlight.has(handle.session)) throw new Error('session already has in-flight dispatch');
    if ((await this.status(handle)).state !== 'idle') throw new Error('session not idle');
    const meta = metadataSchema.parse(handle.metadata); this.inFlight.add(handle.session);
    try {
      const result = await this.client(handle).session.promptAsync({ directory: handle.directory, sessionID: handle.session, messageID: requestId, agent: meta.agent, model: meta.model, parts: [{ type: 'text', text: prompt }] }, { signal: AbortSignal.timeout(15_000) });
      if (result.response.status === 204) return 'accepted';
      if ([400, 401, 403, 404, 422].includes(result.response.status)) { this.inFlight.delete(handle.session); return 'rejected'; }
      return 'uncertain';
    } catch { return 'uncertain'; }
  }
  async status(handle: WorkerHandle): Promise<RuntimeStatus> {
    try {
      const client = this.client(handle), directory = handle.directory;
      const pending = (await client.permission.list({ directory }, { throwOnError: true, signal: AbortSignal.timeout(5000) })).data.filter(p => p.sessionID === handle.session);
      if (pending.length) return { state: 'permission', permissionIds: pending.map(p => p.id) };
      const statuses = (await client.session.status({ directory }, { throwOnError: true, signal: AbortSignal.timeout(5000) })).data;
      const state = statuses[handle.session]?.type;
      if (state === 'busy' || state === 'retry') return { state: 'busy' };
      this.inFlight.delete(handle.session); return { state: 'idle' };
    } catch { return { state: 'unavailable' }; }
  }
  async messages(handle: WorkerHandle): Promise<RuntimeMessage[]> {
    const history = (await this.client(handle).session.messages({ directory: handle.directory, sessionID: handle.session }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })).data;
    return history.map(({ info, parts }) => ({ id: info.id, role: info.role, text: parts.filter(p => p.type === 'text').map(p => p.text).join('\n'),
      complete: info.role === 'user' || info.time.completed !== undefined, parent: info.role === 'assistant' ? info.parentID : undefined,
      error: info.role === 'assistant' && info.error ? JSON.stringify({ name: info.error.name }) : undefined,
      tokens: info.role === 'assistant' ? info.tokens.total ?? info.tokens.input + info.tokens.output + info.tokens.reasoning + info.tokens.cache.read + info.tokens.cache.write : null,
      cost: info.role === 'assistant' && info.cost > 0 ? info.cost : null,
    }));
  }
  async observe(handle: WorkerHandle, notify: () => void, signal: AbortSignal): Promise<void> {
    const controller = new AbortController(); this.observations.set(handle.id, controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const stream = await this.client(handle).event.subscribe({ directory: handle.directory }, { signal: combined, sseMaxRetryAttempts: 0 });
      for await (const event of stream.stream) {
        if (combined.aborted) break;
        if ('properties' in event && event.properties && 'sessionID' in event.properties && event.properties.sessionID === handle.session) notify();
      }
    } finally { this.observations.delete(handle.id); }
  }
  private async terminate(pid: number, child?: ChildProcess, exited?: Promise<void>): Promise<void> {
    const expected = identity(pid);
    const kill = (signal: NodeJS.Signals): void => { try { if (process.platform !== 'win32') process.kill(-pid, signal); else if (child) child.kill(signal); else process.kill(pid, signal); } catch { /* process already exited */ } };
    kill('SIGTERM'); await Promise.race([exited ?? sleep(300), sleep(1500)]); if (processState(expected) === 'alive') kill('SIGKILL');
    if (child && child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), sleep(1000)]);
  }
  async cancel(handle: WorkerHandle): Promise<'stopped' | 'uncertain'> {
    this.observations.get(handle.id)?.abort();
    const meta = metadataSchema.parse(handle.metadata), state = processState(meta);
    if (state === 'dead') return 'stopped'; if (state !== 'alive') return 'uncertain';
    try { await this.client(handle).session.abort({ directory: handle.directory, sessionID: handle.session }, { signal: AbortSignal.timeout(2000) }); } catch { /* still terminate owned process group */ }
    await this.terminate(meta.pid, this.children.get(handle.id)); this.children.delete(handle.id); this.inFlight.delete(handle.session);
    privateWrite(join(this.runtimeDirectory, 'servers', handle.id, 'process.json'), { state: processState(meta) === 'dead' ? 'stopped' : 'uncertain', pid: meta.pid, start: meta.start });
    return processState(meta) === 'dead' ? 'stopped' : 'uncertain';
  }
  async permission(handle: WorkerHandle, requestId: string, reply: 'once' | 'reject'): Promise<void> {
    const client = this.client(handle), directory = handle.directory;
    const pending = (await client.permission.list({ directory }, { throwOnError: true })).data.find(p => p.id === requestId && p.sessionID === handle.session);
    if (!pending) throw new Error('permission does not belong to worker session');
    await client.permission.reply({ directory, requestID: requestId, reply }, { throwOnError: true });
  }
}
