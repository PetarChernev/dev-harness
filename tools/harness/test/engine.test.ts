import { afterEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, spec, commit } from './helpers.js';
import { canonical, git, sleep, uid } from '../src/util.js';
import { Store } from '../src/store.js';
import type { DispatchRow, MailRow } from '../src/store.js';
import { Ownership } from '../src/ownership.js';
import { commandSchema } from '../src/schema.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(slots = 3, check?: string) { const f = await fixture(slots, check); cleanups.push(() => f.cleanup()); return f; }

test('unfinished turn receives concrete continuation and only independent verification/integration finishes it', async () => {
  const f = await setup(3, "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='complete') process.exit(1)"); f.approve([spec()]);
  await f.supervisor.tick(); let task = f.store.task('a'); const worker = f.store.worker(task.worker!), handle = f.store.handle(worker);
  commit(task.workspace!, 'a.txt', 'partial'); f.runtimeAdapter.finish(handle, 'I am done');
  await f.supervisor.tick();
  expect(f.runtimeAdapter.prompts).toHaveLength(2); expect(f.runtimeAdapter.prompts[1]!.text).toContain('Remaining acceptance criteria');
  expect(f.store.task('a').state).toBe('running');
  const submission = commit(task.workspace!, 'a.txt', 'complete');
  await f.service.workerAction(worker, 'submit', { revision: 1, commit: submission, changes: ['a.txt'], evidence: ['implementation and checks'], limitations: [] });
  f.runtimeAdapter.finish(handle);
  for (let i = 0; i < 80 && f.store.task('a').state !== 'done'; i++) { await f.supervisor.tick(); await sleep(10); }
  task = f.store.task('a'); expect(task.state).toBe('done');
  expect(git(f.repo, ['branch', '--show-current'])).toBe('main'); expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(f.base);
  expect(f.store.all('SELECT * FROM evidence WHERE kind=?', 'combined-verification')).toHaveLength(1);
});

test('two-way durable mail wakes idle recipient; busy session is never double-prompted; waiting releases only slot', async () => {
  const f = await setup(1); f.approve([spec('a'), spec('b')]);
  await f.supervisor.tick(); const a = f.store.worker(f.store.task('a').worker!);
  const question = { id: 'q1', thread: 'thread1', to: 'b', task: 'a', type: 'question', body: 'Which word should I emit?' };
  await f.service.workerAction(a, 'mail-send', question);
  await f.service.workerAction(a, 'mail-send', question);
  await f.service.workerAction(a, 'block', { reason: 'waiting on b', waitingFor: 'b' }); f.runtimeAdapter.finish(f.store.handle(a));
  await f.supervisor.tick(); const b = f.store.worker(f.store.task('b').worker!);
  expect(f.runtimeAdapter.prompts.filter(p => p.worker === b.id)).toHaveLength(1);
  expect(f.store.task('a').state).toBe('blocked');
  await f.supervisor.tick(); expect(f.runtimeAdapter.prompts.filter(p => p.worker === b.id)).toHaveLength(1);
  const mail = await f.service.workerAction(b, 'mail-read', {}) as MailRow[]; expect(mail).toHaveLength(1); expect(mail[0]!.id).toBe('q1');
  await f.service.workerAction(b, 'mail-ack', { id: 'q1' });
  await f.service.workerAction(b, 'mail-send', { id: 'answer1', thread: 'thread1', to: 'a', task: 'a', type: 'answer', body: 'complete', replyTo: 'q1' });
  await f.service.workerAction(b, 'block', { reason: 'waiting for next instruction', human: true }); f.runtimeAdapter.finish(f.store.handle(b));
  await f.supervisor.tick();
  expect(f.store.task('a').state).toBe('running');
  expect(f.runtimeAdapter.prompts.filter(p => p.worker === a.id)).toHaveLength(2);
  expect(f.runtimeAdapter.prompts.at(-1)!.text).toContain('answer1');
  expect(f.store.get<MailRow>('SELECT * FROM messages WHERE id=?', 'answer1')!.acknowledged).toBeNull();
});

test('restart preserves pending mail and in-flight dispatch without repeating external action', async () => {
  const f = await setup(); f.approve([spec('a'), spec('b')]); await f.supervisor.tick();
  const a = f.store.worker(f.store.task('a').worker!); f.service.sendMail('a', { id: 'pending', thread: 'pending_thread', to: 'b', task: 'a', type: 'question', body: 'pending question' });
  const before = f.runtimeAdapter.prompts.length;
  await f.restart(); await f.supervisor.tick();
  expect(f.runtimeAdapter.prompts).toHaveLength(before); expect(f.service.readMail('b')).toHaveLength(1);
  expect(f.store.all<DispatchRow>("SELECT * FROM dispatches WHERE status='accepted'")).toHaveLength(2);
  expect(f.store.worker(a.id).status).toBe('active');
});

test('ambiguous timeout reconciles identity; absent outcome pauses; expired lease never creates second writer; cancellation preserves work', async () => {
  const f = await setup(); f.runtimeAdapter.outcome = 'uncertain'; f.approve([spec()]); await f.supervisor.tick();
  const a = f.store.worker(f.store.task('a').worker!); f.store.updateTask('a', { leaseUntil: 1 });
  await f.supervisor.tick(); expect(f.runtimeAdapter.prompts).toHaveLength(1); expect(f.store.task('a').state).toBe('running');
  await f.supervisor.control('cancel', { task: 'a' }); expect(f.store.task('a').state).toBe('cancelled'); expect(f.store.task('a').workspace).not.toBeNull();
  const g = await setup(); g.approve([spec()]); g.runtimeAdapter.outcome = 'uncertain'; g.runtimeAdapter.recordUncertain = false;
  await g.supervisor.tick(); await g.supervisor.tick(); await g.supervisor.tick();
  expect(g.runtimeAdapter.prompts).toHaveLength(1); expect(g.store.task('a').state).toBe('needs_human');
});

test('incomplete submission fails independent checks; worker cannot change criteria, spoof sender or edit policy', async () => {
  const f = await setup(3, "process.exit(require('fs').readFileSync('a.txt','utf8')==='complete'?0:1)"); f.approve([spec()]); await f.supervisor.tick();
  const task = f.store.task('a'), a = f.store.worker(task.worker!); const sha = commit(task.workspace!, 'a.txt', 'incomplete');
  await expect(f.service.workerAction(a, 'done', {})).rejects.toThrow('unknown worker');
  await expect(f.service.workerAction(a, 'mail-send', { id: 'spoof', thread: 'x', to: 'operator', task: 'a', type: 'question', body: 'x', sender: 'operator' })).rejects.toThrow();
  expect(() => f.store.importPlan({ schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec('a', { acceptance: ['anything passes'] })] })).toThrow('immutable');
  await f.service.workerAction(a, 'submit', { revision: 1, commit: sha, changes: ['a.txt'], evidence: ['claimed complete'], limitations: [] }); f.runtimeAdapter.finish(f.store.handle(a));
  await f.supervisor.tick(); await sleep(60); expect(f.store.task('a').state).toBe('ready');
  const policyWorkspace = f.workspaces.candidate(f.base); mkdirSync(join(policyWorkspace, '.harness')); const bad = commit(policyWorkspace, '.harness/policy.yaml', 'bad');
  expect(() => f.workspaces.validate(spec('a', { editablePaths: ['**'] }), f.policy, policyWorkspace, f.base, { revision: 1, commit: bad, changes: ['.harness/policy.yaml'], evidence: ['x'], limitations: [] })).toThrow('protected');
});

test('two independently passing changes fail combined checks; interrupted advancement reconciles Git exactly once', async () => {
  const f = await setup(3, "const fs=require('fs');process.exit(fs.existsSync('a.txt')&&fs.existsSync('b.txt')?1:0)"); f.approve([spec('a'), spec('b')]);
  f.store.setMeta('mode', 'paused');
  for (const name of ['a', 'b']) {
    const workspace = f.workspaces.create(name, f.base, 1), change = commit(workspace, `${name}.txt`, 'complete');
    f.store.updateTask(name, { state: 'submitted', workspace, submission: canonical({ revision: 1, commit: change, changes: [`${name}.txt`], evidence: ['x'], limitations: [] }) });
    expect(await f.verifier.verify(name)).toBe(true);
  }
  f.integrator.crashAfter = 'advance'; await expect(f.integrator.integrate('a')).rejects.toThrow('simulated crash');
  const integrated = git(f.repo, ['rev-parse', 'harness/integration']);
  await f.restart(); expect(await f.integrator.integrate('a')).toBe(true); expect(git(f.repo, ['rev-parse', 'harness/integration'])).toBe(integrated);
  expect(await f.integrator.integrate('b')).toBe(false); expect(git(f.repo, ['rev-parse', 'harness/integration'])).toBe(integrated); expect(f.store.task('b').state).toBe('ready');
});

test('no progress, provider rejection and pending permissions are bounded; pause persists across restart', async () => {
  const f = await setup(); const aSpec = spec(); aSpec.limits.noProgress = 1; f.approve([aSpec]); await f.supervisor.tick();
  f.runtimeAdapter.finish(f.store.handle(f.store.worker(f.store.task('a').worker!)), 'Still thinking'); await f.supervisor.tick(); expect(f.store.task('a').state).toBe('needs_human');
  const g = await setup(); g.approve([spec()]); await g.supervisor.tick(); const worker = g.store.worker(g.store.task('a').worker!);
  g.runtimeAdapter.sessions.get(worker.session!)!.status = { state: 'permission', permissionIds: ['perm_1'] };
  await g.supervisor.tick(); expect(g.store.task('a').blocker).toContain('pending permission'); expect(g.runtimeAdapter.prompts).toHaveLength(1);
  await g.supervisor.control('pause', {}); await g.restart(); await g.supervisor.tick(); expect(g.store.meta('mode', '')).toBe('paused');
  const h = await setup(); const limit = spec(); limit.limits.providerRetries = 0; h.approve([limit]); h.runtimeAdapter.outcome = 'rejected'; await h.supervisor.tick(); await h.supervisor.tick(); expect(h.runtimeAdapter.prompts).toHaveLength(1); expect(h.store.task('a').state).toBe('needs_human');
});

test('real subprocess errors, timeout, WAL online backup, migrations and canonical worktree runtime', async () => {
  const f = await setup(); f.approve([spec()]);
  const task = f.store.task('a');
  expect((await f.runner.run(task, 'missing', commandSchema.parse({ executable: 'harness-missing-executable-123' }), f.repo)).passed).toBe(false);
  const timeout = await f.runner.run(task, 'timeout', commandSchema.parse({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 25 }), f.repo);
  expect(timeout.timedOut).toBe(true);
  const backup = join(f.root, 'backup.sqlite'); await f.store.backup(backup);
  const restored = new Store(backup); expect(restored.task('a').state).toBe('ready'); expect(restored.db.pragma('user_version', { simple: true })).toBe(2); restored.close();
  expect(() => new Ownership(f.runtime)).toThrow('already owned');
  const workspace = f.workspaces.create('path', f.base, 1); const { runtimeLocation } = await import('../src/util.js'); expect(runtimeLocation(workspace).runtime).toBe(f.runtime);
});

test('path handling includes spaces, renames/deletions, traversal and symlink escapes', async () => {
  const f = await setup(); const workspace = f.workspaces.candidate(f.base);
  git(workspace, ['mv', 'README.md', 'renamed file.md']); git(workspace, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-m', 'rename']);
  const change = git(workspace, ['rev-parse', 'HEAD']); expect(f.workspaces.changed(f.base, change).sort()).toEqual(['README.md', 'renamed file.md']);
  expect(() => f.workspaces.validate(spec('a', { editablePaths: ['renamed file.md'] }), f.policy, workspace, f.base, { revision: 1, commit: change, changes: ['README.md', 'renamed file.md'], evidence: ['x'], limitations: [] })).toThrow('README.md');
  symlinkSync('/tmp', join(workspace, 'escape')); git(workspace, ['add', 'escape']); git(workspace, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-m', 'symlink']);
  expect(() => f.workspaces.validate(spec('a', { editablePaths: ['**'] }), f.policy, workspace, f.base, { revision: 1, commit: git(workspace, ['rev-parse', 'HEAD']), changes: ['README.md', 'renamed file.md', 'escape'], evidence: ['x'], limitations: [] })).toThrow('symlink');
});

test('authenticated API scopes session/sender and excludes operator capabilities', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick(); const worker = f.store.worker(f.store.task('a').worker!);
  const input = f.runtimeAdapter.sessions.get(worker.session!)!.input;
  const headers = { authorization: `Bearer ${input.token}`, 'x-harness-session': worker.session!, 'content-type': 'application/json' };
  const context = await fetch(`${f.service.url}/worker/context`, { method: 'POST', headers, body: '{}' }); expect(context.status).toBe(200);
  expect((await fetch(`${f.service.url}/operator/resume`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
  expect((await fetch(`${f.service.url}/worker/context`, { method: 'POST', headers: { ...headers, 'x-harness-session': 'someone_else' }, body: '{}' })).status).toBe(403);
});

test('recorded interrupted external process is not rerun on recovery', async () => {
  const f = await setup(); f.approve([spec()]); await f.supervisor.tick();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); await once(child, 'spawn');
  const { identity } = await import('../src/util.js');
  f.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', uid('action'), 'a', 'command', 'running', canonical({ process: identity(child.pid!) }), null, Date.now());
  const prompts = f.runtimeAdapter.prompts.length; await f.restart(); await f.supervisor.tick();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); expect(f.runtimeAdapter.prompts).toHaveLength(prompts); expect(f.store.task('a').state).toBe('needs_human');
});
