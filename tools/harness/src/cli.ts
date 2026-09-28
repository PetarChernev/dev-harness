#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { FakeRuntime } from './runtime.js';
import { initProject, loadProject } from './profiles.js';
import { errorText, runtimeLocation } from './util.js';
import { openApplication, remoteOperation, status } from './application.js';
import { demo } from './demo.js';
import { OpenCodeRuntime } from './opencode.js';
import { Ownership } from './ownership.js';

interface Options { repo: string; runtime?: string; [key: string]: unknown }
const print = (data: unknown): void => { console.log(JSON.stringify(data, null, 2)); };
const cli = new Command().name('harness').description('Local-first trusted-local development harness; all results are JSON').version('0.1.0').showHelpAfterError();
const targeted = (command: Command): Command => command.requiredOption('--repo <path>', 'explicit target repository').option('--runtime <path>', 'explicit canonical runtime location');
const call = async (opts: Options, action: string, input: Record<string, unknown> = {}): Promise<void> => {
  const location = runtimeLocation(opts.repo, opts.runtime);
  const remote = await remoteOperation(location.runtime, action, input);
  if (remote.connected) { print(remote.output); return; }
  const app = openApplication(location.repo, new OpenCodeRuntime(location.runtime), location.runtime);
  try { print(await app.operate(action, input)); } finally { await app.close(); }
};

targeted(cli.command('init').description('Generate a packaged project profile; refuse existing target files')).option('--profile <name>', 'generic-command or rust-bevy', 'generic-command').action((opts: Options) => {
  if (!['generic-command', 'rust-bevy'].includes(String(opts.profile))) throw new Error('unknown profile'); print({ created: initProject(opts.repo, opts.profile as 'generic-command' | 'rust-bevy') });
});
targeted(cli.command('doctor').description('Profile-aware prerequisite inspection; no model calls')).action((opts: Options) => {
  const checks = ['git', ...(existsSync(join(opts.repo, '.harness/project.yaml')) && loadProject(opts.repo).profile === 'rust-bevy' ? ['rustc', 'cargo', 'pkg-config'] : []), 'opencode'].map(executable => { const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }); return { executable, available: !result.error && result.status === 0, version: result.stdout?.trim() || null }; });
  print({ mode: 'trusted-local', node: process.version, pinnedNode: 'v24.21.0', nodeMatches: process.version === 'v24.21.0', checks, credentials: 'not tested', graphical: 'unverified; environment presence is not render evidence' });
});
for (const name of ['status', 'logs']) targeted(cli.command(name).description(name === 'status' ? 'Authoritative runtime summary from SQLite' : 'Structured decision/event log')).action((opts: Options) => {
  const { runtime } = runtimeLocation(opts.repo, opts.runtime), path = join(runtime, 'state.sqlite');
  if (!existsSync(path)) { print({ mode: 'uninitialized', tasks: [], nextAction: 'import a versioned draft plan' }); return; }
  const store = new Store(path, undefined, true); try { print(name === 'status' ? status(store) : store.all('SELECT * FROM events ORDER BY seq DESC LIMIT 200')); } finally { store.close(); }
});
const task = cli.command('task').description('Import immutable drafts or inspect authoritative task state');
targeted(task.command('import').description('Import versioned YAML/JSON draft graph')).requiredOption('--file <path>', 'plan file').action((opts: Options) => call(opts, 'import', { file: resolve(String(opts.file)) }));
for (const name of ['list', 'show']) targeted(task.command(name).description(`Task ${name}`)).option('--id <id>', 'task ID for show').action((opts: Options) => {
  const { runtime } = runtimeLocation(opts.repo, opts.runtime), store = new Store(join(runtime, 'state.sqlite'), undefined, true);
  try { if (name === 'show' && !opts.id) throw new Error('--id required'); print(name === 'list' ? store.tasks() : { task: store.task(String(opts.id)), spec: store.spec(store.task(String(opts.id))) }); } finally { store.close(); }
});
targeted(cli.command('approve').description('Operator approves entire milestone revisions/policy/finite limits')).requiredOption('--milestone <id>', 'milestone').action((opts: Options) => call(opts, 'approve', { milestone: opts.milestone }));
for (const name of ['pause', 'resume', 'drain', 'stop']) targeted(cli.command(name).description(`Persist operator ${name}; never self-resume paused work`)).option('--milestone <id>', 'scope to milestone').action((opts: Options) => call(opts, name, opts.milestone ? { milestone: opts.milestone } : {}));
for (const name of ['verify', 'integrate', 'cancel']) targeted(cli.command(name).description(`Operator ${name} a task`)).requiredOption('--task <id>', 'task ID').action((opts: Options) => call(opts, name, { task: opts.task }));
targeted(cli.command('retry').description('Explicit retry within approved remaining limits after reconciliation')).requiredOption('--task <id>', 'task').requiredOption('--reason <text>', 'reconciliation evidence').action((opts: Options) => call(opts, 'retry', { task: opts.task, reason: opts.reason }));
targeted(cli.command('mail').description('Read addressed durable mailbox')).option('--recipient <id>', 'task identity or operator', 'operator').action((opts: Options) => call(opts, 'mail', { recipient: opts.recipient }));
targeted(cli.command('answer').description('Authenticated operator answer; proposals require versioned decision record')).requiredOption('--question <id>', 'message ID').requiredOption('--body <text>', 'answer').option('--decision-record <path>', 'committed repository-relative record').action((opts: Options) => call(opts, 'answer', { question: opts.question, body: opts.body, ...(opts.decisionRecord ? { decisionRecord: opts.decisionRecord } : {}) }));
targeted(cli.command('checkpoint').description('Inspect persisted checkpoints and evidence')).requiredOption('--task <id>', 'task').action((opts: Options) => {
  const { runtime } = runtimeLocation(opts.repo, opts.runtime), store = new Store(join(runtime, 'state.sqlite'), undefined, true);
  try { print({ checkpoints: store.all('SELECT * FROM checkpoints WHERE task=? ORDER BY created', opts.task), evidence: store.all('SELECT * FROM evidence WHERE task=? ORDER BY created', opts.task) }); } finally { store.close(); }
});
targeted(cli.command('backup').description('SQLite online backup, including committed WAL content')).requiredOption('--file <path>', 'new backup destination').action((opts: Options) => call(opts, 'backup', { file: resolve(String(opts.file)) }));
targeted(cli.command('resolve-action').description('Record operator reconciliation of uncertain external command')).requiredOption('--id <id>', 'action ID').requiredOption('--reason <text>', 'evidence of observed outcome').action((opts: Options) => call(opts, 'resolve-action', { id: opts.id, reason: opts.reason }));
targeted(cli.command('promote').description('Explicit fast-forward promotion to clean current user branch; no push')).requiredOption('--target <branch>', 'user branch').action((opts: Options) => call(opts, 'promote', { target: opts.target }));
targeted(cli.command('plan').description('Bounded live read-only planner produces a schema-valid draft; never approves')).requiredOption('--brief <path>', 'brief file').requiredOption('--out <path>', 'new draft YAML destination').action((opts: Options) => call(opts, 'plan', { brief: resolve(String(opts.brief)), out: resolve(String(opts.out)) }));
targeted(cli.command('permission').description('Operator answers one scoped permission; never automatic, never always')).requiredOption('--worker <id>', 'worker ID').requiredOption('--request <id>', 'permission request ID').requiredOption('--reply <action>', 'once or reject').action((opts: Options) => call(opts, 'permission', { worker: opts.worker, request: opts.request, reply: opts.reply }));
targeted(cli.command('restore').description('Restore a checked SQLite backup into absent state database; supervisor must be stopped')).requiredOption('--file <path>', 'backup source').action((opts: Options) => {
  const { runtime } = runtimeLocation(opts.repo, opts.runtime), owner = new Ownership(runtime);
  try { Store.restore(resolve(String(opts.file)), join(runtime, 'state.sqlite'), owner); print({ restored: true, mode: 'inspect/reconcile before resuming' }); } finally { owner.close(); }
});
targeted(cli.command('run').description('Run owned OpenCode supervisor; explicit resume, finite wall-clock cap')).option('--max-ms <number>', 'supervisor wall-clock cap', '3600000').action(async (opts: Options) => {
  const { runtime } = runtimeLocation(opts.repo, opts.runtime), maximum = Number(opts.maxMs);
  if (!Number.isSafeInteger(maximum) || maximum < 100 || maximum > 86_400_000) throw new Error('--max-ms must be 100..86400000');
  const app = openApplication(opts.repo, new OpenCodeRuntime(runtime), runtime);
  const stop = (): void => { void app.supervisor.control('stop', {}); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { if (app.store.meta('mode', 'stopped') !== 'running') throw new Error('use resume explicitly before run; paused work never self-restarts'); print({ runtime, limits: app.policy.defaults, resources: app.policy.resources, maxMs: maximum, mode: 'trusted-local' }); await app.run(maximum); print(status(app.store)); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await app.supervisor.stopWorkers(); await app.close(); }
});
targeted(cli.command('demo').description('Run bounded production workflow on a NEW disposable repository')).option('--mode <mode>', 'mock (offline) or live', 'mock').action(async (opts: Options) => {
  if (!['mock', 'live'].includes(String(opts.mode))) throw new Error('mode must be mock or live');
  const report = await demo(opts.repo, opts.mode === 'live' ? 'live' : undefined); print(report);
  if ((report as { result: string }).result !== 'passed') process.exitCode = 2;
});
try { await cli.parseAsync(); } catch (error) { console.error(JSON.stringify({ error: errorText(error) })); process.exitCode = 1; }
