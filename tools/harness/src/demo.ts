import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { initProject, loadProject, writeProject } from './profiles.js';
import { planSchema, taskSchema } from './schema.js';
import { FakeRuntime } from './runtime.js';
import type { WorkerRuntime } from './runtime.js';
import { openApplication, status } from './application.js';
import { git } from './util.js';
import type { MailRow } from './store.js';
import { OpenCodeRuntime } from './opencode.js';
import { runtimeLocation } from './util.js';

/** A disposable, bounded exercise. This never points workers at the harness's running source. */
export async function demo(repoInput: string, runtimeAdapter?: WorkerRuntime | 'live'): Promise<unknown> {
  const repo = resolve(repoInput);
  if (existsSync(repo) && readdirSync(repo).length) throw new Error('demo requires an absent or empty disposable directory');
  initProject(repo, 'generic-command');
  const policy = loadProject(repo);
  policy.resources.implementations = 2; policy.pollMs = runtimeAdapter ? 500 : 10;
  policy.commands = {
    alpha: { executable: process.execPath, args: ['-e', 'if(require("fs").readFileSync("alpha.txt","utf8").trim()!=="complete") process.exit(1)'], cwd: '.', env: {}, timeoutMs: 10_000, artifacts: [], graphical: false, buildJobs: 1 },
    beta: { executable: process.execPath, args: ['-e', 'if(require("fs").readFileSync("beta.txt","utf8").trim()!=="complete") process.exit(1)'], cwd: '.', env: {}, timeoutMs: 10_000, artifacts: [], graphical: false, buildJobs: 1 },
    combined: { executable: process.execPath, args: ['-e', 'const fs=require("fs");for(const p of ["alpha.txt","beta.txt"])if(fs.existsSync(p)&&fs.readFileSync(p,"utf8").trim()!=="complete")process.exit(1)'], cwd: '.', env: {}, timeoutMs: 10_000, artifacts: [], graphical: false, buildJobs: 1 },
  };
  policy.integration.checks = ['combined']; writeProject(join(repo, '.harness/project.yaml'), policy);
  writeFileSync(join(repo, '.gitignore'), 'artifacts/\nnode_modules/\n'); writeFileSync(join(repo, 'README.md'), 'Disposable harness smoke demonstration.\n');
  git(repo, ['add', '.harness/project.yaml', '.gitignore', 'README.md']); git(repo, ['commit', '-m', 'Initialize disposable harness demonstration']);
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const tasks = ['alpha', 'beta'].map(name => taskSchema.parse({ id: name, revision: 1, milestone: 'smoke', role: 'implementer',
    objective: name === 'alpha'
      ? 'FIRST TURN ONLY: send question ID smoke_question, thread smoke_thread, to beta, task alpha asking which word to write, then declare blocked waitingFor beta and end the turn WITHOUT writing alpha.txt. In the NEXT turn, read and acknowledge the answer, write alpha.txt with the answered word (complete), commit only alpha.txt and submit the immutable commit. This explicitly exercises continuation.'
      : 'Read harness mailbox. Answer alpha question smoke_question with ID smoke_answer, same thread/task and replyTo, body complete; acknowledge the question. If question not yet present, checkpoint and end the turn for scheduler delivery. After answering, write beta.txt containing complete, commit only beta.txt, submit immutable commit with evidence. Do not wait for alpha implementation.',
    editablePaths: [`${name}.txt`], acceptance: [`${name}.txt contains complete`, 'Addressed two-way harness mail is processed and acknowledged'], verification: [name], artifacts: [`${name}.txt`],
    limits: { attempts: 2, prompts: 5, steps: 12, elapsedMs: 240_000, noProgress: 3, providerRetries: 1, sessionPrompts: 5, tokens: 60_000, costUsd: 2 },
  }));
  const plan = planSchema.parse({ schemaVersion: 1, milestone: 'smoke', baseCommit, tasks });
  mkdirSync(join(repo, '.harness/plans')); const file = join(repo, '.harness/plans/smoke.yaml'); writeFileSync(file, stringify(plan));
  git(repo, ['add', '.harness/plans/smoke.yaml']); git(repo, ['commit', '-m', 'Record bounded smoke milestone']);
  const fake = new FakeRuntime(), adapter = runtimeAdapter === 'live' ? new OpenCodeRuntime(runtimeLocation(repo).runtime) : runtimeAdapter ?? fake;
  const app = openApplication(repo, adapter);
  if (!runtimeAdapter) fake.onDispatch = async (input) => {
    const worker = app.store.worker(input.id), task = app.store.task(worker.task), handle = app.store.handle(worker);
    const mail = await app.service.workerAction(worker, 'mail-read', {}) as MailRow[];
    if (worker.task === 'alpha' && task.prompts === 1) {
      await app.service.workerAction(worker, 'mail-send', { id: 'smoke_question', thread: 'smoke_thread', to: 'beta', task: 'alpha', type: 'question', body: 'Which word?' });
      await app.service.workerAction(worker, 'block', { reason: 'waiting on beta', waitingFor: 'beta' }); fake.finish(handle); return;
    }
    if (worker.task === 'beta') {
      if (!mail.some(m => m.id === 'smoke_question')) { fake.finish(handle); return; }
      await app.service.workerAction(worker, 'mail-send', { id: 'smoke_answer', thread: 'smoke_thread', to: 'alpha', task: 'alpha', type: 'answer', body: 'complete', replyTo: 'smoke_question' });
    }
    for (const message of mail) await app.service.workerAction(worker, 'mail-ack', { id: message.id });
    writeFileSync(join(input.directory, `${worker.task}.txt`), 'complete\n'); git(input.directory, ['add', `${worker.task}.txt`]); git(input.directory, ['commit', '-m', `Complete ${worker.task}`]);
    await app.service.workerAction(worker, 'submit', { revision: task.revision, commit: git(input.directory, ['rev-parse', 'HEAD']), changes: [`${worker.task}.txt`], evidence: ['answered mail and produced artifact'], limitations: [] }); fake.finish(handle);
  };
  try {
    await app.operate('import', { file }); await app.operate('approve', { milestone: 'smoke' });
    app.store.setMeta('mode', 'running'); await app.run(runtimeAdapter ? 240_000 : 20_000, true);
    const mail = app.store.all<MailRow>('SELECT * FROM messages ORDER BY created');
    const passed = app.store.tasks().every(t => t.state === 'done') && mail.some(m => m.type === 'question' && m.acknowledged) && mail.some(m => m.type === 'answer' && m.acknowledged) && app.store.task('alpha').prompts >= 2;
    const report = { mode: runtimeAdapter ? 'live' : 'mock', result: passed ? 'passed' : 'unverified', ownedProcessesStopped: app.store.all("SELECT * FROM workers WHERE status!='stopped'").length === 0, runtime: app.runtime, status: status(app.store) };
    const output = join(app.runtime, 'demo-report.json'); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); return { ...report, evidence: output };
  } finally { await app.supervisor.stopWorkers(); await app.close(); }
}
