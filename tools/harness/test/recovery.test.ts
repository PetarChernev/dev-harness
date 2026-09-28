import { afterEach, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, spec, commit } from './helpers.js';
import { Store } from '../src/store.js';
import { Ownership } from '../src/ownership.js';
import { CommandRunner } from '../src/commands.js';
import { canonical, git, sleep } from '../src/util.js';
import { commandSchema, planSchema, validateGraph } from '../src/schema.js';
import { generatePlan, reviewer } from '../src/llm-roles.js';
import { packageRoot } from '../src/profiles.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function setup() { const f = await fixture(); close.push(() => f.cleanup()); return f; }

test('dependency graph rejects missing nodes, duplicate IDs and cross-task cycles', () => {
  const base = { schemaVersion: 1, milestone: 'm', baseCommit: 'a'.repeat(40) };
  expect(() => validateGraph(planSchema.parse({ ...base, tasks: [spec('a', { dependencies: [{ id: 'b', revision: 1 }] })] }))).toThrow('missing dependency');
  expect(() => validateGraph(planSchema.parse({ ...base, tasks: [spec(), spec()] }))).toThrow('duplicate task');
  expect(() => validateGraph(planSchema.parse({ ...base, tasks: [spec('a', { dependencies: [{ id: 'b', revision: 1 }] }), spec('b', { dependencies: [{ id: 'a', revision: 1 }] })] }))).toThrow('cycle');
});

test('immutable revision/base changes require new approval and invalidate dependent evidence', async () => {
  const f = await setup(); f.approve([spec(), spec('b', { dependencies: [{ id: 'a', revision: 1 }] })]);
  f.store.evidence(f.store.task('a'), 'verification', { passed: true }); f.store.evidence(f.store.task('b'), 'verification', { passed: true });
  expect(() => f.store.importPlan({ schemaVersion: 1, milestone: 'm', baseCommit: 'b'.repeat(40), tasks: [spec()] })).toThrow('base commit');
  f.store.importPlan({ schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec('a', { revision: 2, acceptance: ['new explicitly reviewed acceptance'] })] });
  expect(f.store.task('a').approval).toBeNull(); expect(f.store.task('b').approval).toBeNull(); expect(f.store.all('SELECT * FROM evidence WHERE valid=1')).toHaveLength(0);
  await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(0);
});

test('SQLite v1 migration preserves state; online backup/restore has integrity and committed WAL records', async () => {
  const f = await setup(); f.approve([spec()]);
  const backup = join(f.root, 'v1.sqlite'); await f.store.backup(backup);
  const legacy = new Store(backup); legacy.db.exec('DROP TABLE attempts; DROP INDEX pending_mail; DROP INDEX task_events; PRAGMA user_version=1'); legacy.close();
  const migrated = new Store(backup); expect(migrated.task('a').state).toBe('ready'); expect(migrated.db.pragma('user_version', { simple: true })).toBe(3); expect(migrated.db.pragma('integrity_check', { simple: true })).toBe('ok'); migrated.close();
  f.service.sendMail('a', { id: 'wal_message', thread: 'wal_thread', to: 'operator', task: 'a', type: 'question', body: 'included in online backup' });
  const latest = join(f.root, 'online.sqlite'); await f.store.backup(latest);
  const destination = join(f.root, 'restore'); mkdirSync(destination); const owner = new Ownership(destination);
  try {
    Store.restore(latest, join(destination, 'state.sqlite'), owner);
    expect(() => Store.restore(latest, join(destination, 'state.sqlite'), owner)).toThrow('absent destination');
    const restored = new Store(join(destination, 'state.sqlite'), owner); expect(restored.get('SELECT * FROM messages WHERE id=?', 'wal_message')).toBeDefined(); restored.close();
  } finally { owner.close(); }
});

test('named locks serialize shared contracts and addressed wait cycles escalate instead of spinning', async () => {
  const f = await setup(); f.policy.sharedLocks = { contract: ['*.txt'] };
  f.approve([spec('a', { locks: ['contract'] }), spec('b', { locks: ['contract'] })]); await f.supervisor.tick();
  expect(f.store.task('a').state).toBe('running'); expect(f.store.task('b').state).toBe('ready');
  expect(f.runtimeAdapter.prompts).toHaveLength(1);
  const waiting = f.store.worker(f.store.task('a').worker!); await f.service.workerAction(waiting, 'block', { reason: 'waiting for contract holder', waitingFor: 'b' }); f.runtimeAdapter.finish(f.store.handle(waiting));
  await f.supervisor.tick(); expect(f.store.task('a').blocker).toContain('message/lock cycle');
  await f.supervisor.control('cancel', { task: 'a' }); await f.supervisor.tick(); await f.supervisor.tick(); expect(f.store.task('b').state).toBe('running');
  const g = await setup(); g.approve([spec('a'), spec('b')]); await g.supervisor.tick();
  for (const [from, to] of [['a', 'b'], ['b', 'a']]) { const worker = g.store.worker(g.store.task(from!).worker!); await g.service.workerAction(worker, 'block', { reason: 'waiting', waitingFor: to }); g.runtimeAdapter.finish(g.store.handle(worker)); }
  await g.supervisor.tick(); expect(g.store.task('a').state).toBe('needs_human'); expect(g.store.task('b').state).toBe('needs_human'); expect(g.runtimeAdapter.prompts).toHaveLength(2);
});

test('replaced sessions rehydrate authoritative diff/context without resetting consumed limits', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick();
  const original = f.store.worker(f.store.task('a').worker!), workspace = f.store.task('a').workspace!;
  writeFileSync(join(workspace, 'a.txt'), 'work in progress');
  await f.service.workerAction(original, 'checkpoint', { id: 'rotate', summary: 'context too long', outcome: 'replace_session' }); f.runtimeAdapter.finish(f.store.handle(original));
  await f.supervisor.tick(); expect(f.store.task('a').worker).not.toBe(original.id); expect(f.store.task('a').workspace).toBe(workspace);
  expect(f.store.task('a').prompts).toBe(2); expect(f.store.task('a').attempt).toBe(2); expect(f.runtimeAdapter.prompts.at(-1)!.text).toContain('Inspect the current Git diff');
  expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('work in progress');
});

test('newly unblocked task base includes integrated dependencies; late responder cannot reopen done work', async () => {
  const f = await setup(); f.approve([spec('a'), spec('b', { dependencies: [{ id: 'a', revision: 1 }] })]);
  const workspace = f.workspaces.create('a', f.base, 1), submitted = commit(workspace, 'a.txt', 'complete');
  f.store.updateTask('a', { state: 'submitted', workspace, submission: canonical({ revision: 1, commit: submitted, changes: ['a.txt'], evidence: ['report'], limitations: [] }) });
  expect(await f.verifier.verify('a')).toBe(true); expect(await f.integrator.integrate('a')).toBe(true);
  await f.supervisor.tick(); expect(readFileSync(join(f.store.task('b').workspace!, 'a.txt'), 'utf8')).toBe('complete'); expect(f.store.task('b').baseCommit).toBe(git(f.repo, ['rev-parse', 'harness/integration']));
  f.service.sendMail('b', { id: 'late', thread: 'late_thread', to: 'a', task: 'b', type: 'question', body: 'Explain report' }); await f.supervisor.tick();
  const responder = f.store.get<{ id: string }>("SELECT id FROM workers WHERE task='a' AND readOnly=1 AND status='active'")!;
  expect(responder).toBeDefined(); await expect(f.service.workerAction(f.store.worker(responder.id), 'submit', {})).rejects.toThrow('read-only');
  f.runtimeAdapter.finish(f.store.handle(f.store.worker(responder.id))); await f.supervisor.tick(); await f.supervisor.tick();
  expect(f.store.task('a').state).toBe('done'); expect(f.store.all("SELECT * FROM workers WHERE task='a' AND readOnly=1")).toHaveLength(1);
});

test('prompt and elapsed limits enforce finite caps even when runtime is busy; events may be lost', async () => {
  const f = await setup(); const bounded = spec(); bounded.limits.prompts = 1; f.approve([bounded]);
  f.runtimeAdapter.observe = async () => { throw new Error('stream lost'); };
  await f.supervisor.tick(); const worker = f.store.worker(f.store.task('a').worker!); commit(f.store.task('a').workspace!, 'a.txt', 'partial'); f.runtimeAdapter.finish(f.store.handle(worker));
  await f.supervisor.tick(); await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(1); expect(f.store.task('a').state).toBe('needs_human');
  const g = await setup(); g.approve([spec()]); await g.supervisor.tick(); g.store.updateTask('a', { started: Date.now() - 70_000 }); await g.supervisor.tick(); expect(g.store.task('a').blocker).toContain('elapsed budget');
});

test('verifier rejects altered resource/launcher policy and semantic review is independent/read-only', async () => {
  const f = await setup(); f.policy.integration.reviewRole = 'reviewer'; f.approve([spec()]);
  const workspace = f.workspaces.create('a', f.base, 1), change = commit(workspace, 'a.txt', 'complete');
  f.store.updateTask('a', { state: 'submitted', workspace, submission: canonical({ revision: 1, commit: change, changes: ['a.txt'], evidence: ['x'], limitations: [] }) });
  const altered = structuredClone(f.policy); altered.resources.buildJobs = 3;
  const runner = new CommandRunner(f.store, f.runtime, altered);
  await expect(runner.run(f.store.task('a'), 'test', f.policy.commands.test!, workspace)).rejects.toThrow('approved snapshot');
  f.runtimeAdapter.onDispatch = async input => { expect(input.readOnly).toBe(true); expect(input.task.role).toBe('reviewer'); f.runtimeAdapter.finish(f.runtimeAdapter.sessions.get(`session_${input.id}`)!.handle, JSON.stringify({ passed: false, findings: ['independent semantic finding'] })); };
  const { Verifier } = await import('../src/verification.js');
  const verifier = new Verifier(f.store, f.workspaces, f.runner, reviewer(f.store, f.service, f.runtimeAdapter));
  expect(await verifier.verify('a')).toBe(false); expect(f.store.task('a').state).toBe('ready'); expect(f.store.all('SELECT * FROM evidence WHERE kind=?', 'review')).toHaveLength(1);
});

test('planner returns schema-valid draft graph without approving or starting implementation', async () => {
  const f = await setup(); f.policy.roles.planner = { instructions: 'Plan only.', readOnly: true };
  const brief = join(f.repo, 'brief.md'), output = join(f.repo, 'plan.yaml'); writeFileSync(brief, 'Write a neutral report.');
  f.runtimeAdapter.onDispatch = async input => { f.runtimeAdapter.finish(f.runtimeAdapter.sessions.get(`session_${input.id}`)!.handle, JSON.stringify({ schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec()] })); };
  const plan = await generatePlan(f.store, f.service, f.workspaces, f.runtimeAdapter, f.policy, brief, output) as { state: string; approvalRequired: boolean };
  expect(plan.state).toBe('draft'); expect(plan.approvalRequired).toBe(true); expect(f.store.tasks()).toHaveLength(0); expect(readFileSync(output, 'utf8')).toContain('schemaVersion: 1');
});

test('CLI help and JSON output work offline with explicit repo and stable exit codes', async () => {
  const f = await setup();
  const cli = join(packageRoot, 'dist/cli.js');
  for (const command of [['--help'], ['task', 'import', '--help'], ['plan', '--help'], ['run', '--help'], ['restore', '--help'], ['permission', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...command], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stdout).toContain('Usage:');
  }
  const result = spawnSync(process.execPath, [cli, 'status', '--repo', f.repo], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).tasks).toEqual([]);
  const missing = spawnSync(process.execPath, [cli, 'status'], { encoding: 'utf8' }); expect(missing.status).toBe(1);
});

test('stable worker check requests deduplicate real subprocess effects and tracked builds suppress idle retries', async () => {
  const f = await setup();
  f.policy.commands.test = commandSchema.parse({ executable: process.execPath, args: ['-e', 'require("fs").appendFileSync(process.env.HARNESS_ARTIFACT_DIR+"/mark", "once");setTimeout(()=>{},150)'], timeoutMs: 1000, buildJobs: 2 });
  f.approve([spec()]); await f.supervisor.tick(); const worker = f.store.worker(f.store.task('a').worker!);
  const first = await f.service.workerAction(worker, 'check', { id: 'stable_check', command: 'test' }) as { action: string };
  const duplicate = await f.service.workerAction(worker, 'check', { id: 'stable_check', command: 'test' }) as { action: string };
  expect(first.action).toBe(duplicate.action);
  f.runtimeAdapter.finish(f.store.handle(worker)); await f.supervisor.tick(); await f.supervisor.tick();
  expect(f.runtimeAdapter.prompts).toHaveLength(1); expect(f.store.task('a').noProgress).toBe(0);
  await f.runner.drain(); expect(readFileSync(join(f.runtime, 'artifacts', first.action, 'mark'), 'utf8')).toBe('once');
  const completed = await f.service.workerAction(worker, 'check', { id: 'stable_check', command: 'test' }) as { state: string; result: { passed: boolean } };
  expect(completed.state).toBe('finished'); expect(completed.result.passed).toBe(true); expect(f.store.all("SELECT * FROM actions WHERE kind='command'")).toHaveLength(1);
  const evidence = f.store.get<{ id: string }>("SELECT id FROM evidence WHERE kind='command'")!;
  expect(await f.service.workerAction(worker, 'evidence', { id: evidence.id })).toMatchObject({ id: evidence.id, nextOffset: null });
  await expect(f.service.workerAction(worker, 'evidence', { id: 'not_own_evidence' })).rejects.toThrow('authorized task');
  await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(2);
});

test('operator answers wake human-blocked work at a safe boundary; pause still prevents continuation', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick(); const worker = f.store.worker(f.store.task('a').worker!);
  await f.service.workerAction(worker, 'mail-send', { id: 'human_question', thread: 'human_thread', to: 'operator', task: 'a', type: 'question', body: 'Confirm existing scope?' });
  await f.service.workerAction(worker, 'block', { reason: 'awaiting operator', human: true }); f.runtimeAdapter.finish(f.store.handle(worker));
  await f.supervisor.control('pause'); f.service.answer({ question: 'human_question', body: 'Yes, keep the approved acceptance.' }); await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(1);
  await f.supervisor.control('resume'); await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(2); expect(f.store.task('a').state).toBe('running');
});

test('secret output split between subprocess chunks is redacted in retained logs', async () => {
  const f = await setup(); f.approve([spec()]);
  const result = await f.runner.run(f.store.task('a'), 'secret-redaction-probe', commandSchema.parse({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.env.PROBE_TOKEN.slice(0,5));setTimeout(()=>process.stdout.write(process.env.PROBE_TOKEN.slice(5)),10)'], env: { PROBE_TOKEN: 'synthetic-test-secret' } }), f.repo);
  expect(readFileSync(result.log, 'utf8')).toBe('[REDACTED]');
});

test('approved checks cannot silently commit an altered verification candidate', async () => {
  const f = await setup();
  f.policy.commands.test = commandSchema.parse({ executable: process.execPath, args: ['-e', 'const fs=require("fs"),cp=require("child_process");fs.writeFileSync("a.txt","changed-by-check");cp.execFileSync("git",["add","a.txt"]);cp.execFileSync("git",["-c","user.name=Harness Test","-c","user.email=harness-test@example.invalid","commit","-m","tamper"]);'] });
  f.approve([spec()]); const workspace = f.workspaces.create('a', f.base, 1), change = commit(workspace, 'a.txt', 'complete');
  f.store.updateTask('a', { state: 'submitted', workspace, submission: canonical({ revision: 1, commit: change, changes: ['a.txt'], evidence: ['x'], limitations: [] }) });
  expect(await f.verifier.verify('a')).toBe(false); expect(f.store.task('a').state).toBe('needs_human'); expect(f.store.task('a').blocker).toContain('altered candidate');
});

test('pause during worker startup and stop during ambiguous dispatch cannot restart work at idle', async () => {
  const f = await setup(); f.approve([spec()]);
  const originalStart = f.runtimeAdapter.start.bind(f.runtimeAdapter); let releaseStart!: () => void;
  const startup = new Promise<void>(resolve => { releaseStart = resolve; });
  f.runtimeAdapter.start = async input => { await startup; return originalStart(input); };
  const tick = f.supervisor.tick(); await sleep(10); await f.supervisor.control('pause'); releaseStart(); await tick;
  expect(f.runtimeAdapter.prompts).toHaveLength(0); expect(f.store.meta('mode', '')).toBe('paused');
  await f.supervisor.control('resume');
  let releaseDispatch!: () => void;
  f.runtimeAdapter.onDispatch = async () => new Promise<void>(resolve => { releaseDispatch = resolve; });
  const dispatching = f.supervisor.tick(); while (!releaseDispatch) await sleep(1);
  await f.supervisor.control('stop'); releaseDispatch(); await dispatching;
  expect(f.store.task('a').state).toBe('ready'); expect(f.store.all("SELECT * FROM dispatches WHERE status IN ('intent','accepted','uncertain')")).toHaveLength(0);
  await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(1);
});

test('provider retry notifications beyond the approved cap stop the existing owner without more prompts', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick(); const worker = f.store.worker(f.store.task('a').worker!);
  f.runtimeAdapter.sessions.get(worker.session!)!.status = { state: 'busy', retryAttempt: 3, nextRetryAt: Date.now() + 30_000 };
  await f.supervisor.tick(); await f.supervisor.tick(); expect(f.store.worker(worker.id).status).toBe('stopped'); expect(f.store.task('a').blocker).toContain('provider retry budget'); expect(f.runtimeAdapter.prompts).toHaveLength(1);
});

test('cancelling verification cannot resurrect ready work or integrate a late command result', async () => {
  const f = await setup(); f.policy.commands.test = commandSchema.parse({ executable: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(1),1000)'], timeoutMs: 2000 }); f.approve([spec()]);
  const workspace = f.workspaces.create('a', f.base, 1), change = commit(workspace, 'a.txt', 'complete');
  f.store.updateTask('a', { state: 'submitted', workspace, submission: canonical({ revision: 1, commit: change, changes: ['a.txt'], evidence: ['x'], limitations: [] }) });
  const checking = f.verifier.verify('a'); await sleep(20); await f.supervisor.control('cancel', { task: 'a' }); await checking;
  expect(f.store.task('a').state).toBe('cancelled'); await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(0);
});

test('generic launcher hook preserves argument boundaries and profile-only environment substitution', async () => {
  const f = await setup(), launcher = join(f.root, 'launcher with spaces.mjs');
  writeFileSync(launcher, 'import {spawnSync} from "node:child_process";const r=spawnSync(process.argv[2],process.argv.slice(3),{stdio:"inherit",env:process.env});process.exit(r.status??1);');
  f.policy.sandbox = { executable: process.execPath, args: [launcher] }; f.policy.executionEnv = { OUTPUT: '{artifactDir}', JOBS: '{buildJobs}' }; f.approve([spec()]);
  const result = await f.runner.run(f.store.task('a'), 'launcher-probe', commandSchema.parse({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({output:process.env.OUTPUT,jobs:process.env.JOBS,args:process.argv.slice(1)}))', 'space and;literal'], buildJobs: 2 }), f.repo);
  expect(result.passed).toBe(true); const output = JSON.parse(readFileSync(result.log, 'utf8')); expect(output.jobs).toBe('2'); expect(output.args).toEqual(['space and;literal']); expect(output.output).toContain(result.action);
});

test('approved new revisions preserve attempt history while getting new scoped counters and workspaces', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick(); const old = f.store.task('a');
  await f.supervisor.control('cancel', { task: 'a' });
  f.store.importPlan({ schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec('a', { revision: 2 })] });
  expect(f.store.task('a').approval).toBeNull(); expect(f.store.task('a').prompts).toBe(0);
  f.store.approve('m', f.policy); await f.supervisor.tick();
  expect(f.store.task('a').attempt).toBe(1); expect(f.store.task('a').workspace).not.toBe(old.workspace);
  expect(f.store.all('SELECT revision,number FROM attempts ORDER BY revision')).toEqual([{ revision: 1, number: 1 }, { revision: 2, number: 1 }]);
  expect(() => f.store.importPlan({ schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec('a', { revision: 3 })] })).toThrow('stop');
});
