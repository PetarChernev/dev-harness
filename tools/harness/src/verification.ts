import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from './commands.js';
import type { IntegrationRow, Store, TaskRow } from './store.js';
import { transition } from './store.js';
import type { Workspaces } from './workspace.js';
import { canonical, errorText, git, hash, safePath, uid } from './util.js';

export type Review = (task: TaskRow, workspace: string, candidate: string) => Promise<{ passed: boolean; findings: string[]; session: string }>;
export class Verifier {
  constructor(readonly store: Store, readonly workspaces: Workspaces, readonly runner: CommandRunner, readonly review?: Review) {}
  async checks(task: TaskRow, workspace: string, commands: string[], semantic = true): Promise<boolean> {
    const policy = this.store.policy(task);
    for (const command of [...new Set(commands)]) {
      const definition = policy.commands[command]; if (!definition) throw new Error('command not in approved policy');
      const result = await this.runner.run(task, command, definition, workspace);
      if (!result.passed) return false;
    }
    const commit = git(workspace, ['rev-parse', 'HEAD']);
    if (semantic && policy.integration.reviewRole) {
      if (!this.review) throw new Error('independent reviewer runtime is required by approved policy');
      const result = await this.review(task, workspace, commit);
      this.store.evidence(task, 'review', { ...result, commit });
      if (!result.passed) return false;
    }
    if (git(workspace, ['diff', 'HEAD', '--']) || git(workspace, ['rev-parse', 'HEAD']) !== commit) throw new Error('verification/reviewer altered candidate');
    return true;
  }
  async verify(taskId: string): Promise<boolean> {
    const task = this.store.task(taskId), submission = this.store.submission(task);
    if (task.state !== 'submitted' || !submission) throw new Error('task must be submitted');
    if (this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped' AND readOnly=0", task.id)) throw new Error('stop implementation writer before independent verification');
    transition(this.store, taskId, 'verifying', 'fresh independent checkout with approved policy snapshot');
    try {
      const spec = this.store.spec(task), policy = this.store.policy(task);
      this.workspaces.validate(spec, policy, task.workspace!, task.baseCommit, submission);
      const candidate = this.workspaces.candidate(submission.commit);
      const artifacts = join(this.workspaces.runtime, 'artifacts', uid('submission')); mkdirSync(artifacts, { recursive: true });
      for (const name of spec.artifacts) {
        const data = readFileSync(safePath(candidate, name)); const saved = join(artifacts, `${hash(name).slice(0, 12)}-${name.split('/').at(-1)}`); writeFileSync(saved, data);
        this.store.evidence(task, 'artifact', { name, path: saved, sha256: hash(data), commit: submission.commit });
      }
      const passed = await this.checks(task, candidate, spec.verification);
      this.store.evidence(task, 'verification', { passed, commit: submission.commit, policyHash: hash(policy), candidate });
      transition(this.store, taskId, passed ? 'integration' : 'ready', passed ? 'independent checks passed; queued for serialized integration' : 'verification failed; repair against original criteria with command evidence');
      if (!passed) this.store.updateTask(taskId, { submission: null, worker: null });
      return passed;
    } catch (error) { transition(this.store, taskId, 'needs_human', `verification boundary failed: ${errorText(error)}`); return false; }
  }
}

export class Integrator {
  constructor(readonly store: Store, readonly workspaces: Workspaces, readonly verifier: Verifier) {}
  /** Fault injection only models crash boundaries; restart uses this same reconciliation path. */
  crashAfter?: 'candidate' | 'advance';
  async integrate(taskId: string): Promise<boolean> {
    const task = this.store.task(taskId), submission = this.store.submission(task), policy = this.store.policy(task);
    if (task.state !== 'integration' || !submission) throw new Error('task not independently verified');
    let attempt = this.store.get<IntegrationRow>("SELECT * FROM integrations WHERE task=? AND revision=? AND state IN ('prepared','created','checked','advanced') ORDER BY created DESC LIMIT 1", taskId, task.revision);
    if (!attempt) {
      const previous = this.workspaces.integrationHead(policy, task.baseCommit), id = uid('integration');
      const workspace = join(this.workspaces.runtime, 'worktrees', id);
      this.store.run('INSERT INTO integrations VALUES (?,?,?,?,?,?,?,?,?,?)', id, taskId, task.revision, submission.commit, previous, null, workspace, 'prepared', canonical([...new Set([...this.store.spec(task).verification, ...policy.integration.checks])]), Date.now());
      attempt = this.store.get<IntegrationRow>('SELECT * FROM integrations WHERE id=?', id)!;
      this.store.event('integration', 'serialized candidate intent recorded against latest target', taskId, { id, previous, submission: submission.commit });
    }
    if (attempt.submission !== submission.commit) throw new Error('integration belongs to different submission');
    const target = this.workspaces.integrationHead(policy, task.baseCommit);
    if (attempt.candidate && target === attempt.candidate && ['checked', 'advanced'].includes(attempt.state)) {
      this.store.run("UPDATE integrations SET state='advanced' WHERE id=?", attempt.id);
      transition(this.store, taskId, 'done', 'reconciled already-advanced verified Git candidate');
      this.store.evidence(task, 'integration', { candidate: attempt.candidate, resultingCommit: target, recovered: true });
      return true;
    }
    if (target !== attempt.previous) { transition(this.store, taskId, 'needs_human', 'integration target changed outside serialized queue'); return false; }
    if (attempt.state === 'prepared') {
      if (!existsSync(attempt.workspace)) git(this.workspaces.repo, ['worktree', 'add', '--detach', attempt.workspace, attempt.previous]);
      const current = git(attempt.workspace, ['rev-parse', 'HEAD']);
      // A crash after Git merge but before recording its result: verify both parents, never merge twice.
      if (current !== attempt.previous) {
        const parents = git(attempt.workspace, ['show', '-s', '--format=%P', current]).split(' ');
        if (parents[0] !== attempt.previous || !parents.includes(submission.commit)) { transition(this.store, taskId, 'needs_human', 'unrecognized Git result in interrupted integration'); return false; }
        attempt.candidate = current;
      } else {
        try {
          git(attempt.workspace, ['merge', '--no-ff', '--no-edit', '-m', `Harness integrate ${task.id}@${task.revision} (${attempt.id})`, submission.commit]);
          attempt.candidate = git(attempt.workspace, ['rev-parse', 'HEAD']);
        } catch (error) {
          this.store.evidence(task, 'conflict', { workspace: attempt.workspace, error: errorText(error), status: git(attempt.workspace, ['status', '--porcelain']) });
          this.store.run("UPDATE integrations SET state='failed' WHERE id=?", attempt.id);
          transition(this.store, taskId, 'needs_human', 'integration conflict preserved; owner must resolve against latest candidate'); return false;
        }
      }
      this.store.run("UPDATE integrations SET candidate=?,state='created' WHERE id=?", attempt.candidate, attempt.id); attempt.state = 'created';
      if (this.crashAfter === 'candidate') throw new Error('simulated crash after candidate');
    }
    if (attempt.state === 'created') {
      const unfinished = this.store.get("SELECT id FROM actions WHERE task=? AND kind='command' AND status IN ('intent','running','uncertain')", taskId);
      if (unfinished) { transition(this.store, taskId, 'needs_human', 'unreconciled external check; do not repeat integration commands'); return false; }
      const passed = await this.verifier.checks(task, attempt.workspace, JSON.parse(attempt.checks) as string[]);
      this.store.evidence(task, 'combined-verification', { passed, previous: attempt.previous, candidate: attempt.candidate });
      if (!passed) { this.store.run("UPDATE integrations SET state='failed' WHERE id=?", attempt.id); transition(this.store, taskId, 'ready', 'combined checks failed; integration target unchanged, repair required'); this.store.updateTask(taskId, { submission: null, worker: null }); return false; }
      this.store.run("UPDATE integrations SET state='checked' WHERE id=?", attempt.id); attempt.state = 'checked';
    }
    if (attempt.state === 'checked') {
      if (!attempt.candidate || git(attempt.workspace, ['rev-parse', 'HEAD']) !== attempt.candidate) throw new Error('verified candidate changed');
      this.workspaces.advance(policy, attempt.previous, attempt.candidate);
      if (this.crashAfter === 'advance') throw new Error('simulated crash after advance');
      this.store.run("UPDATE integrations SET state='advanced' WHERE id=?", attempt.id);
      this.store.evidence(task, 'integration', { candidate: attempt.candidate, resultingCommit: attempt.candidate, previous: attempt.previous });
      transition(this.store, taskId, 'done', 'latest combined candidate passed; integration branch atomically advanced');
      return true;
    }
    return false;
  }
}
