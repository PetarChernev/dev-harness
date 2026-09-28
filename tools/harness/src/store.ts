import Database from 'better-sqlite3';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ownership } from './ownership.js';
import { planSchema, projectSchema, taskSchema, validateGraph } from './schema.js';
import type { Plan, Project, State, Submission, TaskSpec } from './schema.js';
import { canonical, hash, uid } from './util.js';
import type { WorkerHandle } from './runtime.js';

export interface TaskRow {
  id: string; revision: number; milestone: string; state: State; approval: string | null; attempt: number; prompts: number;
  started: number | null; nextRun: number; noProgress: number; progress: string; blocker: string | null; waitingFor: string | null;
  leaseUntil: number | null; worker: string | null; baseCommit: string; workspace: string | null; submission: string | null;
  tokens: number | null; cost: number | null; retries: number;
}
export interface WorkerRow { id: string; task: string; revision: number; attempt: number; session: string | null; handle: string | null; status: 'starting' | 'active' | 'stopped' | 'uncertain'; tokenHash: string; readOnly: number; created: number }
export interface DispatchRow { id: string; worker: string; session: string; status: 'intent' | 'accepted' | 'uncertain' | 'completed' | 'rejected' | 'cancelled'; prompt: string; created: number; result: string | null }
export interface MailRow { id: string; thread: string; sender: string; recipient: string; task: string; type: string; body: string; replyTo: string | null; created: number; delivered: number | null; acknowledged: number | null }
export interface EvidenceRow { id: string; task: string; revision: number; kind: string; data: string; created: number; valid: number }
export interface ActionRow { id: string; task: string; kind: string; status: string; data: string; result: string | null; created: number }
export interface IntegrationRow { id: string; task: string; revision: number; submission: string; previous: string; candidate: string | null; workspace: string; state: 'prepared' | 'created' | 'checked' | 'advanced' | 'failed'; checks: string; created: number }

const migrations = [
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE specs(id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,revision));
   CREATE TABLE approvals(id TEXT PRIMARY KEY, milestone TEXT NOT NULL, plan TEXT NOT NULL, policy TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
   CREATE TABLE tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, milestone TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','ready','running','submitted','verifying','integration','done','blocked','needs_human','failed','cancelled')), approval TEXT REFERENCES approvals(id), attempt INTEGER NOT NULL DEFAULT 0, prompts INTEGER NOT NULL DEFAULT 0, started INTEGER, nextRun INTEGER NOT NULL DEFAULT 0, noProgress INTEGER NOT NULL DEFAULT 0, progress TEXT NOT NULL DEFAULT '', blocker TEXT, waitingFor TEXT, leaseUntil INTEGER, worker TEXT, baseCommit TEXT NOT NULL, workspace TEXT, submission TEXT, tokens REAL, cost REAL, retries INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(id,revision) REFERENCES specs(id,revision));
   CREATE TABLE workers(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, attempt INTEGER NOT NULL, session TEXT UNIQUE, handle TEXT, status TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, readOnly INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
   CREATE UNIQUE INDEX one_writer ON workers(task) WHERE status IN ('starting','active','uncertain') AND readOnly=0;
   CREATE TABLE dispatches(id TEXT PRIMARY KEY, worker TEXT NOT NULL REFERENCES workers(id), session TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, created INTEGER NOT NULL, result TEXT);
   CREATE UNIQUE INDEX one_prompt ON dispatches(session) WHERE status IN ('intent','accepted','uncertain');
   CREATE TABLE messages(id TEXT PRIMARY KEY, thread TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, body TEXT NOT NULL, replyTo TEXT REFERENCES messages(id), created INTEGER NOT NULL, delivered INTEGER, acknowledged INTEGER);
   CREATE TABLE checkpoints(id TEXT PRIMARY KEY, task TEXT NOT NULL, worker TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
   CREATE TABLE evidence(id TEXT PRIMARY KEY, task TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE actions(id TEXT PRIMARY KEY, task TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
   CREATE TABLE integrations(id TEXT PRIMARY KEY, task TEXT NOT NULL, revision INTEGER NOT NULL, submission TEXT NOT NULL, previous TEXT NOT NULL, candidate TEXT, workspace TEXT NOT NULL, state TEXT NOT NULL, checks TEXT NOT NULL, created INTEGER NOT NULL);
   CREATE UNIQUE INDEX one_integration ON integrations((1)) WHERE state IN ('prepared','created','checked');
   CREATE TABLE resource_locks(key TEXT PRIMARY KEY, task TEXT NOT NULL);
   CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, task TEXT, type TEXT NOT NULL, reason TEXT NOT NULL, data TEXT NOT NULL);`,
  `CREATE INDEX pending_mail ON messages(recipient,acknowledged);
   CREATE INDEX task_events ON events(task,seq);
   CREATE TABLE attempts(task TEXT NOT NULL, number INTEGER NOT NULL, worker TEXT NOT NULL, baseCommit TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, reason TEXT, PRIMARY KEY(task,number));`,
  `ALTER TABLE attempts RENAME TO attempts_v2;
   CREATE TABLE attempts(task TEXT NOT NULL, revision INTEGER NOT NULL, number INTEGER NOT NULL, worker TEXT NOT NULL, baseCommit TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, reason TEXT, PRIMARY KEY(task,revision,number));
   INSERT INTO attempts SELECT a.task,COALESCE(w.revision,t.revision,1),a.number,a.worker,a.baseCommit,a.started,a.ended,a.reason FROM attempts_v2 a LEFT JOIN workers w ON w.id=a.worker LEFT JOIN tasks t ON t.id=a.task;
   DROP TABLE attempts_v2;`,
];

export class Store {
  readonly db: Database.Database;
  constructor(readonly path: string, readonly ownership?: Ownership, readonly readOnly = false) {
    if (!readOnly) { ownership?.assert(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new Database(path, { readonly: readOnly, fileMustExist: readOnly });
    this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    if (!readOnly) {
      this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > migrations.length) throw new Error('database schema is newer than this harness');
      for (let i = version; i < migrations.length; i++) this.db.transaction(() => { this.db.exec(migrations[i]!); this.db.pragma(`user_version = ${i + 1}`); })();
    }
  }
  mutate(): void { if (this.readOnly) throw new Error('read-only store'); this.ownership?.assert(); }
  run(sql: string, ...params: unknown[]): Database.RunResult { this.mutate(); return this.db.prepare(sql).run(...params); }
  get<T>(sql: string, ...params: unknown[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: unknown[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  transaction<T>(fn: () => T): T { this.mutate(); return this.db.transaction(fn).immediate(); }
  meta(key: string, fallback: string): string;
  meta<T>(key: string, fallback: T): T;
  meta<T>(key: string, fallback: T): T { const row = this.get<{ value: string }>('SELECT value FROM meta WHERE key=?', key); return row ? JSON.parse(row.value) as T : fallback; }
  setMeta(key: string, value: unknown): void { this.run('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, canonical(value)); }
  event(type: string, reason: string, task: string | null = null, data: unknown = {}): void { this.run('INSERT INTO events(time,task,type,reason,data) VALUES (?,?,?,?,?)', Date.now(), task, type, reason, canonical(data)); }
  task(id: string): TaskRow { const row = this.get<TaskRow>('SELECT * FROM tasks WHERE id=?', id); if (!row) throw new Error(`unknown task ${id}`); return row; }
  tasks(): TaskRow[] { return this.all<TaskRow>('SELECT * FROM tasks ORDER BY id'); }
  spec(task: TaskRow): TaskSpec { return taskSchema.parse(JSON.parse(this.get<{ body: string }>('SELECT body FROM specs WHERE id=? AND revision=?', task.id, task.revision)!.body)); }
  policy(task: TaskRow): Project { if (!task.approval) throw new Error('task not approved'); return projectSchema.parse(JSON.parse(this.get<{ policy: string }>('SELECT policy FROM approvals WHERE id=?', task.approval)!.policy)); }
  worker(id: string): WorkerRow { const row = this.get<WorkerRow>('SELECT * FROM workers WHERE id=?', id); if (!row) throw new Error('unknown worker'); return row; }
  handle(worker: WorkerRow): WorkerHandle { if (!worker.handle) throw new Error('worker start outcome unknown'); return JSON.parse(worker.handle) as WorkerHandle; }
  updateTask(id: string, patch: Partial<Omit<TaskRow, 'id'>>): void {
    const keys = Object.keys(patch);
    if (keys.some(k => !Object.keys(this.task(id)).includes(k))) throw new Error('invalid runtime field');
    if (keys.length) this.run(`UPDATE tasks SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(patch), id);
  }
  evidence(task: TaskRow, kind: string, data: unknown): string { const id = uid('evidence'); this.run('INSERT INTO evidence VALUES (?,?,?,?,?,?,?)', id, task.id, task.revision, kind, canonical(data), Date.now(), Number(this.task(task.id).revision === task.revision)); return id; }
  importPlan(input: unknown): Plan {
    const plan = planSchema.parse(input);
    const existing = this.tasks().map(t => this.spec(t)); validateGraph(plan, existing);
    this.transaction(() => {
      for (const spec of plan.tasks) {
        const old = this.get<{ hash: string }>('SELECT hash FROM specs WHERE id=? AND revision=?', spec.id, spec.revision);
        if (old && old.hash !== hash(spec)) throw new Error(`immutable revision ${spec.id}@${spec.revision}; create a new revision and approve it`);
        const active = this.get<TaskRow>('SELECT * FROM tasks WHERE id=?', spec.id);
        if (active && active.revision > spec.revision) throw new Error('cannot import obsolete revision');
        if (active && active.revision === spec.revision) {
          if (this.meta(`spec-base:${spec.id}@${spec.revision}`, active.baseCommit) !== plan.baseCommit) throw new Error('immutable revision base commit changed');
          continue;
        }
        if (active && this.get('SELECT id FROM workers WHERE task=? AND status!=?', spec.id, 'stopped')) throw new Error('stop/reconcile worker before revising task');
        if (active) {
          const affected = new Set([spec.id]);
          let changed = true;
          while (changed) { changed = false; for (const t of existing) if (!affected.has(t.id) && t.dependencies.some(d => affected.has(d.id))) { affected.add(t.id); changed = true; } }
          for (const taskId of affected) {
            if (['running', 'submitted', 'verifying', 'integration'].includes(this.task(taskId).state) || this.get("SELECT id FROM actions WHERE task=? AND status IN ('queued','intent','running','uncertain')", taskId)) throw new Error('stop/reconcile active work and cancel obsolete submissions before revising');
            if (this.get('SELECT id FROM workers WHERE task=? AND status!=?', taskId, 'stopped')) throw new Error('dependent worker must be stopped before revision');
            this.run('UPDATE evidence SET valid=0 WHERE task=?', taskId);
            this.run('DELETE FROM resource_locks WHERE task=?', taskId);
            this.run("UPDATE tasks SET approval=NULL,state='draft',submission=NULL,blocker='specification revision invalidated prior verification' WHERE id=?", taskId);
          }
        }
        this.run('INSERT OR IGNORE INTO specs VALUES (?,?,?,?)', spec.id, spec.revision, hash(spec), canonical(spec));
        this.setMeta(`spec-base:${spec.id}@${spec.revision}`, plan.baseCommit);
        this.run(`INSERT INTO tasks(id,revision,milestone,state,baseCommit) VALUES (?,?,?,'draft',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,milestone=excluded.milestone,state='draft',approval=NULL,attempt=0,prompts=0,started=NULL,worker=NULL,workspace=NULL,submission=NULL,tokens=NULL,cost=NULL,retries=0,noProgress=0,progress='',nextRun=0,leaseUntil=NULL,waitingFor=NULL,blocker=NULL,baseCommit=excluded.baseCommit`, spec.id, spec.revision, spec.milestone, plan.baseCommit);
      }
      this.event('import', 'immutable draft revisions imported; approval required', null, { milestone: plan.milestone, hash: hash(plan) });
    });
    return plan;
  }
  approve(milestone: string, policyInput: unknown): string {
    const policy = projectSchema.parse(policyInput), tasks = this.tasks().filter(t => t.milestone === milestone && t.state === 'draft');
    if (!tasks.length) throw new Error('no draft tasks in milestone');
    for (const task of tasks) {
      const spec = this.spec(task);
      if (!policy.roles[spec.role]) throw new Error(`unknown role ${spec.role}`);
      for (const command of spec.verification) if (!policy.commands[command]) throw new Error(`unknown command ${command}`);
      for (const key of spec.locks) if (!policy.sharedLocks[key]) throw new Error(`unknown shared lock ${key}`);
      if (spec.kind === 'maintenance' && !policy.integration.reviewRole) throw new Error('maintenance requires independent semantic review');
    }
    const approval = uid('approval');
    this.transaction(() => {
      this.run('INSERT INTO approvals VALUES (?,?,?,?,?,?)', approval, milestone, canonical({ tasks: tasks.map(t => this.spec(t)), bases: tasks.map(t => ({ id: t.id, commit: t.baseCommit })) }), canonical(policy), hash({ policy, tasks: tasks.map(t => this.spec(t)) }), Date.now());
      for (const task of tasks) this.updateTask(task.id, { approval, state: 'ready', blocker: null });
      this.setMeta(`milestone:${milestone}`, 'active');
      this.event('approval', 'operator approved included immutable revisions, policy and finite limits', null, { milestone, approval });
    });
    return approval;
  }
  submission(task: TaskRow): Submission | null { return task.submission ? JSON.parse(task.submission) as Submission : null; }
  async backup(path: string): Promise<void> { this.mutate(); if (existsSync(path)) throw new Error('backup destination exists'); mkdirSync(dirname(path), { recursive: true }); closeSync(openSync(path, 'wx', 0o600)); await this.db.backup(path); this.event('backup', 'SQLite online backup completed', null, { path }); }
  close(): void { this.db.close(); }
  static restore(source: string, destination: string, ownership: Ownership): void {
    ownership.assert();
    const backup = new Database(source, { readonly: true, fileMustExist: true });
    try {
      if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('invalid backup');
      const version = backup.pragma('user_version', { simple: true }) as number;
      if (version < 1 || version > migrations.length || !backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='specs'").get()) throw new Error('unsupported or non-harness backup schema');
    } finally { backup.close(); }
    if (existsSync(destination) || existsSync(destination + '-wal')) throw new Error('restore requires absent destination; archive old database with supervisor stopped');
    const temporary = join(dirname(destination), uid('restore')); copyFileSync(source, temporary); renameSync(temporary, destination);
  }
}

const transitions: Record<State, State[]> = {
  draft: ['ready', 'cancelled'], ready: ['running', 'blocked', 'needs_human', 'failed', 'cancelled'],
  running: ['submitted', 'blocked', 'needs_human', 'failed', 'cancelled', 'ready'],
  submitted: ['verifying', 'needs_human', 'ready', 'failed', 'cancelled'], verifying: ['integration', 'ready', 'needs_human', 'failed', 'cancelled'],
  integration: ['done', 'ready', 'needs_human', 'failed', 'cancelled'], done: [],
  blocked: ['running', 'ready', 'needs_human', 'failed', 'cancelled'], needs_human: ['ready', 'running', 'cancelled', 'failed'],
  failed: ['ready', 'cancelled'], cancelled: ['ready'],
};
export function transition(store: Store, taskId: string, next: State, reason: string): void {
  const task = store.task(taskId);
  if (!transitions[task.state].includes(next)) throw new Error(`invalid transition ${task.state} -> ${next}`);
  store.updateTask(taskId, { state: next, blocker: ['blocked', 'needs_human', 'failed'].includes(next) ? reason : null });
  store.event('transition', reason, taskId, { from: task.state, to: next });
}
